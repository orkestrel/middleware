import type { MultipartPartInput } from '../../setupServer.js'
import { dirname } from 'node:path'
import { readFile, stat, unlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { waitForDelay } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import {
	isMultipartError,
	MULTIPART_MAX_HEADER_BLOCK,
	MULTIPART_MAX_PREAMBLE,
	parseMultipartRequest,
} from '@src/server'
import {
	PNG_MAGIC,
	buildCancelTrackingMultipartRequest,
	buildMultipartBody,
	buildMultipartRequest,
} from '../../setupServer.js'

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
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
			directory.destroy()
		}
	})

	it('preserves a traversal filename as metadata only, never as a path component', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
			directory.destroy()
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
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
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
			(error: unknown) => isMultipartError(error) && error.code === 'rejected',
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
			(error: unknown) => isMultipartError(error) && error.code === 'rejected',
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
			(error: unknown) => isMultipartError(error) && error.code === 'rejected',
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
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
			expect(directory.names()).toHaveLength(1)
		} finally {
			directory.destroy()
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
		const body = await parseMultipartRequest(request, { limits: { file: { count: 1 } } })
		expect(body?.files.b?.[0]?.name).toBe('b.png')
	})

	it('multiple files under one field name append into an array', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
			expect(directory.names()).toHaveLength(2)
		} finally {
			directory.destroy()
		}
	})

	it('preamble bound: a preamble larger than MULTIPART_MAX_PREAMBLE is rejected as malformed without buffering the whole payload', async () => {
		const boundary = 'preamble-bnd'
		const chunkSize = 4096
		// Deliberately far larger than the cap ever lets through, so
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
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
		)
		rejectedDuringFeed = sent < totalChunks
		// The cap is checked incrementally, per chunk — rejection happens well
		// before the source would have produced its full chunk count, proving
		// the scan is bounded rather than buffering the whole (never-arriving)
		// preamble.
		expect(rejectedDuringFeed).toBe(true)
	})

	it('rejects an oversized same-chunk preamble while accepting the exact limit', async () => {
		const boundary = 'same-chunk-preamble'
		const acceptedBody = `${'x'.repeat(MULTIPART_MAX_PREAMBLE)}--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--${boundary}--\r\n`
		const accepted = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: acceptedBody,
		})
		await expect(parseMultipartRequest(accepted)).resolves.toMatchObject({
			fields: { a: 'value' },
		})

		const rejectedBody = `${'x'.repeat(MULTIPART_MAX_PREAMBLE + 1)}--${boundary}--\r\n`
		const rejected = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: rejectedBody,
		})
		await expect(parseMultipartRequest(rejected)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
		)
	})

	it('reader cancellation: a mid-stream limit breach cancels the underlying reader', async () => {
		const { request, cancelled } = buildCancelTrackingMultipartRequest([
			{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(1000) },
		])
		await expect(
			parseMultipartRequest(request, { limits: { file: { size: 10 } } }),
		).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.code === 'limit')
		expect(cancelled.value).toBe(true)
	})

	it('a request abort mid-upload throws MultipartError and leaves the staging directory empty', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
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
					await waitForDelay(5)
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
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('wakes a pending reader on abort, rejects malformed, and cleans staged bytes', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const boundary = 'pending-abort'
			const initial = new TextEncoder().encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${'x'.repeat(256)}`,
			)
			const waiting = new AbortController()
			let pulls = 0
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(streamController) {
						pulls += 1
						if (pulls === 1) {
							streamController.enqueue(initial)
							return
						}
						waiting.abort()
						return new Promise(() => {})
					},
				},
				{ highWaterMark: 0 },
			)
			const controller = new AbortController()
			const init: RequestInit & { readonly duplex: 'half' } = {
				method: 'POST',
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
				body: stream,
				signal: controller.signal,
				duplex: 'half',
			}
			const request = new Request('http://test.local/upload', init)
			const parsing = parseMultipartRequest(request, { directory: directory.path })
			if (!waiting.signal.aborted)
				await new Promise<void>((resolve) =>
					waiting.signal.addEventListener('abort', () => resolve(), { once: true }),
				)
			expect(directory.names()).toHaveLength(1)
			controller.abort()
			await expect(parsing).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'malformed',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('trips the file-size limit mid-stream and cleans staged files', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(1000) },
			])
			await expect(
				parseMultipartRequest(request, {
					limits: { file: { size: 10 } },
					directory: directory.path,
				}),
			).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.code === 'limit')
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('accepts a file exactly AT the file-size limit', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(10) },
			])
			const body = await parseMultipartRequest(request, {
				limits: { file: { size: 10 } },
				directory: directory.path,
			})
			expect(body?.files.avatar?.[0]?.size).toBe(10)
		} finally {
			directory.destroy()
		}
	})

	it('trips the field-count limit', async () => {
		const request = buildMultipartRequest([
			{ kind: 'field', name: 'a', value: '1' },
			{ kind: 'field', name: 'b', value: '2' },
		])
		await expect(
			parseMultipartRequest(request, { limits: { field: { count: 1 } } }),
		).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.code === 'limit')
	})

	it('accepts exactly the field-count limit worth of fields', async () => {
		const request = buildMultipartRequest([
			{ kind: 'field', name: 'a', value: '1' },
			{ kind: 'field', name: 'b', value: '2' },
		])
		const body = await parseMultipartRequest(request, { limits: { field: { count: 2 } } })
		expect(body?.fields.a).toBe('1')
		expect(body?.fields.b).toBe('2')
	})

	it('trips the file-count limit', async () => {
		const request = buildMultipartRequest([
			{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
			{ kind: 'file', name: 'b', filename: 'b.txt', bytes: new TextEncoder().encode('y') },
		])
		await expect(
			parseMultipartRequest(request, { limits: { file: { count: 1 } } }),
		).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.code === 'limit')
	})

	it('accepts exactly the file-count limit worth of files', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
			])
			const body = await parseMultipartRequest(request, {
				limits: { file: { count: 1 } },
				directory: directory.path,
			})
			expect(body?.files.a?.[0]?.name).toBe('a.txt')
		} finally {
			directory.destroy()
		}
	})

	it('an empty-filename part arriving AFTER the files limit was already met does not spuriously trip the limit', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'a', filename: 'a.txt', bytes: new TextEncoder().encode('x') },
				{ kind: 'file', name: 'unused', filename: '', bytes: new Uint8Array(0) },
			])
			const body = await parseMultipartRequest(request, {
				limits: { file: { count: 1 } },
				directory: directory.path,
			})
			expect(body?.files.a?.[0]?.name).toBe('a.txt')
			expect(body?.files.unused).toBeUndefined()
			expect(directory.names()).toHaveLength(1)
		} finally {
			directory.destroy()
		}
	})

	it('trips the field-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(100) }])
		await expect(
			parseMultipartRequest(request, { limits: { field: { size: 10 } } }),
		).rejects.toSatisfy((error: unknown) => isMultipartError(error) && error.code === 'limit')
	})

	it('accepts a field exactly AT the field-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(10) }])
		const body = await parseMultipartRequest(request, { limits: { field: { size: 10 } } })
		expect(body?.fields.a).toBe('x'.repeat(10))
	})

	it('trips the total-size limit', async () => {
		const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: 'x'.repeat(1000) }])
		await expect(parseMultipartRequest(request, { limits: { total: 50 } })).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.code === 'limit',
		)
	})

	it('accepts a body exactly AT the total-size limit (the full wire byte count, including boundary framing)', async () => {
		const parts: readonly MultipartPartInput[] = [
			{ kind: 'field', name: 'a', value: 'x'.repeat(10) },
		]
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
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
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
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
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
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
		)
	})

	it('malformed matrix: oversized header block with no blank line ever arriving', async () => {
		const boundary = 'bnd3'
		const oversizedHeaderLine = `X-Custom: ${'a'.repeat(20_000)}`
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n${oversizedHeaderLine}`
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		})
		await expect(parseMultipartRequest(request)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
		)
	})

	it('rejects an oversized same-chunk header while accepting the exact limit', async () => {
		const boundary = 'same-chunk-header'
		const prefix = 'Content-Disposition: form-data; name="a"\r\nX-Custom: '
		const exactHeader = `${prefix}${'x'.repeat(MULTIPART_MAX_HEADER_BLOCK - prefix.length)}`
		const acceptedBody = `--${boundary}\r\n${exactHeader}\r\n\r\nvalue\r\n--${boundary}--\r\n`
		const accepted = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: acceptedBody,
		})
		await expect(parseMultipartRequest(accepted)).resolves.toMatchObject({
			fields: { a: 'value' },
		})

		const oversizedHeader = `${exactHeader}x`
		const rejectedBody = `--${boundary}\r\n${oversizedHeader}\r\n\r\nvalue\r\n--${boundary}--\r\n`
		const rejected = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body: rejectedBody,
		})
		await expect(parseMultipartRequest(rejected)).rejects.toSatisfy(
			(error: unknown) => isMultipartError(error) && error.code === 'malformed',
		)
	})
})

// ── Staging security — default directory + staged file permission bits ─────

describe('staging security', () => {
	it.runIf(process.platform !== 'win32')(
		'the default staging directory is created with mode 0o700',
		async () => {
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: 'avatar',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const body = await parseMultipartRequest(request)
			const path = body?.files.avatar?.[0]?.path
			expect(path).toBeDefined()
			if (path === undefined) return
			const info = await stat(dirname(path))
			expect(info.mode & 0o777).toBe(0o700)
			await unlink(path)
		},
	)

	it.runIf(process.platform !== 'win32')(
		'a staged upload file is written with mode 0o600',
		async () => {
			const directory = createScratch({ prefix: 'middleware-multipart-' })
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
				directory.destroy()
			}
		},
	)
})
