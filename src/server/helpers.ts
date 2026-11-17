import type {
	AssetRecord,
	AssetSourceInterface,
	BearerState,
	ByteRange,
	Client,
	ClientState,
	CompressResponseOptions,
	ForeignContract,
	ForwardedOptions,
	MultipartBody,
	SessionCursors,
	SessionInterface,
	SessionLimits,
	SessionSnapshot,
	StaticFile,
	StaticResolution,
	StaticPlan,
	StaticOptions,
	MultipartLimits,
	MultipartLimitsInput,
	PartHeaders,
	UploadedFile,
} from './types.js'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { CompiledPath } from '@orkestrel/router'
import type { Connection, Encoding, MiddlewareContext, SignerInterface } from '@orkestrel/server'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
	computeBodyETag,
	computeClientKey,
	isCompressibleType,
	matchesETag,
	mergeVary,
	negotiateEncoding,
	parseRange,
} from '@orkestrel/server'
import { copyFile, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliDecompressSync, deflate as zlibDeflate, gzip as zlibGzip } from 'node:zlib'
import { matchPath } from '@orkestrel/router'
import type { ContractInterface } from '@orkestrel/contract'
import {
	admitValue,
	attempt,
	ContractError,
	describeFaults,
	extractPath,
	isArrayBuffer,
	isError,
	isFiniteNumber,
	isObject,
	isRecord,
	isString,
	isUint8Array,
	preview,
} from '@orkestrel/contract'
import {
	CHALLENGE_TOKEN,
	CHALLENGE_VALUE,
	CIDR_LENGTH,
	CSRF_LABEL,
	CSRF_NONCE_BYTES,
	CSRF_NONCE_PATTERN,
	DEFAULT_CONTENT_TYPE,
	DEFAULT_STATIC_INDEX,
	DEFAULT_MULTIPART_FIELD_SIZE,
	DEFAULT_MULTIPART_FIELD_COUNT,
	DEFAULT_MULTIPART_FILE_SIZE,
	DEFAULT_MULTIPART_FILE_COUNT,
	DEFAULT_MULTIPART_TOTAL,
	EXTENSION_TYPES,
	IPV4_ADDRESS,
	IPV4_MAPPED_PREFIX,
	RESERVED_DEVICE_NAMES,
} from './constants.js'

/**
 * Checks whether `pathname` is `prefix` itself or lies under it on a segment
 * boundary — the shared under-path test `resolveStaticPath`'s prefix strip
 * and `createStatic`'s SPA-fallback `exclude` both apply, so `exclude:
 * '/api'` matches `/api` and `/api/x` but never `/apifoo`.
 *
 * @param pathname - The request pathname to test
 * @param prefix - The path prefix to test against
 * @returns True if `pathname` equals `prefix` or starts with `prefix` + `/`; false otherwise
 *
 * @example
 * ```ts
 * isUnderPath('/api/x', '/api') // true
 * isUnderPath('/apifoo', '/api') // false
 * ```
 */
export function isUnderPath(pathname: string, prefix: string): boolean {
	if (pathname === prefix) return true
	const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`
	return pathname.startsWith(boundary)
}

/**
 * Checks whether a request pathname matches any compiled scope pattern — the test
 * `only` and `except` apply, through the router's own `matchPath`.
 *
 * @param patterns - The patterns, each compiled by the router's `compilePath`
 * @param pathname - The request pathname, `context.url.pathname`
 * @returns True if any pattern matches `pathname`; false otherwise
 *
 * @example
 * ```ts
 * import { compilePath } from '@orkestrel/router'
 *
 * matchesScope([compilePath('/admin')], '/admin/') // true
 * matchesScope([compilePath('/admin')], '/admin/users') // false
 * ```
 */
export function matchesScope(patterns: readonly CompiledPath[], pathname: string): boolean {
	return patterns.some((pattern) => matchPath(pattern, pathname) !== undefined)
}

/**
 * Resolves the fixed SPA shell path when a static-file miss is eligible for
 * fallback.
 *
 * @remarks
 * `GET` and `HEAD` are both eligible, and resolve the same shell: `HEAD` is
 * defined as `GET` without a body (RFC 9110 §9.3.2), so a navigation probe
 * that answered `404` while its `GET` answered `200` would report a resource
 * the very next request serves.
 *
 * @param root - The configured static root
 * @param index - The configured shell filename
 * @param exclude - The URL prefix excluded from fallback
 * @param method - The request method; only `GET` and `HEAD` are eligible
 * @param pathname - The request pathname
 * @param accept - The request's `Accept` header value
 * @returns The fixed shell path, or `undefined` when fallback is ineligible
 *
 * @example
 * ```ts
 * resolveStaticFallbackPath('/srv/public', 'index.html', '/api', 'GET', '/dashboard', 'text/html')
 * // '/srv/public/index.html'
 * ```
 */
export function resolveStaticFallbackPath(
	root: string,
	index: string,
	exclude: string,
	method: string,
	pathname: string,
	accept: string,
): string | undefined {
	if (method !== 'GET' && method !== 'HEAD') return undefined
	if (extname(pathname) !== '') return undefined
	if (!accept.includes('text/html') && !accept.includes('*/*')) return undefined
	if (isUnderPath(pathname, exclude)) return undefined
	return join(root, index)
}

/**
 * Checks whether `child` is `parent` itself or lies inside it on-disk — the
 * filesystem containment predicate `createStatic` applies to `fs.realpath`
 * output (never to a URL pathname — that is {@link isUnderPath}'s job).
 *
 * @remarks
 * Argument order is `(child, parent)` — deliberately the opposite conceptual
 * order from {@link isUnderPath}`(pathname, prefix)`, so a call site cannot
 * casually swap one predicate in for the other. Built on `path.relative`,
 * this is separator-correct on both POSIX (`/`) and win32 (`\`) — unlike a
 * hardcoded `${parent}/` boundary check, which silently fails to match every
 * realpath on Windows — and case-folds on win32 because `path.relative` does.
 *
 * @param child - The absolute on-disk path to test
 * @param parent - The absolute on-disk directory it must lie under
 * @returns True if `child` equals `parent` or resolves inside it; false otherwise
 *
 * @example
 * ```ts
 * isContainedPath('/srv/public/a.html', '/srv/public') // true
 * isContainedPath('/srv/other/a.html', '/srv/public') // false
 * ```
 */
export function isContainedPath(child: string, parent: string): boolean {
	if (child === parent) return true
	const rel = relative(parent, child)
	return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolves a request pathname to an on-disk path under `root`, or `undefined`
 * when it cannot — the traversal guard, whose algorithm and order are exact:
 * strip `prefix` on a segment boundary → `decodeURIComponent` (a
 * malformed escape refuses, never throws) → reject a NUL byte → strip the
 * leading path separator first (so a leading `..` survives `normalize` as a
 * genuine climbing segment) → `normalize` → refuse any Windows
 * reserved-device-name segment ({@link isReservedDeviceName}) → `resolve` and
 * require the result under `root`.
 *
 * @param root - The absolute root directory every result must resolve under
 * @param prefix - An optional URL path prefix stripped on a segment boundary
 * @param pathname - The raw request pathname
 * @returns The resolved absolute path under `root`, or `undefined` when the
 * request does not resolve (out of prefix, malformed escape, NUL byte,
 * reserved device name, or an attempted escape from `root`)
 *
 * @example
 * ```ts
 * resolveStaticPath('/srv/public', '/api', '/api/../../etc/passwd') // undefined
 * ```
 */
export function resolveStaticPath(
	root: string,
	prefix: string | undefined,
	pathname: string,
): string | undefined {
	if (prefix !== undefined && !isUnderPath(pathname, prefix)) return undefined
	const remainder =
		prefix === undefined ? pathname : pathname === prefix ? '/' : pathname.slice(prefix.length)
	const decodedResult = attempt(() => decodeURIComponent(remainder))
	if (!decodedResult.success) return undefined
	const decoded = decodedResult.value
	if (decoded.includes('\0')) return undefined
	const stripped = decoded.replace(/^[/\\]+/, '')
	const normalized = normalize(stripped)
	const segments = normalized.split(/[/\\]+/).filter((segment) => segment.length > 0)
	for (const segment of segments) if (isReservedDeviceName(segment)) return undefined
	const resolved = resolve(root, normalized)
	return isContainedPath(resolved, root) ? resolved : undefined
}

/**
 * Canonicalizes `candidate` and returns it only when it lies inside `rootReal`
 * — the shared realpath-then-contain step `createStatic` applies to a
 * directory index and to its SPA shell.
 *
 * @remarks
 * Total: a `realpath` failure (a dangling symlink, a missing file, a
 * permission refusal) and an escape from `rootReal` both resolve `undefined`,
 * so a caller that treats those two outcomes identically needs no `try`. A
 * caller that must tell them apart keeps its own explicit branch instead.
 *
 * @param candidate - The on-disk path to canonicalize
 * @param rootReal - The already-canonical root the result must lie under
 * @returns The canonical path inside `rootReal`, or `undefined`
 *
 * @example
 * ```ts
 * await resolveContainedRealPath('/srv/public/index.html', '/srv/public')
 * // '/srv/public/index.html'
 * ```
 */
export async function resolveContainedRealPath(
	candidate: string,
	rootReal: string,
): Promise<string | undefined> {
	try {
		const real = await realpath(candidate)
		return isContainedPath(real, rootReal) ? real : undefined
	} catch {
		return undefined
	}
}

/**
 * Checks whether a path segment is a Windows reserved device name (CVE-2025-27210).
 *
 * @remarks
 * Normalizes superscript digits (`¹²³` → `123`) first, strips trailing dots
 * and spaces (Windows drops them), takes the stem before the first `.`,
 * upper-cases it, and tests it against {@link RESERVED_DEVICE_NAMES}
 * (`CON PRN AUX NUL COM1-9 LPT1-9`) — an exact-stem match only, so
 * `console.js` and `nullable.css` are never flagged.
 *
 * @param segment - One path segment (no separators)
 * @returns True if `segment` names a reserved device; false otherwise
 *
 * @example
 * ```ts
 * isReservedDeviceName('NUL.json') // true
 * isReservedDeviceName('nullable.css') // false
 * isReservedDeviceName('CON¹') // true
 * ```
 */
export function isReservedDeviceName(segment: string): boolean {
	const superscripted = segment.replace(/[¹²³]/g, (digit) =>
		digit === '¹' ? '1' : digit === '²' ? '2' : '3',
	)
	const trimmed = superscripted.replace(/[. ]+$/, '')
	const stem = trimmed.split('.')[0]
	if (stem === undefined || stem.length === 0) return false
	return RESERVED_DEVICE_NAMES.has(stem.toUpperCase())
}

/**
 * Checks whether a relative path (already resolved under a static root) has any
 * segment starting with `.` — a dotfile or dot-directory.
 *
 * @param relativePath - A path relative to the static root
 * @returns True if any segment starts with `.`; false otherwise
 *
 * @example
 * ```ts
 * isDotfilePath('.env') // true
 * isDotfilePath('a/.git/config') // true
 * ```
 */
export function isDotfilePath(relativePath: string): boolean {
	return relativePath.split(/[/\\]+/).some((segment) => segment.startsWith('.'))
}

/**
 * Looks up the MIME type for a static file path by its extension.
 *
 * @param pathname - The file's path (only its extension is read)
 * @returns The mapped MIME type, or {@link DEFAULT_CONTENT_TYPE} when unknown
 *
 * @example
 * ```ts
 * lookupContentType('/a/b.css') // 'text/css; charset=utf-8'
 * ```
 */
export function lookupContentType(pathname: string): string {
	const extension = extname(pathname).toLowerCase()
	const mapped = EXTENSION_TYPES[extension]
	return mapped ?? DEFAULT_CONTENT_TYPE
}

/**
 * Computes a static file's weak ETag from its size and modification time.
 *
 * @param size - The file's byte size
 * @param mtimeMs - The file's modification time in milliseconds
 * @returns A weak entity-tag `W/"<size>-<floor(mtimeMs)>"`
 *
 * @example
 * ```ts
 * computeFileETag(1024, 1700000000123.4) // 'W/"1024-1700000000123"'
 * ```
 */
export function computeFileETag(size: number, mtimeMs: number): string {
	return `W/"${size}-${Math.floor(mtimeMs)}"`
}

/**
 * Compresses response bytes with Node's guaranteed zlib gzip/deflate codecs.
 *
 * @param bytes - The uncompressed response bytes
 * @param encoding - The negotiated actionable coding
 * @returns The compressed bytes
 *
 * @example
 * ```ts
 * const bytes = new TextEncoder().encode('compress me')
 * const compressed = await compressNodeBytes(bytes, 'deflate')
 * ```
 */
export async function compressNodeBytes(
	bytes: Uint8Array<ArrayBuffer>,
	encoding: Exclude<Encoding, 'identity'>,
): Promise<Uint8Array<ArrayBuffer>> {
	const compressed =
		encoding === 'gzip' ? await promisify(zlibGzip)(bytes) : await promisify(zlibDeflate)(bytes)
	return Uint8Array.from(compressed)
}

/**
 * Sniffs a MIME type from a file's leading bytes against a small magic-byte
 * table (jpeg, png, gif87a/89a, webp, pdf, zip).
 *
 * @remarks
 * `createMultipart`'s `allowed` check reads this signal alone and never the
 * declared `Content-Type`, so a file whose bytes match no signature can never
 * be placed on an `allowed` list. The record's `mime` field is a different
 * question: it falls back to the declared `Content-Type` (then to
 * {@link DEFAULT_CONTENT_TYPE}) when nothing sniffs, and its `validated` flag
 * reports whether the sniffed and declared types agreed.
 *
 * @param head - The file's first bytes (16 is sufficient for every signature)
 * @returns The detected MIME type, or `undefined` when no signature matches
 *
 * @example
 * ```ts
 * detectMIME(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) // 'image/png'
 * ```
 */
export function detectMIME(head: Uint8Array): string | undefined {
	if (matchesBytes(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (matchesBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (matchesBytes(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
	if (matchesBytes(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
	if (
		matchesBytes(head, [0x52, 0x49, 0x46, 0x46]) &&
		matchesBytes(head, [0x57, 0x45, 0x42, 0x50], 8)
	)
		return 'image/webp'
	if (matchesBytes(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
	if (
		matchesBytes(head, [0x50, 0x4b, 0x03, 0x04]) ||
		matchesBytes(head, [0x50, 0x4b, 0x05, 0x06]) ||
		matchesBytes(head, [0x50, 0x4b, 0x07, 0x08])
	)
		return 'application/zip'
	return undefined
}

/**
 * Checks whether `bytes` contains `signature` at the requested offset.
 *
 * @param bytes - The bytes to inspect
 * @param signature - The exact byte sequence to match
 * @param offset - The starting byte offset, defaulting to zero
 * @returns True if the complete signature matches; false otherwise
 *
 * @example
 * ```ts
 * matchesBytes(Uint8Array.from([0, 0x50, 0x4b]), [0x50, 0x4b], 1) // true
 * ```
 */
export function matchesBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false
	return signature.keys().every((index) => bytes[offset + index] === signature[index])
}

/**
 * Extracts the `boundary` parameter from a `Content-Type` header, or
 * `undefined` when the request is not `multipart/form-data`.
 *
 * @param contentType - The request's `Content-Type` header value, if present
 * @returns The multipart boundary token, or `undefined` for a non-multipart
 * (or malformed/boundary-less) content type
 *
 * @example
 * ```ts
 * extractMultipartBoundary('multipart/form-data; boundary=abc123') // 'abc123'
 * extractMultipartBoundary('application/json') // undefined
 * ```
 */
export function extractMultipartBoundary(contentType: string | null): string | undefined {
	if (contentType === null) return undefined
	const [type, ...params] = contentType.split(';').map((part) => part.trim())
	if (type === undefined || type.toLowerCase() !== 'multipart/form-data') return undefined
	for (const param of params) {
		const equals = param.indexOf('=')
		if (equals === -1) continue
		const key = param.slice(0, equals).trim().toLowerCase()
		if (key !== 'boundary') continue
		const raw = param.slice(equals + 1).trim()
		const value =
			raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw
		return value.length > 0 ? value : undefined
	}
	return undefined
}

/**
 * Resolves `createMultipart`'s effective {@link MultipartLimits}, applying
 * every documented default to an omitted leaf.
 *
 * @param limits - The caller's partial limits
 * @returns The fully-resolved limits
 *
 * @example
 * ```ts
 * resolveMultipartLimits({ file: { size: 1_048_576 } })
 * ```
 */
export function resolveMultipartLimits(limits: MultipartLimitsInput | undefined): MultipartLimits {
	return {
		file: {
			size: limits?.file?.size ?? DEFAULT_MULTIPART_FILE_SIZE,
			count: limits?.file?.count ?? DEFAULT_MULTIPART_FILE_COUNT,
		},
		field: {
			size: limits?.field?.size ?? DEFAULT_MULTIPART_FIELD_SIZE,
			count: limits?.field?.count ?? DEFAULT_MULTIPART_FIELD_COUNT,
		},
		total: limits?.total ?? DEFAULT_MULTIPART_TOTAL,
	}
}

/**
 * Parses one multipart part's raw header block into its `name` (from
 * `Content-Disposition`), optional `filename`, and optional `Content-Type`.
 *
 * @param block - The raw header block for one multipart part (before the
 * terminating blank line)
 * @returns The parsed `name`, `filename`, and `mime` (each `undefined` when
 * absent)
 *
 * @example
 * ```ts
 * parsePartHeaders('Content-Disposition: form-data; name="title"')
 * // { name: 'title', filename: undefined, mime: undefined }
 * ```
 */
export function parsePartHeaders(block: string): PartHeaders {
	return block.split('\r\n').reduce<PartHeaders>(
		(headers, line) => {
			const colon = line.indexOf(':')
			if (colon === -1) return headers
			const key = line.slice(0, colon).trim().toLowerCase()
			const value = line.slice(colon + 1).trim()
			if (key === 'content-disposition') {
				const nameMatch = /;\s*name="([^"]*)"/.exec(value)
				const filenameMatch = /;\s*filename="([^"]*)"/.exec(value)
				return {
					...headers,
					name: nameMatch === null ? headers.name : nameMatch[1],
					filename: filenameMatch === null ? headers.filename : filenameMatch[1],
				}
			}
			return key === 'content-type' ? { ...headers, mime: value } : headers
		},
		{ name: undefined, filename: undefined, mime: undefined },
	)
}

/**
 * Attempts to unlink every still-`'staged'` file in a parsed
 * {@link MultipartBody} — the fail-closed cleanup `createMultipart` runs when
 * its downstream handler throws, mirroring `parseMultipartRequest`'s own
 * cleanup pattern (a missing file is already gone; failures are swallowed).
 *
 * @param body - The parsed multipart body to clean up
 * @returns A promise that resolves once every staged file has been attempted
 *
 * @example
 * ```ts
 * await unlinkStagedFiles(body)
 * ```
 */
export async function unlinkStagedFiles(body: MultipartBody): Promise<void> {
	for (const records of Object.values(body.files)) {
		for (const file of records) {
			if (file.status !== 'staged') continue
			try {
				await unlink(file.path)
			} catch {
				// Already gone — cleanup is best-effort.
			}
		}
	}
}

/**
 * Adapts a `node:fs` read stream over a file path (or an already-open
 * `FileHandle`) into a DOM-compatible `ReadableStream<Uint8Array>` — the
 * single shared node↔web stream bridge every static-file and uploaded-file
 * response body routes through.
 *
 * @remarks
 * Pull-driven, not push-driven: the underlying node stream's async iterator
 * is only advanced (`iterator.next()`) from inside `pull(controller)`, which
 * the web `ReadableStream` invokes exactly when its internal queue has room
 * for more data. Exactly one disk chunk is read and enqueued per `pull` —
 * never more — so a slow or stalled consumer (a stalled HTTP connection)
 * stops triggering `pull` calls and the source stops reading ahead;
 * this is genuine consumer backpressure, not the "naturally backpressured"
 * `for await`/`enqueue` pattern (which does not block on a slow consumer at
 * all, because `enqueue` returns synchronously). The controller is closed on
 * iterator completion and errored (never thrown into the process) on a
 * mid-stream read failure. Cancelling the returned `ReadableStream` (for
 * example the consumer aborts the response) calls the iterator's `return()`, which
 * destroys the underlying node read stream so the file descriptor is
 * released. When `source` is a `FileHandle`, `FileHandle.createReadStream`'s
 * default `autoClose` closes the handle on every terminal path (end, error,
 * or `destroy()` through the iterator's `return()`) — the caller never needs a
 * separate `handle.close()` for a `FileHandle` passed as `source`.
 *
 * @param source - The absolute on-disk file path to stream, or an already-open
 * `FileHandle` (for example one already `fstat`'d so the served bytes match the
 * headers computed from that same `fstat`)
 * @param range - An optional inclusive byte range; see {@link ByteRange}
 * @returns A `ReadableStream<Uint8Array>` valid as a fetch `BodyInit`
 *
 * @example
 * ```ts
 * new Response(streamFile('/srv/public/index.html'))
 * ```
 */
export function streamFile(
	source: string | FileHandle,
	range?: ByteRange,
): ReadableStream<Uint8Array> {
	const stream = isString(source)
		? range === undefined
			? createReadStream(source)
			: createReadStream(source, { start: range.start, end: range.end })
		: range === undefined
			? source.createReadStream()
			: source.createReadStream({ start: range.start, end: range.end })
	const iterator: AsyncIterator<unknown> = stream[Symbol.asyncIterator]()
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next()
				if (done) {
					controller.close()
					return
				}
				if (!isUint8Array(value)) {
					await iterator.return?.()
					controller.error(new TypeError('streamFile: read stream yielded a non-Uint8Array chunk'))
					return
				}
				controller.enqueue(value)
			} catch (error) {
				await iterator.return?.()
				controller.error(error)
			}
		},
		async cancel() {
			await iterator.return?.()
		},
	})
}

/**
 * Opens a staged/moved uploaded file as a web `ReadableStream`.
 *
 * @param file - The {@link UploadedFile} record to stream
 * @returns A `ReadableStream<Uint8Array>` over the file's current on-disk path
 *
 * @example
 * ```ts
 * new Response(streamUploadedFile(file))
 * ```
 */
export function streamUploadedFile(file: UploadedFile): ReadableStream<Uint8Array> {
	return streamFile(file.path)
}

/**
 * Reads a staged/moved uploaded file's full contents into memory.
 *
 * @param file - The {@link UploadedFile} record to read
 * @returns The file's bytes
 *
 * @example
 * ```ts
 * const bytes = await readUploadedFile(file)
 * ```
 */
export async function readUploadedFile(file: UploadedFile): Promise<Uint8Array> {
	return readFile(file.path)
}

/**
 * Moves a staged uploaded file to its final `destination`.
 *
 * @remarks
 * Attempts a `rename` first; on a cross-device error (`EXDEV`) falls back to
 * `copyFile` + `unlink`. Returns a new frozen record with `status: 'moved'`
 * and `path: destination` — the input record is never mutated. The suite
 * drives the `EXDEV` fallback only on a host whose device probe finds a
 * second filesystem, so a single-device host leaves that branch unproven.
 *
 * @param file - The {@link UploadedFile} record to move
 * @param destination - The final on-disk path
 * @returns A new {@link UploadedFile} record reflecting the move
 *
 * @example
 * ```ts
 * const moved = await moveUploadedFile(file, '/var/uploads/final.png')
 * ```
 */
export async function moveUploadedFile(
	file: UploadedFile,
	destination: string,
): Promise<UploadedFile> {
	try {
		await rename(file.path, destination)
	} catch (error) {
		// `isRecord` refuses a class instance, and every `node:fs` rejection is
		// an `Error` instance, so the cross-device branch must narrow with
		// `isError` to be reachable at all.
		if (isError(error) && 'code' in error && error.code === 'EXDEV') {
			await copyFile(file.path, destination)
			await unlink(file.path)
		} else {
			throw error
		}
	}
	return Object.freeze({
		field: file.field,
		name: file.name,
		size: file.size,
		mime: file.mime,
		validated: file.validated,
		status: 'moved',
		path: destination,
	})
}
/**
 * Resolves a contained static path, including a directory's index.
 * @param target - The requested absolute path.
 * @param rootReal - The canonical serving root.
 * @param index - The index filename.
 * @returns The canonical path and containment decision, or undefined for an unavailable path.
 */
export async function resolveStaticFile(
	target: string,
	rootReal: string,
	index: string,
): Promise<StaticResolution | undefined> {
	const path = await realpath(target).catch(() => undefined)
	if (path === undefined) return undefined
	if (!isContainedPath(path, rootReal)) return { path, contained: false }
	const info = await stat(path).catch(() => undefined)
	if (info === undefined) return undefined
	const file = info.isDirectory()
		? await resolveContainedRealPath(join(path, index), rootReal)
		: path
	return file === undefined ? undefined : { path: file, contained: true }
}

/**
 * Opens a static file and reads its handle's metadata.
 * @param path - The resolved file path.
 * @returns An open regular file, or undefined after closing any unsuitable handle.
 */
export async function openStaticFile(path: string): Promise<StaticFile | undefined> {
	const handle = await open(path, 'r').catch(() => undefined)
	if (handle === undefined) return undefined
	const info = await handle.stat().catch(() => undefined)
	if (info === undefined || !info.isFile()) {
		await handle.close().catch(() => {})
		return undefined
	}
	return { path, handle, info }
}

/**
 * Plans conditional, HEAD, and byte-range responses from opened-file metadata.
 * @param request - The request carrying conditional and range headers.
 * @param method - The effective request method.
 * @param info - The opened file's metadata.
 * @param path - The path used for content-type selection.
 * @param options - The cache duration and ETag switch.
 * @returns The status, headers, and optional byte range without consuming the file.
 */
export function planStaticResponse(
	request: Request,
	method: string,
	info: Stats,
	path: string,
	options: Pick<StaticOptions, 'cache' | 'etag'>,
): StaticPlan {
	const headers = new Headers({
		'content-type': lookupContentType(path),
		'accept-ranges': 'bytes',
	})
	if (options.cache !== undefined) headers.set('cache-control', `max-age=${options.cache}`)
	if (options.etag !== false) {
		const etag = computeFileETag(info.size, info.mtimeMs)
		headers.set('etag', etag)
		const conditional = request.headers.get('if-none-match')
		if (conditional !== null && matchesETag(conditional, etag)) {
			return { status: 304, headers, range: undefined }
		}
	}
	if (method === 'HEAD') {
		headers.set('content-length', String(info.size))
		return { status: 200, headers, range: undefined }
	}
	const range = parseRange(request.headers.get('range') ?? undefined, info.size)
	if (range === undefined) {
		headers.set('content-length', String(info.size))
		return { status: 200, headers, range: undefined }
	}
	if (!range.satisfiable) {
		headers.set('content-range', `bytes */${info.size}`)
		return { status: 416, headers, range: undefined }
	}
	headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
	headers.set('content-length', String(range.end - range.start + 1))
	return { status: 206, headers, range: { start: range.start, end: range.end } }
}
/**
 * Resolves a decoded relative asset key while refusing hidden or traversing segments.
 * @param pathname - The URL pathname.
 * @returns The asset key, or undefined when decoding or validation fails.
 */
export function resolveAssetKey(pathname: string): string | undefined {
	const decoded = attempt(() => decodeURIComponent(pathname))
	if (!decoded.success) return undefined
	const key = decoded.value === '/' ? DEFAULT_STATIC_INDEX : decoded.value.slice(1)
	if (
		key.length === 0 ||
		key.includes('\\') ||
		key.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
		isDotfilePath(key)
	)
		return undefined
	return key
}

/**
 * Copies an asset, derives its identity bytes, and computes their validator.
 * @param source - The bounded asset source.
 * @param key - The validated relative asset key.
 * @returns Owned representations, or undefined on a source miss.
 * @throws {TypeError} When the source returns malformed asset data.
 * @throws {Error} When Brotli data cannot be decompressed.
 */
export async function readAssetRecord(
	source: AssetSourceInterface,
	key: string,
): Promise<AssetRecord | undefined> {
	const asset = source.read(key)
	if (asset === undefined) return undefined
	if (!isObject(asset))
		throw new TypeError('AssetSourceInterface.read must return an AssetRepresentation')
	const body = asset.body
	const encoding = asset.encoding
	if (
		(!isArrayBuffer(body) && !isUint8Array(body)) ||
		(encoding !== undefined && encoding !== 'br')
	)
		throw new TypeError('AssetSourceInterface.read must return an AssetRepresentation')
	const content = isArrayBuffer(body)
		? Uint8Array.from(new Uint8Array(body))
		: Uint8Array.from(body)
	const brotli = encoding === 'br' ? content : undefined
	const identity = brotli === undefined ? content : Uint8Array.from(brotliDecompressSync(brotli))
	return { key, identity, brotli, etag: await computeBodyETag(identity) }
}

/**
 * Builds a conditional asset response with identity or Brotli negotiation.
 * @param request - The request carrying negotiation and conditional headers.
 * @param method - The effective GET or HEAD method.
 * @param record - The cached asset representations.
 * @returns A full, HEAD, or not-modified response.
 */
export function buildAssetResponse(
	request: Request,
	method: string,
	record: AssetRecord,
): Response {
	const encoded =
		record.brotli !== undefined &&
		negotiateEncoding(request.headers.get('accept-encoding') ?? '', ['br']) === 'br'
	const body = encoded ? record.brotli : record.identity
	const headers = new Headers({
		'content-type': lookupContentType(record.key),
		etag: record.etag,
		vary: 'accept-encoding',
	})
	if (encoded) headers.set('content-encoding', 'br')
	const cached = request.headers.get('if-none-match')
	if (cached !== null && matchesETag(cached, record.etag))
		return new Response(null, { status: 304, headers })
	headers.set('content-length', String(body.byteLength))
	return new Response(method === 'HEAD' ? undefined : Uint8Array.from(body), { headers })
}

/**
 * Derives `createLimiter`'s default rate-limit bucket key from a request's
 * resolved identity facts.
 *
 * @remarks
 * Prefers a verified bearer token ({@link BearerState.token}) as
 * `token:<value>` only when it is a string, so an object credential falls
 * through; else a resolved client IP ({@link ClientState.client.ip},
 * set when `createForwarded` is mounted) or the raw socket peer
 * (`connection.ip`) collapsed through `computeClientKey`
 * (IPv6 to its `/64` network) as `ip:<key>`; else the literal `ip:unknown`.
 * Never reads `X-Forwarded-For` itself — that trust decision belongs solely
 * to `createForwarded`.
 *
 * @param state - The slices `createLimiter`'s default key may read
 * @param connection - The exchange's connection facts, `context.connection`
 * @returns The bucket key for the request
 *
 * @example
 * ```ts
 * resolveKey({ token: 'abc' }, { encrypted: false }) // 'token:abc'
 * resolveKey({ client: { ip: '2001:db8::1' } }, { encrypted: false }) // 'ip:2001:db8:0:0::/64'
 * ```
 */
export function resolveKey(
	state: BearerState<unknown> & ClientState,
	connection: Connection,
): string {
	if (isString(state.token)) return `token:${state.token}`
	const ip = state.client?.ip ?? connection.ip
	if (ip !== undefined) return `ip:${computeClientKey(ip)}`
	return 'ip:unknown'
}

/**
 * Extracts a token after a case-insensitive scheme and one space.
 * @param raw - The header value.
 * @param scheme - The required scheme, or an empty string for an unprefixed token.
 * @returns The token, or undefined when the prefix does not match.
 */
export function extractBearerToken(raw: string, scheme: string): string | undefined {
	if (scheme === '') return raw
	const prefix = `${scheme.toLowerCase()} `
	return raw.toLowerCase().startsWith(prefix) ? raw.slice(prefix.length) : undefined
}

/**
 * Renders a `WWW-Authenticate` challenge as the scheme alone, or the scheme followed by
 * quoted auth-params in the record's own key order.
 *
 * @remarks
 * Refuses a malformed piece instead of escaping or stripping it, so the header a
 * caller reads is the header it configured.
 *
 * @param scheme - The authentication scheme, an RFC 9110 `token`
 * @param parameters - The auth-params, each name an RFC 9110 `token` and each value limited to the RFC 6750 § 3 character set
 * @param door - The factory name a refusal message leads with; defaults to `'renderChallenge'`
 * @returns The challenge header value
 * @throws {ContractError} Thrown when the scheme or a parameter name is not a `token`, when two names match ignoring case, or when a value holds a character outside `%x20-21 / %x23-5B / %x5D-7E`; the message names the offending piece through `preview`, JSON-encoded and capped
 *
 * @example
 * ```ts
 * renderChallenge('Bearer', { realm: 'taverna' }) // 'Bearer realm="taverna"'
 * ```
 */
export function renderChallenge(
	scheme: string,
	parameters?: Readonly<Record<string, string>>,
	door = 'renderChallenge',
): string {
	if (!CHALLENGE_TOKEN.test(scheme))
		throw new ContractError(
			`${door}: challenge scheme ${preview(scheme)} must be an RFC 9110 token`,
			{ code: 'pattern', context: { path: ['scheme'], shape: door, received: preview(scheme) } },
		)
	const entries = Object.entries(parameters ?? {})
	const rendered = entries.map(([name, value], index) => {
		if (!CHALLENGE_TOKEN.test(name))
			throw new ContractError(
				`${door}: challenge parameter name ${preview(name)} must be an RFC 9110 token`,
				{
					code: 'pattern',
					context: { path: ['challenge', name], shape: door, received: preview(name) },
				},
			)
		if (entries.findIndex(([other]) => other.toLowerCase() === name.toLowerCase()) !== index)
			throw new ContractError(
				`${door}: challenge parameter name ${preview(name)} repeats an earlier name ignoring case`,
				{
					code: 'structure',
					context: { path: ['challenge', name], shape: door, received: preview(name) },
				},
			)
		if (!isString(value) || !CHALLENGE_VALUE.test(value))
			throw new ContractError(
				`${door}: challenge parameter ${preview(name)} value ${preview(value)} must hold only the RFC 6750 § 3 characters %x20-21, %x23-5B, and %x5D-7E`,
				{
					code: 'pattern',
					context: { path: ['challenge', name], shape: door, received: preview(value) },
				},
			)
		return `${name}="${value}"`
	})
	return rendered.length === 0 ? scheme : `${scheme} ${rendered.join(', ')}`
}

/**
 * Extracts a string field from a parsed body record.
 * @param body - The parsed request body.
 * @param field - The token field name.
 * @returns The string field, or undefined when the record or field is absent.
 */
export function extractFieldToken(body: unknown, field: string): string | undefined {
	return isRecord(body) && isString(body[field]) ? body[field] : undefined
}

/**
 * Builds the `Retry-After` header value — whole seconds until a window reset,
 * floored at a minimum of `1`.
 *
 * @param expiry - The window reset instant (same clock unit as `now`)
 * @param now - The current instant
 * @returns The `Retry-After` value in whole seconds, minimum `1`
 *
 * @example
 * ```ts
 * buildRetryAfter(1_500, 1_000) // '1'
 * ```
 */
export function buildRetryAfter(expiry: number, now: number): string {
	const seconds = Math.ceil((expiry - now) / 1000)
	return String(Math.max(1, seconds))
}

/**
 * Builds the draft `RateLimit` structured header field — emitted only when
 * `createLimiter`'s `policy` option is `true`.
 *
 * @param remaining - The requests still admitted this window
 * @param expiry - The window reset instant (same clock unit as `now`)
 * @param now - The current instant
 * @returns The `RateLimit` header value
 *
 * @example
 * ```ts
 * buildRateLimitField(4, 1_500, 1_000) // '"default";r=4;t=1'
 * ```
 */
export function buildRateLimitField(remaining: number, expiry: number, now: number): string {
	const seconds = Math.max(1, Math.ceil((expiry - now) / 1000))
	return `"default";r=${remaining};t=${seconds}`
}

/**
 * Builds the draft `RateLimit-Policy` structured header field — emitted only
 * when `createLimiter`'s `policy` option is `true`.
 *
 * @param max - The window's admitted request count
 * @param window - The window length in milliseconds
 * @returns The `RateLimit-Policy` header value
 *
 * @example
 * ```ts
 * buildRateLimitPolicyField(10, 60_000) // '"default";q=10;w=60'
 * ```
 */
export function buildRateLimitPolicyField(max: number, window: number): string {
	return `"default";q=${max};w=${Math.ceil(window / 1000)}`
}

/**
 * Checks whether a candidate address is a trusted-hop match — an exact match, or a
 * prefix-CIDR match for IPv4 (`/8`–`/32`), with an IPv4-mapped address compared by
 * its embedded IPv4. An IPv6 entry matches by exact string only — there is no IPv6
 * CIDR support.
 *
 * @remarks
 * An IPv4-mapped address (`::ffff:a.b.c.d`, in either case), on either side,
 * compares as its embedded IPv4, so `::ffff:10.0.0.6` matches `10.0.0.6` and
 * `10.0.0.0/8`. A CIDR entry reads its network and the candidate only as four
 * decimal octets from 0 to 255, with no sign, hex digit, leading zero, or empty
 * octet, and its prefix length only as a decimal from 8 to 32; anything else is
 * no match. Any other address or entry, IPv6 included, compares as an exact
 * string, with no zero-compression normalization and no case folding.
 *
 * @param address - The candidate hop address
 * @param entry - One `trusted` roster entry — an exact address or an IPv4 CIDR
 * @returns True if `address` is covered by `entry`; false otherwise
 *
 * @example
 * ```ts
 * matchesTrustedEntry('10.1.2.3', '10.0.0.0/8') // true
 * matchesTrustedEntry('::ffff:10.1.2.3', '10.0.0.0/8') // true
 * matchesTrustedEntry('0x0a.1.2.3', '10.0.0.0/8') // false
 * matchesTrustedEntry('192.168.1.1', '10.0.0.0/8') // false
 * ```
 */
export function matchesTrustedEntry(address: string, entry: string): boolean {
	const candidate = address.replace(IPV4_MAPPED_PREFIX, '')
	const slash = entry.indexOf('/')
	if (slash === -1) return candidate === entry.replace(IPV4_MAPPED_PREFIX, '')
	const network = entry.slice(0, slash)
	const length = entry.slice(slash + 1)
	if (!CIDR_LENGTH.test(length)) return false
	if (!IPV4_ADDRESS.test(network) || !IPV4_ADDRESS.test(candidate)) return false
	const bits = Number(length)
	const networkOctets = network.split('.').map(Number)
	const addressOctets = candidate.split('.').map(Number)
	const networkInt =
		((networkOctets[0] ?? 0) << 24) |
		((networkOctets[1] ?? 0) << 16) |
		((networkOctets[2] ?? 0) << 8) |
		(networkOctets[3] ?? 0)
	const addressInt =
		((addressOctets[0] ?? 0) << 24) |
		((addressOctets[1] ?? 0) << 16) |
		((addressOctets[2] ?? 0) << 8) |
		(addressOctets[3] ?? 0)
	const mask = bits === 32 ? -1 : ~((1 << (32 - bits)) - 1)
	return (networkInt & mask) === (addressInt & mask)
}

/**
 * Resolves the client address from `X-Forwarded-For` and the socket peer —
 * `createForwarded`'s core algorithm.
 *
 * @remarks
 * Reads `X-Forwarded-For` only, and skips its empty entries. With `proxies`
 * set, each of that many proxies appended one hop, so the client is the hop
 * at index `length − proxies`: one proxy resolves the rightmost hop. A header
 * with fewer hops than `proxies` resolves the socket peer. With `trusted` set,
 * the walk starts at the socket peer and moves left through every address
 * that matches the roster ({@link matchesTrustedEntry}); the first address
 * that does not match is the client. An untrusted or unknown socket peer is
 * therefore the client, and its header is never read. When the peer and every
 * hop match, the leftmost hop is the client.
 *
 * @param header - The raw `X-Forwarded-For` header value (comma-separated hops), if present
 * @param trust - The {@link ForwardedOptions} form in force — a trusted hop count or a `trusted` CIDR/exact roster
 * @param peer - The socket peer address, `context.connection.ip`, if known
 * @returns The resolved client address, or `undefined` when the resolution reaches an unknown socket peer
 *
 * @example
 * ```ts
 * resolveForwardedFor('203.0.113.7, 10.0.0.1', { proxies: 1 }, '10.0.0.2') // '10.0.0.1'
 * resolveForwardedFor('203.0.113.7, 10.0.0.1', { trusted: ['10.0.0.0/8'] }, '10.0.0.2') // '203.0.113.7'
 * resolveForwardedFor('203.0.113.7, 10.0.0.1', { trusted: ['10.0.0.0/8'] }, '198.51.100.9') // '198.51.100.9'
 * ```
 */
export function resolveForwardedFor(
	header: string | undefined,
	trust: ForwardedOptions,
	peer: string | undefined,
): string | undefined {
	const hops = (header ?? '')
		.split(',')
		.map((hop) => hop.trim())
		.filter((hop) => hop.length > 0)
	if ('proxies' in trust) {
		const index = hops.length - trust.proxies
		return index >= 0 ? hops[index] : peer
	}
	const chain = [peer, ...hops.toReversed()]
	const index = chain.findIndex(
		(address) =>
			address === undefined || !trust.trusted.some((entry) => matchesTrustedEntry(address, entry)),
	)
	return index === -1 ? chain.at(-1) : chain[index]
}

/**
 * Feature-detects which of `candidates` the runtime's `CompressionStream`
 * actually supports — `createCompression`'s construction-time intersection.
 *
 * @remarks
 * Probes each candidate with `new CompressionStream(candidate)` inside a
 * `try`/`catch`; a coding the runtime rejects is dropped silently. `identity`
 * is never probed (it has no `CompressionStream` coding and is always
 * implicitly acceptable to negotiation).
 *
 * @param candidates - The codings to probe, in preference order
 * @returns The subset of `candidates` the runtime's `CompressionStream` supports, in order
 *
 * @example
 * ```ts
 * detectEncodings(['gzip', 'deflate']) // ['gzip', 'deflate'] on a runtime with both
 * ```
 */
export function detectEncodings(candidates: readonly Encoding[]): readonly Encoding[] {
	const supported: Encoding[] = []
	for (const candidate of candidates) {
		if (candidate === 'identity') continue
		try {
			// Construction throws when the runtime doesn't support this coding;
			// `readable` is checked only to use the instance, never inspected further.
			const stream = new CompressionStream(candidate)
			if (stream.readable) supported.push(candidate)
		} catch {
			// Unsupported coding on this runtime — drop it, never throw.
		}
	}
	return supported
}

/**
 * Compresses bytes with the host-independent `CompressionStream` primitive.
 *
 * @param bytes - The uncompressed response bytes
 * @param encoding - The negotiated actionable coding
 * @returns The compressed bytes, or the original bytes when the platform
 * stream unexpectedly has no readable body
 *
 * @example
 * ```ts
 * const bytes = new TextEncoder().encode('compress me')
 * const compressed = await compressBytes(bytes, 'gzip')
 * ```
 */
export async function compressBytes(
	bytes: Uint8Array<ArrayBuffer>,
	encoding: Exclude<Encoding, 'identity'>,
): Promise<Uint8Array<ArrayBuffer>> {
	const source = new Response(bytes).body
	if (source === null) return bytes
	const compressed = await new Response(
		source.pipeThrough(new CompressionStream(encoding)),
	).arrayBuffer()
	return new Uint8Array(compressed)
}

/**
 * Checks whether a response must skip the compression and ETag buffering pipeline
 * — the shared cheap-skip predicate both batteries apply before ever touching
 * `response.arrayBuffer()`, true for a `HEAD` request, a `204`/`304` or
 * otherwise bodyless response, an `event-stream` response, and a response
 * already carrying the header the caller is about to set.
 *
 * @remarks
 * Buffering an `event-stream` response would hang the connection, so SSE skips
 * whatever its size. `skipHeader` is the header whose presence already answers
 * the question — `Content-Encoding` for compression, `ETag` for the ETag
 * battery.
 *
 * @param method - The request's HTTP method
 * @param response - The candidate response
 * @param skipHeader - The response header whose presence means "already handled"
 * @returns True if the response must be left untouched; false otherwise
 *
 * @example
 * ```ts
 * matchesUnbufferableResponse('GET', new Response(null, { status: 204 }), 'content-encoding') // true
 * ```
 */
export function matchesUnbufferableResponse(
	method: string,
	response: Response,
	skipHeader: string,
): boolean {
	if (method === 'HEAD') return true
	if (response.status === 204 || response.status === 304) return true
	if (response.body === null) return true
	const contentType = response.headers.get('content-type')
	if (contentType !== null && contentType.toLowerCase().startsWith('text/event-stream')) return true
	if (response.headers.has(skipHeader)) return true
	return false
}

/**
 * Checks whether a negotiated `Accept-Encoding` outcome is worth acting on —
 * `createCompression`'s negotiation-eligibility half of the skip list.
 *
 * @param encoding - The negotiated coding, or `undefined` when negotiation failed
 * @returns True if `encoding` names an actionable, non-`identity` coding; false otherwise
 *
 * @example
 * ```ts
 * isCompressionNegotiated('gzip') // true
 * isCompressionNegotiated(undefined) // false
 * ```
 */
export function isCompressionNegotiated(
	encoding: Encoding | undefined,
): encoding is Exclude<Encoding, 'identity'> {
	return encoding !== undefined && encoding !== 'identity'
}

/**
 * Resolves an opt-in, value-bearing security header — `string | boolean`
 * (off by default, `true` uses the secure default), the shape `createSecurity`'s
 * `coep`/`hsts` options use, distinct from the plain value-or-`false` shape
 * `resolveSecurityHeader` (the peer substrate) handles.
 *
 * @param value - The option value — a `string` override, `true` for the secure default, or `false`/`undefined` to omit
 * @param fallback - The secure-default value used when `value` is `true`
 * @returns The header value to set, or `undefined` to omit the header
 *
 * @example
 * ```ts
 * resolveOptInHeader(true, 'require-corp') // 'require-corp'
 * resolveOptInHeader(undefined, 'require-corp') // undefined — omitted
 * ```
 */
export function resolveOptInHeader(
	value: string | boolean | undefined,
	fallback: string,
): string | undefined {
	if (value === true) return fallback
	if (value === false || value === undefined) return undefined
	return value
}

/**
 * Rebuilds a `Response` around a replacement body while preserving its
 * status/statusText — the buffered-response reconstruction shared by the
 * compression and ETag batteries after they have consumed
 * `response.arrayBuffer()`.
 *
 * @param body - The replacement body (already-buffered bytes, or `null`)
 * @param response - The original response whose status/statusText/headers are preserved
 * @param headers - The headers to apply; defaults to a fresh copy of `response.headers`
 * @returns A new `Response` carrying `body` with `response`'s status/statusText
 *
 * @example
 * ```ts
 * rebuildResponse(bytes, response) // same status/statusText, response's headers copied
 * rebuildResponse(bytes, response, headers) // explicit replacement headers
 * ```
 */
export function rebuildResponse(
	body: ConstructorParameters<typeof Response>[0],
	response: Response,
	headers?: ConstructorParameters<typeof Headers>[0],
): Response {
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: headers ?? new Headers(response.headers),
	})
}

/**
 * Runs the shared negotiate → skip → threshold → compress → header-set skeleton
 * `createCompression` and `createNodeCompression` compose — response-body
 * compression over a caller-supplied set of feature-detected codings.
 *
 * @remarks
 * Decision order: {@link matchesUnbufferableResponse} → `options.filter` → stamp
 * `Vary: Accept-Encoding` (every negotiation-eligible response carries it,
 * even when a later skip declines to compress) → `negotiateEncoding` over
 * `options.encodings` → {@link isCompressionNegotiated} → `isCompressibleType`
 * on `Content-Type` → a fast skip when the response already carries a
 * numeric `Content-Length` below `options.threshold` (avoids buffering a
 * body known too small to be worth compressing) → buffer through
 * `response.arrayBuffer()` → a threshold passthrough when the buffered size
 * is still below `options.threshold` → `options.compress` → set
 * `Content-Encoding` and a fresh `Content-Length` through {@link rebuildResponse}.
 * Returns `response` unchanged (aside from the `Vary` stamp) on any skip.
 *
 * @param request - The inbound `Request` (read for `Accept-Encoding`)
 * @param context - The `MiddlewareContext` (read for `context.method`)
 * @param response - The downstream `Response` to consider compressing
 * @param options - See {@link CompressResponseOptions}
 * @returns The original `response` when skipped, or a new compressed `Response`
 *
 * @example
 * ```ts
 * await compressResponse(request, context, response, {
 * 	threshold: 1024,
 * 	encodings: ['gzip'],
 * 	compress: async (bytes, encoding) => gzip(bytes),
 * })
 * ```
 */
export async function compressResponse(
	request: Request,
	context: MiddlewareContext<unknown>,
	response: Response,
	options: CompressResponseOptions,
): Promise<Response> {
	if (matchesUnbufferableResponse(context.method, response, 'content-encoding')) return response
	if (options.filter !== undefined && !options.filter(request, response)) return response
	response.headers.set(
		'vary',
		mergeVary(response.headers.get('vary') ?? undefined, 'Accept-Encoding'),
	)
	const acceptEncoding = request.headers.get('accept-encoding')
	if (acceptEncoding === null) return response
	const negotiated = negotiateEncoding(acceptEncoding, options.encodings)
	if (!isCompressionNegotiated(negotiated)) return response
	const contentType = response.headers.get('content-type')
	if (contentType === null || !isCompressibleType(contentType)) return response
	const declaredLength = response.headers.get('content-length')
	if (declaredLength !== null) {
		const declared = Number(declaredLength)
		if (isFiniteNumber(declared) && declared < options.threshold) return response
	}
	const buffer = await response.arrayBuffer()
	if (buffer.byteLength < options.threshold) return rebuildResponse(buffer, response)
	const compressed = await options.compress(new Uint8Array(buffer), negotiated)
	const headers = new Headers(response.headers)
	headers.set('content-encoding', negotiated)
	headers.set('content-length', String(compressed.byteLength))
	return rebuildResponse(compressed, response, headers)
}

/**
 * Copies every entry of one session's `state` into another — the regenerate
 * state-carry `createSession`'s `control.regenerate()` applies.
 *
 * @param from - The source session whose `state` is copied
 * @param to - The destination session the entries are written into, through
 * its own `set` mutator
 *
 * @example
 * ```ts
 * transferSessionState(oldSession, newSession)
 * ```
 */
export function transferSessionState(from: SessionInterface, to: SessionInterface): void {
	for (const [key, value] of from.state) to.set(key, value)
}

/**
 * Checks whether two session states hold the same keys, each bound to the same value by
 * `Object.is` — the test `createSession` applies to decide whether a handler wrote to a session.
 *
 * @param before - The state the request arrived with, copied before the handler ran
 * @param after - The state after the handler ran
 * @returns True if both hold the same keys and the same values; false otherwise
 *
 * @example
 * ```ts
 * matchesSessionState(new Map([['mark', 'lamp']]), new Map([['mark', 'lamp']])) // true
 * matchesSessionState(new Map([['mark', 'lamp']]), new Map([['mark', 'wick']])) // false
 * ```
 */
export function matchesSessionState(
	before: ReadonlyMap<string, unknown>,
	after: ReadonlyMap<string, unknown>,
): boolean {
	if (before.size !== after.size) return false
	return [...before].every(([key, value]) => after.has(key) && Object.is(after.get(key), value))
}

/**
 * Generates a random nonce: 32 bytes from the platform's cryptographic source, as 43 base64url
 * characters — the nonce `createCSRF` keeps in its cookie and a CSRF token's random part.
 *
 * @returns A nonce that matches {@link CSRF_NONCE_PATTERN}
 *
 * @example
 * ```ts
 * generateNonce() // 'b3Vy…' — 43 base64url characters
 * ```
 */
export function generateNonce(): string {
	return randomBytes(CSRF_NONCE_BYTES).toString('base64url')
}

/**
 * Signs a CSRF token bound to `binding`: `random.signature`, where `signature` is the signer's
 * HMAC over {@link CSRF_LABEL}, `binding`, and `random`, so the token carries no form of the
 * binding.
 *
 * @remarks
 * `random` is a fresh {@link generateNonce} value, so every call returns another token, and every
 * one verifies for `binding`. Its fixed length makes the signed message injective: no other
 * binding and random part spell the same message.
 *
 * @param signer - The signer whose first key signs
 * @param binding - The value the token binds to: a session id, or the battery's nonce
 * @returns The token
 *
 * @example
 * ```ts
 * const token = await signCSRFToken(createSigner('shh'), 'session-7f3a')
 * ```
 */
export async function signCSRFToken(signer: SignerInterface, binding: string): Promise<string> {
	const random = generateNonce()
	return `${random}.${await signer.sign(`${CSRF_LABEL}${binding}${random}`)}`
}

/**
 * Verifies a CSRF token against `binding`: the token's random part must match
 * {@link CSRF_NONCE_PATTERN}, and its signature must be the signer's HMAC over
 * {@link CSRF_LABEL}, `binding`, and that random part, under any held key.
 *
 * @remarks
 * A token with no `.` or a random part outside the pattern answers `false` before the signer is
 * called. The answer is otherwise the signer's: server's `Signer` never rejects, and a consumer
 * signer whose `verify` rejects makes this call reject with its error.
 *
 * @param signer - The signer whose keys verify
 * @param binding - The value the token must be bound to
 * @param token - The submitted token
 * @returns True if the token is a CSRF token bound to `binding`; false otherwise
 *
 * @example
 * ```ts
 * const signer = createSigner('shh')
 * const token = await signCSRFToken(signer, 'session-7f3a')
 * await verifyCSRFToken(signer, 'session-7f3a', token) // true
 * await verifyCSRFToken(signer, 'session-9c1d', token) // false
 * ```
 */
export async function verifyCSRFToken(
	signer: SignerInterface,
	binding: string,
	token: string,
): Promise<boolean> {
	const dot = token.indexOf('.')
	const random = token.slice(0, dot)
	if (dot < 0 || !CSRF_NONCE_PATTERN.test(random)) return false
	return signer.verify(`${CSRF_LABEL}${binding}${random}`, token.slice(dot + 1))
}

/**
 * Determines whether a request is a CORS preflight — an `OPTIONS` request
 * carrying an `Access-Control-Request-Method` header.
 *
 * @param method - The request's HTTP method
 * @param headers - The request's `Headers`
 * @returns True if the request is a CORS preflight `createCors` must answer; false otherwise
 *
 * @example
 * ```ts
 * isPreflight('OPTIONS', new Headers({ 'access-control-request-method': 'POST' })) // true
 * ```
 */
export function isPreflight(method: string, headers: Headers): boolean {
	return method === 'OPTIONS' && headers.has('access-control-request-method')
}

/**
 * Builds the {@link Client} slice `createForwarded` stashes, from the
 * resolved client IP — a leaf shaping helper.
 *
 * @param ip - The resolved client IP, if any
 * @returns The {@link Client} slice value
 *
 * @example
 * ```ts
 * buildClient('203.0.113.7') // { ip: '203.0.113.7' }
 * ```
 */
export function buildClient(ip: string | undefined): Client {
	return { ...(ip !== undefined ? { ip } : {}) }
}

/**
 * Compares two strings in constant time once their lengths match, so a
 * per-character mismatch never changes how long the comparison takes.
 *
 * @remarks
 * Length-guarded XOR-accumulate over char codes: a length mismatch short
 * circuits (safe — the lengths of two independently-generated tokens are
 * not a useful timing signal), but once lengths match every character is
 * compared with no early return, so a per-character mismatch never affects
 * how long the comparison takes.
 *
 * @param a - The first string
 * @param b - The second string
 * @returns True if `a` and `b` are exactly equal; false otherwise
 *
 * @example
 * ```ts
 * equalsConstantTime('abc', 'abc') // true
 * equalsConstantTime('abc', 'abd') // false
 * ```
 */
export function equalsConstantTime(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	const diff = a.matchAll(/[\s\S]/g).reduce((difference, match) => {
		return difference | (match[0].charCodeAt(0) ^ b.charCodeAt(match.index))
	}, 0)
	return diff === 0
}

/**
 * Checks whether a session has aged past its idle timeout or absolute lifetime as
 * of `now` — the pure expiry predicate `MemorySessionStore` delegates to.
 *
 * @param cursors - See {@link SessionCursors}
 * @param now - The current instant (same clock unit as `cursors`)
 * @param limits - See {@link SessionLimits}
 * @returns True if either configured threshold has elapsed; false otherwise
 *
 * @example
 * ```ts
 * sessionExpired({ seen: 0, created: 0 }, 1_000, { ttl: 500 }) // true
 * ```
 */
export function sessionExpired(
	cursors: SessionCursors,
	now: number,
	limits: SessionLimits,
): boolean {
	if (limits.ttl !== undefined && now - cursors.seen >= limits.ttl) return true
	if (limits.lifetime !== undefined && now - cursors.created >= limits.lifetime) return true
	return false
}

/**
 * Admits an options bag whole against its compiled contract, refusing a missing
 * required key, an undeclared key, and a value outside a declared range.
 *
 * @typeParam T - The type the contract admits
 * @param door - The factory name a refusal message leads with
 * @param contract - The compiled contract that declares the bag
 * @param value - The caller's bag, before any default or projection; an absent bag (`undefined`) admits as `{}`
 * @returns Nothing; a successful return means the bag is whole
 * @throws {ContractError} Thrown when the bag is refused; `context.path` holds the first fault's
 * path and `cause` holds the refusal with every fault
 *
 * @example
 * ```ts
 * admitOptions('createETag', ETAG_CONTRACT, { weak: false }) // returns
 * admitOptions('createETag', ETAG_CONTRACT, { strong: true }) // throws a ContractError at ['strong']
 * ```
 */
export function admitOptions<T>(
	door: string,
	contract: ContractInterface<T>,
	value: unknown,
): void {
	const outcome = admitValue(contract, value === undefined ? {} : value)
	if (outcome.success) return
	const first = outcome.error.faults[0]
	throw new ContractError(`${door}: ${describeFaults(outcome.error.faults, contract.schema)}`, {
		code: 'structure',
		context: { path: first === undefined ? [] : extractPath(first), shape: door },
		cause: outcome.error,
	})
}

/**
 * Admits one foreign implementation key against the members its published interface
 * declares, accepting a class instance and unknown members.
 *
 * @param door - The factory name a refusal message leads with
 * @param path - The key's path inside the options bag
 * @param foreign - The {@link ForeignContract} the key's interface declares
 * @param value - The caller's implementation
 * @returns Nothing; a successful return means every declared member is present
 * @throws {ContractError} Thrown when `value` lacks a declared member; `context.path` holds `path`
 *
 * @example
 * ```ts
 * admitForeign('createSession', ['store'], SESSION_STORE_FOREIGN, new MemorySessionStore()) // returns
 * admitForeign('createSession', ['store'], SESSION_STORE_FOREIGN, {}) // throws a ContractError at ['store']
 * ```
 */
export function admitForeign(
	door: string,
	path: readonly string[],
	foreign: ForeignContract,
	value: unknown,
): void {
	if (foreign.is(value)) return
	throw new ContractError(
		`${door}: options.${path.join('.')} must be ${foreign.expected}; received ${preview(value)}`,
		{ code: 'structure', context: { path, shape: door, received: preview(value) } },
	)
}

/**
 * Snapshots a session's `state` into a plain, serializable record — the
 * projection a durable store's `set` writes to disk.
 *
 * @param session - The session to snapshot
 * @returns A {@link SessionSnapshot} whose `state` is a plain-object copy of
 * `session.state`, keyed alongside `session.id`
 *
 * @remarks
 * `state` is built on a null-prototype object (`Object.create(null)`), never
 * a `{}` literal — a session key literally named `__proto__` must round-trip
 * as an own enumerable property instead of hitting `Object.prototype`'s
 * `__proto__` accessor (which would silently drop the entry and risk
 * polluting the shared prototype).
 *
 * @example
 * ```ts
 * snapshotSession(session) // { id: 'abc', state: { userId: 'u_1' } }
 * ```
 */
export function snapshotSession(session: SessionInterface): SessionSnapshot {
	const state: Record<string, unknown> = Object.create(null)
	for (const [key, value] of session.state) state[key] = value
	return { id: session.id, state }
}
