import { join, resolve as resolvePath } from 'node:path'
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isMultipartFile } from '@src/core'
import {
	computeFileETag,
	createUploadedFile,
	detectMIME,
	isDotfilePath,
	isMultipartError,
	isReservedDeviceName,
	isUnderPath,
	lookupContentType,
	moveUploadedFile,
	multipartBoundary,
	parseMultipartRequest,
	parsePartHeaders,
	readUploadedFile,
	resolveDefaultDirectory,
	resolveStaticPath,
	streamFile,
	streamUploadedFile,
	unlinkStagedFiles,
} from '@src/server'
import {
	PNG_MAGIC,
	buildCancelTrackingMultipartRequest,
	buildMultipartBody,
	buildMultipartRequest,
	buildTempDirectory,
} from '../../setupServer.js'

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

// ── computeFileETag ──────────────────────────────────────────────────────────

describe('computeFileETag', () => {
	it('formats a weak entity-tag from size + floored mtime', () => {
		expect(computeFileETag(1024, 1_700_000_000_123.4)).toBe('W/"1024-1700000000123"')
	})

	it('formats deterministically for the same inputs', () => {
		expect(computeFileETag(0, 0)).toBe('W/"0-0"')
	})
})

// ── multipartBoundary — totality ────────────────────────────────────────────

describe('multipartBoundary', () => {
	it('extracts a boundary from a well-formed content-type', () => {
		expect(multipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
	})

	it('extracts a quoted boundary', () => {
		expect(multipartBoundary('multipart/form-data; boundary="abc 123"')).toBe('abc 123')
	})

	it('returns undefined for a non-multipart content type', () => {
		expect(multipartBoundary('application/json')).toBeUndefined()
	})

	it('returns undefined for null, missing boundary, or empty boundary', () => {
		expect(multipartBoundary(null)).toBeUndefined()
		expect(multipartBoundary('multipart/form-data')).toBeUndefined()
		expect(multipartBoundary('multipart/form-data; boundary=')).toBeUndefined()
	})
})

// ── parseMultipartRequest — the streaming state machine ─────────────────────

describe('parseMultipartRequest', () => {
	it('returns undefined untouched for a non-multipart request', async () => {
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		await expect(parseMultipartRequest(request)).resolves.toBeUndefined()
	})

	it('parses fields and a genuine PNG file, staging under a random name', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'field', name: 'title', value: 'hello' },
				{
					kind: 'file',
					name: 'avatar',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('rest')]),
				},
			])
			const body = await parseMultipartRequest(request, { directory: directory.path })
			expect(body).toBeDefined()
			if (body === undefined) return
			expect(body.fields.title).toBe('hello')
			const files = body.files.avatar
			expect(files).toBeDefined()
			if (files === undefined) return
			expect(files).toHaveLength(1)
			const file = files[0]
			expect(file).toBeDefined()
			if (file === undefined) return
			expect(file.name).toBe('a.png')
			expect(file.path).not.toContain('a.png')
			const staged = await readFile(file.path)
			expect(staged.subarray(0, 8)).toEqual(Buffer.from(PNG_MAGIC))
		} finally {
			await directory.cleanup()
		}
	})

	it('preserves a traversal filename as metadata only, never as a path component', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: 'avatar',
					filename: '../../etc/passwd',
					contentType: 'text/plain',
					bytes: new TextEncoder().encode('x'),
				},
			])
			const body = await parseMultipartRequest(request, { directory: directory.path })
			expect(body).toBeDefined()
			const files = body?.files.avatar
			expect(files?.[0]?.name).toBe('../../etc/passwd')
			expect(files?.[0]?.path.includes('..')).toBe(false)
		} finally {
			await directory.cleanup()
		}
	})

	it('skips a dangerous field key (__proto__) without pollution', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: '__proto__', value: 'polluted' }])
		const body = await parseMultipartRequest(request)
		// `fields.__proto__` always reads as `Object.prototype` (the accessor
		// every plain object inherits) — the honest assertion is that
		// `__proto__` was never set as an OWN property (the actual pollution
		// vector), not that the accessor read resolves `undefined`.
		expect(Object.prototype.hasOwnProperty.call(body?.fields ?? {}, '__proto__')).toBe(false)
		const probe: Record<string, unknown> = {}
		expect(probe.polluted).toBeUndefined()
	})

	it('skips a dangerous file field-name (__proto__) without crashing, and leaves no orphaned temp file', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: '__proto__',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const body = await parseMultipartRequest(request, { directory: directory.path })
			expect(body).toBeDefined()
			expect(Object.prototype.hasOwnProperty.call(body?.files ?? {}, '__proto__')).toBe(false)
			const probe: Record<string, unknown> = {}
			expect(probe.polluted).toBeUndefined()
			expect(await readdir(directory.path)).toHaveLength(0)
		} finally {
			await directory.cleanup()
		}
	})

	it('rejects a declared-vs-sniffed mismatch under an allow-list (415)', async () => {
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: new TextEncoder().encode('<script>evil</script>'),
			},
		])
		await expect(parseMultipartRequest(request, { allowed: ['image/png'] })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'rejected',
		)
	})

	it('rejects a signature-less declared type even when listed', async () => {
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'note',
				filename: 'note.txt',
				contentType: 'text/plain',
				bytes: new TextEncoder().encode('plain text, no signature'),
			},
		])
		await expect(parseMultipartRequest(request, { allowed: ['text/plain'] })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'rejected',
		)
	})

	it('an empty allow-list rejects everything', async () => {
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: Buffer.from(PNG_MAGIC),
			},
		])
		await expect(parseMultipartRequest(request, { allowed: [] })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'rejected',
		)
	})

	it('a genuine sniff-matching, on-list file is ACCEPTED with validated:true', async () => {
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('rest of a real png')]),
			},
		])
		const body = await parseMultipartRequest(request, { allowed: ['image/png'] })
		expect(body).toBeDefined()
		const file = body?.files.avatar?.[0]
		expect(file).toBeDefined()
		expect(file?.validated).toBe(true)
		expect(file?.mime).toBe('image/png')
	})

	it('sniff-authoritative: a declared/sniffed MISMATCH is accepted when the SNIFFED type is on the allow-list, with validated:false', async () => {
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.jpg',
				contentType: 'image/jpeg',
				bytes: Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('rest of a real png')]),
			},
		])
		const body = await parseMultipartRequest(request, { allowed: ['image/png'] })
		expect(body).toBeDefined()
		const file = body?.files.avatar?.[0]
		expect(file).toBeDefined()
		expect(file?.mime).toBe('image/png')
		expect(file?.validated).toBe(false)
	})

	it('empty-filename part (unselected optional file input) is a silent no-op — not staged, not keyed, not counted', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'field', name: 'title', value: 'hello' },
				{ kind: 'file', name: 'avatar', filename: '', bytes: new Uint8Array(0) },
				{
					kind: 'file',
					name: 'other',
					filename: 'b.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const body = await parseMultipartRequest(request, { directory: directory.path })
			expect(body).toBeDefined()
			expect(body?.files.avatar).toBeUndefined()
			expect(body?.fields.title).toBe('hello')
			expect(body?.files.other?.[0]?.name).toBe('b.png')
			// Only the non-empty file part is staged on disk.
			expect(await readdir(directory.path)).toHaveLength(1)
		} finally {
			await directory.cleanup()
		}
	})

	it('empty-filename part does not count against the files limit', async () => {
		const request = buildMultipartRequest([
			{ kind: 'file', name: 'a', filename: '', bytes: new Uint8Array(0) },
			{
				kind: 'file',
				name: 'b',
				filename: 'b.png',
				contentType: 'image/png',
				bytes: Buffer.from(PNG_MAGIC),
			},
		])
		const body = await parseMultipartRequest(request, { limits: { files: 1 } })
		expect(body?.files.b?.[0]?.name).toBe('b.png')
	})

	it('multiple files under one field name append into an array', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: 'photos',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
				{
					kind: 'file',
					name: 'photos',
					filename: 'b.jpg',
					contentType: 'image/jpeg',
					bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
				},
			])
			const body = await parseMultipartRequest(request, { directory: directory.path })
			const files = body?.files.photos
			expect(files).toHaveLength(2)
			expect(files?.[0]?.name).toBe('a.png')
			expect(files?.[1]?.name).toBe('b.jpg')
			expect(await readdir(directory.path)).toHaveLength(2)
		} finally {
			await directory.cleanup()
		}
	})

	it('preamble bound: a preamble larger than MULTIPART_MAX_PREAMBLE is rejected as malformed without buffering the whole payload', async () => {
		const boundary = 'preamble-bnd'
		const chunkSize = 4096
		// Deliberately far larger than what the cap should ever let through, so
		// a passing "rejected before the source was exhausted" assertion is
		// robust rather than tightly coupled to the exact chunk arithmetic.
		const totalChunks = 100_000
		let sent = 0
		let rejectedDuringFeed = false
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (sent >= totalChunks) {
					controller.close()
					return
				}
				sent += 1
				controller.enqueue(new TextEncoder().encode('x'.repeat(chunkSize)))
			},
		})
		const init: RequestInit & { readonly duplex: 'half' } = {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: stream,
			duplex: 'half',
		}
		const request = new Request('http://test.local/x', init)
		const promise = parseMultipartRequest(request)
		await expect(promise).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'malformed',
		)
		rejectedDuringFeed = sent < totalChunks
		// The cap is checked incrementally, per chunk — rejection happens well
		// before the source would have produced its full chunk count, proving
		// the scan is bounded rather than buffering the whole (never-arriving)
		// preamble.
		expect(rejectedDuringFeed).toBe(true)
	})

	it('reader cancellation: a mid-stream limit breach cancels the underlying reader', async () => {
		const { request, cancelled } = buildCancelTrackingMultipartRequest([
			{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(1000) },
		])
		await expect(parseMultipartRequest(request, { limits: { file: 10 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'limit',
		)
		expect(cancelled.value).toBe(true)
	})

	it('a request abort mid-upload throws MultipartError and leaves the staging directory empty', async () => {
		const directory = await buildTempDirectory()
		try {
			const bigFile = new Uint8Array(4000).fill(0x41)
			const { body, contentType } = buildMultipartBody([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: bigFile },
			])
			const controller = new AbortController()
			const chunkSize = 64
			let offset = 0
			let abortedOnce = false
			const stream = new ReadableStream<Uint8Array>({
				async pull(streamController) {
					if (offset >= body.length) {
						streamController.close()
						return
					}
					await new Promise((resolve) => setTimeout(resolve, 5))
					// Fire the abort only after at least one file chunk has already
					// been staged (offset > chunkSize guarantees a prior enqueue was
					// consumed and written to disk by the multipart parser).
					if (offset > chunkSize && !abortedOnce) {
						abortedOnce = true
						controller.abort()
					}
					const chunk = body.subarray(offset, offset + chunkSize)
					offset += chunkSize
					streamController.enqueue(chunk)
				},
			})
			// `duplex: 'half'` is required by the runtime for a streamed request
			// body but is absent from this project's DOM-sourced `RequestInit`
			// type (the DOM lib wins the global merge over `undici`'s richer
			// type) — an intersection annotation states the real runtime shape
			// without an `as` cast.
			const init: RequestInit & { readonly duplex: 'half' } = {
				method: 'POST',
				headers: { 'content-type': contentType },
				body: stream,
				signal: controller.signal,
				duplex: 'half',
			}
			const request = new Request('http://test.local/upload', init)
			await expect(parseMultipartRequest(request, { directory: directory.path })).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error),
			)
			expect(await readdir(directory.path)).toHaveLength(0)
		} finally {
			await directory.cleanup()
		}
	})

	it('trips the file-size limit mid-stream and cleans staged files', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(1000) },
			])
			await expect(
				parseMultipartRequest(request, { limits: { file: 10 }, directory: directory.path }),
			).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.reason === 'limit')
			expect(await readdir(directory.path)).toHaveLength(0)
		} finally {
			await directory.cleanup()
		}
	})

	it('accepts a file exactly AT the file-size limit', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(10) },
			])
			const body = await parseMultipartRequest(request, {
				limits: { file: 10 },
				directory: directory.path,
			})
			expect(body?.files.avatar?.[0]?.size).toBe(10)
		} finally {
			await directory.cleanup()
		}
	})

	it('trips the field-count limit', async () => {
		const request = buildMultipartRequest([
			{ kind: 'field', name: 'a', value: '1' },
			{ kind: 'field', name: 'b', value: '2' },
		])
		await expect(parseMultipartRequest(request, { limits: { fields: 1 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'limit',
		)
	})

	it('accepts exactly the field-count limit worth of fields', async () => {
		const request = buildMultipartRequest([
			{ kind: 'field', name: 'a', value: '1' },
			{ kind: 'field', name: 'b', value: '2' },
		])
		const body = await parseMultipartRequest(request, { limits: { fields: 2 } })
		expect(body?.fields.a).toBe('1')
		expect(body?.fields.b).toBe('2')
	})

	it('trips the file-count limit', async () => {
		const request = buildMultipartRequest([
			{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
			{ kind: 'file', name: 'b', filename: 'b.txt', bytes: new TextEncoder().encode('y') },
		])
		await expect(parseMultipartRequest(request, { limits: { files: 1 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'limit',
		)
	})

	it('accepts exactly the file-count limit worth of files', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
			])
			const body = await parseMultipartRequest(request, {
				limits: { files: 1 },
				directory: directory.path,
			})
			expect(body?.files.a?.[0]?.name).toBe('a.txt')
		} finally {
			await directory.cleanup()
		}
	})

	it('an empty-filename part arriving AFTER the files limit was already met does not spuriously trip the limit', async () => {
		const directory = await buildTempDirectory()
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
				{ kind: 'file', name: 'unused', filename: '', bytes: new Uint8Array(0) },
			])
			const body = await parseMultipartRequest(request, {
				limits: { files: 1 },
				directory: directory.path,
			})
			expect(body?.files.a?.[0]?.name).toBe('a.txt')
			expect(body?.files.unused).toBeUndefined()
			expect(await readdir(directory.path)).toHaveLength(1)
		} finally {
			await directory.cleanup()
		}
	})

	it('trips the field-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(100) }])
		await expect(parseMultipartRequest(request, { limits: { field: 10 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'limit',
		)
	})

	it('accepts a field exactly AT the field-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(10) }])
		const body = await parseMultipartRequest(request, { limits: { field: 10 } })
		expect(body?.fields.a).toBe('x'.repeat(10))
	})

	it('trips the total-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(1000) }])
		await expect(parseMultipartRequest(request, { limits: { total: 50 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'limit',
		)
	})

	it('accepts a body exactly AT the total-size limit (the full wire byte count, including boundary framing)', async () => {
		const parts = [{ kind: 'field' as const, name: 'a', value: 'x'.repeat(10) }]
		const boundary = 'total-limit-bnd'
		const { body, contentType } = buildMultipartBody(parts, boundary)
		const request = new Request('http://test.local/upload', {
			method: 'POST',
			headers: { 'content-type': contentType },
			body: new Blob([Buffer.from(body)]),
		})
		const parsed = await parseMultipartRequest(request, { limits: { total: body.byteLength } })
		expect(parsed?.fields.a).toBe('x'.repeat(10))
	})

	it('malformed matrix: missing boundary marker', async () => {
		const boundary = `bnd-${Math.random()}`
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: 'not a real multipart body at all',
		})
		await expect(parseMultipartRequest(request)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'malformed',
		)
	})

	it('malformed matrix: nameless part', async () => {
		const boundary = 'bnd1'
		const body = `--${boundary}\r\nContent-Type: text/plain\r\n\r\nvalue\r\n--${boundary}--\r\n`
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		})
		await expect(parseMultipartRequest(request)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'malformed',
		)
	})

	it('malformed matrix: unterminated boundary (stream ends mid-part)', async () => {
		const boundary = 'bnd2'
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue-no-terminator`
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		})
		await expect(parseMultipartRequest(request)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'malformed',
		)
	})

	it('malformed matrix: oversized header block with no blank line ever arriving', async () => {
		// The 16KB header-block cap is checked only while still SEEKING the
		// terminating blank line (`\r\n\r\n`) — a request whose full body
		// (headers + terminator) arrives in one read never re-checks size once
		// the terminator is already found. To honestly trip the cap, the
		// blank line must never appear at all.
		const boundary = 'bnd3'
		const oversizedHeaderLine = `X-Custom: ${'a'.repeat(20_000)}`
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n${oversizedHeaderLine}`
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		})
		await expect(parseMultipartRequest(request)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.reason === 'malformed',
		)
	})
})

// ── streamFile — pull-driven backpressure ───────────────────────────────────

describe('streamFile', () => {
	it('streams the full file contents byte-for-byte', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('is PULL-driven — reads exactly one chunk per reader.read(), not the whole file up front', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('respects an inclusive byte range', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('a mid-stream read failure errors the ReadableStream WITHOUT crashing the process', async () => {
		const reader = streamFile('/no/such/directory/at/all/missing.bin').getReader()
		await expect(reader.read()).rejects.toBeDefined()
	})

	it('cancelling the stream releases the underlying file descriptor', async () => {
		const directory = await buildTempDirectory()
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const reader = streamFile(filePath).getReader()
			await reader.read()
			const duringOpenReads = process
				.getActiveResourcesInfo()
				.filter((resource) => resource === 'FSReqCallback').length
			expect(duringOpenReads).toBeGreaterThan(0)
			await reader.cancel()
			let afterOpenReads = duringOpenReads
			for (let attempt = 0; attempt < 20 && afterOpenReads > 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5))
				afterOpenReads = process
					.getActiveResourcesInfo()
					.filter((resource) => resource === 'FSReqCallback').length
			}
			expect(afterOpenReads).toBe(0)
		} finally {
			await directory.cleanup()
		}
	})

	it('streams the full file contents byte-for-byte from an open FileHandle', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('a fully-consumed FileHandle stream closes the handle (autoClose) — no lingering fd', async () => {
		const directory = await buildTempDirectory()
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const handle = await open(filePath, 'r')
			const reader = streamFile(handle).getReader()
			for (;;) {
				const { done } = await reader.read()
				if (done) break
			}
			// A closed FileHandle rejects any further operation with EBADF —
			// the only observable, race-free proof the fd was released
			// (FSReqCallback resource counts do not track FileHandle-backed
			// streams the way they track path-backed ones).
			await expect(handle.stat()).rejects.toSatisfy(
				(error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF',
			)
		} finally {
			await directory.cleanup()
		}
	})

	it('cancelling a FileHandle stream mid-read closes the handle (autoClose) — no lingering fd', async () => {
		const directory = await buildTempDirectory()
		try {
			const filePath = join(directory.path, 'content.bin')
			await writeFile(filePath, Buffer.alloc(200_000, 0x41))
			const handle = await open(filePath, 'r')
			const reader = streamFile(handle).getReader()
			await reader.read()
			await reader.cancel()
			let closed = false
			for (let attempt = 0; attempt < 20 && !closed; attempt += 1) {
				try {
					await handle.stat()
				} catch (error) {
					closed = error instanceof Error && 'code' in error && error.code === 'EBADF'
				}
				if (!closed) await new Promise((resolve) => setTimeout(resolve, 5))
			}
			expect(closed).toBe(true)
		} finally {
			await directory.cleanup()
		}
	})
})

// ── moveUploadedFile — EXDEV fallback (exercised as a same-temp-dir rename) ──

describe('moveUploadedFile', () => {
	it('moves a staged file to its final destination via rename', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('rethrows a non-EXDEV rename error (e.g. a missing destination directory)', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it.todo(
		'EXDEV fallback (copyFile + unlink) — requires two distinct filesystems/mount points, unavailable in this sandbox',
	)
})

// ── unlinkStagedFiles ────────────────────────────────────────────────────────

describe('unlinkStagedFiles', () => {
	it('unlinks every still-staged file across multiple fields', async () => {
		const directory = await buildTempDirectory()
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
			expect(await readdir(directory.path)).toHaveLength(0)
		} finally {
			await directory.cleanup()
		}
	})

	it('skips a file whose status is "moved"', async () => {
		const directory = await buildTempDirectory()
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
			expect(await readdir(directory.path)).toHaveLength(1)
		} finally {
			await directory.cleanup()
		}
	})

	it('swallows an already-missing staged path without throwing', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})
})

// ── readUploadedFile / streamUploadedFile ───────────────────────────────────

describe('readUploadedFile / streamUploadedFile', () => {
	it('readUploadedFile round-trips the staged bytes', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})

	it('streamUploadedFile streams the same bytes as the on-disk file', async () => {
		const directory = await buildTempDirectory()
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
			await directory.cleanup()
		}
	})
})

// ── parsePartHeaders — direct unit coverage ─────────────────────────────────

describe('parsePartHeaders', () => {
	it('parses name only', () => {
		expect(parsePartHeaders('Content-Disposition: form-data; name="title"')).toEqual({
			name: 'title',
			filename: undefined,
			contentType: undefined,
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
			contentType: 'image/png',
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
			contentType: undefined,
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

// ── isMultipartFile (@src/core) — direct unit coverage ──────────────────────

describe('isMultipartFile', () => {
	it('accepts a well-shaped record', () => {
		expect(
			isMultipartFile({
				field: 'avatar',
				name: 'a.png',
				size: 10,
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: '/tmp/x',
			}),
		).toBe(true)
	})

	it('rejects a record missing/mistyping a required field', () => {
		expect(isMultipartFile({ field: 'avatar', name: 'a.png' })).toBe(false)
		expect(
			isMultipartFile({
				field: 'avatar',
				name: 'a.png',
				size: 'not-a-number',
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: '/tmp/x',
			}),
		).toBe(false)
	})

	it('is total on non-record input', () => {
		expect(isMultipartFile(null)).toBe(false)
		expect(isMultipartFile('nope')).toBe(false)
		expect(isMultipartFile(undefined)).toBe(false)
	})
})

// ── isMultipartError — brand narrowing ───────────────────────────────────────

describe('isMultipartError', () => {
	it('accepts a structurally-branded plain object built WITHOUT the class', () => {
		// Simulates the "other module face" case: a value carrying the SAME
		// well-known Symbol.for brand plus reason/status, but never
		// constructed via `new MultipartError(...)` — the guard is structural,
		// not `instanceof`.
		const brand = Symbol.for('@orkestrel/middleware.MultipartError')
		const value = { [brand]: true, status: 413, reason: 'limit' }
		expect(isMultipartError(value)).toBe(true)
	})

	it('rejects a plain Error (no brand)', () => {
		expect(isMultipartError(new Error('boom'))).toBe(false)
	})

	it('rejects a branded object with an invalid reason', () => {
		const brand = Symbol.for('@orkestrel/middleware.MultipartError')
		expect(isMultipartError({ [brand]: true, status: 400, reason: 'nope' })).toBe(false)
	})

	it('is total on non-object input', () => {
		expect(isMultipartError(null)).toBe(false)
		expect(isMultipartError('nope')).toBe(false)
		expect(isMultipartError(42)).toBe(false)
	})
})

// ── Staging security — default directory + staged file permission bits ─────

describe('staging security', () => {
	it.runIf(process.platform !== 'win32')(
		'the default staging directory is created with mode 0o700',
		async () => {
			const directory = await resolveDefaultDirectory()
			const info = await stat(directory)
			expect(info.mode & 0o777).toBe(0o700)
		},
	)

	it.runIf(process.platform !== 'win32')(
		'a staged upload file is written with mode 0o600',
		async () => {
			const directory = await buildTempDirectory()
			try {
				const request = buildMultipartRequest([
					{
						kind: 'file',
						name: 'avatar',
						filename: 'a.png',
						contentType: 'image/png',
						bytes: Buffer.from(PNG_MAGIC),
					},
				])
				const body = await parseMultipartRequest(request, { directory: directory.path })
				const path = body?.files.avatar?.[0]?.path
				expect(path).toBeDefined()
				if (path === undefined) return
				const info = await stat(path)
				expect(info.mode & 0o777).toBe(0o600)
			} finally {
				await directory.cleanup()
			}
		},
	)
})
