import type { MultipartBody, MultipartFile } from '@src/core'
import type {
	MultipartLimits,
	MultipartOptions,
	PartHeaders,
	UploadedFileInput,
	UploadedFileInterface,
} from './types.js'
import type { FileHandle } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdtemp, open, readFile, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isRecord } from '@orkestrel/contract'
import { isDangerousKey } from '@orkestrel/server'
import {
	DEFAULT_CONTENT_TYPE,
	DEFAULT_MULTIPART_FIELD,
	DEFAULT_MULTIPART_FIELDS,
	DEFAULT_MULTIPART_FILE,
	DEFAULT_MULTIPART_FILES,
	DEFAULT_MULTIPART_TOTAL,
	EXTENSION_TYPES,
	MULTIPART_MAX_HEADER_BLOCK,
	MULTIPART_MAX_PREAMBLE,
	RESERVED_DEVICE_NAMES,
} from './constants.js'
import { MultipartError } from './errors.js'

// ============================================================================
//  @orkestrel/middleware/server — node-face pure/near-pure leaves (AGENTS §5
//  helpers.ts). The static-file traversal guard, the reserved-device-name and
//  dotfile screens, the extension/MIME lookup, the file ETag formula, the
//  magic-byte MIME sniffer, the multipart boundary parser, the streaming
//  multipart state machine, and the post-parse uploaded-file operations.
// ============================================================================

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
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Resolve a request pathname to an on-disk path UNDER `root`, or `undefined`
 * when it cannot — the traversal guard, EXACT algorithm and order (PROPOSAL
 * §4.14): strip `prefix` on a segment boundary → `decodeURIComponent` (a
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
	if (resolved === root || resolved.startsWith(`${root}${sep}`)) return resolved
	return undefined
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
 * Sniff a MIME type from a file's leading bytes against a small magic-byte
 * table (jpeg, png, gif87a/89a, webp, pdf, zip) — the SNIFF-AUTHORITATIVE
 * signal `createMultipart`'s type validation rests on, never the declared
 * `Content-Type`.
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
	function matches(signature: readonly number[], offset = 0): boolean {
		if (head.length < offset + signature.length) return false
		for (let index = 0; index < signature.length; index += 1)
			if (head[offset + index] !== signature[index]) return false
		return true
	}
	if (matches([0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
	if (matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
	if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
	if (matches([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
	if (
		matches([0x50, 0x4b, 0x03, 0x04]) ||
		matches([0x50, 0x4b, 0x05, 0x06]) ||
		matches([0x50, 0x4b, 0x07, 0x08])
	)
		return 'application/zip'
	return undefined
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
 * Memoized `Promise` for `parseMultipartRequest`'s lazily-created default
 * staging directory — created once per process via {@link resolveDefaultDirectory}.
 */
let defaultDirectory: Promise<string> | undefined

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
	if (defaultDirectory === undefined) {
		defaultDirectory = (async () => {
			const path = await mkdtemp(join(tmpdir(), 'orkestrel-multipart-'))
			await chmod(path, 0o700)
			return path
		})()
	}
	return defaultDirectory
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
 * the mid-stream state machine `createMultipart` drives (PROPOSAL §4.15).
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

	const staged: string[] = []
	const files: Record<string, MultipartFile[]> = Object.create(null)
	const fields: Record<string, string> = Object.create(null)
	let fileCount = 0
	let fieldCount = 0
	let totalBytes = 0
	let aborted = false

	async function cleanup(): Promise<void> {
		for (const path of staged) {
			try {
				await unlink(path)
			} catch {
				// Already gone — cleanup is best-effort.
			}
		}
	}

	const reader = request.body.getReader()
	let buffer = Buffer.alloc(0)
	let ended = false
	const onAbort = (): void => {
		aborted = true
	}
	request.signal.addEventListener('abort', onAbort)

	async function pull(): Promise<boolean> {
		if (aborted || request.signal.aborted)
			throw new MultipartError('malformed', 'request aborted mid-upload')
		if (ended) return false
		const { done, value } = await reader.read()
		if (done) {
			ended = true
			return false
		}
		totalBytes += value.byteLength
		if (totalBytes > limits.total)
			throw new MultipartError('limit', 'multipart body exceeds total limit')
		buffer = Buffer.concat([buffer, Buffer.from(value.buffer, value.byteOffset, value.byteLength)])
		return true
	}

	try {
		const openMarker = Buffer.from(`--${boundary}`)
		let preambleScanned = 0
		let index = buffer.indexOf(openMarker)
		while (index === -1) {
			const carry = openMarker.length - 1
			if (buffer.length > carry) {
				const drop = buffer.length - carry
				preambleScanned += drop
				if (preambleScanned > MULTIPART_MAX_PREAMBLE)
					throw new MultipartError('malformed', 'multipart preamble too large')
				buffer = buffer.subarray(drop)
			}
			if (!(await pull())) throw new MultipartError('malformed', 'missing multipart boundary')
			index = buffer.indexOf(openMarker)
		}
		buffer = buffer.subarray(index + openMarker.length)

		for (;;) {
			while (buffer.length < 2)
				if (!(await pull()))
					throw new MultipartError('malformed', 'unterminated multipart boundary')
			if (buffer[0] === 0x2d && buffer[1] === 0x2d) break
			if (buffer[0] !== 0x0d || buffer[1] !== 0x0a)
				throw new MultipartError('malformed', 'malformed multipart boundary')
			buffer = buffer.subarray(2)

			let headerEnd = buffer.indexOf('\r\n\r\n')
			while (headerEnd === -1) {
				if (buffer.length > MULTIPART_MAX_HEADER_BLOCK)
					throw new MultipartError('malformed', 'multipart header block too large')
				if (!(await pull()))
					throw new MultipartError('malformed', 'unterminated multipart part headers')
				headerEnd = buffer.indexOf('\r\n\r\n')
			}
			const headerBlock = buffer.subarray(0, headerEnd).toString('utf8')
			buffer = buffer.subarray(headerEnd + 4)
			const { name, filename, contentType } = parsePartHeaders(headerBlock)
			if (name === undefined) throw new MultipartError('malformed', 'multipart part missing name')

			const partDelimiter = Buffer.from(`\r\n--${boundary}`)

			if (filename !== undefined) {
				if (filename !== '') {
					fileCount += 1
					if (fileCount > limits.files)
						throw new MultipartError('limit', 'too many multipart files')
				}
				const path = join(directory, randomUUID())
				staged.push(path)
				const handle = await open(path, 'w', 0o600)
				let size = 0
				let head = Buffer.alloc(0)
				try {
					for (;;) {
						const boundaryIndex = buffer.indexOf(partDelimiter)
						if (boundaryIndex === -1) {
							const safeLength = Math.max(0, buffer.length - (partDelimiter.length - 1))
							if (safeLength > 0) {
								const chunk = buffer.subarray(0, safeLength)
								size += chunk.length
								if (size > limits.file)
									throw new MultipartError('limit', 'multipart file exceeds size limit')
								if (head.length < 16)
									head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
								await handle.write(chunk)
								buffer = buffer.subarray(safeLength)
							}
							if (!(await pull()))
								throw new MultipartError('malformed', 'unterminated multipart file part')
							continue
						}
						const chunk = buffer.subarray(0, boundaryIndex)
						size += chunk.length
						if (size > limits.file)
							throw new MultipartError('limit', 'multipart file exceeds size limit')
						if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
						await handle.write(chunk)
						buffer = buffer.subarray(boundaryIndex + 2)
						break
					}
				} finally {
					await handle.close()
				}
				if (filename === '' && size === 0) {
					// Browser empty-optional-file-input convention: an
					// unselected <input type="file"> still submits a part
					// with an empty filename and zero-byte body — a no-op,
					// never counted against the files limit or the allow-list.
					await unlink(path)
					staged.splice(staged.indexOf(path), 1)
				} else {
					if (filename === '') {
						fileCount += 1
						if (fileCount > limits.files)
							throw new MultipartError('limit', 'too many multipart files')
					}
					const detected = detectMIME(head)
					const declared = contentType ?? DEFAULT_CONTENT_TYPE
					const validated = detected !== undefined && detected === declared
					if (allowed !== undefined) {
						const acceptable = detected !== undefined && allowed.includes(detected)
						if (!acceptable)
							throw new MultipartError('rejected', 'multipart file failed type validation')
					}
					if (isDangerousKey(name)) {
						await unlink(path)
						staged.splice(staged.indexOf(path), 1)
					} else {
						const record = createUploadedFile({
							field: name,
							name: filename,
							size,
							mime: detected ?? declared,
							validated,
							status: 'staged',
							path,
						})
						const existing = files[name]
						if (existing === undefined) files[name] = [record]
						else existing.push(record)
					}
				}
			} else {
				fieldCount += 1
				if (fieldCount > limits.fields)
					throw new MultipartError('limit', 'too many multipart fields')
				let value = Buffer.alloc(0)
				for (;;) {
					const boundaryIndex = buffer.indexOf(partDelimiter)
					if (boundaryIndex === -1) {
						const safeLength = Math.max(0, buffer.length - (partDelimiter.length - 1))
						if (safeLength > 0) {
							value = Buffer.concat([value, buffer.subarray(0, safeLength)])
							if (value.length > limits.field)
								throw new MultipartError('limit', 'multipart field exceeds size limit')
							buffer = buffer.subarray(safeLength)
						}
						if (!(await pull()))
							throw new MultipartError('malformed', 'unterminated multipart field part')
						continue
					}
					value = Buffer.concat([value, buffer.subarray(0, boundaryIndex)])
					if (value.length > limits.field)
						throw new MultipartError('limit', 'multipart field exceeds size limit')
					buffer = buffer.subarray(boundaryIndex + 2)
					break
				}
				if (!isDangerousKey(name)) fields[name] = value.toString('utf8')
			}

			while (buffer.length < openMarker.length)
				if (!(await pull()))
					throw new MultipartError('malformed', 'unterminated multipart boundary')
			buffer = buffer.subarray(openMarker.length)
		}
	} catch (error) {
		await cleanup()
		await reader.cancel().catch(() => {})
		throw error
	} finally {
		request.signal.removeEventListener('abort', onAbort)
		if (!ended) await reader.cancel().catch(() => {})
	}

	return { files: Object.freeze(files), fields: Object.freeze(fields) }
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
