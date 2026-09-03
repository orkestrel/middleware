import type { Asset } from '@src/server'
import {
	createReadStream,
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { waitForCondition } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import {
	buildCancelTrackingMultipartRequest,
	buildChunkedStream,
	buildDirectoryIndexFixture,
	buildMultipartBody,
	buildMultipartRequest,
	buildStaticFixture,
	buildSymlinkFixture,
	countActiveFileRequests,
	createAssetSource,
	detectClosedHandle,
	JPEG_MAGIC,
	PNG_MAGIC,
	resolveSecondDevicePath,
	SECOND_DEVICE_CANDIDATES,
} from './setupServer.js'

// ── tests/setupServer.ts — the Node-only fixtures ─────────────────────────────
//
// Proves the exported behavior `tests/src/server/helpers.test.ts` and
// `tests/src/server/middlewares.test.ts` drive their scenarios with: the image
// signatures, the in-memory asset source, the real scratch trees and their
// teardown, the descriptor readings, and the multipart wire fixtures. The
// fixtures are asserted through real Node resources and through routes this
// module cannot share — a hand-transcribed multipart body, the runtime's own
// `formData` parser, `latin1` and `hex` decodings of the signature bytes, and
// `realpathSync` for escape.

describe('PNG_MAGIC and JPEG_MAGIC', () => {
	it('carry the real image signature bytes', () => {
		expect(Buffer.from(PNG_MAGIC).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
		expect(Buffer.from(JPEG_MAGIC).toString('hex')).toBe('ffd8ff')
	})
})

describe('createAssetSource', () => {
	it('reads a mapped asset, answers an absent key with the fallback, and records each request', () => {
		const page: Asset = { body: Uint8Array.from([1, 2, 3]) }
		const compressed: Asset = { body: Uint8Array.from([9]), encoding: 'br' }
		const fixture = createAssetSource(new Map([['index.html', page]]), compressed)

		expect(fixture.source.read('index.html')).toBe(page)
		expect(fixture.source.read('absent.html')).toBe(compressed)
		expect(fixture.paths).toEqual(['index.html', 'absent.html'])

		const bare = createAssetSource(new Map())
		expect(bare.source.read('absent.html')).toBeUndefined()
		expect(bare.paths).toEqual(['absent.html'])
	})

	it('hands out a snapshot of the requested paths rather than the live record', () => {
		const fixture = createAssetSource(new Map())
		fixture.source.read('first.html')
		const snapshot = fixture.paths
		fixture.source.read('second.html')

		expect(snapshot).toEqual(['first.html'])
		expect(fixture.paths).toEqual(['first.html', 'second.html'])
	})
})

describe('buildStaticFixture', () => {
	it('seeds a real file tree on disk and removes it on destroy', () => {
		const fixture = buildStaticFixture()
		try {
			expect(readFileSync(fixture.indexPath, 'utf8')).toContain('root index')
			expect(readFileSync(fixture.nestedPath, 'utf8')).toContain('nested page')
			expect(readFileSync(fixture.dotfilePath, 'utf8')).toBe('SECRET=hidden')

			const binary = readFileSync(fixture.binaryPath)
			expect(binary.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
			expect(binary.byteLength).toBeGreaterThan(8)

			expect(statSync(fixture.largePath).size).toBe(200_000)
			expect(readFileSync(fixture.largePath).every((byte) => byte === 0x41)).toBe(true)

			expect(fixture.reservedLikePath.endsWith('nullable.css')).toBe(true)
			expect(existsSync(fixture.reservedLikePath)).toBe(true)
			expect(fixture.reservedPath.endsWith('NUL.json')).toBe(true)
			// Windows reserves the NUL device name, so no host but a POSIX one can
			// hold that file: the fixture names the path on every host and seeds it
			// only where a write reaches disk.
			expect(existsSync(fixture.reservedPath)).toBe(process.platform !== 'win32')
		} finally {
			fixture.scratch.destroy()
		}
		expect(existsSync(fixture.scratch.path)).toBe(false)
	})
})

describe('buildSymlinkFixture', () => {
	// Creating a symlink on Windows needs the privileged `CreateSymbolicLink`
	// right, which the fixture's `link` calls cannot assume; the consuming suite
	// gates its symlink cases the same way.
	it.runIf(process.platform !== 'win32')(
		'links one path inside root and one to a target outside it, then destroys both roots',
		() => {
			const fixture = buildSymlinkFixture()
			const root = realpathSync(fixture.scratch.path)
			const escaped = realpathSync(fixture.linkToOutside)
			try {
				expect(lstatSync(fixture.linkToInside).isSymbolicLink()).toBe(true)
				expect(lstatSync(fixture.linkToOutside).isSymbolicLink()).toBe(true)
				expect(realpathSync(fixture.linkToInside)).toBe(realpathSync(fixture.insideTarget))
				expect(realpathSync(fixture.linkToInside).startsWith(root)).toBe(true)
				expect(escaped.startsWith(root)).toBe(false)
				expect(readFileSync(fixture.linkToInside, 'utf8')).toContain('inside target')
				expect(readFileSync(fixture.linkToOutside, 'utf8')).toContain('outside secret')
			} finally {
				fixture.destroy()
			}
			expect(existsSync(fixture.scratch.path)).toBe(false)
			expect(existsSync(escaped)).toBe(false)
		},
	)
})

describe('buildDirectoryIndexFixture', () => {
	// Same privileged-symlink gate as `buildSymlinkFixture`.
	it.runIf(process.platform !== 'win32')(
		'points the subdirectory index at a file outside root, then destroys both roots',
		() => {
			const fixture = buildDirectoryIndexFixture()
			const root = realpathSync(fixture.scratch.path)
			const indexPath = `${fixture.subdir}/index.html`
			const escaped = realpathSync(indexPath)
			try {
				expect(fixture.subdir.startsWith(fixture.scratch.path)).toBe(true)
				expect(lstatSync(indexPath).isSymbolicLink()).toBe(true)
				expect(escaped.startsWith(root)).toBe(false)
				expect(readFileSync(indexPath, 'utf8')).toContain('outside secret')
			} finally {
				fixture.destroy()
			}
			expect(existsSync(fixture.scratch.path)).toBe(false)
			expect(existsSync(escaped)).toBe(false)
		},
	)
})

describe('countActiveFileRequests', () => {
	it('rises while a real file read is in flight and returns to the baseline after release', async () => {
		const scratch = createScratch({ prefix: 'middleware-setup-count-' })
		try {
			const filePath = scratch.write('content.bin', 'a'.repeat(200_000))
			const baseline = countActiveFileRequests()
			const stream = createReadStream(filePath)
			await new Promise((resolve) => stream.once('data', resolve))

			expect(countActiveFileRequests()).toBeGreaterThan(baseline)
			stream.destroy()
			await waitForCondition(
				'the destroyed read stream releases every active file request',
				() => countActiveFileRequests() === baseline,
			)
			expect(countActiveFileRequests()).toBe(baseline)
		} finally {
			scratch.destroy()
		}
	})
})

describe('detectClosedHandle', () => {
	it('reports an open descriptor as live and a closed one as released', async () => {
		const scratch = createScratch({ prefix: 'middleware-setup-handle-' })
		try {
			const filePath = scratch.write('content.txt', 'handle')
			const handle = await open(filePath, 'r')
			expect(await detectClosedHandle(handle)).toBe(false)
			await handle.close()
			expect(await detectClosedHandle(handle)).toBe(true)
		} finally {
			scratch.destroy()
		}
	})
})

describe('buildMultipartBody', () => {
	it('encodes the parts as a real wire body carrying the given boundary', () => {
		const bytes = Uint8Array.from([0x01, 0x02, 0x03])
		const { body, contentType } = buildMultipartBody(
			[
				{ kind: 'field', name: 'title', value: 'hello' },
				{
					kind: 'file',
					name: 'avatar',
					filename: 'a.png',
					contentType: 'image/png',
					bytes,
				},
				{ kind: 'file', name: 'raw', filename: 'b.bin', bytes },
			],
			'fixed-boundary',
		)

		expect(contentType).toBe('multipart/form-data; boundary=fixed-boundary')
		expect(Buffer.from(body).toString('latin1')).toBe(
			'--fixed-boundary\r\n' +
				'Content-Disposition: form-data; name="title"\r\n' +
				'\r\n' +
				'hello\r\n' +
				'--fixed-boundary\r\n' +
				'Content-Disposition: form-data; name="avatar"; filename="a.png"\r\n' +
				'Content-Type: image/png\r\n' +
				'\r\n' +
				'\u0001\u0002\u0003\r\n' +
				'--fixed-boundary\r\n' +
				'Content-Disposition: form-data; name="raw"; filename="b.bin"\r\n' +
				'\r\n' +
				'\u0001\u0002\u0003\r\n' +
				'--fixed-boundary--\r\n',
		)
	})

	it('gives each body a fresh boundary when the caller names none', () => {
		const first = buildMultipartBody([{ kind: 'field', name: 'a', value: '1' }])
		const second = buildMultipartBody([{ kind: 'field', name: 'a', value: '1' }])

		expect(first.contentType.startsWith('multipart/form-data; boundary=test-boundary-')).toBe(true)
		expect(first.contentType).not.toBe(second.contentType)
	})
})

describe('buildMultipartRequest', () => {
	it('posts the encoded parts as a body the runtime multipart parser reads back', async () => {
		const request = buildMultipartRequest([
			{ kind: 'field', name: 'title', value: 'hello' },
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: PNG_MAGIC,
			},
		])

		expect(request.method).toBe('POST')
		expect(request.headers.get('content-type')).toContain('multipart/form-data; boundary=')

		const form = await request.formData()
		expect(form.get('title')).toBe('hello')
		const file = form.get('avatar')
		if (!(file instanceof File)) throw new Error('the avatar part must read back as a File')
		expect(file.name).toBe('a.png')
		expect(file.type).toBe('image/png')
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG_MAGIC)
	})
})

describe('buildCancelTrackingMultipartRequest', () => {
	it('feeds the body in chunks and reports the cancellation of a still-open stream', async () => {
		// The single 500-byte field outsizes the 16-byte chunk, so the stream is
		// still open when the reader cancels — cancelling a closed stream is a
		// specified no-op and would prove nothing.
		const { request, cancelled } = buildCancelTrackingMultipartRequest(
			[{ kind: 'field', name: 'title', value: 'x'.repeat(500) }],
			'fixed-boundary',
			16,
		)

		expect(request.method).toBe('POST')
		expect(request.headers.get('content-type')).toBe('multipart/form-data; boundary=fixed-boundary')
		expect(cancelled.value).toBe(false)

		const stream = request.body
		if (stream === null) throw new Error('the cancel-tracking request must expose a body stream')
		const reader = stream.getReader()
		const first = await reader.read()
		expect(first.done).toBe(false)
		expect(first.value?.byteLength).toBeGreaterThan(0)
		expect(first.value?.byteLength).toBeLessThanOrEqual(16)
		expect(cancelled.value).toBe(false)

		await reader.cancel()
		expect(cancelled.value).toBe(true)
	})
})

describe('buildChunkedStream', () => {
	it('delivers the payload in order, in chunks no larger than asked, then closes', async () => {
		const payload = Uint8Array.from({ length: 200 }, (_value, index) => index % 256)
		const reader = buildChunkedStream(payload, 64).getReader()
		const sizes: number[] = []
		const collected: number[] = []
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (value === undefined) throw new Error('the chunked stream enqueued no bytes')
			sizes.push(value.byteLength)
			collected.push(...value)
		}
		// Transcribed against the payload itself, never against a second call to
		// the builder, so the assertion cannot pass by agreeing with the helper.
		expect(Uint8Array.from(collected)).toEqual(payload)
		expect(sizes).toEqual([64, 64, 64, 8])
	})

	it('closes at once for an empty payload', async () => {
		const reader = buildChunkedStream(new Uint8Array(0)).getReader()
		expect(await reader.read()).toEqual({ done: true, value: undefined })
	})
})

describe('resolveSecondDevicePath', () => {
	it('never resolves a path on the reference own device, and answers only from the declared candidates', () => {
		const root = createScratch({ prefix: 'middleware-device-' })
		try {
			const device = statSync(root.path).dev
			const other = resolveSecondDevicePath(root.path)
			// Read the answer's device off the host rather than off the helper, so
			// a result on the reference device fails here whatever the helper
			// believed. On a single-device host the reading is `undefined`, which
			// is the inapplicable answer a caller gates on.
			const otherDevice = other === undefined ? undefined : statSync(other).dev
			expect(otherDevice).not.toBe(device)
			expect(other === undefined || SECOND_DEVICE_CANDIDATES.includes(other)).toBe(true)
			expect(other === undefined || statSync(other).isDirectory()).toBe(true)
			expect(other).not.toBe(root.path)
		} finally {
			root.destroy()
		}
	})

	it('reads the host temporary directory as a candidate', () => {
		expect(SECOND_DEVICE_CANDIDATES).toContain(tmpdir())
		expect(SECOND_DEVICE_CANDIDATES.every((candidate) => candidate.length > 0)).toBe(true)
	})

	it('resolves undefined for a reference the host cannot read', () => {
		const root = createScratch({ prefix: 'middleware-device-' })
		try {
			expect(resolveSecondDevicePath(join(root.path, 'no-such-directory'))).toBeUndefined()
		} finally {
			root.destroy()
		}
	})
})
