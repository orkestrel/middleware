import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { open, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { gunzipSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { waitForCondition } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import {
	computeFileETag,
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
	parsePartHeaders,
	readUploadedFile,
	resolveMultipartLimits,
	resolveStaticFallbackPath,
	resolveStaticPath,
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

// Read once at collection: the host's device layout does not change under the
// suite, and `it.runIf` needs the answer while the cases are being registered.
const secondDevice = resolveSecondDevicePath(tmpdir())

// ── resolveStaticPath — the traversal matrix ────────────────────────────────

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
	it('accepts a structurally-branded plain object built WITHOUT the class', () => {
		// Simulates the "other module face" case: a value carrying the SAME
		// well-known Symbol.for brand plus code/status, but never
		// constructed through `new MultipartError(...)` — the guard is structural,
		// not `instanceof`.
		const brand = Symbol.for('@orkestrel/middleware.MultipartError')
		const value = { [brand]: true, status: 413, code: 'limit' }
		expect(isMultipartError(value)).toBe(true)
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
