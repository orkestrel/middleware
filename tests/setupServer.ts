import type { FileHandle } from 'node:fs/promises'
import type { ScratchInterface } from '@orkestrel/test/server'
import type { Asset, AssetSourceInterface } from '@src/server'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createScratch } from '@orkestrel/test/server'

// ── Server-only test harness ─────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-file / real-multipart-body / real-socket
// tests, driven against real implementations. Environment-agnostic helpers stay
// in `setup.ts`. This file REPLACES the router-template's upgrade-seam-oriented
// setup (this package has no protocol-upgrade concept) with the fixtures this
// package's node-face suites actually need.

/** A real PNG magic-byte header (8 bytes) — the shortest genuine PNG signature. */
export const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A real JPEG magic-byte header (3 bytes) — the shortest genuine JPEG signature. */
export const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff])

/**
 * The directories a second-filesystem probe reads, in the order it reads them.
 *
 * @remarks
 * `/dev/shm` is a tmpfs on a Linux host that mounts one, and the host temporary
 * directory is a separate mount on some hosts and the same mount as the
 * repository on others. Which entry answers is the host's fact, so
 * {@link resolveSecondDevicePath} reads it rather than assuming it.
 */
export const SECOND_DEVICE_CANDIDATES: readonly string[] = Object.freeze([
	'/dev/shm',
	'/run/shm',
	tmpdir(),
])

/**
 * Resolves a directory sitting on a different filesystem device from `reference`.
 *
 * @param reference - An existing path whose device the result must differ from
 * @returns The first candidate directory on another device, or `undefined` when the host exposes only one
 * @remarks Reads `statSync(...).dev` on the running host rather than branching on
 * a platform name, so a proof gated on the result runs wherever a second device
 * exists and reports itself inapplicable where it does not. An unreadable
 * `reference` resolves `undefined`, because the comparison has no baseline.
 *
 * @example
 * ```ts
 * const other = resolveSecondDevicePath(tmpdir())
 * it.runIf(other !== undefined)('crosses a device boundary', () => {})
 * ```
 */
export function resolveSecondDevicePath(reference: string): string | undefined {
	let device: number
	try {
		device = statSync(reference).dev
	} catch {
		return undefined
	}
	for (const candidate of SECOND_DEVICE_CANDIDATES) {
		try {
			const info = statSync(candidate)
			if (info.isDirectory() && info.dev !== device) return candidate
		} catch {
			// A candidate the host does not expose is not a second device.
		}
	}
	return undefined
}

/** A map-backed in-memory asset source with a readonly record of requested keys. */
export interface AssetSourceFixtureInterface {
	readonly source: AssetSourceInterface
	readonly paths: readonly string[]
}

/**
 * Build an inert in-memory asset source for `createAssets` tests.
 *
 * @param assets - The exact key-to-asset records the source exposes
 * @param fallback - Optional asset returned for every key absent from `assets`
 * @returns The source and a snapshotting record of keys passed to `read`
 */
export function createAssetSource(
	assets: ReadonlyMap<string, Asset>,
	fallback?: Asset,
): AssetSourceFixtureInterface {
	const paths: string[] = []
	return {
		get paths() {
			return [...paths]
		},
		source: {
			read(path) {
				paths.push(path)
				return assets.get(path) ?? fallback
			},
		},
	}
}

/** A scratch-backed static fixture tree — the seeded directory plus its known file paths, ready for `createStatic` tests. */
export interface StaticFixtureInterface {
	readonly scratch: ScratchInterface
	readonly indexPath: string
	readonly nestedPath: string
	readonly dotfilePath: string
	readonly binaryPath: string
	readonly largePath: string
	readonly reservedPath: string
	readonly reservedLikePath: string
}

/**
 * Build a real scratch-directory static-file fixture: nested directories, an
 * `index.html`, a dotfile, a binary file with real PNG magic bytes, a large
 * file (for Range tests), and a Windows-reserved-device-name file alongside
 * a merely reserved-LOOKING one — the seeded tree `createStatic`'s node-face
 * suite serves real files from.
 *
 * @remarks The binary and large files carry real bytes rather than text, so
 * they are written directly through `node:fs` after allocation; every text
 * file is seeded through the scratch itself.
 * @returns A {@link StaticFixtureInterface} whose `scratch.destroy()` every caller MUST invoke
 *
 * @example
 * ```ts
 * const fixture = buildStaticFixture()
 * try {
 * 	// ... drive createStatic({ root: fixture.scratch.path }) ...
 * } finally {
 * 	fixture.scratch.destroy()
 * }
 * ```
 */
export function buildStaticFixture(): StaticFixtureInterface {
	const scratch = createScratch({
		prefix: 'middleware-static-',
		files: {
			'index.html': '<!doctype html><html><body>root index</body></html>',
			'nested/deep/page.html': '<!doctype html><html><body>nested page</body></html>',
			'.env': 'SECRET=hidden',
			'nullable.css': 'body { color: red }',
			// On Windows, NUL is a reserved device name — the write would hit the null device, not disk.
			...(process.platform === 'win32' ? {} : { 'NUL.json': '{}' }),
		},
	})

	const binaryPath = join(scratch.path, 'image.png')
	writeFileSync(
		binaryPath,
		Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('rest of a fake png body')]),
	)

	const largePath = join(scratch.path, 'large.bin')
	writeFileSync(largePath, Buffer.alloc(200_000, 0x41))

	return {
		scratch,
		indexPath: join(scratch.path, 'index.html'),
		nestedPath: join(scratch.path, 'nested', 'deep', 'page.html'),
		dotfilePath: join(scratch.path, '.env'),
		binaryPath,
		largePath,
		reservedPath: join(scratch.path, 'NUL.json'),
		reservedLikePath: join(scratch.path, 'nullable.css'),
	}
}

/** A scratch-backed fixture with a symlink INSIDE root pointing IN-root, and one pointing OUTSIDE root — for `createStatic`'s symlink-escape matrix. */
export interface SymlinkFixtureInterface {
	readonly scratch: ScratchInterface
	readonly insideTarget: string
	readonly linkToInside: string
	readonly linkToOutside: string
	destroy(): void
}

/**
 * Build a real scratch-directory fixture with two symlinks: one inside the
 * scratch root pointing to another file inside it (still served normally), and
 * one inside the scratch root pointing to a file OUTSIDE it (the escape
 * `createStatic` must refuse) — POSIX-only; the platform-gated caller is
 * responsible for `it.runIf(process.platform !== 'win32')`.
 *
 * @returns A {@link SymlinkFixtureInterface} with a `destroy()` teardown every caller MUST invoke
 *
 * @example
 * ```ts
 * const fixture = buildSymlinkFixture()
 * try {
 * 	// ... drive createStatic({ root: fixture.scratch.path }) against fixture.linkToOutside ...
 * } finally {
 * 	fixture.destroy()
 * }
 * ```
 */
export function buildSymlinkFixture(): SymlinkFixtureInterface {
	const root = createScratch({ prefix: 'middleware-symlink-root-' })
	const outside = createScratch({ prefix: 'middleware-symlink-outside-' })

	root.write('inside.html', '<!doctype html><html><body>inside target</body></html>')
	outside.write('secret.html', '<!doctype html><html><body>outside secret</body></html>')

	const insideTarget = join(root.path, 'inside.html')
	const outsideTarget = join(outside.path, 'secret.html')

	root.link('link-inside.html', insideTarget)
	root.link('link-outside.html', outsideTarget)

	return {
		scratch: root,
		insideTarget,
		linkToInside: join(root.path, 'link-inside.html'),
		linkToOutside: join(root.path, 'link-outside.html'),
		destroy() {
			root.destroy()
			outside.destroy()
		},
	}
}

/** A scratch-backed fixture with a subdirectory whose `index.html` is a symlink pointing OUTSIDE root — for `createStatic`'s directory-index symlink-escape case. */
export interface DirectoryIndexFixtureInterface {
	readonly scratch: ScratchInterface
	readonly subdir: string
	destroy(): void
}

/**
 * Build a real scratch-directory fixture with a subdirectory whose
 * `index.html` is a symlink to a file OUTSIDE the scratch root — the
 * directory-index escape `createStatic` must refuse; the platform-gated caller
 * is responsible for `it.runIf(process.platform !== 'win32')`.
 *
 * @returns A {@link DirectoryIndexFixtureInterface} with a `destroy()` teardown every caller MUST invoke
 *
 * @example
 * ```ts
 * const fixture = buildDirectoryIndexFixture()
 * try {
 * 	// ... drive createStatic({ root: fixture.scratch.path }) against `${fixture.subdir}/` ...
 * } finally {
 * 	fixture.destroy()
 * }
 * ```
 */
export function buildDirectoryIndexFixture(): DirectoryIndexFixtureInterface {
	const root = createScratch({ prefix: 'middleware-dirindex-root-' })
	const outside = createScratch({ prefix: 'middleware-dirindex-outside-' })

	outside.write('secret.html', '<!doctype html><html><body>outside secret</body></html>')
	const outsideTarget = join(outside.path, 'secret.html')

	root.link('sub/index.html', outsideTarget)

	return {
		scratch: root,
		subdir: join(root.path, 'sub'),
		destroy() {
			root.destroy()
			outside.destroy()
		},
	}
}

/**
 * Counts the file-system requests the host holds open.
 *
 * @returns The number of active `FSReqCallback` resources `process.getActiveResourcesInfo()` reports
 * @remarks A path-backed `streamFile` stream holds one such resource per in-flight read, so this
 * reading is the observable proof a descriptor-release test waits on. The count comes from the
 * runtime itself rather than from an instrumented stream, and it covers the whole process, so read
 * it as a threshold a release drives to zero rather than as one stream's private tally.
 *
 * @example
 * ```ts
 * await waitForCondition('the stream releases every active file request', () => countActiveFileRequests() === 0)
 * ```
 */
export function countActiveFileRequests(): number {
	return process.getActiveResourcesInfo().filter((resource) => resource === 'FSReqCallback').length
}

/**
 * Detects whether a `FileHandle`'s descriptor is already released.
 *
 * @param handle - The handle to read
 * @returns `true` after the descriptor is released, `false` while `stat()` still succeeds
 * @throws Any error other than `EBADF`, because a retried wait over a broken reading would conceal it
 * @remarks A closed `FileHandle` rejects every further operation with `EBADF`, which is the
 * observable, race-free proof the descriptor was released: `FSReqCallback` resource counts do not
 * track `FileHandle`-backed streams the way they track path-backed ones.
 *
 * @example
 * ```ts
 * await waitForCondition('the stream closes its descriptor', () => detectClosedHandle(handle))
 * ```
 */
export async function detectClosedHandle(handle: FileHandle): Promise<boolean> {
	try {
		await handle.stat()
		return false
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EBADF') return true
		throw error
	}
}

/** A `Request` carrying a real multipart body over a single-chunk stream, with an observable `cancelled` flag. */
export interface CancelTrackingRequestInterface {
	readonly request: Request
	readonly cancelled: { value: boolean }
}

/**
 * Build a multipart `Request` whose body is a CHUNKED, pull-driven
 * `ReadableStream` that records whether it was cancelled — the observable
 * hook `parseMultipartRequest`'s reader-cancellation contract needs, held here
 * so no suite reimplements the stream. Chunked
 * (rather than one bulk `enqueue`+`close`) deliberately so the stream is
 * still OPEN — not yet naturally closed — at the moment a mid-stream limit
 * breach fires, which is what makes the parser's `reader.cancel()` call
 * observable at all (cancelling an already-closed stream is a spec no-op).
 *
 * @param parts - The ordered multipart parts to encode
 * @param boundary - An optional explicit boundary token
 * @param chunkSize - The byte size fed per pull; defaults to 64
 * @returns A {@link CancelTrackingRequestInterface} pairing the request with a live `cancelled` flag
 *
 * @example
 * ```ts
 * const { request, cancelled } = buildCancelTrackingMultipartRequest([...])
 * await expect(parseMultipartRequest(request, { limits: { file: 1 } })).rejects.toBeDefined()
 * expect(cancelled.value).toBe(true)
 * ```
 */
export function buildCancelTrackingMultipartRequest(
	parts: readonly MultipartPartInput[],
	boundary?: string,
	chunkSize = 64,
): CancelTrackingRequestInterface {
	const { body, contentType } = buildMultipartBody(parts, boundary)
	const cancelled = { value: false }
	let offset = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= body.length) {
				controller.close()
				return
			}
			const chunk = body.subarray(offset, offset + chunkSize)
			offset += chunkSize
			controller.enqueue(chunk)
		},
		cancel() {
			cancelled.value = true
		},
	})
	// `duplex: 'half'` is required by the runtime for a streamed request body
	// but is absent from this project's DOM-sourced `RequestInit` type — an
	// intersection annotation states the real runtime shape without an `as` cast.
	const init: RequestInit & { readonly duplex: 'half' } = {
		method: 'POST',
		headers: { 'content-type': contentType },
		body: stream,
		duplex: 'half',
	}
	return { request: new Request('http://test.local/upload', init), cancelled }
}

/** One part of a real `multipart/form-data` body — either a text field or a file. */
export type MultipartPartInput =
	| { readonly kind: 'field'; readonly name: string; readonly value: string }
	| {
			readonly kind: 'file'
			readonly name: string
			readonly filename: string
			readonly contentType?: string
			readonly bytes: Uint8Array
	  }

/**
 * Compose a real `multipart/form-data` request body from a list of parts —
 * a genuine wire-format payload built on the framework's own boundary grammar
 * rather than a fabricated shortcut, with a caller-controllable `boundary` so
 * malformed-boundary test cases stay explicit.
 *
 * @param parts - The ordered parts to encode
 * @param boundary - The multipart boundary token; defaults to a fresh random one
 * @returns The encoded body bytes plus the `contentType` header value carrying the boundary
 *
 * @example
 * ```ts
 * const { body, contentType } = buildMultipartBody([
 * 	{ kind: 'field', name: 'title', value: 'hello' },
 * 	{ kind: 'file', name: 'avatar', filename: 'a.png', contentType: 'image/png', bytes: PNG_MAGIC },
 * ])
 * ```
 */
export function buildMultipartBody(
	parts: readonly MultipartPartInput[],
	boundary = `test-boundary-${randomUUID()}`,
): { readonly body: Uint8Array; readonly contentType: string } {
	const chunks: Uint8Array[] = []
	const encoder = new TextEncoder()
	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`))
		if (part.kind === 'field') {
			chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`))
			chunks.push(encoder.encode(part.value))
			chunks.push(encoder.encode('\r\n'))
		} else {
			chunks.push(
				encoder.encode(
					`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
				),
			)
			if (part.contentType !== undefined)
				chunks.push(encoder.encode(`Content-Type: ${part.contentType}\r\n`))
			chunks.push(encoder.encode('\r\n'))
			chunks.push(part.bytes)
			chunks.push(encoder.encode('\r\n'))
		}
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`))
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Build a `ReadableStream` that feeds `bytes` in fixed-size chunks.
 *
 * @param bytes - The full payload the stream delivers, in order
 * @param chunkSize - The byte size fed per pull; defaults to 64
 * @returns A pull-driven `ReadableStream<Uint8Array>` that closes after the last chunk
 * @remarks Chunked deliberately: a parser's per-chunk accounting — a running
 * total, an incremental scan — only shows itself against a source that arrives
 * in pieces, and a single bulk `enqueue` hides it.
 *
 * @example
 * ```ts
 * const stream = buildChunkedStream(body, 64)
 * ```
 */
export function buildChunkedStream(bytes: Uint8Array, chunkSize = 64): ReadableStream<Uint8Array> {
	let offset = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close()
				return
			}
			const chunk = bytes.subarray(offset, offset + chunkSize)
			offset += chunkSize
			controller.enqueue(chunk)
		},
	})
}

/**
 * Build a `Request` carrying a real multipart body — composes
 * {@link buildMultipartBody} with a `POST` request the multipart battery can
 * stream-parse.
 *
 * @param parts - The ordered parts to encode
 * @param boundary - An optional explicit boundary token
 * @returns A `POST` `Request` with a real multipart body and matching `Content-Type`
 *
 * @example
 * ```ts
 * const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: '1' }])
 * ```
 */
export function buildMultipartRequest(
	parts: readonly MultipartPartInput[],
	boundary?: string,
): Request {
	const { body, contentType } = buildMultipartBody(parts, boundary)
	return new Request('http://test.local/upload', {
		method: 'POST',
		headers: { 'content-type': contentType },
		body: new Blob([Buffer.from(body)]),
	})
}
