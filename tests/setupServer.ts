import type { FileHandle } from 'node:fs/promises'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import type { CookieJarInterface, ScratchInterface } from '@orkestrel/test/server'
import type {
	AssetRepresentation,
	AssetSourceInterface,
	BearerState,
	BodyState,
	ClientState,
	CSRFState,
	ForwardedOptions,
	IdentifierState,
	MultipartState,
	SessionInterface,
	SessionState,
} from '@src/server'
import type { MiddlewareHandler } from '@orkestrel/server'
import {
	createAssets,
	createBearer,
	createBody,
	createBoundary,
	createCSRF,
	createCompression,
	createCookieTransport,
	createCORS,
	createDatabaseSessionStore,
	createDeadline,
	createETag,
	createForwarded,
	createHeaderTransport,
	createLimiter,
	createMemoryAssetStore,
	createMemoryLimiterStore,
	createMemorySessionStore,
	createMultipart,
	createNodeCompression,
	createSecurity,
	createSession,
	createStatic,
	createTelemetry,
	createUploadedFile,
	except,
	isSession,
	only,
	Session,
} from '@src/server'
import { ContractError, attempt, isRecord, isString } from '@orkestrel/contract'
import { MiddlewareValue, buildStore } from './setup.js'
import { statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as sendHttpRequest } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCookieJar, createLoopback, createScratch } from '@orkestrel/test/server'
import { createDispatcher } from '@orkestrel/router'
import { createServer, HTTPError } from '@orkestrel/server'
import { createRecorder, requireValue, waitForAbort, waitForDelay } from '@orkestrel/test'

// ── Server-only test harness ─────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-file / real-multipart-body / real-socket
// tests, driven against real implementations. Environment-agnostic helpers stay
// in `setup.ts`. This file REPLACES the router-template's upgrade-seam-oriented
// setup (this package has no protocol-upgrade concept) with the fixtures this
// package's node-face suites actually need.

/** Carries a real PNG magic-byte header (8 bytes) — the shortest genuine PNG signature. */
export const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Carries the real-socket middleware composition's request state. */
export interface CapstoneState extends SessionState {
	readonly identifier?: string
	readonly client?: { readonly ip?: string }
	readonly token?: string
	readonly csrf?: string
}

/** Carries a real JPEG magic-byte header (3 bytes) — the shortest genuine JPEG signature. */
export const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff])

/**
 * Lists the directories a second-filesystem probe reads, in the order it reads them.
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
	const reading = attempt(() => statSync(reference).dev)
	if (!reading.success) return undefined
	const device = reading.value
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

/** Pairs a map-backed in-memory asset source with a readonly record of requested keys. */
export interface AssetSourceFixtureInterface {
	readonly source: AssetSourceInterface
	readonly paths: readonly string[]
}

/**
 * Builds an inert in-memory asset source for `createAssets` tests.
 *
 * @param assets - The exact key-to-asset records the source exposes
 * @param fallback - Optional asset returned for every key absent from `assets`
 * @returns The source and a snapshotting record of keys passed to `read`
 */
export function createAssetSource(
	assets: ReadonlyMap<string, AssetRepresentation>,
	fallback?: AssetRepresentation,
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

/** Holds a scratch-backed static fixture tree — the seeded directory plus its known file paths, ready for `createStatic` tests. */
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
 * Builds a real scratch-directory static-file fixture: nested directories, an
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

/** Holds a scratch-backed fixture with a symlink INSIDE root pointing IN-root, and one pointing OUTSIDE root — for `createStatic`'s symlink-escape matrix. */
export interface SymlinkFixtureInterface {
	readonly scratch: ScratchInterface
	readonly insideTarget: string
	readonly linkToInside: string
	readonly linkToOutside: string
	destroy(): void
}

/**
 * Builds a real scratch-directory fixture with two symlinks: one inside the
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

/** Holds a scratch-backed fixture with a subdirectory whose `index.html` is a symlink pointing OUTSIDE root — for `createStatic`'s directory-index symlink-escape case. */
export interface DirectoryIndexFixtureInterface {
	readonly scratch: ScratchInterface
	readonly subdir: string
	destroy(): void
}

/**
 * Builds a real scratch-directory fixture with a subdirectory whose
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

/** Pairs a `Request` carrying a real multipart body over a single-chunk stream with an observable `cancelled` flag. */
export interface CancelTrackingRequestInterface {
	readonly request: Request
	readonly cancelled: { value: boolean }
}

/**
 * Builds a multipart `Request` whose body is a CHUNKED, pull-driven
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
	const cancelled = new MiddlewareValue(false)
	const offset = new MiddlewareValue(0)
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset.value >= body.length) {
				controller.close()
				return
			}
			const chunk = body.subarray(offset.value, offset.value + chunkSize)
			offset.value += chunkSize
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

/** Names one part of a real `multipart/form-data` body — either a text field or a file. */
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
 * Composes a real `multipart/form-data` request body from a list of parts —
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
	chunks.reduce((offset, chunk) => {
		body.set(chunk, offset)
		return offset + chunk.byteLength
	}, 0)
	return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Builds a `ReadableStream` that feeds `bytes` in fixed-size chunks.
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
	const offset = new MiddlewareValue(0)
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset.value >= bytes.length) {
				controller.close()
				return
			}
			const chunk = bytes.subarray(offset.value, offset.value + chunkSize)
			offset.value += chunkSize
			controller.enqueue(chunk)
		},
	})
}

/**
 * Builds a `Request` carrying a real multipart body — composes
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

/** Describes one key of an options bag a door admits, by the values it accepts and refuses. */
export interface AdmissionKeyInterface {
	readonly path: readonly string[]
	readonly valid: readonly unknown[]
	readonly invalid: readonly unknown[]
	readonly required?: boolean
	readonly fault?: readonly string[]
}

/** Describes one door and its options contract: the bag, the keys, and how the door takes the bag. */
export interface AdmissionDoorInterface {
	readonly name: string
	readonly factory: string
	readonly create: (...args: never[]) => unknown
	readonly base: Readonly<Record<string, unknown>>
	readonly keys: readonly AdmissionKeyInterface[]
	readonly misspelled?: string
	readonly optionalBag?: boolean
	readonly positional?: boolean
	readonly unionRoot?: boolean
	readonly spread?: (bag: unknown) => readonly unknown[]
	readonly rows?: readonly AdmissionRowInterface[]
}

/** Describes one admission case: the arguments a door receives and the path its refusal carries, or `undefined` when it admits. */
export interface AdmissionRowInterface {
	readonly title: string
	readonly args: readonly unknown[]
	readonly path: readonly string[] | undefined
}

/** Holds the cases one door runs, tagged with the door that runs them. */
export interface AdmissionCaseInterface extends AdmissionRowInterface {
	readonly door: AdmissionDoorInterface
}

/**
 * Places a value at a path inside a record, creating the nested records the path needs.
 *
 * @param base - The record the value joins
 * @param path - The key path, at least one segment
 * @param value - The value to place
 * @returns A new record with `value` at `path`
 *
 * @example
 * ```ts
 * placeValue({ a: 1 }, ['b', 'c'], 2) // { a: 1, b: { c: 2 } }
 * ```
 */
export function placeValue(
	base: Readonly<Record<string, unknown>>,
	path: readonly string[],
	value: unknown,
): Readonly<Record<string, unknown>> {
	const [head, ...rest] = path
	if (head === undefined) return base
	return { ...base, [head]: rest.length === 0 ? value : placeValue({}, rest, value) }
}

/**
 * Lists every admission case one door runs: each key at a valid value, absent, at an explicit
 * `undefined`, at each invalid value, plus an undeclared key, a misspelled key, and a bag of the wrong type.
 *
 * @param door - The door and its keys
 * @returns The ordered cases
 *
 * @example
 * ```ts
 * listAdmissionRows(door).filter((row) => row.path === undefined) // the cases the door admits
 * ```
 */
export function listAdmissionRows(door: AdmissionDoorInterface): readonly AdmissionRowInterface[] {
	const rows: AdmissionRowInterface[] = []
	rows.push({ title: 'admits the base bag', args: spreadBag(door, door.base), path: undefined })
	for (const key of door.keys) {
		const label = key.path.join('.')
		const top = key.path[0] ?? ''
		const bare = withoutKey(door.base, top)
		for (const value of key.valid)
			rows.push({
				title: `admits ${label} at ${describeAdmissionValue(value)}`,
				args: spreadBag(door, placeValue(bare, key.path, value)),
				path: undefined,
			})
		if (key.path.length === 1 && key.required !== true)
			rows.push({
				title: `admits ${label} absent`,
				args: spreadBag(door, withoutKey(door.base, top)),
				path: undefined,
			})
		if (key.path.length === 1 && key.required === true)
			rows.push({
				title: `refuses ${label} absent`,
				args: spreadBag(door, withoutKey(door.base, top)),
				path: locateRefusal(door, key.path),
			})
		if (key.path.length === 1 && key.required !== true && !door.unionRoot)
			rows.push({
				title: `refuses ${label} at an explicit undefined`,
				args: spreadBag(door, { ...bare, [top]: undefined }),
				path: locateRefusal(door, key.path),
			})
		for (const value of key.invalid)
			rows.push({
				title: `refuses ${label} at ${describeAdmissionValue(value)}`,
				args: spreadBag(door, placeValue(bare, key.path, value)),
				path: locateRefusal(door, key.fault ?? key.path),
			})
	}
	if (door.positional !== true) {
		rows.push({
			title: 'refuses an undeclared key',
			args: spreadBag(door, { ...door.base, undeclared: 1 }),
			path: locateRefusal(door, ['undeclared']),
		})
		if (door.misspelled !== undefined)
			rows.push({
				title: `refuses the misspelled key ${door.misspelled}`,
				args: spreadBag(door, { ...door.base, [door.misspelled]: 1 }),
				path: locateRefusal(door, [door.misspelled]),
			})
		for (const bag of [null, 'bag', 42, []])
			rows.push({
				title: `refuses a bag of ${describeAdmissionValue(bag)}`,
				args: spreadBag(door, bag),
				path: [],
			})
		rows.push({
			title: door.optionalBag === true ? 'admits an absent bag' : 'refuses an absent bag',
			args: spreadBag(door, undefined),
			path:
				door.optionalBag === true
					? undefined
					: locateRefusal(door, door.keys.find((key) => key.required === true)?.path ?? []),
		})
	}
	return [...rows, ...(door.rows ?? [])]
}

/**
 * Describes a value as a case title segment.
 *
 * @param value - The value a case places
 * @returns A short readable label
 *
 * @example
 * ```ts
 * describeAdmissionValue(Number.NaN) // 'NaN'
 * ```
 */
export function describeAdmissionValue(value: unknown): string {
	if (typeof value === 'function') return 'a function'
	if (typeof value === 'number' || typeof value === 'boolean' || value === undefined)
		return String(value)
	if (typeof value === 'bigint') return String(value)
	if (typeof value === 'symbol') return 'a symbol'
	if (value instanceof Object && !Array.isArray(value) && value.constructor !== Object)
		return 'a class instance'
	return JSON.stringify(value) ?? 'unknown'
}

/**
 * Lists the arguments a door receives for one bag, through the door's own `spread` when it takes
 * its bag positionally.
 *
 * @param door - The door
 * @param bag - The bag a case places
 * @returns The ordered arguments
 *
 * @example
 * ```ts
 * spreadBag(door, { ms: 1 }) // [{ ms: 1 }]
 * ```
 */
export function spreadBag(door: AdmissionDoorInterface, bag: unknown): readonly unknown[] {
	return door.spread === undefined ? [bag] : door.spread(bag)
}

/**
 * Locates the path a refusal carries: the door's root for a union contract, otherwise the key path.
 *
 * @param door - The door
 * @param path - The key path the case refuses
 * @returns The path a refusal starts with
 *
 * @example
 * ```ts
 * locateRefusal(door, ['ms']) // ['ms']
 * ```
 */
export function locateRefusal(
	door: AdmissionDoorInterface,
	path: readonly string[],
): readonly string[] {
	return door.unionRoot === true ? [] : path
}

/** Reports what one door did with one case: whether it admitted, and the refusal it threw. */
export interface AdmissionOutcomeInterface {
	readonly refusal: string | undefined
	readonly message: string
	readonly path: readonly string[] | undefined
}

/**
 * Runs one case against its door and reports the refusal by class name, message, and the path
 * prefix the case expects.
 *
 * @param door - The door
 * @param row - The case
 * @returns The outcome; `refusal` is `undefined` when the door admitted
 *
 * @example
 * ```ts
 * runAdmission(door, row).refusal // 'ContractError' when the door refused
 * ```
 */
export function runAdmission(
	door: AdmissionDoorInterface,
	row: AdmissionRowInterface,
): AdmissionOutcomeInterface {
	const outcome = attempt(() => Reflect.apply(door.create, undefined, [...row.args]))
	if (outcome.success) return { refusal: undefined, message: '', path: undefined }
	const error = outcome.error
	if (!(error instanceof ContractError)) return { refusal: 'other', message: '', path: undefined }
	const path = error.context?.path
	return {
		refusal: error.name,
		message: error.message,
		path: (typeof path === 'string' ? [path] : path)?.slice(0, row.path?.length ?? 0),
	}
}

/**
 * Copies a record without one top-level key.
 *
 * @param base - The record to copy
 * @param key - The key to leave out
 * @returns The copy
 *
 * @example
 * ```ts
 * withoutKey({ a: 1, b: 2 }, 'a') // { b: 2 }
 * ```
 */
export function withoutKey(
	base: Readonly<Record<string, unknown>>,
	key: string,
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))
}

const FUNCTION_KEY = { valid: [() => undefined], invalid: ['fn', 1, null, {}] }
const BOOLEAN_KEY = { valid: [true, false], invalid: ['true', 1, null] }
const STRING_KEY = { valid: ['x', ''], invalid: [1, null, ['x'], {}] }
const STRING_LIST_KEY = { valid: [[], ['a', 'b']], invalid: ['a', [1], [null], {}] }
const NON_NEGATIVE_KEY = {
	valid: [0, 1_024],
	invalid: [-1, Number.NaN, Number.POSITIVE_INFINITY, '1', null],
}
const POSITIVE_KEY = {
	valid: [1, 0.5, Number.MIN_VALUE],
	invalid: [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null],
}
const MINIMUM_ONE_KEY = {
	valid: [1, 100],
	invalid: [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null],
}
const COUNT_KEY = { valid: [0, 3], invalid: [-1, 1.5, Number.NaN, '1', null] }
const SECRET_KEY = { valid: ['s', ['a', 'b']], invalid: [1, [1], null, {}] }
const STRING_OR_FALSE_KEY = { valid: ['x', false], invalid: [true, 1, null, ['x']] }
const STRING_OR_BOOLEAN_KEY = { valid: ['x', true, false], invalid: [1, null, ['x']] }

class ForeignStore {
	readonly extra = 1
	get(): undefined {
		return undefined
	}
	set(): undefined {
		return undefined
	}
	delete(): undefined {
		return undefined
	}
}

/** Lists every door that admits an options bag, with the keys and ranges its contract declares. */
export const ADMISSION_DOORS: readonly AdmissionDoorInterface[] = Object.freeze([
	{
		name: 'createBoundary',
		factory: 'createBoundary',
		create: createBoundary,
		base: {},
		optionalBag: true,
		misspelled: 'exposes',
		keys: [
			{ path: ['expose'], ...BOOLEAN_KEY },
			{ path: ['report'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createTelemetry',
		factory: 'createTelemetry',
		create: createTelemetry,
		base: { record: () => undefined },
		misspelled: 'records',
		keys: [{ path: ['record'], required: true, ...FUNCTION_KEY }],
	},
	{
		name: 'createCompression',
		factory: 'createCompression',
		create: createCompression,
		base: {},
		optionalBag: true,
		misspelled: 'thresholds',
		keys: [
			{ path: ['threshold'], ...NON_NEGATIVE_KEY },
			{
				path: ['encodings'],
				valid: [[], ['gzip'], ['gzip', 'deflate', 'identity']],
				invalid: ['gzip', ['br'], [1], null],
			},
			{ path: ['filter'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createNodeCompression',
		factory: 'createNodeCompression',
		create: createNodeCompression,
		base: {},
		optionalBag: true,
		misspelled: 'thresholds',
		keys: [
			{ path: ['threshold'], ...NON_NEGATIVE_KEY },
			{ path: ['filter'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createSecurity',
		factory: 'createSecurity',
		create: createSecurity,
		base: {},
		optionalBag: true,
		misspelled: 'frames',
		keys: [
			{
				path: ['frame'],
				valid: ['DENY', 'SAMEORIGIN', false],
				invalid: ['ALLOW', true, 1, null],
			},
			{ path: ['csp'], ...STRING_OR_FALSE_KEY },
			{ path: ['referrer'], ...STRING_OR_FALSE_KEY },
			{ path: ['permissions'], ...STRING_OR_FALSE_KEY },
			{ path: ['coop'], ...STRING_OR_FALSE_KEY },
			{ path: ['corp'], ...STRING_OR_FALSE_KEY },
			{ path: ['cluster'], ...STRING_OR_FALSE_KEY },
			{ path: ['coep'], ...STRING_OR_BOOLEAN_KEY },
			{ path: ['hsts'], ...STRING_OR_BOOLEAN_KEY },
			{
				path: ['identifier'],
				valid: [false, {}, { trust: true }],
				invalid: [true, 'x', { trust: 'yes' }, { extra: 1 }, null],
			},
			{ path: ['identifier', 'trust'], fault: ['identifier'], ...BOOLEAN_KEY },
		],
	},
	{
		name: 'createCORS',
		factory: 'createCORS',
		create: createCORS,
		base: {},
		optionalBag: true,
		misspelled: 'origins',
		keys: [
			{
				path: ['origin'],
				valid: ['*', 'https://app.example', ['https://app.example']],
				invalid: [1, [1], null, true],
			},
			{ path: ['methods'], ...STRING_LIST_KEY },
			{ path: ['headers'], ...STRING_LIST_KEY },
		],
	},
	{
		name: 'createDeadline',
		factory: 'createDeadline',
		create: createDeadline,
		base: { ms: 1_000 },
		misspelled: 'mss',
		keys: [
			{
				path: ['ms'],
				required: true,
				valid: [1, 1_000, 2_147_483_647],
				invalid: [
					0,
					-1,
					1.5,
					3e9,
					2_147_483_648,
					Number.MIN_VALUE,
					Number.NaN,
					Number.POSITIVE_INFINITY,
					'1',
					null,
				],
			},
			{
				path: ['status'],
				valid: [200, 503, 599],
				invalid: [199, 600, 1_000, 503.5, Number.NaN, '503', null],
			},
		],
	},
	{
		name: 'createForwarded (proxies)',
		factory: 'createForwarded',
		create: createForwarded,
		base: { proxies: 1 },
		unionRoot: true,
		misspelled: 'proxy',
		keys: [{ path: ['proxies'], required: true, ...MINIMUM_ONE_KEY }],
		rows: [
			{ title: 'refuses both forms', args: [{ proxies: 1, trusted: [] }], path: [] },
			{ title: 'refuses neither form', args: [{}], path: [] },
			{ title: 'admits the trusted form', args: [{ trusted: ['10.0.0.0/8'] }], path: undefined },
		],
	},
	{
		name: 'createForwarded (trusted)',
		factory: 'createForwarded',
		create: createForwarded,
		base: { trusted: ['10.0.0.0/8'] },
		unionRoot: true,
		misspelled: 'trust',
		keys: [
			{
				path: ['trusted'],
				required: true,
				valid: [[], ['10.0.0.0/8', '::1']],
				invalid: ['10.0.0.0/8', [1], [null], null],
			},
		],
	},
	{
		name: 'createETag',
		factory: 'createETag',
		create: createETag,
		base: {},
		optionalBag: true,
		misspelled: 'weaks',
		keys: [{ path: ['weak'], ...BOOLEAN_KEY }],
	},
	{
		name: 'createBearer',
		factory: 'createBearer',
		create: createBearer,
		base: { verify: () => 'user' },
		misspelled: 'verifies',
		keys: [
			{ path: ['verify'], required: true, ...FUNCTION_KEY },
			{ path: ['header'], ...STRING_KEY },
			{ path: ['scheme'], ...STRING_KEY },
			{
				path: ['challenge'],
				valid: [{}, { realm: 'taverna' }],
				invalid: ['x', { realm: 1 }, ['realm'], null],
			},
		],
		rows: [
			{
				title: 'refuses a challenge naming error',
				args: [{ verify: (): string => 'x', challenge: { error: 'x' } }],
				path: ['challenge', 'error'],
			},
			{
				title: 'refuses a challenge naming Error in another case',
				args: [{ verify: (): string => 'x', challenge: { Error: 'x' } }],
				path: ['challenge', 'Error'],
			},
			{
				title: 'refuses a challenge name that is not a token',
				args: [{ verify: (): string => 'x', challenge: { 'two words': 'x' } }],
				path: ['challenge', 'two words'],
			},
			{
				title: 'refuses a challenge value holding a quote',
				args: [{ verify: (): string => 'x', challenge: { realm: 'a"b' } }],
				path: ['challenge', 'realm'],
			},
			{
				title: 'refuses a scheme that is not a token',
				args: [{ verify: (): string => 'x', scheme: 'Bad Scheme' }],
				path: ['scheme'],
			},
		],
	},
	{
		name: 'createLimiter',
		factory: 'createLimiter',
		create: createLimiter,
		base: { max: 1, window: 1_000 },
		misspelled: 'maxs',
		keys: [
			{ path: ['max'], required: true, ...MINIMUM_ONE_KEY },
			{ path: ['window'], required: true, ...POSITIVE_KEY },
			{ path: ['capacity'], ...MINIMUM_ONE_KEY },
			{ path: ['key'], ...FUNCTION_KEY },
			{ path: ['message'], ...STRING_KEY },
			{ path: ['clock'], ...FUNCTION_KEY },
			{ path: ['policy'], ...BOOLEAN_KEY },
			{ path: ['evict'], ...FUNCTION_KEY },
			{
				path: ['store'],
				valid: [createMemoryLimiterStore(), { consume: () => undefined }],
				invalid: [{}, 'store', 1, null, [], { consume: 1 }],
			},
		],
	},
	{
		name: 'createSession',
		factory: 'createSession',
		create: createSession,
		base: { transport: createHeaderTransport() },
		misspelled: 'transports',
		keys: [
			{
				path: ['transport'],
				required: true,
				valid: [
					createHeaderTransport(),
					{ read: () => undefined, write: () => undefined, clear: () => undefined },
				],
				invalid: [
					{},
					'transport',
					1,
					null,
					[],
					{ read: () => undefined, write: 1, clear: () => undefined },
				],
			},
			{
				path: ['store'],
				valid: [createMemorySessionStore(), new ForeignStore()],
				invalid: [
					{},
					'store',
					1,
					null,
					[],
					{ get: (): undefined => undefined, set: (): undefined => undefined },
				],
			},
			{ path: ['ttl'], ...POSITIVE_KEY },
			{ path: ['lifetime'], ...POSITIVE_KEY },
			{ path: ['capacity'], ...MINIMUM_ONE_KEY },
			{ path: ['evict'], ...FUNCTION_KEY },
			{ path: ['create'], ...FUNCTION_KEY },
			{ path: ['mint'], ...FUNCTION_KEY },
			{ path: ['required'], ...BOOLEAN_KEY },
			{ path: ['clock'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createCSRF',
		factory: 'createCSRF',
		create: createCSRF,
		base: { secret: 'shh' },
		misspelled: 'secrets',
		keys: [
			{ path: ['secret'], required: true, ...SECRET_KEY },
			{ path: ['cookie'], ...STRING_KEY },
			{ path: ['header'], ...STRING_KEY },
			{ path: ['field'], ...STRING_KEY },
			{ path: ['safe'], ...STRING_LIST_KEY },
		],
	},
	{
		name: 'createCookieTransport',
		factory: 'createCookieTransport',
		create: createCookieTransport,
		base: { secret: 'shh' },
		misspelled: 'secrets',
		keys: [
			{ path: ['secret'], required: true, ...SECRET_KEY },
			{ path: ['name'], ...STRING_KEY },
			{
				path: ['cookie'],
				valid: [
					{},
					{
						path: '/',
						domain: 'app.example',
						maxAge: 60,
						httpOnly: false,
						secure: true,
						sameSite: 'Lax',
					},
					{ maxAge: -1 },
					{ maxAge: 60.7 },
				],
				invalid: [
					5,
					'x',
					[],
					null,
					() => undefined,
					{ path: 1 },
					{ maxAge: Number.NaN },
					{ maxAge: Number.POSITIVE_INFINITY },
					{ sameSite: 'Other' },
					{ maxage: 60 },
					{ httponly: false },
					{ Secure: true },
					{ unknown: 1 },
				],
			},
		],
	},
	{
		name: 'createHeaderTransport',
		factory: 'createHeaderTransport',
		create: createHeaderTransport,
		base: {},
		optionalBag: true,
		misspelled: 'headers',
		keys: [{ path: ['header'], ...STRING_KEY }],
	},
	{
		name: 'createMemorySessionStore',
		factory: 'MemorySessionStore',
		create: createMemorySessionStore,
		base: {},
		optionalBag: true,
		misspelled: 'ttls',
		keys: [
			{ path: ['ttl'], ...POSITIVE_KEY },
			{ path: ['lifetime'], ...POSITIVE_KEY },
			{ path: ['capacity'], ...MINIMUM_ONE_KEY },
			{ path: ['evict'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createMemoryLimiterStore',
		factory: 'MemoryLimiterStore',
		create: createMemoryLimiterStore,
		base: {},
		optionalBag: true,
		misspelled: 'capacities',
		keys: [
			{ path: ['capacity'], ...MINIMUM_ONE_KEY },
			{ path: ['evict'], ...FUNCTION_KEY },
		],
	},
	{
		name: 'createDatabaseSessionStore',
		factory: 'DatabaseSessionStore',
		create: createDatabaseSessionStore,
		base: {},
		optionalBag: true,
		misspelled: 'ttls',
		spread: (bag) => [buildStore().table, isSession, bag],
		keys: [
			{ path: ['ttl'], ...POSITIVE_KEY },
			{ path: ['lifetime'], ...POSITIVE_KEY },
		],
	},
	{
		name: 'createAssets',
		factory: 'createAssets',
		create: createAssets,
		base: { source: { read: () => undefined } },
		misspelled: 'sources',
		keys: [
			{
				path: ['source'],
				required: true,
				valid: [{ read: () => undefined }, createAssetSource(new Map()).source],
				invalid: [{}, 'source', 1, null, [], { read: 1 }],
			},
			{
				path: ['store'],
				valid: [createMemoryAssetStore(), new ForeignStore()],
				invalid: [{}, 'store', 1, null, [], { get: (): undefined => undefined }],
			},
		],
	},
	{
		name: 'createStatic',
		factory: 'createStatic',
		create: createStatic,
		base: { root: '/srv/public' },
		misspelled: 'roots',
		keys: [
			{
				path: ['root'],
				required: true,
				valid: ['/srv/public', 'x'],
				invalid: ['', 1, null, ['x']],
			},
			{ path: ['prefix'], ...STRING_KEY },
			{ path: ['index'], ...STRING_KEY },
			{
				path: ['dotfiles'],
				valid: ['ignore', 'deny', 'allow'],
				invalid: ['permit', true, 1, null],
			},
			{ path: ['cache'], ...NON_NEGATIVE_KEY },
			{ path: ['etag'], ...BOOLEAN_KEY },
			{
				path: ['fallback'],
				valid: [true, false, {}, { exclude: '/api' }],
				invalid: ['yes', 1, { exclude: 1 }, { other: 1 }, null],
			},
			{ path: ['fallback', 'exclude'], fault: ['fallback'], ...STRING_KEY },
		],
	},
	{
		name: 'createMultipart',
		factory: 'createMultipart',
		create: createMultipart,
		base: {},
		optionalBag: true,
		misspelled: 'limit',
		keys: [
			{
				path: ['limits'],
				valid: [{}, { total: 10 }],
				invalid: ['x', [], null, { bogus: 1 }],
			},
			{ path: ['limits', 'file', 'size'], ...NON_NEGATIVE_KEY },
			{ path: ['limits', 'file', 'count'], ...COUNT_KEY },
			{ path: ['limits', 'field', 'size'], ...NON_NEGATIVE_KEY },
			{ path: ['limits', 'field', 'count'], ...COUNT_KEY },
			{ path: ['limits', 'total'], ...NON_NEGATIVE_KEY },
			{ path: ['allowed'], ...STRING_LIST_KEY },
			{ path: ['directory'], ...STRING_KEY },
		],
		rows: [
			{
				title: 'refuses NaN field size and NaN total at construction',
				args: [{ limits: { field: { size: Number.NaN }, total: Number.NaN } }],
				path: ['limits', 'field', 'size'],
			},
		],
	},
	{
		name: 'only',
		factory: 'only',
		create: only,
		base: { paths: '/admin', handler: () => undefined },
		positional: true,
		spread: (bag) => (isRecord(bag) ? [bag.paths, bag.handler] : []),
		keys: [
			{
				path: ['paths'],
				required: true,
				valid: ['/admin', ['/a', '/b'], []],
				invalid: [1, [1], null, {}],
			},
			{ path: ['handler'], required: true, ...FUNCTION_KEY },
		],
	},
	{
		name: 'except',
		factory: 'except',
		create: except,
		base: { paths: '/health', handler: () => undefined },
		positional: true,
		spread: (bag) => (isRecord(bag) ? [bag.paths, bag.handler] : []),
		keys: [
			{
				path: ['paths'],
				required: true,
				valid: ['/health', ['/a', '/b'], []],
				invalid: [1, [1], null, {}],
			},
			{ path: ['handler'], required: true, ...FUNCTION_KEY },
		],
	},
	{
		name: 'createUploadedFile',
		factory: 'createUploadedFile',
		create: createUploadedFile,
		base: {
			field: 'avatar',
			name: 'a.png',
			size: 3,
			mime: 'image/png',
			validated: true,
			status: 'staged',
			path: '/tmp/a',
		},
		misspelled: 'sizes',
		keys: [
			{ path: ['field'], required: true, ...STRING_KEY },
			{ path: ['name'], required: true, ...STRING_KEY },
			{ path: ['size'], required: true, ...NON_NEGATIVE_KEY },
			{ path: ['mime'], required: true, ...STRING_KEY },
			{ path: ['validated'], required: true, ...BOOLEAN_KEY },
			{
				path: ['status'],
				required: true,
				valid: ['staged', 'moved'],
				invalid: ['pending', 1, null],
			},
			{ path: ['path'], required: true, ...STRING_KEY },
		],
	},
])

/** Carries every state slice a battery under the real-`Server` exchange rows reads or writes. */
export type ExchangeState = CapstoneState & BodyState & MultipartState

/** Holds one started real `Server` over a real socket and the requests its routes received. */
export interface ExchangeFixtureInterface {
	readonly url: string
	readonly requests: readonly Request[]
	stop(): Promise<void>
}

/** Delays the exchange fixture's `/slow` route past a short deadline, in milliseconds. */
export const EXCHANGE_SLOW_DELAY = 150

/**
 * Starts a real `Server` from `@orkestrel/server` on a loopback port with the given middleware.
 *
 * @remarks
 * The router answers `POST /echo` with the body a body battery stashed on `state.body`, `GET /plain`
 * with `plain`, `GET /client` with the `state.client` ip, and `GET /slow` with `late` after {@link EXCHANGE_SLOW_DELAY} milliseconds. Each route
 * records the `Request` it received. The state factory returns `{}`, so a battery reads connection
 * facts from `context.connection` alone.
 *
 * @param running - The list the fixture joins, so a test stops every started server
 * @param middleware - The ordered chain, outermost first
 * @returns The fixture, whose `stop` ends the server
 *
 * @example
 * ```ts
 * const fixture = await startExchange([], [createDeadline({ ms: 5_000 }), createBody()])
 * ```
 */
export async function startExchange(
	running: ExchangeFixtureInterface[],
	middleware: ReadonlyArray<MiddlewareHandler<ExchangeState>>,
): Promise<ExchangeFixtureInterface> {
	const requests: Request[] = []
	const dispatcher = createDispatcher<ExchangeState>()
	dispatcher.add({
		method: 'POST',
		path: '/echo',
		handler: (request, context) => {
			requests.push(request)
			return Response.json({ body: context.state.body })
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/plain',
		handler: (request) => {
			requests.push(request)
			return new Response('plain')
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/client',
		handler: (request, context) => {
			requests.push(request)
			return new Response(context.state.client?.ip ?? 'none')
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/slow',
		handler: async (request) => {
			requests.push(request)
			await waitForDelay(EXCHANGE_SLOW_DELAY)
			return new Response('late')
		},
	})
	const server = createServer<ExchangeState>({
		dispatcher,
		state: () => ({}),
		host: '127.0.0.1',
		middleware,
	})
	const port = await server.start()
	const fixture = {
		url: `http://127.0.0.1:${port}`,
		requests,
		stop: server.stop.bind(server),
	}
	running.push(fixture)
	return fixture
}

// ── Composed-stack oracle ────────────────────────────────────────────────────

/** Names one battery position in the composed-stack oracle's onion. */
export type StackLayer =
	| 'compression'
	| 'security'
	| 'cors'
	| 'boundary'
	| 'deadline'
	| 'forwarded'
	| 'etag'
	| 'bearer'
	| 'limiter'
	| 'body'
	| 'session'
	| 'csrf'
	| 'multipart'
	| 'static'

/** Names one onion order the guide's ordering doctrine permits. */
export type StackArrangement = 'oracle' | 'canonical' | 'deadline'

/** Names the compression battery a stack mounts: `createCompression` or `createNodeCompression`. */
export type StackEngine = 'web' | 'node'

/** Names the unit that turns a red oracle cell green. */
export type StackCloser = 'M3' | 'M6'

/** Carries every state slice a battery of the composed stack reads or writes. */
export interface StackState
	extends
		BearerState,
		BodyState,
		ClientState,
		CSRFState,
		IdentifierState,
		MultipartState,
		SessionState {}

/** Configures one composed stack: its order, its forwarded trust, its compression battery, its session capacity, and whether a cookie-less request mints no session. */
export interface StackOptions {
	readonly order: readonly StackLayer[]
	readonly forwarded: ForwardedOptions
	readonly engine: StackEngine
	readonly capacity?: number
	readonly anonymous?: boolean
	readonly peer?: string
}

/** Holds one started composed stack: a real `Server` over a real dispatcher, and the proxy fixture in front of it. */
export interface StackFixtureInterface {
	readonly url: string
	readonly proxy: string
	readonly peer: string
	readonly hops: readonly string[]
	readonly ids: readonly string[]
	stop(): Promise<void>
}

/** Holds every stack the oracle drives, and whether the proxy reaches the server from its own address. */
export interface StackSetInterface {
	readonly orders: Readonly<Record<StackArrangement, StackFixtureInterface>>
	readonly trusted: StackFixtureInterface
	readonly nodes: Readonly<Record<StackArrangement, StackFixtureInterface>>
	readonly capacity: StackFixtureInterface
	readonly anonymous: StackFixtureInterface
	readonly alias: boolean
	stop(): Promise<void>
}

/** Describes one request the oracle sends. */
export interface StackRequest {
	readonly method?: string
	readonly path: string
	readonly headers?: Readonly<Record<string, string>>
	readonly body?: string | Blob
}

/** Holds what one oracle request read back: the status, the headers, the raw `Set-Cookie` fields, and the content-decoded body. */
export interface StackReply {
	readonly status: number
	readonly headers: Headers
	readonly cookies: readonly string[]
	readonly body: Uint8Array
	readonly text: string
}

/** Describes one oracle cell: the request it sends with the CSRF token or without it, and the unit that closes it when the base holds it red. */
export interface StackCell {
	readonly title: string
	readonly build: (token: string | undefined) => StackRequest
	readonly closer?: StackCloser
}

/** Describes one oracle cell whose route answers a status the fixture knows. */
export interface StackStatusCell extends StackCell {
	readonly status?: number
}

/** Describes one forwarded-trust cell: the stack's trust, whether the request crosses the proxy, the hops the client wrote, and the address the cell expects. */
export interface StackForwardedCell {
	readonly title: string
	readonly trust: 'proxies' | 'trusted'
	readonly proxied: boolean
	readonly headers: Readonly<Record<string, string>>
	readonly expect: 'peer' | 'hop'
	readonly closer?: StackCloser
}

/** Describes one ranged-response cell: the compression battery its stack mounts and the request it sends. */
export interface StackRangeCell extends StackCell {
	readonly engine: StackEngine
}

/** Names the loopback address every oracle client and fixture server uses. */
export const STACK_LOOPBACK = '127.0.0.1'

/** Names the second loopback address the proxy fixture connects to the server from, so the server's socket peer differs from the hop the proxy appends. */
export const STACK_PEER = '127.0.0.2'

/** Signs the session cookie and the CSRF token alike, as the guide's canonical onion shares one secret between them. */
export const STACK_SECRET = 'stack-secret'

/** Holds the bearer token `/admin` admits. */
export const STACK_BEARER = 'stack-bearer'

/** Holds the one origin the stack's list-mode CORS battery allows. */
export const STACK_ORIGIN = 'https://app.example'

/** Holds an origin the stack's list-mode CORS battery does not allow. */
export const STACK_FOREIGN_ORIGIN = 'https://other.example'

/** Holds a hop a client writes into a forwarding header itself. */
export const STACK_CLIENT_HOP = '198.51.100.66'

/** Bounds every stack response, in milliseconds: past every ordinary route on a loaded host, and the wait of the route that parks until the deadline fires. */
export const STACK_DEADLINE = 1_500

/** Bounds the session store of the capacity stack, so a cookie-less flood the size of the store reaches eviction. */
export const STACK_CAPACITY = 4

/** Holds the HTML `/page` and the static `index.html` answer: deterministic, and longer than the compression threshold. */
export const STACK_PAGE = `<!doctype html><title>Lamp</title>${'<p>lamp oil and wick</p>'.repeat(200)}`

/** Holds the static `large.txt` text: compressible, and longer than the range the ranged cells request. */
export const STACK_TEXT = 'lamp oil and wick\n'.repeat(1_200)

/** Holds the byte range the ranged cells request. */
export const STACK_RANGE = 'bytes=0-4999'

/** Holds the multipart boundary the upload cells send, fixed so every order receives the same bytes. */
export const STACK_BOUNDARY = 'stack-boundary'

/** Lists the security headers invariant 7 compares against the bare-route control, by name. */
export const SECURITY_HEADERS: readonly string[] = Object.freeze([
	'x-content-type-options',
	'x-frame-options',
	'content-security-policy',
	'referrer-policy',
	'permissions-policy',
	'cross-origin-opener-policy',
	'cross-origin-resource-policy',
	'origin-agent-cluster',
	'strict-transport-security',
])

/**
 * Lists the onion orders the guide's ordering doctrine permits, outermost first.
 *
 * @remarks
 * `canonical` is the guide's fence order, and `oracle`, the reference the other orders are
 * compared against, mounts the same order; `deadline` mounts `createDeadline` after `createBody`
 * (doctrine item 6). Every order mounts compression outside the boundary and `createETag`,
 * `createSecurity` and `createCORS` outside the boundary and the deadline (doctrine items 7 and 8),
 * the bearer before the limiter, and the body before the session and CSRF.
 */
export const STACK_ORDERS: Readonly<Record<StackArrangement, readonly StackLayer[]>> =
	Object.freeze({
		oracle: [
			'compression',
			'security',
			'cors',
			'boundary',
			'deadline',
			'forwarded',
			'etag',
			'bearer',
			'limiter',
			'body',
			'session',
			'csrf',
			'multipart',
			'static',
		],
		canonical: [
			'compression',
			'security',
			'cors',
			'boundary',
			'deadline',
			'forwarded',
			'etag',
			'bearer',
			'limiter',
			'body',
			'session',
			'csrf',
			'multipart',
			'static',
		],
		deadline: [
			'compression',
			'security',
			'cors',
			'boundary',
			'forwarded',
			'etag',
			'bearer',
			'limiter',
			'body',
			'deadline',
			'session',
			'csrf',
			'multipart',
			'static',
		],
	})

/** Lists the orders invariant 10 compares against the `oracle` order. */
export const STACK_VARIANTS: readonly StackArrangement[] = Object.freeze(['canonical', 'deadline'])

/**
 * Builds the headers of a request that carries the CSRF token in its header, when it has one.
 *
 * @param token - The CSRF token, or `undefined` for the uncredentialed arm
 * @param headers - The request's other headers
 * @returns The headers, with `x-csrf-token` when `token` is defined
 *
 * @example
 * ```ts
 * buildTokenHeaders('abc', { 'content-type': 'application/json' }) // { 'content-type': ..., 'x-csrf-token': 'abc' }
 * ```
 */
export function buildTokenHeaders(
	token: string | undefined,
	headers: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
	return token === undefined ? headers : { ...headers, 'x-csrf-token': token }
}

/**
 * Builds the `POST /echo` request with a JSON body and the CSRF token in its header.
 *
 * @param token - The CSRF token, or `undefined` for the uncredentialed arm
 * @returns The request
 *
 * @example
 * ```ts
 * buildEchoRequest(undefined).path // '/echo'
 * ```
 */
export function buildEchoRequest(token: string | undefined): StackRequest {
	return {
		method: 'POST',
		path: '/echo',
		headers: buildTokenHeaders(token, { 'content-type': 'application/json' }),
		body: '{"item":"lamp"}',
	}
}

/**
 * Builds the `POST /upload` multipart request, with the CSRF token in its header.
 *
 * @param token - The CSRF token, or `undefined` for the uncredentialed arm
 * @returns The request, over the fixed {@link STACK_BOUNDARY}
 *
 * @example
 * ```ts
 * buildUploadRequest('abc').headers?.['x-csrf-token'] // 'abc'
 * ```
 */
export function buildUploadRequest(token: string | undefined): StackRequest {
	const { body, contentType } = buildMultipartBody(
		[
			{ kind: 'field', name: 'title', value: 'lamp' },
			{
				kind: 'file',
				name: 'avatar',
				filename: 'lamp.png',
				contentType: 'image/png',
				bytes: PNG_MAGIC,
			},
		],
		STACK_BOUNDARY,
	)
	return {
		method: 'POST',
		path: '/upload',
		headers: buildTokenHeaders(token, { 'content-type': contentType }),
		body: new Blob([Buffer.from(body)]),
	}
}

/**
 * Lists the cells of a table the base holds green: those that name no closing unit.
 *
 * @param cells - The table
 * @returns The cells with no `closer`, in table order
 *
 * @example
 * ```ts
 * listGreenCells(FAULT_CELLS).every((cell) => cell.closer === undefined) // true
 * ```
 */
export function listGreenCells<TCell extends { readonly closer?: StackCloser }>(
	cells: readonly TCell[],
): readonly TCell[] {
	return cells.filter((cell) => cell.closer === undefined)
}

/**
 * Lists the cells of a table the base holds red: those that name the unit that closes them.
 *
 * @param cells - The table
 * @returns The cells with a `closer`, in table order
 *
 * @example
 * ```ts
 * listRedCells(FAULT_CELLS).map((cell) => cell.closer) // []
 * ```
 */
export function listRedCells<TCell extends { readonly closer?: StackCloser }>(
	cells: readonly TCell[],
): ReadonlyArray<TCell & { readonly closer: StackCloser }> {
	return cells.filter(
		(cell): cell is TCell & { readonly closer: StackCloser } => cell.closer !== undefined,
	)
}

/** Lists invariant 1's cells: each request through the oracle stack, which answers no 5xx unless its handler threw a non-`HTTPError`. */
export const FAULT_CELLS: readonly StackCell[] = Object.freeze([
	{ title: 'GET /page', build: () => ({ path: '/page' }) },
	{ title: 'GET /token', build: () => ({ path: '/token' }) },
	{ title: 'POST /echo with a JSON body and the header token', build: buildEchoRequest },
	{ title: 'POST /echo without a token', build: () => buildEchoRequest(undefined) },
	{
		title: 'POST /echo with malformed JSON',
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: buildTokenHeaders(token, { 'content-type': 'application/json' }),
			body: '{"item":',
		}),
	},
	{ title: 'GET /teapot, whose handler throws an HTTPError', build: () => ({ path: '/teapot' }) },
	{ title: 'GET /missing, which no route matches', build: () => ({ path: '/missing' }) },
	{ title: 'GET /moved, a constructed 302', build: () => ({ path: '/moved' }) },
	{ title: 'GET /redirect, a Response.redirect 302', build: () => ({ path: '/redirect' }) },
	{
		title: 'POST /redirect, a Response.redirect 303 after a write',
		build: (token) => ({ method: 'POST', path: '/redirect', headers: buildTokenHeaders(token) }),
	},
	{
		title: 'POST /login, which regenerates the session and redirects',
		build: (token) => ({ method: 'POST', path: '/login', headers: buildTokenHeaders(token) }),
	},
	{
		title: 'OPTIONS /echo, a preflight from the allowed origin',
		build: () => ({
			method: 'OPTIONS',
			path: '/echo',
			headers: { origin: STACK_ORIGIN, 'access-control-request-method': 'POST' },
		}),
	},
	{ title: 'GET /static/index.html', build: () => ({ path: '/static/index.html' }) },
	{
		title: 'GET /static/large.txt with a Range',
		build: () => ({ path: '/static/large.txt', headers: { range: STACK_RANGE } }),
	},
	{ title: 'POST /upload, a multipart form with the header token', build: buildUploadRequest },
	{
		title: 'POST /upload, a malformed multipart form',
		build: (token) => ({
			method: 'POST',
			path: '/upload',
			headers: buildTokenHeaders(token, {
				'content-type': `multipart/form-data; boundary=${STACK_BOUNDARY}`,
			}),
			body: 'not a multipart body',
		}),
	},
	{ title: 'GET /admin/ without a bearer token', build: () => ({ path: '/admin/' }) },
])

/** Lists invariant 2's cells: each protected route, whose credentialed arm answers 200 and whose uncredentialed arm answers 401 or 403. */
export const ARM_CELLS: readonly StackCell[] = Object.freeze([
	{ title: 'POST /echo, the token in the header', build: buildEchoRequest },
	{
		title: 'POST /echo, the token in the JSON _csrf field',
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(token === undefined ? { item: 'lamp' } : { item: 'lamp', _csrf: token }),
		}),
	},
	{
		title: 'POST /echo, the token in the urlencoded _csrf field',
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(
				token === undefined ? { item: 'lamp' } : { item: 'lamp', _csrf: token },
			).toString(),
		}),
	},
	{ title: 'POST /upload, the token in the header of a multipart form', build: buildUploadRequest },
	{
		title: 'GET /admin, the bearer token',
		build: (token) => ({
			path: '/admin',
			headers: token === undefined ? {} : { authorization: `Bearer ${STACK_BEARER}` },
		}),
	},
	{
		title: 'GET /admin/, the bearer token on the trailing-slash form the router dispatches',
		build: (token) => ({
			path: '/admin/',
			headers: token === undefined ? {} : { authorization: `Bearer ${STACK_BEARER}` },
		}),
	},
])

/** Lists invariant 3's cells: the client ip each request resolves to, which is the socket peer or a hop the proxy fixture appended. */
export const FORWARDED_CELLS: readonly StackForwardedCell[] = Object.freeze([
	{
		title: 'proxies: 1, a direct request with no forwarding header resolves the socket peer',
		trust: 'proxies',
		proxied: false,
		headers: {},
		expect: 'peer',
	},
	{
		title: 'proxies: 1, a request through the proxy resolves the hop the proxy appended',
		trust: 'proxies',
		proxied: true,
		headers: {},
		expect: 'hop',
	},
	{
		title: 'proxies: 1, a client-written X-Forwarded-For hop through the proxy never resolves',
		trust: 'proxies',
		proxied: true,
		headers: { 'x-forwarded-for': STACK_CLIENT_HOP },
		expect: 'hop',
	},
	{
		title: 'proxies: 1, two client-written X-Forwarded-For hops through the proxy never resolve',
		trust: 'proxies',
		proxied: true,
		headers: { 'x-forwarded-for': `${STACK_CLIENT_HOP}, 203.0.113.7` },
		expect: 'hop',
	},
	{
		title: 'proxies: 1, a client-written Forwarded hop through the proxy never resolves',
		trust: 'proxies',
		proxied: true,
		headers: { forwarded: `for=${STACK_CLIENT_HOP}` },
		expect: 'hop',
	},
	{
		title: 'trusted, a direct request with no forwarding header resolves the socket peer',
		trust: 'trusted',
		proxied: false,
		headers: {},
		expect: 'peer',
	},
	{
		title:
			'trusted, a direct request from an untrusted peer naming the trusted proxy resolves the socket peer',
		trust: 'trusted',
		proxied: false,
		headers: { 'x-forwarded-for': `${STACK_CLIENT_HOP}, ${STACK_PEER}` },
		expect: 'peer',
	},
	{
		title: 'trusted, a request through the trusted proxy resolves the hop it appended',
		trust: 'trusted',
		proxied: true,
		headers: {},
		expect: 'hop',
	},
	{
		title: 'trusted, a client-written hop through the trusted proxy never resolves',
		trust: 'trusted',
		proxied: true,
		headers: { 'x-forwarded-for': STACK_CLIENT_HOP },
		expect: 'hop',
	},
	{
		title: 'trusted, a client-written hop naming the trusted proxy through it never resolves',
		trust: 'trusted',
		proxied: true,
		headers: { 'x-forwarded-for': `${STACK_CLIENT_HOP}, ${STACK_PEER}` },
		expect: 'hop',
	},
])

/** Lists invariant 5's cells: each response or preflight in list mode, which carries `Vary: Origin`. */
export const VARY_CELLS: readonly StackStatusCell[] = Object.freeze([
	{
		title: 'GET /page from the allowed origin',
		status: 200,
		build: () => ({ path: '/page', headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'GET /page from a disallowed origin',
		status: 200,
		build: () => ({ path: '/page', headers: { origin: STACK_FOREIGN_ORIGIN } }),
	},
	{
		title: 'GET /page with no Origin',
		status: 200,
		build: () => ({ path: '/page' }),
	},
	{
		title: 'OPTIONS /echo, a preflight from the allowed origin',
		build: () => ({
			method: 'OPTIONS',
			path: '/echo',
			headers: { origin: STACK_ORIGIN, 'access-control-request-method': 'POST' },
		}),
	},
	{
		title: 'OPTIONS /echo, a preflight from a disallowed origin',
		build: () => ({
			method: 'OPTIONS',
			path: '/echo',
			headers: { origin: STACK_FOREIGN_ORIGIN, 'access-control-request-method': 'POST' },
		}),
	},
	{
		title: 'GET /missing from the allowed origin',
		status: 404,
		build: () => ({ path: '/missing', headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'POST /echo without a token from the allowed origin',
		status: 403,
		build: () => ({ ...buildEchoRequest(undefined), headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'GET /teapot from a disallowed origin',
		status: 418,
		build: () => ({ path: '/teapot', headers: { origin: STACK_FOREIGN_ORIGIN } }),
	},
	{
		title: 'GET /static/large.txt with a Range from the allowed origin',
		status: 206,
		build: () => ({
			path: '/static/large.txt',
			headers: { origin: STACK_ORIGIN, range: STACK_RANGE },
		}),
	},
	{
		title: 'GET /redirect, a Response.redirect 302, from the allowed origin',
		status: 302,
		build: () => ({ path: '/redirect', headers: { origin: STACK_ORIGIN } }),
	},
])

/** Lists invariant 7's cells: each redirect and error, whose security headers equal the bare `/page` route's. */
export const HEADER_CELLS: readonly StackStatusCell[] = Object.freeze<StackStatusCell[]>([
	{ title: 'GET /moved, a constructed 302', status: 302, build: () => ({ path: '/moved' }) },
	{
		title: 'GET /redirect, a Response.redirect 302',
		status: 302,
		build: () => ({ path: '/redirect' }),
	},
	{
		title: 'POST /redirect, a Response.redirect 303 after a write',
		status: 303,
		build: (token) => ({ method: 'POST', path: '/redirect', headers: buildTokenHeaders(token) }),
	},
	{
		title: 'POST /login, which regenerates the session and redirects',
		status: 303,
		build: (token) => ({ method: 'POST', path: '/login', headers: buildTokenHeaders(token) }),
	},
	{
		title: 'POST /echo without a token, a thrown 403',
		status: 403,
		build: () => buildEchoRequest(undefined),
	},
	{
		title: 'POST /echo with malformed JSON, a thrown 400',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: buildTokenHeaders(token, { 'content-type': 'application/json' }),
			body: '{"item":',
		}),
	},
	{
		title: 'GET /admin without a bearer token, a returned 401',
		status: 401,
		build: () => ({ path: '/admin' }),
	},
	{ title: 'GET /missing, the router 404', status: 404, build: () => ({ path: '/missing' }) },
	{ title: 'GET /teapot, a thrown HTTPError 418', status: 418, build: () => ({ path: '/teapot' }) },
	{ title: 'GET /fault, a thrown Error', status: 500, build: () => ({ path: '/fault' }) },
	{ title: 'GET /slow, the deadline 503', status: 503, build: () => ({ path: '/slow' }) },
	{
		title: 'POST /upload, a malformed multipart form',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/upload',
			headers: buildTokenHeaders(token, {
				'content-type': `multipart/form-data; boundary=${STACK_BOUNDARY}`,
			}),
			body: 'not a multipart body',
		}),
	},
])

/** Lists invariant 5's cells on the guide's `canonical` order: each error from the allowed origin, which carries `Vary: Origin`. */
export const CANONICAL_VARY_CELLS: readonly StackStatusCell[] = Object.freeze<StackStatusCell[]>([
	{
		title: 'POST /echo without a token, a thrown 403, from the allowed origin, the canonical order',
		status: 403,
		build: () => ({ ...buildEchoRequest(undefined), headers: { origin: STACK_ORIGIN } }),
	},
	{
		title:
			'POST /echo with malformed JSON, a thrown 400, from the allowed origin, the canonical order',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: buildTokenHeaders(token, {
				'content-type': 'application/json',
				origin: STACK_ORIGIN,
			}),
			body: '{"item":',
		}),
	},
	{
		title: 'GET /teapot, a thrown HTTPError 418, from the allowed origin, the canonical order',
		status: 418,
		build: () => ({ path: '/teapot', headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'GET /fault, a thrown Error, from the allowed origin, the canonical order',
		status: 500,
		build: () => ({ path: '/fault', headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'GET /slow, the deadline 503, from the allowed origin, the canonical order',
		status: 503,
		build: () => ({ path: '/slow', headers: { origin: STACK_ORIGIN } }),
	},
	{
		title: 'POST /upload, a malformed multipart form, from the allowed origin, the canonical order',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/upload',
			headers: buildTokenHeaders(token, {
				'content-type': `multipart/form-data; boundary=${STACK_BOUNDARY}`,
				origin: STACK_ORIGIN,
			}),
			body: 'not a multipart body',
		}),
	},
])

/** Lists invariant 7's cells on the guide's `canonical` order: each error, whose security headers equal the bare `/page` route's on that order. */
export const CANONICAL_HEADER_CELLS: readonly StackStatusCell[] = Object.freeze<StackStatusCell[]>([
	{
		title: 'POST /echo without a token, a thrown 403, the canonical order',
		status: 403,
		build: () => buildEchoRequest(undefined),
	},
	{
		title: 'POST /echo with malformed JSON, a thrown 400, the canonical order',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: buildTokenHeaders(token, { 'content-type': 'application/json' }),
			body: '{"item":',
		}),
	},
	{
		title: 'GET /teapot, a thrown HTTPError 418, the canonical order',
		status: 418,
		build: () => ({ path: '/teapot' }),
	},
	{
		title: 'GET /fault, a thrown Error, the canonical order',
		status: 500,
		build: () => ({ path: '/fault' }),
	},
	{
		title: 'GET /slow, the deadline 503, the canonical order',
		status: 503,
		build: () => ({ path: '/slow' }),
	},
	{
		title: 'POST /upload, a malformed multipart form, the canonical order',
		status: 400,
		build: (token) => ({
			method: 'POST',
			path: '/upload',
			headers: buildTokenHeaders(token, {
				'content-type': `multipart/form-data; boundary=${STACK_BOUNDARY}`,
			}),
			body: 'not a multipart body',
		}),
	},
])

/** Lists invariant 8's cells: each 206 a client that accepts gzip receives, which carries no content coding. */
export const RANGE_CELLS: readonly StackRangeCell[] = Object.freeze([
	{
		title: 'createCompression over createStatic, GET /static/large.txt with a Range',
		engine: 'web',
		build: () => ({
			path: '/static/large.txt',
			headers: { range: STACK_RANGE, 'accept-encoding': 'gzip' },
		}),
	},
	{
		title: 'createCompression over a handler 206, GET /partial',
		engine: 'web',
		build: () => ({ path: '/partial', headers: { 'accept-encoding': 'gzip' } }),
	},
	{
		title: 'createNodeCompression over createStatic, GET /static/large.txt with a Range',
		engine: 'node',
		build: () => ({
			path: '/static/large.txt',
			headers: { range: STACK_RANGE, 'accept-encoding': 'gzip' },
		}),
	},
	{
		title: 'createNodeCompression over a handler 206, GET /partial',
		engine: 'node',
		build: () => ({ path: '/partial', headers: { 'accept-encoding': 'gzip' } }),
	},
])

/** Lists invariant 11's cells: each `GET` a client that accepts gzip revalidates, whose 304 carries the `ETag` and `Vary` of its 200. */
export const REVALIDATION_CELLS: readonly StackCell[] = Object.freeze([
	{
		title: 'GET /page, a createETag body above the compression threshold',
		build: () => ({ path: '/page', headers: { 'accept-encoding': 'gzip' } }),
	},
	{
		title: 'GET /client, a createETag body below the compression threshold',
		build: () => ({ path: '/client', headers: { 'accept-encoding': 'gzip' } }),
	},
	{
		title: 'GET /static/large.txt, a createStatic file',
		build: () => ({ path: '/static/large.txt', headers: { 'accept-encoding': 'gzip' } }),
	},
])

/** Lists invariant 10's cells: each request whose body every permitted order answers byte for byte alike. */
export const BODY_CELLS: readonly StackCell[] = Object.freeze([
	{ title: 'GET /page', build: () => ({ path: '/page', headers: { 'accept-encoding': 'gzip' } }) },
	{ title: 'POST /echo, the token in the header', build: buildEchoRequest },
	{
		title: 'POST /echo, the token in the JSON _csrf field',
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ item: 'lamp', _csrf: token }),
		}),
	},
	{ title: 'POST /upload, a multipart form', build: buildUploadRequest },
	{ title: 'GET /static/index.html', build: () => ({ path: '/static/index.html' }) },
	{
		title: 'GET /static/large.txt with a Range',
		build: () => ({ path: '/static/large.txt', headers: { range: STACK_RANGE } }),
	},
	{
		title: 'GET /admin, the bearer token',
		build: () => ({ path: '/admin', headers: { authorization: `Bearer ${STACK_BEARER}` } }),
	},
	{ title: 'GET /missing', build: () => ({ path: '/missing' }) },
	{ title: 'GET /teapot', build: () => ({ path: '/teapot' }) },
	{
		title: 'POST /echo with malformed JSON',
		build: (token) => ({
			method: 'POST',
			path: '/echo',
			headers: buildTokenHeaders(token, { 'content-type': 'application/json' }),
			body: '{"item":',
		}),
	},
])

/**
 * Probes whether the host routes a second loopback address, by connecting from {@link STACK_PEER}.
 *
 * @returns `true` when a socket bound to {@link STACK_PEER} reaches a {@link STACK_LOOPBACK} listener,
 * `false` when the host refuses the bind with `EADDRNOTAVAIL`
 * @throws The socket error, for any other refusal
 * @remarks Linux routes all of `127.0.0.0/8` to the loopback interface; a host that routes only
 * `127.0.0.1` refuses the bind with `EADDRNOTAVAIL`, and then the proxy fixture's hop and the
 * server's socket peer are the same address.
 *
 * @example
 * ```ts
 * const alias = await probeLoopbackAlias()
 * ```
 */
export async function probeLoopbackAlias(): Promise<boolean> {
	const loopback = await createLoopback(createNetServer((socket) => socket.end()))
	try {
		return await new Promise<boolean>((resolve, reject) => {
			const socket = connect({
				host: STACK_LOOPBACK,
				port: loopback.port,
				localAddress: STACK_PEER,
			})
			socket.once('connect', () => {
				socket.destroy()
				resolve(true)
			})
			socket.once('error', (error) => {
				if (Reflect.get(error, 'code') === 'EADDRNOTAVAIL') resolve(false)
				else reject(error)
			})
		})
	} finally {
		await loopback.destroy()
	}
}

/**
 * Renders a node address as an RFC 7239 `for=` value: a bare IPv4 address, or a quoted bracketed IPv6 one.
 *
 * @param address - The address, or `undefined` when the socket reports none
 * @returns The `for=` value, `unknown` for an absent address
 *
 * @example
 * ```ts
 * renderForwardedNode('127.0.0.1') // '127.0.0.1'
 * renderForwardedNode('::1') // '"[::1]"'
 * ```
 */
export function renderForwardedNode(address: string | undefined): string {
	if (address === undefined) return 'unknown'
	return address.includes(':') ? `"[${address}]"` : address
}

/**
 * Builds the headers the proxy fixture forwards: the client's headers with one hop appended to
 * `X-Forwarded-For` and to `Forwarded`, and no `Connection` field.
 *
 * @param headers - The headers the proxy received
 * @param hop - The client address the proxy read from its own socket
 * @returns The headers to send upstream
 *
 * @example
 * ```ts
 * appendForwardedHops({ 'x-forwarded-for': '198.51.100.66' }, '127.0.0.1')['x-forwarded-for'] // '198.51.100.66, 127.0.0.1'
 * ```
 */
export function appendForwardedHops(
	headers: IncomingHttpHeaders,
	hop: string,
): OutgoingHttpHeaders {
	const written = headers['x-forwarded-for']
	const claimed = headers.forwarded
	const node = `for=${renderForwardedNode(hop)}`
	return {
		...Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'connection')),
		'x-forwarded-for': written === undefined ? hop : `${String(written)}, ${hop}`,
		forwarded: claimed === undefined ? node : `${String(claimed)}, ${node}`,
	}
}

/** Holds one started proxy fixture: its origin, the hops it appended, and its teardown. */
export interface ProxyFixtureInterface {
	readonly url: string
	readonly hops: readonly string[]
	destroy(): Promise<void>
}

/**
 * Starts a reverse proxy on a loopback port that forwards every request to `target`, appending
 * the client address it read from its own socket to `X-Forwarded-For` and `Forwarded`.
 *
 * @param target - The upstream origin
 * @param peer - The local address the proxy connects upstream from, or `undefined` for the host's choice
 * @returns The fixture, whose `hops` lists every hop it appended, in order
 *
 * @example
 * ```ts
 * const proxy = await startProxy('http://127.0.0.1:8080', '127.0.0.2')
 * ```
 */
export async function startProxy(
	target: string,
	peer: string | undefined,
): Promise<ProxyFixtureInterface> {
	const upstream = new URL(target)
	const hops: string[] = []
	const loopback = await createLoopback(
		createHttpServer((incoming, outgoing) => {
			const hop = incoming.socket.remoteAddress ?? 'unknown'
			hops.push(hop)
			const forwarded = sendHttpRequest(
				{
					host: upstream.hostname,
					port: upstream.port,
					method: incoming.method,
					path: incoming.url,
					headers: appendForwardedHops(incoming.headers, hop),
					agent: false,
					...(peer === undefined ? {} : { localAddress: peer }),
				},
				(reply) => {
					outgoing.writeHead(reply.statusCode ?? 502, reply.rawHeaders)
					reply.pipe(outgoing)
				},
			)
			forwarded.once('error', () => outgoing.destroy())
			incoming.pipe(forwarded)
		}),
	)
	return {
		url: loopback.url,
		get hops() {
			return [...hops]
		},
		destroy: () => loopback.destroy(),
	}
}

/**
 * Refuses to mint a session, as the `mint` option of a stack whose cookie-less requests carry none.
 *
 * @returns `false`
 *
 * @example
 * ```ts
 * createSession({ transport, mint: refuseSession })
 * ```
 */
export function refuseSession(): boolean {
	return false
}

/**
 * Starts one composed stack: a real `Server` from `@orkestrel/server` over a real router
 * dispatcher, the given onion, and a proxy fixture in front of it.
 *
 * @remarks
 * The dispatcher answers `GET /page` with {@link STACK_PAGE}, `GET /token` with the request's
 * CSRF token as JSON, `POST /echo` with the stashed body's `item`, `GET /client` with the resolved client
 * ip, `GET /admin` with `admin`, `GET /redirect` and `POST /redirect` with a `Response.redirect`,
 * `POST /login` and `POST /rotate` after regenerating the session, `GET /moved` with a constructed
 * 302, `GET /mark` after writing the session, `GET /whoami` with that write, `GET /teapot` and
 * `GET /fault` with a throw, `GET /slow` after the deadline aborts its request, `GET /partial` with
 * a handler 206, and `POST /upload` with the parsed multipart form. `createStatic` serves
 * {@link STACK_PAGE} and {@link STACK_TEXT} under `/static`. The session battery records every id it
 * mints or rotates to, through its `create` option.
 *
 * @param options - The order, the forwarded trust, the compression battery, the session capacity, whether a cookie-less request mints no session, and the proxy's upstream address
 * @returns The fixture, whose `stop` ends the server and the proxy and removes the scratch trees
 *
 * @example
 * ```ts
 * const stack = await startStack({ order: STACK_ORDERS.oracle, forwarded: { proxies: 1 }, engine: 'web' })
 * ```
 */
export async function startStack(options: StackOptions): Promise<StackFixtureInterface> {
	const files = createScratch({
		prefix: 'middleware-stack-',
		files: { 'index.html': STACK_PAGE, 'large.txt': STACK_TEXT },
	})
	const uploads = createScratch({ prefix: 'middleware-stack-uploads-' })
	const minted = createRecorder<readonly [string]>()
	const layers: Readonly<Record<StackLayer, MiddlewareHandler<StackState>>> = {
		compression: options.engine === 'node' ? createNodeCompression() : createCompression(),
		security: createSecurity({ hsts: true }),
		cors: createCORS({ origin: [STACK_ORIGIN] }),
		boundary: createBoundary({ expose: false }),
		deadline: createDeadline({ ms: STACK_DEADLINE }),
		forwarded: createForwarded(options.forwarded),
		etag: createETag({ weak: false }),
		bearer: only(
			'/admin',
			createBearer<StackState>({
				verify: (token) => (token === STACK_BEARER ? 'admin' : undefined),
			}),
		),
		limiter: createLimiter({ max: 10_000, window: 60_000 }),
		body: except('/upload', createBody<StackState>()),
		session: createSession<SessionInterface, StackState>({
			transport: createCookieTransport({ secret: STACK_SECRET }),
			store: createMemorySessionStore(
				options.capacity === undefined ? {} : { capacity: options.capacity },
			),
			create: (id) => {
				minted.handler(id)
				return new Session(id)
			},
			...(options.anonymous === true ? { mint: refuseSession } : {}),
		}),
		csrf: createCSRF({ secret: STACK_SECRET }),
		multipart: only('/upload', createMultipart<StackState>({ directory: uploads.path })),
		static: createStatic({ root: files.path, prefix: '/static' }),
	}
	const dispatcher = createDispatcher<StackState>()
	dispatcher.add([
		{
			method: 'GET',
			path: '/page',
			handler: () =>
				new Response(STACK_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
		},
		{
			method: 'GET',
			path: '/token',
			handler: (_request, context) => Response.json({ csrf: context.state.csrf }),
		},
		{
			method: 'POST',
			path: '/echo',
			handler: (_request, context) =>
				Response.json({
					item: isRecord(context.state.body) ? context.state.body.item : undefined,
				}),
		},
		{
			method: 'GET',
			path: '/client',
			handler: (_request, context) => new Response(context.state.client?.ip ?? 'none'),
		},
		{ method: 'GET', path: '/admin', handler: () => new Response('admin') },
		{
			method: 'GET',
			path: '/redirect',
			handler: (_request, context) => Response.redirect(new URL('/page', context.url), 302),
		},
		{
			method: 'POST',
			path: '/redirect',
			handler: (_request, context) => Response.redirect(new URL('/page', context.url), 303),
		},
		{
			method: 'POST',
			path: '/login',
			handler: (_request, context) => {
				context.state.control?.regenerate()
				return Response.redirect(new URL('/page', context.url), 303)
			},
		},
		{
			method: 'POST',
			path: '/rotate',
			handler: (_request, context) => {
				context.state.control?.regenerate()
				return Response.json({ rotated: true })
			},
		},
		{
			method: 'GET',
			path: '/moved',
			handler: () => new Response(null, { status: 302, headers: { location: '/page' } }),
		},
		{
			method: 'GET',
			path: '/mark',
			handler: (_request, context) => {
				context.state.session?.set('mark', 'lamp')
				return new Response('marked')
			},
		},
		{
			method: 'GET',
			path: '/whoami',
			handler: (_request, context) =>
				new Response(String(context.state.session?.state.get('mark') ?? 'none')),
		},
		{
			method: 'GET',
			path: '/teapot',
			handler: () => {
				throw new HTTPError(418, 'teapot')
			},
		},
		{
			method: 'GET',
			path: '/fault',
			handler: () => {
				throw new Error('fault')
			},
		},
		{
			method: 'GET',
			path: '/slow',
			handler: async (request) => {
				await waitForAbort(request.signal)
				return new Response('late')
			},
		},
		{
			method: 'GET',
			path: '/partial',
			handler: () =>
				new Response(STACK_TEXT.slice(0, 5_000), {
					status: 206,
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						'content-range': `bytes 0-4999/${STACK_TEXT.length}`,
					},
				}),
		},
		{
			method: 'POST',
			path: '/upload',
			handler: (_request, context) =>
				Response.json({
					fields: context.state.multipart?.fields,
					files: Object.values(context.state.multipart?.files ?? {})
						.flat()
						.map((file) => ({ field: file.field, name: file.name, size: file.size })),
				}),
		},
	])
	const server = createServer<StackState>({
		dispatcher,
		state: () => ({}),
		host: STACK_LOOPBACK,
		middleware: options.order.map((layer) => layers[layer]),
	})
	const url = `http://${STACK_LOOPBACK}:${await server.start()}`
	const proxy = await startProxy(url, options.peer)
	return {
		url,
		proxy: proxy.url,
		peer: options.peer ?? STACK_LOOPBACK,
		get hops() {
			return proxy.hops
		},
		get ids() {
			return minted.calls.map(([id]) => id)
		},
		stop: async () => {
			await proxy.destroy()
			await server.stop()
			files.destroy()
			uploads.destroy()
		},
	}
}

/**
 * Starts every stack the oracle drives: one per permitted order under `proxies: 1`, one under
 * `trusted`, one per permitted order mounting `createNodeCompression`, one with a session store of
 * {@link STACK_CAPACITY}, and one whose session battery mints no session for a cookie-less
 * request, so `createCSRF` runs on its own nonce.
 *
 * @returns The stacks, whose `stop` ends every one
 *
 * @example
 * ```ts
 * const stacks = await startStacks()
 * await stacks.stop()
 * ```
 */
export async function startStacks(): Promise<StackSetInterface> {
	const alias = await probeLoopbackAlias()
	const base: Omit<StackOptions, 'order'> = {
		forwarded: { proxies: 1 },
		engine: 'web',
		...(alias ? { peer: STACK_PEER } : {}),
	}
	const [
		oracle,
		canonical,
		deadline,
		trusted,
		nodeOracle,
		nodeCanonical,
		nodeDeadline,
		capacity,
		anonymous,
	] = await Promise.all([
		startStack({ ...base, order: STACK_ORDERS.oracle }),
		startStack({ ...base, order: STACK_ORDERS.canonical }),
		startStack({ ...base, order: STACK_ORDERS.deadline }),
		startStack({ ...base, order: STACK_ORDERS.oracle, forwarded: { trusted: [STACK_PEER] } }),
		startStack({ ...base, order: STACK_ORDERS.oracle, engine: 'node' }),
		startStack({ ...base, order: STACK_ORDERS.canonical, engine: 'node' }),
		startStack({ ...base, order: STACK_ORDERS.deadline, engine: 'node' }),
		startStack({ ...base, order: STACK_ORDERS.oracle, capacity: STACK_CAPACITY }),
		startStack({ ...base, order: STACK_ORDERS.oracle, anonymous: true }),
	])
	const all = [
		oracle,
		canonical,
		deadline,
		trusted,
		nodeOracle,
		nodeCanonical,
		nodeDeadline,
		capacity,
		anonymous,
	]
	return {
		orders: { oracle, canonical, deadline },
		trusted,
		nodes: { oracle: nodeOracle, canonical: nodeCanonical, deadline: nodeDeadline },
		capacity,
		anonymous,
		alias,
		stop: async () => {
			await Promise.all(all.map((stack) => stack.stop()))
		},
	}
}

/**
 * Sends one oracle request with `fetch`, never following a redirect, and reads the reply whole.
 *
 * @param origin - The server's or the proxy's origin
 * @param request - The request
 * @param jar - The cookie jar whose header the request carries and whose cookies the reply updates
 * @returns The status, the headers, the raw `Set-Cookie` fields, and the content-decoded body
 *
 * @example
 * ```ts
 * const reply = await sendStack(stack.url, { path: '/page' })
 * ```
 */
export async function sendStack(
	origin: string,
	request: StackRequest,
	jar?: CookieJarInterface,
): Promise<StackReply> {
	const headers = new Headers(request.headers)
	const cookie = jar?.header
	if (cookie !== undefined) headers.set('cookie', cookie)
	const response = await fetch(`${origin}${request.path}`, {
		method: request.method ?? 'GET',
		headers,
		redirect: 'manual',
		...(request.body === undefined ? {} : { body: request.body }),
	})
	const cookies = jar === undefined ? response.headers.getSetCookie() : jar.capture(response)
	const body = new Uint8Array(await response.arrayBuffer())
	return {
		status: response.status,
		headers: response.headers,
		cookies,
		body,
		text: new TextDecoder().decode(body),
	}
}

/**
 * Opens a session the way a page does: a `GET /token` whose cookies join `jar`, and whose body
 * carries the CSRF token the page embeds.
 *
 * @param stack - The stack
 * @param jar - The client's cookie jar
 * @returns The CSRF token
 * @throws When the body carries no string `csrf`
 *
 * @example
 * ```ts
 * const token = await openSession(stack, createCookieJar())
 * ```
 */
export async function openSession(
	stack: StackFixtureInterface,
	jar: CookieJarInterface,
): Promise<string> {
	const reply = await sendStack(stack.url, { path: '/token' }, jar)
	const parsed = attempt((): unknown => JSON.parse(reply.text))
	const token = parsed.success && isRecord(parsed.value) ? parsed.value.csrf : undefined
	return requireValue(isString(token) ? token : undefined, `GET /token answered ${reply.text}`)
}

/**
 * Drives one cell the way a page does: opens a session in `jar`, then sends the cell's request
 * with the token.
 *
 * @param stack - The stack
 * @param cell - The cell
 * @param jar - The client's cookie jar
 * @returns The reply to the cell's request
 *
 * @example
 * ```ts
 * const reply = await driveCell(stack, FAULT_CELLS[0], createCookieJar())
 * ```
 */
export async function driveCell(
	stack: StackFixtureInterface,
	cell: StackCell,
	jar: CookieJarInterface,
): Promise<StackReply> {
	const token = await openSession(stack, jar)
	return sendStack(stack.url, cell.build(token), jar)
}

/**
 * Drives invariant 2's two arms of one cell: the credentialed arm sends the cell's request with
 * the session's token, and the uncredentialed arm sends it from another session without one.
 *
 * @param stack - The stack
 * @param cell - The cell
 * @returns The credentialed arm's status, and whether the uncredentialed arm answered 401 or 403
 *
 * @example
 * ```ts
 * await readArms(stack, ARM_CELLS[0]) // { granted: 200, refused: true }
 * ```
 */
export async function readArms(
	stack: StackFixtureInterface,
	cell: StackCell,
): Promise<{ readonly granted: number; readonly refused: boolean }> {
	const granted = await driveCell(stack, cell, createCookieJar())
	const anonymous = createCookieJar()
	await openSession(stack, anonymous)
	const refused = await sendStack(stack.url, cell.build(undefined), anonymous)
	return { granted: granted.status, refused: refused.status === 401 || refused.status === 403 }
}

/**
 * Drives one invariant 3 cell and pairs the client ip the stack resolved with the address the
 * fixture knows: its own loopback address for a direct request, or the hop the proxy appended.
 *
 * @param stacks - The stacks
 * @param cell - The cell
 * @returns The resolved ip and the expected one
 *
 * @example
 * ```ts
 * const { resolved, expected } = await readForwarded(stacks, FORWARDED_CELLS[0])
 * ```
 */
export async function readForwarded(
	stacks: StackSetInterface,
	cell: StackForwardedCell,
): Promise<{ readonly resolved: string; readonly expected: string }> {
	const stack = cell.trust === 'proxies' ? stacks.orders.oracle : stacks.trusted
	const reply = await sendStack(cell.proxied ? stack.proxy : stack.url, {
		path: '/client',
		headers: cell.headers,
	})
	return {
		resolved: reply.text,
		expected: cell.expect === 'hop' ? requireValue(stack.hops.at(-1)) : STACK_LOOPBACK,
	}
}

/**
 * Drives one invariant 7 cell beside the bare `GET /page` control.
 *
 * @param stack - The stack
 * @param cell - The cell
 * @returns The cell's status and security headers, and the expected ones: the cell's route status and the control's headers
 *
 * @example
 * ```ts
 * const { observed, expected } = await readSecurityCell(stack, HEADER_CELLS[0])
 * ```
 */
export async function readSecurityCell(
	stack: StackFixtureInterface,
	cell: StackStatusCell,
): Promise<{ readonly observed: unknown; readonly expected: unknown }> {
	const control = await sendStack(stack.url, { path: '/page' })
	const reply = await driveCell(stack, cell, createCookieJar())
	return {
		observed: { status: reply.status, headers: readSecurityHeaders(reply.headers) },
		expected: { status: cell.status, headers: readSecurityHeaders(control.headers) },
	}
}

/**
 * Drives one invariant 5 cell and reads its status and whether `Vary` names `Origin`.
 *
 * @param stack - The stack
 * @param cell - The cell
 * @returns The observed status and `Vary` reading, and the expected ones
 *
 * @example
 * ```ts
 * const { observed, expected } = await readVaryCell(stack, VARY_CELLS[0])
 * ```
 */
export async function readVaryCell(
	stack: StackFixtureInterface,
	cell: StackStatusCell,
): Promise<{ readonly observed: unknown; readonly expected: unknown }> {
	const reply = await driveCell(stack, cell, createCookieJar())
	return {
		observed: { status: reply.status, vary: listVary(reply.headers).includes('origin') },
		expected: { status: cell.status ?? reply.status, vary: true },
	}
}

/**
 * Drives one invariant 8 cell on the stack that mounts its compression battery.
 *
 * @param stacks - The stacks
 * @param cell - The cell
 * @returns The status and the `Content-Encoding` value, `null` when absent
 *
 * @example
 * ```ts
 * await readRangeCell(stacks, RANGE_CELLS[0]) // { status: 206, coding: null }
 * ```
 */
export async function readRangeCell(
	stacks: StackSetInterface,
	cell: StackRangeCell,
): Promise<{ readonly status: number; readonly coding: string | null }> {
	const stack = cell.engine === 'node' ? stacks.nodes.oracle : stacks.orders.oracle
	const reply = await sendStack(stack.url, cell.build(undefined))
	return { status: reply.status, coding: reply.headers.get('content-encoding') }
}

/**
 * Drives one invariant 11 cell: the `GET` its cell builds, then the same request carrying the
 * 200's `ETag` in `If-None-Match`.
 *
 * @param stack - The stack
 * @param cell - The cell
 * @returns The 304's status, `ETag`, and `Vary`, and the 200's as the expected reading
 *
 * @example
 * ```ts
 * const { observed, expected } = await readRevalidation(stack, REVALIDATION_CELLS[0])
 * ```
 */
export async function readRevalidation(
	stack: StackFixtureInterface,
	cell: StackCell,
): Promise<{ readonly observed: unknown; readonly expected: unknown }> {
	const request = cell.build(undefined)
	const full = await sendStack(stack.url, request)
	const etag = full.headers.get('etag') ?? ''
	const reply = await sendStack(stack.url, {
		...request,
		headers: { ...request.headers, 'if-none-match': etag },
	})
	return {
		observed: {
			status: reply.status,
			etag: reply.headers.get('etag'),
			vary: listVary(reply.headers),
		},
		expected: { status: 304, etag, vary: listVary(full.headers) },
	}
}

/**
 * Drives one invariant 10 cell under the `oracle` order and under another permitted order.
 *
 * @param stacks - The stacks
 * @param arrangement - The other order
 * @param cell - The cell
 * @returns The content-decoded body under each order
 *
 * @example
 * ```ts
 * const { variant, reference } = await readBodies(stacks, 'canonical', BODY_CELLS[0])
 * ```
 */
export async function readBodies(
	stacks: StackSetInterface,
	arrangement: StackArrangement,
	cell: StackCell,
): Promise<{ readonly variant: Uint8Array; readonly reference: Uint8Array }> {
	const reference = await driveCell(stacks.orders.oracle, cell, createCookieJar())
	const variant = await driveCell(stacks.orders[arrangement], cell, createCookieJar())
	return { variant: variant.body, reference: reference.body }
}

/**
 * Drives invariant 9's flood on the capacity stack: one client writes its session through
 * `GET /mark`, {@link STACK_CAPACITY} cookie-less requests to `path` follow, and the client then
 * reads its session back.
 *
 * @param stack - The capacity stack
 * @param path - The flood's route
 * @returns What `GET /whoami` read: `lamp` while the written session survives, `none` after eviction
 *
 * @example
 * ```ts
 * await readFlood(stacks.capacity, '/page') // 'lamp'
 * ```
 */
export async function readFlood(stack: StackFixtureInterface, path: string): Promise<string> {
	const jar = createCookieJar()
	await sendStack(stack.url, { path: '/mark' }, jar)
	await Promise.all(Array.from({ length: STACK_CAPACITY }, () => sendStack(stack.url, { path })))
	return (await sendStack(stack.url, { path: '/whoami' }, jar)).text
}

/**
 * Detects whether a `Set-Cookie` field carries the `HttpOnly` attribute.
 *
 * @param field - One raw `Set-Cookie` field
 * @returns `true` when an attribute after the pair is `HttpOnly`, in any case
 *
 * @example
 * ```ts
 * isHttpOnlyCookie('sid=abc; Path=/; HttpOnly') // true
 * ```
 */
export function isHttpOnlyCookie(field: string): boolean {
	return field
		.split(';')
		.slice(1)
		.some((attribute) => attribute.trim().toLowerCase() === 'httponly')
}

/**
 * Detects whether a text holds a value: as written, percent-decoded, or inside a base64 or
 * base64url run, to `depth` decodings.
 *
 * @param text - The text a script can read
 * @param value - The value to find
 * @param depth - How many decodings deep to search
 * @returns `true` when some decoding of `text` contains `value`
 *
 * @example
 * ```ts
 * holdsValue(Buffer.from('{"value":"abc"}').toString('base64url'), 'abc') // true
 * ```
 */
export function holdsValue(text: string, value: string, depth = 4): boolean {
	if (text.includes(value)) return true
	if (depth === 0) return false
	const decoded = attempt(() => decodeURIComponent(text))
	if (decoded.success && decoded.value !== text && holdsValue(decoded.value, value, depth - 1))
		return true
	return (text.match(/[A-Za-z0-9+/_-]{8,}/g) ?? []).some((run) =>
		holdsValue(Buffer.from(run, 'base64').toString('latin1'), value, depth - 1),
	)
}

/**
 * Lists every value of a reply a page script can read: the body, each `Set-Cookie` field without
 * `HttpOnly`, and every other header value.
 *
 * @param reply - The reply
 * @returns The script-readable values
 *
 * @example
 * ```ts
 * listScriptValues(reply).some((text) => holdsValue(text, id))
 * ```
 */
export function listScriptValues(reply: StackReply): readonly string[] {
	return [
		reply.text,
		...reply.cookies.filter((field) => !isHttpOnlyCookie(field)),
		...[...reply.headers]
			.filter(([name]) => name !== 'set-cookie')
			.map(([name, value]) => `${name}: ${value}`),
	]
}

/**
 * Lists every script-readable value of a reply that holds one of the session ids.
 *
 * @param reply - The reply
 * @param ids - The session ids the stack minted
 * @returns The holding values; empty when none holds an id
 *
 * @example
 * ```ts
 * listHeldValues(reply, stack.ids) // []
 * ```
 */
export function listHeldValues(reply: StackReply, ids: readonly string[]): readonly string[] {
	return listScriptValues(reply).filter((text) => ids.some((id) => holdsValue(text, id)))
}

/**
 * Reads the {@link SECURITY_HEADERS} of a response, by name.
 *
 * @param headers - The response headers
 * @returns Each declared security header's value, `null` when absent
 *
 * @example
 * ```ts
 * readSecurityHeaders(reply.headers)['x-content-type-options'] // 'nosniff'
 * ```
 */
export function readSecurityHeaders(headers: Headers): Readonly<Record<string, string | null>> {
	return Object.fromEntries(SECURITY_HEADERS.map((name) => [name, headers.get(name)]))
}

/**
 * Lists the field names a `Vary` header carries, lower-cased.
 *
 * @param headers - The response headers
 * @returns The names; empty when the header is absent
 *
 * @example
 * ```ts
 * listVary(new Headers({ vary: 'Accept-Encoding, Origin' })) // ['accept-encoding', 'origin']
 * ```
 */
export function listVary(headers: Headers): readonly string[] {
	return (headers.get('vary') ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name.length > 0)
}

/**
 * Lists the CORS response headers a response carries, by name.
 *
 * @param headers - The response headers
 * @returns Every `access-control-*` header name
 *
 * @example
 * ```ts
 * listCORSHeaders(new Headers({ 'access-control-allow-origin': '*' })) // ['access-control-allow-origin']
 * ```
 */
export function listCORSHeaders(headers: Headers): readonly string[] {
	return [...headers.keys()].filter((name) => name.startsWith('access-control-'))
}
