import type { FileHandle } from 'node:fs/promises'
import type { ScratchInterface } from '@orkestrel/test/server'
import type {
	AssetRepresentation,
	AssetSourceInterface,
	BodyState,
	MultipartState,
	SessionState,
} from '@src/server'
import type { MiddlewareHandler } from '@orkestrel/server'
import {
	createAssets,
	createBearer,
	createBoundary,
	createCSRF,
	createCompression,
	createCookieTransport,
	createCors,
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
} from '@src/server'
import { ContractError, attempt, isRecord } from '@orkestrel/contract'
import { MiddlewareValue, buildStore } from './setup.js'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createScratch } from '@orkestrel/test/server'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { waitForDelay } from '@orkestrel/test'

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
		name: 'createCors',
		factory: 'createCors',
		create: createCors,
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
