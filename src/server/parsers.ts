import type { MultipartBody } from '@src/core'
import type { MultipartOptions } from './types.js'
import { MultipartError } from './errors.js'
import { extractMultipartBoundary, resolveMultipartLimits } from './helpers.js'
import { MultipartParser } from './MultipartParser.js'

/**
 * Stream-parses a `multipart/form-data` request into its files and fields —
 * the mid-stream state machine `createMultipart` drives.
 *
 * @remarks
 * Reads `request.body` chunk by chunk through its `ReadableStream` reader —
 * NEVER buffers the whole body — enforcing every {@link MultipartLimits} cap
 * the instant it is exceeded (reading stops, every already-staged temp file
 * is deleted, throws {@link MultipartError} with code `'limit'`). Each file
 * part streams to `join(directory, randomUUID())` — the client's declared
 * filename is METADATA ONLY, never a path component. A field OR file part
 * named `__proto__` / `constructor` / `prototype` is silently skipped and
 * never keyed onto the returned {@link MultipartBody} (a skipped file's
 * staged temp file is unlinked immediately, since it can never be
 * referenced). A file part with an empty declared filename (`filename=""`)
 * AND a zero-byte body — the browser convention for an unselected optional
 * `<input type="file">` — is a silent no-op: its temp file is unlinked, it is
 * never counted against the `file.count` limit, and it never runs the
 * `allowed` check. A malformed
 * structure (missing/unterminated boundary, nameless part, an oversized
 * header block, or a preamble exceeding {@link MULTIPART_MAX_PREAMBLE} before
 * the first boundary) throws with code `'malformed'`. A file is accepted
 * against the configured `allowed` MIME list iff its SNIFFED bytes detect a
 * type present in the list — sniff-authoritative, independent of whether the
 * declared `Content-Type` matches (that agreement is exposed separately as
 * `validated`); otherwise throws with code `'rejected'`. A
 * request abort mid-upload triggers the same fail-closed cleanup as a limit
 * breach. Returns `undefined` for a non-multipart request (untouched).
 *
 * Staging defaults to a process-owned directory created ONCE (lazily,
 * memoized across calls) with `mkdtemp` under `os.tmpdir()` and locked to
 * mode `0o700`; `options.directory` overrides it.
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
	const boundary = extractMultipartBoundary(request.headers.get('content-type'))
	if (boundary === undefined) return undefined
	if (request.body === null) throw new MultipartError('malformed', 'multipart request has no body')

	const limits = resolveMultipartLimits(options.limits)
	const allowed = options.allowed
	const directory = options.directory ?? (await MultipartParser.directory())
	return new MultipartParser(
		request.body,
		request.signal,
		boundary,
		limits,
		allowed,
		directory,
	).parse()
}
