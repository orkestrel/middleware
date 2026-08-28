import type { MultipartBody } from '@src/core'
import type {
	MultipartLimits,
	MultipartOptions,
	PartHeaders,
	UploadedFileInput,
	UploadedFileInterface,
} from './types.js'
import type { FileHandle } from 'node:fs/promises'
import type { Encoding } from '@orkestrel/server'
import { createReadStream } from 'node:fs'
import { copyFile, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { deflate as zlibDeflate, gzip as zlibGzip } from 'node:zlib'
import { isRecord } from '@orkestrel/contract'
import {
	DEFAULT_CONTENT_TYPE,
	DEFAULT_MULTIPART_FIELD,
	DEFAULT_MULTIPART_FIELDS,
	DEFAULT_MULTIPART_FILE,
	DEFAULT_MULTIPART_FILES,
	DEFAULT_MULTIPART_TOTAL,
	EXTENSION_TYPES,
	RESERVED_DEVICE_NAMES,
} from './constants.js'
import { MultipartError } from './errors.js'
import { MultipartParser } from './MultipartParser.js'

/**
 * Whether `pathname` is `prefix` itself or lies under it on a SEGMENT
 * boundary — the shared under-path test `resolveStaticPath`'s prefix strip
 * and `createStatic`'s SPA-fallback `exclude` both apply, so `exclude:
 * '/api'` matches `/api` and `/api/x` but never `/apifoo`.
 *
 * @param pathname - The request pathname to test
 * @param prefix - The path prefix to test against
 * @returns `true` when `pathname` equals `prefix` or starts with `prefix` + `/`
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
 * Resolve the fixed SPA shell path when a static-file miss is eligible for
 * fallback.
 *
 * @param root - The configured static root
 * @param index - The configured shell filename
 * @param exclude - The URL prefix excluded from fallback
 * @param method - The request method
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
	if (method !== 'GET') return undefined
	if (extname(pathname) !== '') return undefined
	if (!accept.includes('text/html') && !accept.includes('*/*')) return undefined
	if (isUnderPath(pathname, exclude)) return undefined
	return join(root, index)
}

/**
 * Whether `child` is `parent` itself or lies inside it on-disk — the
 * FILESYSTEM containment predicate `createStatic` applies to `fs.realpath`
 * output (never to a URL pathname — that is {@link isUnderPath}'s job).
 *
 * @remarks
 * Argument order is `(child, parent)` — deliberately the OPPOSITE conceptual
 * order from {@link isUnderPath}`(pathname, prefix)`, so a call site cannot
 * casually swap one predicate in for the other. Built on `path.relative`,
 * this is separator-correct on both POSIX (`/`) and win32 (`\`) — unlike a
 * hardcoded `${parent}/` boundary check, which silently fails to match every
 * realpath on Windows — and case-folds on win32 because `path.relative` does.
 *
 * @param child - The absolute on-disk path to test
 * @param parent - The absolute on-disk directory it must lie under
 * @returns `true` when `child` equals `parent` or resolves inside it
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
 * Resolve a request pathname to an on-disk path UNDER `root`, or `undefined`
 * when it cannot — the traversal guard, whose algorithm and order are exact:
 * strip `prefix` on a segment boundary → `decodeURIComponent` (a
 * malformed escape refuses, never throws) → reject a NUL byte → strip the
 * leading path separator FIRST (so a leading `..` survives `normalize` as a
 * genuine climbing segment) → `normalize` → refuse any Windows reserved-
 * device-name segment ({@link isReservedDeviceName}) → `resolve` and require
 * the result under `root`.
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
	let remainder = pathname
	if (prefix !== undefined) {
		if (!isUnderPath(pathname, prefix)) return undefined
		remainder = pathname === prefix ? '/' : pathname.slice(prefix.length)
	}
	let decoded: string
	try {
		decoded = decodeURIComponent(remainder)
	} catch {
		return undefined
	}
	if (decoded.includes('\0')) return undefined
	const stripped = decoded.replace(/^[/\\]+/, '')
	const normalized = normalize(stripped)
	const segments = normalized.split(/[/\\]+/).filter((segment) => segment.length > 0)
	for (const segment of segments) if (isReservedDeviceName(segment)) return undefined
	const resolved = resolve(root, normalized)
	return isContainedPath(resolved, root) ? resolved : undefined
}

/**
 * Canonicalize `candidate` and return it only when it lies inside `rootReal`
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
	let real: string
	try {
		real = await realpath(candidate)
	} catch {
		return undefined
	}
	return isContainedPath(real, rootReal) ? real : undefined
}

/**
 * Whether a path segment is a Windows reserved device name (CVE-2025-27210).
 *
 * @remarks
 * Normalizes superscript digits (`¹²³` → `123`) first, strips trailing dots
 * and spaces (Windows drops them), takes the STEM before the first `.`,
 * upper-cases it, and tests it against {@link RESERVED_DEVICE_NAMES}
 * (`CON PRN AUX NUL COM1-9 LPT1-9`) — an exact-stem match only, so
 * `console.js` and `nullable.css` are never flagged.
 *
 * @param segment - One path segment (no separators)
 * @returns `true` when `segment` names a reserved device
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
 * Whether a relative path (already resolved under a static root) has any
 * segment starting with `.` — a dotfile or dot-directory.
 *
 * @param relativePath - A path relative to the static root
 * @returns `true` when any segment starts with `.`
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
 * Look up the MIME type for a static file path by its extension.
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
 * Compute a static file's weak ETag from its size and modification time.
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
 * Compress response bytes with Node's guaranteed zlib gzip/deflate codecs.
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
 * Sniff a MIME type from a file's leading bytes against a small magic-byte
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
 * Whether `bytes` contains `signature` at the requested offset.
 *
 * @param bytes - The bytes to inspect
 * @param signature - The exact byte sequence to match
 * @param offset - The starting byte offset, defaulting to zero
 * @returns `true` when the complete signature matches
 *
 * @example
 * ```ts
 * matchesBytes(Uint8Array.from([0, 0x50, 0x4b]), [0x50, 0x4b], 1) // true
 * ```
 */
export function matchesBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false
	for (let index = 0; index < signature.length; index += 1)
		if (bytes[offset + index] !== signature[index]) return false
	return true
}

/**
 * Extract the `boundary` parameter from a `Content-Type` header, or
 * `undefined` when the request is not `multipart/form-data`.
 *
 * @param contentType - The request's `Content-Type` header value, if present
 * @returns The multipart boundary token, or `undefined` for a non-multipart
 * (or malformed/boundary-less) content type
 *
 * @example
 * ```ts
 * multipartBoundary('multipart/form-data; boundary=abc123') // 'abc123'
 * multipartBoundary('application/json') // undefined
 * ```
 */
export function multipartBoundary(contentType: string | null): string | undefined {
	if (contentType === null) return undefined
	const [type, ...params] = contentType.split(';').map((part) => part.trim())
	if (type === undefined || type.toLowerCase() !== 'multipart/form-data') return undefined
	for (const param of params) {
		const equals = param.indexOf('=')
		if (equals === -1) continue
		const key = param.slice(0, equals).trim().toLowerCase()
		if (key !== 'boundary') continue
		let value = param.slice(equals + 1).trim()
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
			value = value.slice(1, -1)
		return value.length > 0 ? value : undefined
	}
	return undefined
}

/**
 * Resolve `createMultipart`'s effective {@link MultipartLimits}, applying
 * every documented default.
 *
 * @param limits - The caller's partial limits
 * @returns The fully-resolved limits
 */
export function resolveMultipartLimits(
	limits: MultipartLimits | undefined,
): Required<MultipartLimits> {
	return {
		file: limits?.file ?? DEFAULT_MULTIPART_FILE,
		files: limits?.files ?? DEFAULT_MULTIPART_FILES,
		field: limits?.field ?? DEFAULT_MULTIPART_FIELD,
		fields: limits?.fields ?? DEFAULT_MULTIPART_FIELDS,
		total: limits?.total ?? DEFAULT_MULTIPART_TOTAL,
	}
}

/**
 * Resolve `parseMultipartRequest`'s default staging directory when the
 * caller did not configure one — a process-owned directory created ONCE
 * (lazily, memoized across calls) via `mkdtemp` under `os.tmpdir()` and
 * locked to mode `0o700`.
 *
 * @returns The absolute path of the process-owned staging directory
 *
 * @example
 * ```ts
 * const directory = await resolveDefaultDirectory()
 * ```
 */
export function resolveDefaultDirectory(): Promise<string> {
	return MultipartParser.directory()
}

/**
 * Parse one multipart part's raw header block into its `name` (from
 * `Content-Disposition`), optional `filename`, and optional `Content-Type`.
 *
 * @param block - The raw header block for one multipart part (before the
 * terminating blank line)
 * @returns The parsed `name`, `filename`, and `contentType` (each
 * `undefined` when absent)
 *
 * @example
 * ```ts
 * parsePartHeaders('Content-Disposition: form-data; name="title"')
 * // { name: 'title', filename: undefined, contentType: undefined }
 * ```
 */
export function parsePartHeaders(block: string): PartHeaders {
	let name: string | undefined
	let filename: string | undefined
	let contentType: string | undefined
	for (const line of block.split('\r\n')) {
		const colon = line.indexOf(':')
		if (colon === -1) continue
		const key = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		if (key === 'content-disposition') {
			const nameMatch = /;\s*name="([^"]*)"/.exec(value)
			const filenameMatch = /;\s*filename="([^"]*)"/.exec(value)
			if (nameMatch !== null) name = nameMatch[1]
			if (filenameMatch !== null) filename = filenameMatch[1]
		} else if (key === 'content-type') {
			contentType = value
		}
	}
	return { name, filename, contentType }
}

/**
 * Stream-parse a `multipart/form-data` request into its files and fields —
 * the mid-stream state machine `createMultipart` drives.
 *
 * @remarks
 * Reads `request.body` chunk by chunk via its `ReadableStream` reader —
 * NEVER buffers the whole body — enforcing every {@link MultipartLimits} cap
 * the instant it is exceeded (reading stops, every already-staged temp file
 * is deleted, throws {@link MultipartError} with reason `'limit'`). Each file
 * part streams to `join(directory, randomUUID())` — the client's declared
 * filename is METADATA ONLY, never a path component. A field OR file part
 * named `__proto__` / `constructor` / `prototype` is silently skipped and
 * never keyed onto the returned {@link MultipartBody} (a skipped file's
 * staged temp file is unlinked immediately, since it can never be
 * referenced). A file part with an empty declared filename (`filename=""`)
 * AND a zero-byte body — the browser convention for an unselected optional
 * `<input type="file">` — is a silent no-op: its temp file is unlinked, it is
 * never counted against the `files` limit, and it never runs the `allowed`
 * check. A malformed
 * structure (missing/unterminated boundary, nameless part, an oversized
 * header block, or a preamble exceeding {@link MULTIPART_MAX_PREAMBLE} before
 * the first boundary) throws with reason `'malformed'`. A file is accepted
 * against the configured `allowed` MIME list iff its SNIFFED bytes detect a
 * type present in the list — sniff-authoritative, independent of whether the
 * declared `Content-Type` matches (that agreement is exposed separately as
 * `validated`); otherwise throws with reason `'rejected'`. A
 * request abort mid-upload triggers the same fail-closed cleanup as a limit
 * breach. Returns `undefined` for a non-multipart request (untouched).
 *
 * @param request - The incoming multipart request
 * @param options - See {@link MultipartOptions}
 * @returns The parsed {@link MultipartBody}, or `undefined` when the request
 * is not `multipart/form-data`
 * @throws {MultipartError} On any limit breach, malformed structure, or
 * rejected file type
 *
 * @example
 * ```ts
 * const body = await parseMultipartRequest(request, { allowed: ['image/png'] })
 * ```
 */
export async function parseMultipartRequest(
	request: Request,
	options: MultipartOptions = {},
): Promise<MultipartBody | undefined> {
	const boundary = multipartBoundary(request.headers.get('content-type'))
	if (boundary === undefined) return undefined
	if (request.body === null) throw new MultipartError('malformed', 'multipart request has no body')

	const limits = resolveMultipartLimits(options.limits)
	const allowed = options.allowed
	const directory = options.directory ?? (await resolveDefaultDirectory())
	return new MultipartParser(
		request.body,
		request.signal,
		boundary,
		limits,
		allowed,
		directory,
	).parse()
}

/**
 * Build a frozen {@link UploadedFileInterface} record.
 *
 * @param input - Every field of the record
 * @returns A frozen {@link UploadedFileInterface}
 *
 * @example
 * ```ts
 * createUploadedFile({ field: 'avatar', name: 'a.png', size: 1024, mime: 'image/png', validated: true, status: 'staged', path: '/tmp/x' })
 * ```
 */
export function createUploadedFile(input: UploadedFileInput): UploadedFileInterface {
	return Object.freeze({ ...input })
}

/**
 * Best-effort unlink every still-`'staged'` file in a parsed
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
 * Adapt a `node:fs` read stream over `path` (or an already-open
 * `FileHandle`) into a DOM-compatible `ReadableStream<Uint8Array>` — the
 * single shared node↔web stream bridge every static-file and uploaded-file
 * response body routes through.
 *
 * @remarks
 * PULL-driven, not push-driven: the underlying node stream's async iterator
 * is only advanced (`iterator.next()`) from inside `pull(controller)`, which
 * the web `ReadableStream` invokes exactly when its internal queue has room
 * for more data. Exactly one disk chunk is read and enqueued per `pull` —
 * never more — so a slow or stalled consumer (a stalled HTTP connection)
 * simply stops triggering `pull` calls and the source stops reading ahead;
 * this is genuine consumer backpressure, not the "naturally backpressured"
 * `for await`/`enqueue` pattern (which does not block on a slow consumer at
 * all, since `enqueue` returns synchronously). The controller is closed on
 * iterator completion and errored (never thrown into the process) on a
 * mid-stream read failure. Cancelling the returned `ReadableStream` (e.g. the
 * consumer aborts the response) calls the iterator's `return()`, which
 * destroys the underlying node read stream so the file descriptor is
 * released. When `path` is a `FileHandle`, `FileHandle.createReadStream`'s
 * default `autoClose` closes the handle on every terminal path (end, error,
 * or `destroy()` via the iterator's `return()`) — the caller never needs a
 * separate `handle.close()` for a handle passed here.
 *
 * @param source - The absolute on-disk file path to stream, or an already-open
 * `FileHandle` (e.g. one already `fstat`'d so the served bytes match the
 * headers computed from that same `fstat`)
 * @param range - An optional inclusive byte range (`start`/`end`, both
 * 0-indexed and inclusive, matching `node:fs`'s `createReadStream` options)
 * @returns A `ReadableStream<Uint8Array>` valid as a fetch `BodyInit`
 *
 * @example
 * ```ts
 * new Response(streamFile('/srv/public/index.html'))
 * ```
 */
export function streamFile(
	source: string | FileHandle,
	range?: { readonly start: number; readonly end: number },
): ReadableStream<Uint8Array> {
	const stream =
		typeof source === 'string'
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
				if (!(value instanceof Uint8Array)) {
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
 * Open a staged/moved uploaded file as a web `ReadableStream`.
 *
 * @param file - The {@link UploadedFileInterface} record to stream
 * @returns A `ReadableStream<Uint8Array>` over the file's current on-disk path
 *
 * @example
 * ```ts
 * new Response(streamUploadedFile(file))
 * ```
 */
export function streamUploadedFile(file: UploadedFileInterface): ReadableStream<Uint8Array> {
	return streamFile(file.path)
}

/**
 * Read a staged/moved uploaded file's full contents into memory.
 *
 * @param file - The {@link UploadedFileInterface} record to read
 * @returns The file's bytes
 *
 * @example
 * ```ts
 * const bytes = await readUploadedFile(file)
 * ```
 */
export async function readUploadedFile(file: UploadedFileInterface): Promise<Uint8Array> {
	return readFile(file.path)
}

/**
 * Move a staged uploaded file to its final `destination`.
 *
 * @remarks
 * Attempts a `rename` first; on a cross-device error (`EXDEV`) falls back to
 * `copyFile` + `unlink`. Returns a new frozen record with `status: 'moved'`
 * and `path: destination` — the input record is never mutated.
 *
 * @param file - The {@link UploadedFileInterface} record to move
 * @param destination - The final on-disk path
 * @returns A new {@link UploadedFileInterface} record reflecting the move
 *
 * @example
 * ```ts
 * const moved = await moveUploadedFile(file, '/var/uploads/final.png')
 * ```
 */
export async function moveUploadedFile(
	file: UploadedFileInterface,
	destination: string,
): Promise<UploadedFileInterface> {
	try {
		await rename(file.path, destination)
	} catch (error) {
		if (isRecord(error) && error.code === 'EXDEV') {
			await copyFile(file.path, destination)
			await unlink(file.path)
		} else {
			throw error
		}
	}
	return createUploadedFile({
		field: file.field,
		name: file.name,
		size: file.size,
		mime: file.mime,
		validated: file.validated,
		status: 'moved',
		path: destination,
	})
}
