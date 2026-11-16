import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { open, readFile, realpath, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { brotliCompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ContractError, attempt } from '@orkestrel/contract'
import { waitForCondition } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import {
	buildClient,
	buildRateLimitField,
	buildRateLimitPolicyField,
	buildRetryAfter,
	compressBytes,
	compressResponse,
	detectEncodings,
	equalsConstantTime,
	extractBearerToken,
	extractFieldToken,
	matchesUnbufferableResponse,
	isCompressionNegotiated,
	isPreflight,
	matchesTrustedEntry,
	rebuildResponse,
	renderChallenge,
	resolveForwardedFor,
	resolveKey,
	Session,
	sessionExpired,
	snapshotSession,
	transferSessionState,
	admitForeign,
	admitOptions,
	buildForeignContract,
	SESSION_LIMITS_CONTRACT,
	computeFileETag,
	buildAssetResponse,
	readAssetRecord,
	resolveAssetKey,
	compressNodeBytes,
	createUploadedFile,
	detectMIME,
	extractMultipartBoundary,
	isContainedPath,
	isDotfilePath,
	isMultipartError,
	isReservedDeviceName,
	isUnderPath,
	lookupContentType,
	matchesBytes,
	DEFAULT_MULTIPART_FIELD_SIZE,
	DEFAULT_MULTIPART_FIELD_COUNT,
	DEFAULT_MULTIPART_FILE_SIZE,
	DEFAULT_MULTIPART_FILE_COUNT,
	DEFAULT_MULTIPART_TOTAL,
	moveUploadedFile,
	openStaticFile,
	planStaticResponse,
	parsePartHeaders,
	readUploadedFile,
	resolveMultipartLimits,
	resolveStaticFallbackPath,
	resolveStaticPath,
	resolveStaticFile,
	streamFile,
	streamUploadedFile,
	unlinkStagedFiles,
} from '@src/server'
import {
	PNG_MAGIC,
	countActiveFileRequests,
	detectClosedHandle,
	resolveSecondDevicePath,
} from '../../setupServer.js'
import { buildTestRequest, buildSession, createTestContext, decompress } from '../../setup.js'

// Read once at collection: the host's device layout does not change under the
// suite, and `it.runIf` needs the answer while the cases are being registered.
const secondDevice = resolveSecondDevicePath(tmpdir())

// ── resolveStaticPath — the traversal matrix ────────────────────────────────

describe('asset stages', () => {
	it('resolves decoded keys and refuses malformed or hidden paths', () => {
		expect(resolveAssetKey('/')).toBe('index.html')
		expect(resolveAssetKey('/a%20b.js')).toBe('a b.js')
		for (const path of ['/%zz', '/a//b', '/a/../b', '/.hidden', '/a%5Cb']) {
			expect(resolveAssetKey(path)).toBeUndefined()
		}
	})

	it('copies identity bytes and derives Brotli records with the same validator', async () => {
		const bytes = new TextEncoder().encode('asset')
		const identity = await readAssetRecord({ read: () => ({ body: bytes }) }, 'a.txt')
		const encoded = await readAssetRecord(
			{ read: () => ({ body: brotliCompressSync(bytes), encoding: 'br' }) },
			'a.txt',
		)
		expect(encoded?.identity).toEqual(bytes)
		expect(encoded?.etag).toBe(identity?.etag)
		bytes.fill(0)
		expect(new TextDecoder().decode(identity?.identity)).toBe('asset')
		expect(await readAssetRecord({ read: () => undefined }, 'missing')).toBeUndefined()
		await expect(
			readAssetRecord({ read: () => ({ body: new Uint8Array([0]), encoding: 'br' }) }, 'bad'),
		).rejects.toThrow(/unexpected end|decompress/i)
	})

	it('refuses a source that returns a body outside the AssetRepresentation shape', async () => {
		const malformed = new Proxy(
			{ body: new Uint8Array([0]) },
			{ get: (target, key) => (key === 'body' ? 'text' : Reflect.get(target, key)) },
		)
		await expect(readAssetRecord({ read: () => malformed }, 'a.txt')).rejects.toThrow(
			'AssetSourceInterface.read must return an AssetRepresentation',
		)
	})

	it('builds negotiated HEAD and conditional responses from a record', async () => {
		const record = await readAssetRecord(
			{ read: () => ({ body: brotliCompressSync('asset'), encoding: 'br' }) },
			'a.txt',
		)
		if (record === undefined) throw new Error('expected asset')
		const plain = buildAssetResponse(new Request('http://test/a'), 'GET', record)
		expect(await plain.text()).toBe('asset')
		const encoded = buildAssetResponse(
			new Request('http://test/a', { headers: { 'accept-encoding': 'br' } }),
			'GET',
			record,
		)
		expect(encoded.headers.get('content-encoding')).toBe('br')
		expect(new Uint8Array(await encoded.arrayBuffer())).toEqual(record.brotli)
		const head = buildAssetResponse(new Request('http://test/a'), 'HEAD', record)
		expect(await head.text()).toBe('')
		expect(head.headers.get('content-length')).toBe('5')
		const fresh = buildAssetResponse(
			new Request('http://test/a', { headers: { 'if-none-match': record.etag } }),
			'GET',
			record,
		)
		expect(fresh.status).toBe(304)
		expect(fresh.headers.get('vary')).toBe('accept-encoding')
	})
})

describe('static file stages', () => {
	it('resolves contained files and directory indexes and refuses missing paths', async () => {
		const directory = createScratch({ prefix: 'static-stages-' })
		try {
			const path = join(directory.path, 'index.html')
			await writeFile(path, 'hello')
			const root = await realpath(directory.path)
			expect(await resolveStaticFile(root, root, 'index.html')).toEqual({
				path: await realpath(path),
				contained: true,
			})
			expect(await resolveStaticFile(path, root, 'index.html')).toEqual({
				path: await realpath(path),
				contained: true,
			})
			expect(await resolveStaticFile(join(root, 'missing'), root, 'index.html')).toBeUndefined()
			expect(await resolveStaticFile(root, join(root, 'child'), 'index.html')).toEqual({
				path: root,
				contained: false,
			})
		} finally {
			await directory.destroy()
		}
	})

	it('opens regular files with handle metadata and refuses directories and missing files', async () => {
		const directory = createScratch({ prefix: 'static-open-' })
		try {
			const path = join(directory.path, 'a.txt')
			await writeFile(path, 'hello')
			const file = await openStaticFile(path)
			if (file === undefined) throw new Error('expected an opened file')
			try {
				expect(file.path).toBe(path)
				expect(file.info.size).toBe(5)
				expect(await file.handle.readFile('utf8')).toBe('hello')
			} finally {
				await file.handle.close()
			}
			expect(await openStaticFile(directory.path)).toBeUndefined()
			expect(await openStaticFile(join(directory.path, 'missing'))).toBeUndefined()
		} finally {
			await directory.destroy()
		}
	})

	it('plans conditional HEAD and range responses from the opened file', async () => {
		const directory = createScratch({ prefix: 'static-plan-' })
		try {
			const path = join(directory.path, 'a.txt')
			await writeFile(path, 'hello')
			const file = await openStaticFile(path)
			if (file === undefined) throw new Error('expected an opened file')
			try {
				const full = planStaticResponse(new Request('http://test/a'), 'GET', file.info, path, {
					cache: 60,
				})
				expect(full.status).toBe(200)
				expect(full.headers.get('cache-control')).toBe('max-age=60')
				expect(full.headers.get('content-length')).toBe('5')
				const head = planStaticResponse(new Request('http://test/a'), 'HEAD', file.info, path, {})
				expect(head.status).toBe(200)
				expect(head.range).toBeUndefined()
				const partial = planStaticResponse(
					new Request('http://test/a', { headers: { range: 'bytes=1-3' } }),
					'GET',
					file.info,
					path,
					{},
				)
				expect(partial.status).toBe(206)
				expect(partial.range).toEqual({ start: 1, end: 3 })
				const refused = planStaticResponse(
					new Request('http://test/a', { headers: { range: 'bytes=8-' } }),
					'GET',
					file.info,
					path,
					{},
				)
				expect(refused.status).toBe(416)
				const fresh = planStaticResponse(
					new Request('http://test/a', {
						headers: { 'if-none-match': computeFileETag(file.info.size, file.info.mtimeMs) },
					}),
					'GET',
					file.info,
					path,
					{},
				)
				expect(fresh.status).toBe(304)
			} finally {
				await file.handle.close()
			}
		} finally {
			await directory.destroy()
		}
	})
})

describe('resolveStaticPath', () => {
	const root = resolvePath('/srv/public')

	it('resolves a plain nested path under root', () => {
		expect(resolveStaticPath(root, undefined, '/a/b.html')).toBe(join(root, 'a', 'b.html'))
	})

	it('refuses raw ../ traversal', () => {
		expect(resolveStaticPath(root, undefined, '/../etc/passwd')).toBeUndefined()
		expect(resolveStaticPath(root, undefined, '/a/../../etc/passwd')).toBeUndefined()
	})

	it('refuses encoded-dot traversal (%2e%2e)', () => {
		expect(resolveStaticPath(root, undefined, '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined()
		expect(resolveStaticPath(root, undefined, '/%2e%2e%2fetc%2fpasswd')).toBeUndefined()
	})

	it('collapses a doubled leading slash to a plain relative path (no separate escape vector)', () => {
		// A doubled leading `/` is stripped entirely by the relative-strip step
		// (`/^[/\\]+/`), so `//etc/passwd` resolves to the harmless relative
		// path `etc/passwd` under root — it is not a distinct traversal vector
		// on its own (unlike a leading `..` segment, which the strip-then-
		// normalize ordering is specifically designed to catch).
		expect(resolveStaticPath(root, undefined, '//etc/passwd')).toBe(join(root, 'etc', 'passwd'))
	})

	it('enforces the prefix on a SEGMENT boundary — /apifoo is not under /api', () => {
		expect(resolveStaticPath(root, '/api', '/apifoo/x')).toBeUndefined()
		expect(resolveStaticPath(root, '/api', '/api/x')).toBe(join(root, 'x'))
		expect(resolveStaticPath(root, '/api', '/api')).toBe(root)
	})

	it('refuses a malformed percent-escape without throwing', () => {
		expect(() => resolveStaticPath(root, undefined, '/%zz')).not.toThrow()
		expect(resolveStaticPath(root, undefined, '/%zz')).toBeUndefined()
	})

	it('refuses a NUL byte', () => {
		expect(resolveStaticPath(root, undefined, '/a\0b')).toBeUndefined()
	})

	// `normalize`/`resolve` on POSIX never treat `\` as a path separator — a
	// backslash-joined string is a single literal segment, so it stays
	// (harmlessly) under root rather than escaping. On win32, `node:path`
	// treats `\` as a genuine separator, so the same string traverses out of
	// root and is refused. This guard's mixed-separator defense is a
	// Windows-path concern.
	it.runIf(process.platform !== 'win32')(
		'treats a backslash as a literal filename character on POSIX — the segment stays under root',
		() => {
			const resolved = resolveStaticPath(root, undefined, '/a\\..\\..\\etc\\passwd')
			expect(resolved).toBeDefined()
			expect(resolved?.startsWith(root)).toBe(true)
		},
	)

	it.runIf(process.platform === 'win32')(
		'treats a backslash as a separator on win32 — the traversal escapes root and is refused',
		() => {
			const resolved = resolveStaticPath(root, undefined, '/a\\..\\..\\etc\\passwd')
			expect(resolved).toBeUndefined()
		},
	)

	it('resolves the root itself for an empty remainder', () => {
		expect(resolveStaticPath(root, undefined, '/')).toBe(root)
	})
})

// ── isUnderPath ──────────────────────────────────────────────────────────────

describe('isUnderPath', () => {
	it('matches the prefix exactly', () => {
		expect(isUnderPath('/api', '/api')).toBe(true)
	})

	it('matches a segment-boundary child', () => {
		expect(isUnderPath('/api/x', '/api')).toBe(true)
	})

	it('does NOT match a mere string-prefix sibling', () => {
		expect(isUnderPath('/apifoo', '/api')).toBe(false)
		expect(isUnderPath('/apifoo/x', '/api')).toBe(false)
	})

	it('does not match an unrelated path', () => {
		expect(isUnderPath('/other', '/api')).toBe(false)
	})
})

describe('resolveStaticFallbackPath', () => {
	const root = resolvePath('/srv/public')

	it('resolves the fixed shell for an eligible navigation', () => {
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'GET', '/dashboard', 'text/html'),
		).toBe(join(root, 'index.html'))
	})

	it('resolves the same shell for HEAD as for GET, so a navigation probe agrees with its body', () => {
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'HEAD', '/dashboard', 'text/html'),
		).toBe(join(root, 'index.html'))
	})

	it('rejects non-navigation methods, extensions, excluded paths, and accept values', () => {
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'POST', '/dashboard', 'text/html'),
		).toBeUndefined()
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'GET', '/app.js', 'text/html'),
		).toBeUndefined()
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'GET', '/api/users', 'text/html'),
		).toBeUndefined()
		expect(
			resolveStaticFallbackPath(root, 'index.html', '/api', 'GET', '/dashboard', 'image/png'),
		).toBeUndefined()
	})
})

// ── isContainedPath ──────────────────────────────────────────────────────────

describe('isContainedPath', () => {
	const root = resolvePath('/srv/public')

	it('matches the parent itself', () => {
		expect(isContainedPath(root, root)).toBe(true)
	})

	it('matches a contained subpath', () => {
		expect(isContainedPath(join(root, 'a', 'b.html'), root)).toBe(true)
	})

	it('does not match a child escaping through ..', () => {
		expect(isContainedPath(resolvePath(root, '..', 'etc', 'passwd'), root)).toBe(false)
	})

	it('does not match an absolute path under a different root', () => {
		const other = resolvePath('/srv/other')
		expect(isContainedPath(join(other, 'a.html'), root)).toBe(false)
	})

	it('is separator-correct on the current platform (native realpath-style paths)', () => {
		const base = resolvePath('/srv/public')
		const child = join(base, 'nested', 'file.html')
		expect(isContainedPath(child, base)).toBe(true)
	})

	it('does not match a sibling whose name merely shares the parent as a prefix', () => {
		const sibling = resolvePath('/srv/publicx')
		expect(isContainedPath(join(sibling, 'file.html'), root)).toBe(false)
	})

	it('matches a literal entry name that is merely prefixed with ..', () => {
		expect(isContainedPath(join(root, '..foo'), root)).toBe(true)
	})
})

// ── isReservedDeviceName ─────────────────────────────────────────────────────

describe('isReservedDeviceName', () => {
	it('flags bare and cased reserved stems', () => {
		expect(isReservedDeviceName('CON')).toBe(true)
		expect(isReservedDeviceName('con')).toBe(true)
		expect(isReservedDeviceName('NUL')).toBe(true)
		expect(isReservedDeviceName('AUX')).toBe(true)
		expect(isReservedDeviceName('COM1')).toBe(true)
		expect(isReservedDeviceName('LPT9')).toBe(true)
	})

	it('flags a reserved stem with an extension', () => {
		expect(isReservedDeviceName('NUL.json')).toBe(true)
		expect(isReservedDeviceName('CON.txt')).toBe(true)
	})

	it('flags a reserved stem with trailing dots/spaces', () => {
		expect(isReservedDeviceName('AUX ')).toBe(true)
		expect(isReservedDeviceName('AUX.')).toBe(true)
		expect(isReservedDeviceName('AUX. ')).toBe(true)
	})

	it('flags a reserved stem with superscript digits', () => {
		expect(isReservedDeviceName('COM¹')).toBe(true)
		expect(isReservedDeviceName('CON¹')).toBe(false)
	})

	it('does NOT flag a name merely starting with a reserved stem', () => {
		expect(isReservedDeviceName('console.js')).toBe(false)
		expect(isReservedDeviceName('nullable.css')).toBe(false)
		expect(isReservedDeviceName('context')).toBe(false)
	})

	it('is total on empty and dot-only segments', () => {
		expect(isReservedDeviceName('')).toBe(false)
		expect(isReservedDeviceName('.')).toBe(false)
	})
})

// ── isDotfilePath ────────────────────────────────────────────────────────────

describe('isDotfilePath', () => {
	it('flags a leading-dot segment anywhere in the path', () => {
		expect(isDotfilePath('.env')).toBe(true)
		expect(isDotfilePath('a/.git/config')).toBe(true)
	})

	it('does not flag an ordinary path', () => {
		expect(isDotfilePath('a/b.css')).toBe(false)
	})
})

// ── detectMIME — real magic bytes ───────────────────────────────────────────

describe('detectMIME', () => {
	it('detects PNG', () => {
		expect(detectMIME(PNG_MAGIC)).toBe('image/png')
	})

	it('detects JPEG', () => {
		expect(detectMIME(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
	})

	it('detects GIF87a and GIF89a', () => {
		expect(detectMIME(new TextEncoder().encode('GIF87a'))).toBe('image/gif')
		expect(detectMIME(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
	})

	it('detects WEBP (RIFF....WEBP wildcard middle bytes)', () => {
		const head = new Uint8Array(12)
		head.set(new TextEncoder().encode('RIFF'), 0)
		head.set([0x00, 0x00, 0x00, 0x00], 4)
		head.set(new TextEncoder().encode('WEBP'), 8)
		expect(detectMIME(head)).toBe('image/webp')
	})

	it('detects PDF and ZIP', () => {
		expect(detectMIME(new TextEncoder().encode('%PDF-1.4'))).toBe('application/pdf')
		expect(detectMIME(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip')
	})

	it('returns undefined for unknown bytes', () => {
		expect(detectMIME(new TextEncoder().encode('plain text body'))).toBeUndefined()
	})

	it('is total on empty/short input', () => {
		expect(detectMIME(new Uint8Array(0))).toBeUndefined()
		expect(detectMIME(Uint8Array.from([0x89]))).toBeUndefined()
	})
})

describe('matchesBytes', () => {
	it('matches a complete signature at zero or an explicit offset', () => {
		const bytes = Uint8Array.from([1, 2, 3, 4, 5])
		expect(matchesBytes(bytes, [1, 2, 3])).toBe(true)
		expect(matchesBytes(bytes, [3, 4], 2)).toBe(true)
	})

	it('rejects mismatches and truncated signatures', () => {
		expect(matchesBytes(Uint8Array.from([1, 2]), [1, 3])).toBe(false)
		expect(matchesBytes(Uint8Array.from([1, 2]), [1, 2, 3])).toBe(false)
	})
})

describe('compressNodeBytes', () => {
	it('compresses bytes with both guaranteed zlib codings', async () => {
		const bytes = new TextEncoder().encode('compress me'.repeat(100))
		const gzip = await compressNodeBytes(bytes, 'gzip')
		const deflate = await compressNodeBytes(bytes, 'deflate')
		expect(gunzipSync(gzip).toString()).toBe('compress me'.repeat(100))
		expect(inflateSync(deflate).toString()).toBe('compress me'.repeat(100))
	})
})

// ── computeFileETag ──────────────────────────────────────────────────────────

describe('computeFileETag', () => {
	it('formats a weak entity-tag from size + floored mtime', () => {
		expect(computeFileETag(1024, 1_700_000_000_123.4)).toBe('W/"1024-1700000000123"')
	})

	it('formats deterministically for the same inputs', () => {
		expect(computeFileETag(0, 0)).toBe('W/"0-0"')
	})
})

// ── extractMultipartBoundary — totality ─────────────────────────────────────

describe('extractMultipartBoundary', () => {
	it('extracts a boundary from a well-formed content-type', () => {
		expect(extractMultipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
	})

	it('extracts a quoted boundary', () => {
		expect(extractMultipartBoundary('multipart/form-data; boundary="abc 123"')).toBe('abc 123')
	})

	it('returns undefined for a non-multipart content type', () => {
		expect(extractMultipartBoundary('application/json')).toBeUndefined()
	})

	it('returns undefined for null, missing boundary, or empty boundary', () => {
		expect(extractMultipartBoundary(null)).toBeUndefined()
		expect(extractMultipartBoundary('multipart/form-data')).toBeUndefined()
		expect(extractMultipartBoundary('multipart/form-data; boundary=')).toBeUndefined()
	})
})

// ── streamFile — pull-driven backpressure ───────────────────────────────────

describe('streamFile', () => {
	it('streams the full file contents byte-for-byte', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			const expected = Buffer.alloc(50_000, 0x5a)
			await writeFile(filePath, expected)
			const reader = streamFile(filePath).getReader()
			const chunks: Uint8Array[] = []
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
			}
			expect(Buffer.concat(chunks)).toEqual(expected)
		} finally {
			directory.destroy()
		}
	})

	it('is PULL-driven — reads exactly one chunk per reader.read(), not the whole file up front', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(100_000, 0x41))
			const reader = streamFile(filePath).getReader()
			const first = await reader.read()
			expect(first.done).toBe(false)
			// A single pull() call yields far fewer bytes than the whole file —
			// proving the source is not drained into the queue up front.
			expect(first.value?.byteLength).toBeLessThan(100_000)
			await reader.cancel()
		} finally {
			directory.destroy()
		}
	})

	it('respects an inclusive byte range', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.from('0123456789'))
			const reader = streamFile(filePath, { start: 2, end: 5 }).getReader()
			const chunks: Uint8Array[] = []
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
			}
			expect(Buffer.concat(chunks).toString('utf8')).toBe('2345')
		} finally {
			directory.destroy()
		}
	})

	it('a mid-stream read failure errors the ReadableStream WITHOUT crashing the process', async () => {
		const reader = streamFile('/no/such/directory/at/all/missing.bin').getReader()
		await expect(reader.read()).rejects.toBeDefined()
	})

	it('cancelling the stream releases the underlying file descriptor', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const reader = streamFile(filePath).getReader()
			await reader.read()
			expect(countActiveFileRequests()).toBeGreaterThan(0)
			await reader.cancel()
			await waitForCondition(
				'the cancelled file stream releases every active file request',
				() => countActiveFileRequests() === 0,
			)
			expect(countActiveFileRequests()).toBe(0)
		} finally {
			directory.destroy()
		}
	})

	it('streams the full file contents byte-for-byte from an open FileHandle', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			const expected = Buffer.alloc(50_000, 0x5a)
			await writeFile(filePath, expected)
			const handle = await open(filePath, 'r')
			const reader = streamFile(handle).getReader()
			const chunks: Uint8Array[] = []
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
			}
			expect(Buffer.concat(chunks)).toEqual(expected)
		} finally {
			directory.destroy()
		}
	})

	it('a fully-consumed FileHandle stream closes the handle (autoClose) — no lingering fd', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const handle = await open(filePath, 'r')
			const reader = streamFile(handle).getReader()
			for (;;) {
				const { done } = await reader.read()
				if (done) break
			}
			await waitForCondition('the fully consumed FileHandle stream closes its descriptor', () =>
				detectClosedHandle(handle),
			)
			expect(await detectClosedHandle(handle)).toBe(true)
		} finally {
			directory.destroy()
		}
	})

	it('cancelling a FileHandle stream mid-read closes the handle (autoClose) — no lingering fd', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const handle = await open(filePath, 'r')
			const reader = streamFile(handle).getReader()
			await reader.read()
			await reader.cancel()
			await waitForCondition('the cancelled FileHandle stream closes its descriptor', () =>
				detectClosedHandle(handle),
			)
			expect(await detectClosedHandle(handle)).toBe(true)
		} finally {
			directory.destroy()
		}
	})
})

// ── moveUploadedFile — the rename path and its cross-device fallback ────────

describe('moveUploadedFile', () => {
	it('moves a staged file to its final destination through rename', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const stagedPath = join(directory.path, randomUUID())
			await writeFile(stagedPath, Buffer.from(PNG_MAGIC))
			const staged = createUploadedFile({
				field: 'avatar',
				name: 'a.png',
				size: PNG_MAGIC.byteLength,
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: stagedPath,
			})
			const destination = join(directory.path, 'final.png')
			const moved = await moveUploadedFile(staged, destination)
			expect(moved.status).toBe('moved')
			expect(moved.path).toBe(destination)
			await expect(readFile(destination)).resolves.toBeDefined()
		} finally {
			directory.destroy()
		}
	})

	it('rethrows a non-EXDEV rename error (for example a missing destination directory)', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const stagedPath = join(directory.path, randomUUID())
			await writeFile(stagedPath, Buffer.from(PNG_MAGIC))
			const staged = createUploadedFile({
				field: 'avatar',
				name: 'a.png',
				size: PNG_MAGIC.byteLength,
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: stagedPath,
			})
			const destination = join(directory.path, 'no', 'such', 'dir', 'final.png')
			await expect(moveUploadedFile(staged, destination)).rejects.toBeDefined()
		} finally {
			directory.destroy()
		}
	})

	// The `EXDEV` fallback needs a destination on another filesystem device.
	// `resolveSecondDevicePath` reads the running host for one, so this case is
	// registered wherever a second device exists and reports itself
	// inapplicable where the host mounts only one.
	it.runIf(secondDevice !== undefined)(
		'copies and unlinks across a device boundary when rename reports EXDEV',
		async () => {
			if (secondDevice === undefined) return
			const source = createScratch({ prefix: 'middleware-exdev-source-' })
			const target = createScratch({ parent: secondDevice, prefix: 'middleware-exdev-target-' })
			try {
				const stagedPath = join(source.path, randomUUID())
				await writeFile(stagedPath, Buffer.from(PNG_MAGIC))
				const staged = createUploadedFile({
					field: 'avatar',
					name: 'a.png',
					size: PNG_MAGIC.byteLength,
					mime: 'image/png',
					validated: true,
					status: 'staged',
					path: stagedPath,
				})
				const destination = join(target.path, 'final.png')
				const moved = await moveUploadedFile(staged, destination)
				expect(moved.status).toBe('moved')
				expect(moved.path).toBe(destination)
				expect(await readFile(destination)).toEqual(Buffer.from(PNG_MAGIC))
				// The fallback unlinks the source after copying it, so the staged
				// path is gone rather than duplicated.
				await expect(readFile(stagedPath)).rejects.toBeDefined()
			} finally {
				target.destroy()
				source.destroy()
			}
		},
	)
})

// ── unlinkStagedFiles ────────────────────────────────────────────────────────

describe('unlinkStagedFiles', () => {
	it('unlinks every still-staged file across multiple fields', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const pathA = join(directory.path, randomUUID())
			const pathB = join(directory.path, randomUUID())
			await writeFile(pathA, 'a')
			await writeFile(pathB, 'b')
			const body = {
				files: Object.freeze({
					a: Object.freeze([
						createUploadedFile({
							field: 'a',
							name: 'a.txt',
							size: 1,
							mime: 'text/plain',
							validated: true,
							status: 'staged',
							path: pathA,
						}),
					]),
					b: Object.freeze([
						createUploadedFile({
							field: 'b',
							name: 'b.txt',
							size: 1,
							mime: 'text/plain',
							validated: true,
							status: 'staged',
							path: pathB,
						}),
					]),
				}),
				fields: Object.freeze({}),
			}
			await unlinkStagedFiles(body)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('skips a file whose status is "moved"', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const path = join(directory.path, randomUUID())
			await writeFile(path, 'a')
			const body = {
				files: Object.freeze({
					a: Object.freeze([
						createUploadedFile({
							field: 'a',
							name: 'a.txt',
							size: 1,
							mime: 'text/plain',
							validated: true,
							status: 'moved',
							path,
						}),
					]),
				}),
				fields: Object.freeze({}),
			}
			await unlinkStagedFiles(body)
			expect(directory.names()).toHaveLength(1)
		} finally {
			directory.destroy()
		}
	})

	it('swallows an already-missing staged path without throwing', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const path = join(directory.path, randomUUID())
			const body = {
				files: Object.freeze({
					a: Object.freeze([
						createUploadedFile({
							field: 'a',
							name: 'a.txt',
							size: 1,
							mime: 'text/plain',
							validated: true,
							status: 'staged',
							path,
						}),
					]),
				}),
				fields: Object.freeze({}),
			}
			await expect(unlinkStagedFiles(body)).resolves.toBeUndefined()
		} finally {
			directory.destroy()
		}
	})
})

// ── readUploadedFile / streamUploadedFile ───────────────────────────────────

describe('readUploadedFile / streamUploadedFile', () => {
	it('readUploadedFile round-trips the staged bytes', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const path = join(directory.path, randomUUID())
			const expected = Buffer.from('hello uploaded file contents')
			await writeFile(path, expected)
			const record = createUploadedFile({
				field: 'avatar',
				name: 'a.txt',
				size: expected.byteLength,
				mime: 'text/plain',
				validated: true,
				status: 'staged',
				path,
			})
			await expect(readUploadedFile(record)).resolves.toEqual(expected)
		} finally {
			directory.destroy()
		}
	})

	it('streamUploadedFile streams the same bytes as the on-disk file', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const path = join(directory.path, randomUUID())
			const expected = Buffer.from('streamed uploaded file contents')
			await writeFile(path, expected)
			const record = createUploadedFile({
				field: 'avatar',
				name: 'a.txt',
				size: expected.byteLength,
				mime: 'text/plain',
				validated: true,
				status: 'staged',
				path,
			})
			const reader = streamUploadedFile(record).getReader()
			const chunks: Uint8Array[] = []
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
			}
			expect(Buffer.concat(chunks)).toEqual(expected)
		} finally {
			directory.destroy()
		}
	})
})

// ── parsePartHeaders — direct unit coverage ─────────────────────────────────

describe('parsePartHeaders', () => {
	it('parses name only', () => {
		expect(parsePartHeaders('Content-Disposition: form-data; name="title"')).toEqual({
			name: 'title',
			filename: undefined,
			mime: undefined,
		})
	})

	it('parses name + filename + content-type across header lines', () => {
		const block = [
			'Content-Disposition: form-data; name="avatar"; filename="a.png"',
			'Content-Type: image/png',
		].join('\r\n')
		expect(parsePartHeaders(block)).toEqual({
			name: 'avatar',
			filename: 'a.png',
			mime: 'image/png',
		})
	})

	it('parses a quoted filename containing spaces', () => {
		const block = 'Content-Disposition: form-data; name="avatar"; filename="my file.png"'
		expect(parsePartHeaders(block).filename).toBe('my file.png')
	})

	it('stops a filename capture at the first quote, even an escaped one (no backslash-unescaping)', () => {
		// The current grammar is `filename="([^"]*)"` — a literal backslash
		// before a quote does not escape it, so the match ends at that quote.
		const block = String.raw`Content-Disposition: form-data; name="avatar"; filename="fi\"le.png"`
		expect(parsePartHeaders(block).filename).toBe('fi\\')
	})

	it('a folded (whitespace-led) continuation line is ignored, not appended to the prior value', () => {
		// Lines are split on \r\n and matched independently; a continuation
		// line with no `:` has no key and is skipped entirely (no folding
		// support), so the header value is exactly what its own line carried.
		const block = ['Content-Disposition: form-data; name="title"', ' continued-fold-text'].join(
			'\r\n',
		)
		expect(parsePartHeaders(block).name).toBe('title')
	})

	it('is total on a block with no recognized headers', () => {
		expect(parsePartHeaders('X-Custom: whatever')).toEqual({
			name: undefined,
			filename: undefined,
			mime: undefined,
		})
	})
})

// ── lookupContentType — direct unit coverage ────────────────────────────────

describe('lookupContentType', () => {
	it('maps a known extension', () => {
		expect(lookupContentType('/a/b.css')).toBe('text/css; charset=utf-8')
		expect(lookupContentType('/a/b.png')).toBe('image/png')
	})

	it('is case-insensitive on the extension', () => {
		expect(lookupContentType('/a/B.CSS')).toBe('text/css; charset=utf-8')
	})

	it('falls back to the default content type for an unknown/missing extension', () => {
		expect(lookupContentType('/a/b.unknownext')).toBe('application/octet-stream')
		expect(lookupContentType('/a/b')).toBe('application/octet-stream')
	})
})

// ── isMultipartError — brand narrowing ───────────────────────────────────────

describe('isMultipartError', () => {
	it('rejects a branded plain object built without the error class', () => {
		const brand = Symbol.for('@orkestrel/middleware.MultipartError')
		const value = { [brand]: true, status: 413, code: 'limit' }
		expect(isMultipartError(value)).toBe(false)
	})

	it('rejects a plain Error (no brand)', () => {
		expect(isMultipartError(new Error('boom'))).toBe(false)
	})

	it('rejects a branded object with an invalid code', () => {
		const brand = Symbol.for('@orkestrel/middleware.MultipartError')
		expect(isMultipartError({ [brand]: true, status: 400, code: 'nope' })).toBe(false)
	})

	it('is total on non-object input', () => {
		expect(isMultipartError(null)).toBe(false)
		expect(isMultipartError('nope')).toBe(false)
		expect(isMultipartError(42)).toBe(false)
	})
})

// ── resolveMultipartLimits — the documented default matrix ──────────────────

describe('resolveMultipartLimits', () => {
	it('fills every leaf from the documented defaults when no limits are given', () => {
		expect(resolveMultipartLimits(undefined)).toEqual({
			file: { size: DEFAULT_MULTIPART_FILE_SIZE, count: DEFAULT_MULTIPART_FILE_COUNT },
			field: { size: DEFAULT_MULTIPART_FIELD_SIZE, count: DEFAULT_MULTIPART_FIELD_COUNT },
			total: DEFAULT_MULTIPART_TOTAL,
		})
	})

	it('keeps a stated leaf and defaults its sibling inside the same group', () => {
		const limits = resolveMultipartLimits({ file: { size: 1_048_576 } })
		expect(limits.file).toEqual({ size: 1_048_576, count: DEFAULT_MULTIPART_FILE_COUNT })
		expect(limits.field).toEqual({
			size: DEFAULT_MULTIPART_FIELD_SIZE,
			count: DEFAULT_MULTIPART_FIELD_COUNT,
		})
	})

	it('keeps every stated leaf across both groups and the total', () => {
		expect(
			resolveMultipartLimits({
				file: { size: 1, count: 2 },
				field: { size: 3, count: 4 },
				total: 5,
			}),
		).toEqual({ file: { size: 1, count: 2 }, field: { size: 3, count: 4 }, total: 5 })
	})
})

describe('token extraction', () => {
	it('extracts bearer schemes without trimming or changing token case', () => {
		expect(extractBearerToken('bEaReR A b', 'Bearer')).toBe('A b')
		expect(extractBearerToken('Bearer ', 'Bearer')).toBe('')
		expect(extractBearerToken('BearerX value', 'Bearer')).toBeUndefined()
		expect(extractBearerToken('raw', '')).toBe('raw')
	})

	it('extracts only string fields from parsed records', () => {
		expect(extractFieldToken({ csrf: 'token' }, 'csrf')).toBe('token')
		expect(extractFieldToken({ csrf: '' }, 'csrf')).toBe('')
		expect(extractFieldToken({ csrf: 1 }, 'csrf')).toBeUndefined()
		expect(extractFieldToken({}, 'csrf')).toBeUndefined()
		expect(extractFieldToken(null, 'csrf')).toBeUndefined()
	})
})

describe('resolveKey', () => {
	it('prefers a bearer token over client and connection facts', () => {
		expect(
			resolveKey({
				token: 'abc',
				client: { ip: '203.0.113.7' },
				connection: { ip: '10.0.0.1', encrypted: false },
			}),
		).toBe('token:abc')
	})

	it('falls back to client IP when no token is present', () => {
		expect(
			resolveKey({
				client: { ip: '203.0.113.7' },
				connection: { ip: '10.0.0.1', encrypted: false },
			}),
		).toBe('ip:203.0.113.7')
	})

	it('falls back to connection IP when neither token nor client is present', () => {
		expect(resolveKey({ connection: { ip: '10.0.0.1', encrypted: false } })).toBe('ip:10.0.0.1')
	})

	it('resolves the literal ip:unknown when no identity fact is present', () => {
		expect(resolveKey({})).toBe('ip:unknown')
	})

	it('collapses an IPv6 client IP to its /64 network through computeClientKey', () => {
		expect(resolveKey({ client: { ip: '2001:db8::1' } })).toBe('ip:2001:db8:0:0::/64')
	})

	it('keys a string credential as token:<value>', () => {
		expect(resolveKey({ token: 'user-1' })).toBe('token:user-1')
	})

	it('falls an object credential through to the client address', () => {
		expect(
			resolveKey({
				token: { subject: 'user-1' },
				client: { ip: '203.0.113.7' },
				connection: { ip: '10.0.0.1', encrypted: false },
			}),
		).toBe('ip:203.0.113.7')
	})

	it('falls an object credential with no address through to ip:unknown', () => {
		expect(resolveKey({ token: { subject: 'user-1' } })).toBe('ip:unknown')
	})
})

describe('renderChallenge', () => {
	it('renders the scheme alone when no parameter is given', () => {
		expect(renderChallenge('Bearer')).toBe('Bearer')
		expect(renderChallenge('Bearer', {})).toBe('Bearer')
	})

	it('renders one parameter as a quoted auth-param', () => {
		expect(renderChallenge('Bearer', { realm: 'taverna' })).toBe('Bearer realm="taverna"')
	})

	it('renders several parameters in the record key order', () => {
		expect(renderChallenge('Bearer', { scope: 'read write', realm: 'taverna' })).toBe(
			'Bearer scope="read write", realm="taverna"',
		)
	})

	it('renders resource_metadata with an https: URL', () => {
		expect(
			renderChallenge('Bearer', {
				resource_metadata: 'https://api.example/.well-known/oauth-protected-resource',
			}),
		).toBe('Bearer resource_metadata="https://api.example/.well-known/oauth-protected-resource"')
	})

	it('admits the boundary characters of the RFC 6750 § 3 value set', () => {
		expect(renderChallenge('Bearer', { realm: ' !#[]~' })).toBe('Bearer realm=" !#[]~"')
		expect(renderChallenge('Bearer', { realm: '' })).toBe('Bearer realm=""')
	})

	it('refuses a value holding a character outside the value set, naming the value', () => {
		const values = ['a"b', 'a\\b', 'a\rb', 'a\nb', 'a\tb', 'a\u0000b', 'café']
		for (const value of values) {
			expect(() => renderChallenge('Bearer', { realm: value })).toThrow(ContractError)
			expect(() => renderChallenge('Bearer', { realm: value })).toThrow(JSON.stringify(value))
		}
		expect(() => renderChallenge('Bearer', { realm: 'a\u007fb' })).toThrow(ContractError)
		expect(() => renderChallenge('Bearer', { realm: 'a\u007fb' })).toThrow('"a\\u007fb"')
	})

	it('refuses a parameter name that is not a token, naming the name', () => {
		const names = ['', 'two words', 'a=b', 'a"b', 'café']
		for (const name of names) {
			expect(() => renderChallenge('Bearer', { [name]: 'x' })).toThrow(ContractError)
			expect(() => renderChallenge('Bearer', { [name]: 'x' })).toThrow(JSON.stringify(name))
		}
	})

	it('refuses a scheme that is not a token, naming the scheme', () => {
		for (const scheme of ['', 'Bad Scheme', 'Bearer,']) {
			expect(() => renderChallenge(scheme)).toThrow(ContractError)
			expect(() => renderChallenge(scheme)).toThrow(JSON.stringify(scheme))
		}
	})

	it('refuses two parameter names that match ignoring case, naming the later one', () => {
		expect(() => renderChallenge('Bearer', { realm: 'a', Realm: 'b' })).toThrow(ContractError)
		expect(() => renderChallenge('Bearer', { realm: 'a', Realm: 'b' })).toThrow('"Realm"')
	})

	it('caps a long refused value in the message instead of echoing it whole', () => {
		const value = 'a"'.repeat(50_000)
		// The 100,000-character value previews clipped with a closing ellipsis.
		expect(() => renderChallenge('Bearer', { realm: value })).toThrow(/^(?=[^]*…)[^]{1,300}$/u)
	})
})

describe('buildRetryAfter', () => {
	it('returns whole seconds ceiling to the next second', () => {
		expect(buildRetryAfter(1_500, 1_000)).toBe('1')
		expect(buildRetryAfter(3_001, 1_000)).toBe('3')
	})

	it('floors at a minimum of 1 even when the reset has already passed', () => {
		expect(buildRetryAfter(500, 1_000)).toBe('1')
		expect(buildRetryAfter(1_000, 1_000)).toBe('1')
	})
})

describe('buildRateLimitField', () => {
	it('builds the exact draft RateLimit structured-field string', () => {
		expect(buildRateLimitField(4, 1_500, 1_000)).toBe('"default";r=4;t=1')
	})

	it('floors its seconds-to-reset at a minimum of 1', () => {
		expect(buildRateLimitField(0, 1_000, 1_000)).toBe('"default";r=0;t=1')
	})
})

describe('buildRateLimitPolicyField', () => {
	it('builds the exact draft RateLimit-Policy structured-field string', () => {
		expect(buildRateLimitPolicyField(10, 60_000)).toBe('"default";q=10;w=60')
	})

	it('ceils a fractional window to whole seconds', () => {
		expect(buildRateLimitPolicyField(5, 1_500)).toBe('"default";q=5;w=2')
	})
})

describe('matchesTrustedEntry', () => {
	it('matches an exact address', () => {
		expect(matchesTrustedEntry('203.0.113.7', '203.0.113.7')).toBe(true)
		expect(matchesTrustedEntry('203.0.113.8', '203.0.113.7')).toBe(false)
	})

	it('matches an IPv4 CIDR entry within its network', () => {
		expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/8')).toBe(true)
		expect(matchesTrustedEntry('192.168.1.1', '10.0.0.0/8')).toBe(false)
		expect(matchesTrustedEntry('10.0.0.0', '10.0.0.0/32')).toBe(true)
		expect(matchesTrustedEntry('10.0.0.1', '10.0.0.0/32')).toBe(false)
	})

	it('rejects a malformed CIDR total-safely (never throws)', () => {
		expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/99')).toBe(false)
		expect(matchesTrustedEntry('10.1.2.3', 'not-an-address/8')).toBe(false)
		expect(matchesTrustedEntry('not-an-address', '10.0.0.0/8')).toBe(false)
		expect(matchesTrustedEntry('2001:db8::1', '10.0.0.0/8')).toBe(false)
	})

	it('matches an IPv6 entry by exact string only', () => {
		expect(matchesTrustedEntry('2001:db8::1', '2001:db8::1')).toBe(true)
		expect(matchesTrustedEntry('2001:db8::2', '2001:db8::1')).toBe(false)
	})

	it('doc-pin: an IPv6 CIDR-shaped entry is never expanded — no IPv6 CIDR support', () => {
		expect(matchesTrustedEntry('2001:db8::1', '2001:db8::/32')).toBe(false)
	})
})

describe('resolveForwardedFor', () => {
	it('resolves undefined when the header is absent', () => {
		expect(resolveForwardedFor(undefined, { proxies: 1 })).toBeUndefined()
	})

	it('resolves undefined when the header is present but empty', () => {
		expect(resolveForwardedFor('', { proxies: 1 })).toBeUndefined()
		expect(resolveForwardedFor('   ', { proxies: 1 })).toBeUndefined()
	})

	it('with a proxies count, trusts exactly that many hops from the right', () => {
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1', { proxies: 1 })).toBe('203.0.113.7')
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1, 10.0.0.2', { proxies: 2 })).toBe(
			'203.0.113.7',
		)
	})

	it('with a proxies count, resolves undefined when every hop is claimed as trusted', () => {
		expect(resolveForwardedFor('10.0.0.1', { proxies: 1 })).toBeUndefined()
		expect(resolveForwardedFor('10.0.0.1', { proxies: 5 })).toBeUndefined()
	})

	it('with a trusted roster, walks right-to-left past consecutive matches', () => {
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1', { trusted: ['10.0.0.0/8'] })).toBe(
			'203.0.113.7',
		)
		expect(
			resolveForwardedFor('203.0.113.7, 10.0.0.1, 10.0.0.2', { trusted: ['10.0.0.0/8'] }),
		).toBe('203.0.113.7')
	})

	it('with a trusted roster, resolves undefined when every hop is trusted', () => {
		expect(resolveForwardedFor('10.0.0.1, 10.0.0.2', { trusted: ['10.0.0.0/8'] })).toBeUndefined()
	})

	it('with a garbage header, remains total-safe and never throws', () => {
		expect(() => resolveForwardedFor(',,,', { proxies: 1 })).not.toThrow()
		expect(resolveForwardedFor(',,,', { proxies: 1 })).toBeUndefined()
		expect(() =>
			resolveForwardedFor('not-an-ip, also-not', { trusted: ['10.0.0.0/8'] }),
		).not.toThrow()
		// The rightmost hop ('also-not') does not match the trusted roster, so the
		// whole header is untrustworthy — falls back to undefined rather than
		// returning a client-supplied hop.
		expect(resolveForwardedFor('not-an-ip, also-not', { trusted: ['10.0.0.0/8'] })).toBeUndefined()
	})

	it('with a trusted roster, an untrusted rightmost (immediate sender) hop makes the whole header untrustworthy, even when an earlier hop would match', () => {
		expect(
			resolveForwardedFor('203.0.113.7, 10.0.0.1, attacker-injected', {
				trusted: ['10.0.0.0/8'],
			}),
		).toBeUndefined()
	})
})

describe('detectEncodings', () => {
	it('returns exactly the runtime-supported subset of a known candidate list, in order', () => {
		expect(detectEncodings(['gzip', 'deflate'])).toEqual(['gzip', 'deflate'])
	})

	it('never probes identity and never throws on an empty candidate list', () => {
		expect(detectEncodings([])).toEqual([])
		expect(detectEncodings(['identity'])).toEqual([])
	})
})

describe('compressBytes', () => {
	it('compresses bytes with the selected CompressionStream coding', async () => {
		const bytes = new TextEncoder().encode('compress me'.repeat(100))
		const compressed = await compressBytes(bytes, 'gzip')
		expect(compressed.byteLength).toBeLessThan(bytes.byteLength)
		expect(await decompress(compressed, 'gzip')).toBe('compress me'.repeat(100))
	})
})

describe('isBufferingIneligible', () => {
	it('keeps the buffering decision under the matchesUnbufferableResponse name', () => {
		const response = new Response('body', { headers: { etag: '"asset"' } })
		expect(matchesUnbufferableResponse('GET', response, 'etag')).toBe(true)
		expect(matchesUnbufferableResponse('GET', response, 'content-encoding')).toBe(false)
	})

	it('is ineligible for a HEAD request', () => {
		expect(matchesUnbufferableResponse('HEAD', new Response('body'), 'content-encoding')).toBe(true)
	})

	it('is ineligible for a 204 or 304 response', () => {
		expect(
			matchesUnbufferableResponse('GET', new Response(null, { status: 204 }), 'content-encoding'),
		).toBe(true)
		expect(
			matchesUnbufferableResponse('GET', new Response(null, { status: 304 }), 'content-encoding'),
		).toBe(true)
	})

	it('is ineligible for a bodyless response', () => {
		expect(
			matchesUnbufferableResponse('GET', new Response(null, { status: 200 }), 'content-encoding'),
		).toBe(true)
	})

	it('is ineligible for a text/event-stream response', () => {
		const response = new Response('data: x\n\n', {
			headers: { 'content-type': 'text/event-stream' },
		})
		expect(matchesUnbufferableResponse('GET', response, 'content-encoding')).toBe(true)
	})

	it('is ineligible when the skip header is already present', () => {
		const response = new Response('body', { headers: { 'content-encoding': 'gzip' } })
		expect(matchesUnbufferableResponse('GET', response, 'content-encoding')).toBe(true)
	})

	it('is eligible for a plain buffered GET response', () => {
		const response = new Response('body', {
			status: 200,
			headers: { 'content-type': 'text/plain' },
		})
		expect(matchesUnbufferableResponse('GET', response, 'content-encoding')).toBe(false)
	})
})

describe('isCompressionNegotiated', () => {
	it('is true for an actionable non-identity coding', () => {
		expect(isCompressionNegotiated('gzip')).toBe(true)
	})

	it('is false for identity and for undefined', () => {
		expect(isCompressionNegotiated('identity')).toBe(false)
		expect(isCompressionNegotiated(undefined)).toBe(false)
	})
})

describe('transferSessionState', () => {
	it('copies every entry from one session state into another', () => {
		const from = new Session('a')
		from.set('userId', 'u_1')
		from.set('role', 'admin')
		const to = new Session('b')
		transferSessionState(from, to)
		expect(to.state.get('userId')).toBe('u_1')
		expect(to.state.get('role')).toBe('admin')
		expect(to.state.size).toBe(2)
	})

	it('leaves the source untouched and overwrites an overlapping destination key', () => {
		const from = buildSession('a', 'new')
		const to = buildSession('b', 'old')
		to.set('extra', 1)
		transferSessionState(from, to)
		expect(to.state.get('mark')).toBe('new')
		expect(to.state.get('extra')).toBe(1)
		expect(from.state.get('mark')).toBe('new')
		expect(from.state.size).toBe(1)
	})
})

describe('isPreflight', () => {
	it('is true for an OPTIONS request carrying Access-Control-Request-Method', () => {
		expect(isPreflight('OPTIONS', new Headers({ 'access-control-request-method': 'POST' }))).toBe(
			true,
		)
	})

	it('is false for a plain OPTIONS request or a non-OPTIONS method', () => {
		expect(isPreflight('OPTIONS', new Headers())).toBe(false)
		expect(isPreflight('GET', new Headers({ 'access-control-request-method': 'POST' }))).toBe(false)
	})
})

describe('equalsConstantTime', () => {
	it('is true for equal strings', () => {
		expect(equalsConstantTime('abc123', 'abc123')).toBe(true)
	})

	it('is false for different strings of the same length', () => {
		expect(equalsConstantTime('abc123', 'abc124')).toBe(false)
		expect(equalsConstantTime('aaaaaa', 'zzzzzz')).toBe(false)
	})

	it('is false for different-length strings', () => {
		expect(equalsConstantTime('abc', 'abcd')).toBe(false)
		expect(equalsConstantTime('', 'a')).toBe(false)
	})

	it('treats two empty strings as equal', () => {
		expect(equalsConstantTime('', '')).toBe(true)
	})
})

describe('buildClient', () => {
	it('wraps a resolved IP into a Client slice', () => {
		expect(buildClient('203.0.113.7')).toEqual({ ip: '203.0.113.7' })
	})

	it('wraps an undefined IP the same way', () => {
		expect(buildClient(undefined)).toEqual({})
	})
})

describe('rebuildResponse', () => {
	it('preserves status and statusText and copies the original headers', () => {
		const original = new Response('old', {
			status: 201,
			statusText: 'Created',
			headers: { 'content-type': 'text/plain', 'x-custom': 'yes' },
		})
		const rebuilt = rebuildResponse('new body', original)
		expect(rebuilt.status).toBe(201)
		expect(rebuilt.statusText).toBe('Created')
		expect(rebuilt.headers.get('content-type')).toBe('text/plain')
		expect(rebuilt.headers.get('x-custom')).toBe('yes')
	})

	it('overrides the body with the replacement', async () => {
		const original = new Response('old')
		const rebuilt = rebuildResponse('new body', original)
		expect(await rebuilt.text()).toBe('new body')
	})

	it('applies explicit replacement headers instead of copying the original', () => {
		const original = new Response('old', { headers: { 'x-original': 'yes' } })
		const headers = new Headers({ 'x-replacement': 'yes' })
		const rebuilt = rebuildResponse('new body', original, headers)
		expect(rebuilt.headers.get('x-replacement')).toBe('yes')
		expect(rebuilt.headers.has('x-original')).toBe(false)
	})

	it('accepts a null body', async () => {
		const original = new Response(null, { status: 304 })
		const rebuilt = rebuildResponse(null, original)
		expect(rebuilt.status).toBe(304)
		expect(rebuilt.body).toBeNull()
	})
})

describe('compressResponse', () => {
	it('compresses an above-threshold compressible body and sets the coding headers', async () => {
		const body = 'x'.repeat(2_000)
		const response = new Response(body, { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.get('content-encoding')).toBe('gzip')
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
		const buffer = await result.arrayBuffer()
		expect(result.headers.get('content-length')).toBe(String(buffer.byteLength))
		expect(await decompress(new Uint8Array(buffer), 'gzip')).toBe(body)
	})

	it('passes through unchanged when the buffered body is below threshold', async () => {
		const response = new Response('short', { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100_000,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.has('content-encoding')).toBe(false)
		expect(await result.text()).toBe('short')
	})

	it('passes through an incompressible content-type unchanged', async () => {
		const response = new Response('x'.repeat(2_000), {
			headers: { 'content-type': 'image/png' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.has('content-encoding')).toBe(false)
	})

	it('passes through an already-encoded response unchanged', async () => {
		const response = new Response('x'.repeat(2_000), {
			headers: { 'content-type': 'text/plain', 'content-encoding': 'br' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result).toBe(response)
	})

	it('passes through an SSE response unchanged', async () => {
		const response = new Response('data: x\n\n', {
			headers: { 'content-type': 'text/event-stream' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 1,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result).toBe(response)
	})

	it('fast-skips without buffering when Content-Length is already below threshold', async () => {
		const body = 'short'
		const response = new Response(body, {
			headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100_000,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result).toBe(response)
	})

	it('stamps Vary: Accept-Encoding when there is no Accept-Encoding header at all', async () => {
		const response = new Response('x'.repeat(2_000), { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/')
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
	})

	it('stamps Vary: Accept-Encoding even when the body is below threshold', async () => {
		const response = new Response('short', { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100_000,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
	})

	it('stamps Vary: Accept-Encoding even for a non-compressible content type', async () => {
		const response = new Response('x'.repeat(2_000), { headers: { 'content-type': 'image/png' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
	})

	it('stamps Vary: Accept-Encoding on the actually-compressed path', async () => {
		const response = new Response('x'.repeat(2_000), { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.get('content-encoding')).toBe('gzip')
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
	})

	it('never adds Vary to a buffering-ineligible response (already content-encoded)', async () => {
		const response = new Response('x'.repeat(2_000), {
			headers: { 'content-type': 'text/plain', 'content-encoding': 'br' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(
			request,
			createTestContext(buildTestRequest('/'), {}),
			response,
			{
				threshold: 100,
				encodings: ['gzip'],
				compress: compressBytes,
			},
		)
		expect(result.headers.has('vary')).toBe(false)
	})
})

describe('sessionExpired', () => {
	it('is false when neither ttl nor lifetime is configured', () => {
		expect(sessionExpired({ seen: 0, created: 0 }, 1_000_000, {})).toBe(false)
	})

	it('is true once idle time reaches ttl (boundary >=)', () => {
		expect(sessionExpired({ seen: 0, created: 0 }, 999, { ttl: 1_000 })).toBe(false)
		expect(sessionExpired({ seen: 0, created: 0 }, 1_000, { ttl: 1_000 })).toBe(true)
	})

	it('is true once absolute lifetime reaches its threshold (boundary >=)', () => {
		expect(sessionExpired({ seen: 500, created: 0 }, 1_999, { lifetime: 2_000 })).toBe(false)
		expect(sessionExpired({ seen: 500, created: 0 }, 2_000, { lifetime: 2_000 })).toBe(true)
	})

	it('is true when either ttl or lifetime independently elapses (both configured)', () => {
		expect(sessionExpired({ seen: 0, created: 0 }, 1_000, { ttl: 1_000, lifetime: 5_000 })).toBe(
			true,
		)
		expect(
			sessionExpired({ seen: 4_000, created: 0 }, 5_000, { ttl: 2_000, lifetime: 5_000 }),
		).toBe(true)
	})

	it('is false when neither threshold has elapsed (both configured)', () => {
		expect(sessionExpired({ seen: 100, created: 0 }, 500, { ttl: 1_000, lifetime: 5_000 })).toBe(
			false,
		)
	})
})

describe('snapshotSession', () => {
	it('projects a session state into a plain record', () => {
		const session = new Session('abc')
		session.set('userId', 'u_1')
		session.set('count', 3)
		expect(snapshotSession(session)).toEqual({ id: 'abc', state: { userId: 'u_1', count: 3 } })
	})

	it('snapshots an empty session state to an empty record', () => {
		expect(snapshotSession(new Session('x'))).toEqual({ id: 'x', state: {} })
	})

	it('carries a "__proto__"-named state key without polluting Object.prototype', () => {
		const session = new Session('x')
		session.set('__proto__', 'evil')
		const snapshot = snapshotSession(session)
		expect(Object.getPrototypeOf(snapshot.state)).toBeNull()
		expect(Object.prototype.hasOwnProperty.call(snapshot.state, '__proto__')).toBe(true)
		expect(snapshot.state['__proto__']).toBe('evil')
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)
	})
})

describe('admitOptions', () => {
	const door = 'SessionLimits'

	it('returns for an absent bag, an absent threshold, or a positive finite one', () => {
		expect(admitOptions(door, SESSION_LIMITS_CONTRACT, undefined)).toBeUndefined()
		expect(admitOptions(door, SESSION_LIMITS_CONTRACT, {})).toBeUndefined()
		expect(admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: 1_000 })).toBeUndefined()
		expect(admitOptions(door, SESSION_LIMITS_CONTRACT, { lifetime: 1_000 })).toBeUndefined()
		expect(
			admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: 1_000, lifetime: 2_000 }),
		).toBeUndefined()
	})

	it('throws a ContractError for a non-finite or non-positive ttl', () => {
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: Number.NaN })).toThrow(
			ContractError,
		)
		expect(() =>
			admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: Number.POSITIVE_INFINITY }),
		).toThrow(ContractError)
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: 0 })).toThrow(ContractError)
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: -1 })).toThrow(ContractError)
	})

	it('throws a ContractError for a non-finite or non-positive lifetime', () => {
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { lifetime: Number.NaN })).toThrow(
			ContractError,
		)
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { lifetime: 0 })).toThrow(
			ContractError,
		)
		expect(() => admitOptions(door, SESSION_LIMITS_CONTRACT, { lifetime: -1 })).toThrow(
			ContractError,
		)
	})

	it('names the door and carries the first fault path and every fault as the cause', () => {
		const outcome = attempt(() =>
			admitOptions(door, SESSION_LIMITS_CONTRACT, { ttl: -1, undeclared: true }),
		)
		expect(outcome.success).toBe(false)
		if (outcome.success || !(outcome.error instanceof ContractError)) return
		expect(outcome.error.message).toContain('SessionLimits: ')
		expect(outcome.error.context?.path).toEqual(['ttl'])
		expect(outcome.error.cause).toMatchObject({
			faults: [{ path: ['ttl'] }, { path: ['undeclared'] }],
		})
	})
})

describe('admitForeign', () => {
	it('returns for a class instance and for unknown members', () => {
		class Store {
			readonly extra = 1
			get(): undefined {
				return undefined
			}
		}
		const foreign = buildForeignContract(['get'])
		expect(admitForeign('createSession', ['store'], foreign, new Store())).toBeUndefined()
		expect(admitForeign('createSession', ['store'], foreign, { get: () => 1 })).toBeUndefined()
	})

	it('throws a ContractError naming the door, the key, and the expected members', () => {
		const foreign = buildForeignContract(['get', 'set'])
		const outcome = attempt(() => admitForeign('createSession', ['store'], foreign, { get: 1 }))
		expect(outcome.success).toBe(false)
		if (outcome.success || !(outcome.error instanceof ContractError)) return
		expect(outcome.error.message).toContain('createSession: options.store must be')
		expect(outcome.error.message).toContain('get, set')
		expect(outcome.error.context?.path).toEqual(['store'])
	})
})
