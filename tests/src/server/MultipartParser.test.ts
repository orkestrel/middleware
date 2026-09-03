import { describe, expect, it } from 'vitest'
import { createScratch } from '@orkestrel/test/server'
import {
	isMultipartError,
	MULTIPART_MAX_HEADER_BLOCK,
	MULTIPART_MAX_PREAMBLE,
	resolveMultipartLimits,
} from '@src/server'
import { MultipartParser } from '../../../src/server/MultipartParser.js'
import { buildChunkedStream, buildMultipartBody } from '../../setupServer.js'

// ============================================================================
//  @orkestrel/middleware — MultipartParser unit tests. The class is interned
//  rather than barrelled, so it is imported relatively and driven directly:
//  every case constructs the state machine over a real chunked stream and
//  reads both the refusal it raises and the staging directory it leaves.
// ============================================================================

describe('MultipartParser preamble cap', () => {
	it('refuses a preamble larger than MULTIPART_MAX_PREAMBLE as malformed', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const boundary = 'parser-preamble'
			const payload = new TextEncoder().encode(
				`${'x'.repeat(MULTIPART_MAX_PREAMBLE + 1)}--${boundary}--\r\n`,
			)
			const parser = new MultipartParser(
				buildChunkedStream(payload, 4096),
				new AbortController().signal,
				boundary,
				resolveMultipartLimits(undefined),
				undefined,
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'malformed',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('accepts a preamble exactly at the cap', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const boundary = 'parser-preamble-exact'
			const payload = new TextEncoder().encode(
				`${'x'.repeat(MULTIPART_MAX_PREAMBLE)}--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--${boundary}--\r\n`,
			)
			const parser = new MultipartParser(
				buildChunkedStream(payload, 4096),
				new AbortController().signal,
				boundary,
				resolveMultipartLimits(undefined),
				undefined,
				directory.path,
			)
			await expect(parser.parse()).resolves.toMatchObject({ fields: { a: 'value' } })
		} finally {
			directory.destroy()
		}
	})
})

describe('MultipartParser header-block cap', () => {
	it('refuses a part header block larger than MULTIPART_MAX_HEADER_BLOCK as malformed', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const boundary = 'parser-header'
			const oversized = `X-Custom: ${'a'.repeat(MULTIPART_MAX_HEADER_BLOCK)}`
			const payload = new TextEncoder().encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n${oversized}\r\n\r\nvalue\r\n--${boundary}--\r\n`,
			)
			const parser = new MultipartParser(
				buildChunkedStream(payload, 1024),
				new AbortController().signal,
				boundary,
				resolveMultipartLimits(undefined),
				undefined,
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'malformed',
			)
			// The refusal lands while the headers are still being read, so no
			// temp file was ever opened for the part.
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})
})

describe('MultipartParser total-bytes cap', () => {
	it('refuses a body past the total cap and unlinks the file already staged', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const { body } = buildMultipartBody(
				[
					{
						kind: 'file',
						name: 'avatar',
						filename: 'big.bin',
						bytes: new Uint8Array(2000).fill(0x41),
					},
				],
				'parser-total',
			)
			// The cap sits below the body's own length, so it trips only after
			// the header block was parsed and the part's temp file opened.
			const limits = resolveMultipartLimits({ total: body.byteLength - 256 })
			const parser = new MultipartParser(
				buildChunkedStream(body, 64),
				new AbortController().signal,
				'parser-total',
				limits,
				undefined,
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'limit',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})
})

describe('MultipartParser abort mid-upload', () => {
	it('refuses as malformed and unlinks every staged file when the request aborts mid-part', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const boundary = 'parser-abort'
			const head = new TextEncoder().encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${'x'.repeat(256)}`,
			)
			const controller = new AbortController()
			let pulls = 0
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(streamController) {
						pulls += 1
						if (pulls === 1) {
							streamController.enqueue(head)
							return
						}
						// The part is staged and the parser is waiting for more
						// bytes: abort here and never resolve, so the abort — not
						// the source ending — is what the parser answers.
						controller.abort()
						return new Promise(() => {})
					},
				},
				{ highWaterMark: 0 },
			)
			const parser = new MultipartParser(
				stream,
				controller.signal,
				boundary,
				resolveMultipartLimits(undefined),
				undefined,
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'malformed',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})
})

describe('MultipartParser staged-file cleanup', () => {
	it('unlinks the staged file when a rejected type ends the parse', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const { body } = buildMultipartBody(
				[
					{
						kind: 'file',
						name: 'avatar',
						filename: 'a.txt',
						contentType: 'text/plain',
						bytes: new TextEncoder().encode('plain text, no signature'),
					},
				],
				'parser-rejected',
			)
			const parser = new MultipartParser(
				buildChunkedStream(body, 64),
				new AbortController().signal,
				'parser-rejected',
				resolveMultipartLimits(undefined),
				['image/png'],
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'rejected',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('unlinks the staged file when the per-file size cap ends the parse', async () => {
		const directory = createScratch({ prefix: 'middleware-parser-' })
		try {
			const { body } = buildMultipartBody(
				[
					{
						kind: 'file',
						name: 'avatar',
						filename: 'big.bin',
						bytes: new Uint8Array(1000).fill(0x41),
					},
				],
				'parser-file-size',
			)
			const parser = new MultipartParser(
				buildChunkedStream(body, 64),
				new AbortController().signal,
				'parser-file-size',
				resolveMultipartLimits({ file: { size: 10 } }),
				undefined,
				directory.path,
			)
			await expect(parser.parse()).rejects.toSatisfy(
				(error: unknown) => isMultipartError(error) && error.code === 'limit',
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})
})

describe('MultipartParser default directory', () => {
	it('memoizes the process-owned staging directory across calls', async () => {
		const first = await MultipartParser.directory()
		const second = await MultipartParser.directory()
		expect(second).toBe(first)
	})
})
