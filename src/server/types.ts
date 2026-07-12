import type { MultipartFile } from '@src/core'

// ============================================================================
//  @orkestrel/middleware/server — node-face type surface (AGENTS §5 source of
//  truth). Options for the two node-bound batteries (createStatic,
//  createMultipart) plus the multipart post-parse companion shapes. The
//  request-time multipart state slice (`MultipartState`) and the parsed
//  `MultipartBody`/`MultipartFile` shapes are OWNED by the pure core face
//  (`@src/core`) — imported here, never redeclared, so a consumer can
//  narrow `context.state` without depending on this node-bound face.
// ============================================================================

/**
 * Options for `createStatic` — node `fs`-backed static file serving.
 *
 * @param options - See fields below
 * @remarks
 * - `root` — the directory every request resolves under, resolved once at
 *   construction. REQUIRED.
 * - `prefix` — a URL path prefix stripped (on a segment boundary) before
 *   resolving under `root`.
 * - `index` — the filename served for a directory hit; defaults to
 *   {@link DEFAULT_STATIC_INDEX}.
 * - `dotfiles` — the policy for a path with a dotfile segment: `'ignore'`
 *   (default, falls through to `next()`), `'deny'` (403), or `'allow'`
 *   (serves it).
 * - `cache` — `Cache-Control: max-age=<cache>` in seconds, when set.
 * - `etag` — whether to compute and honor a weak file `ETag`; defaults to `true`.
 * - `fallback` — SPA fallback: `false` (default, off), `true` (on, excluding
 *   {@link DEFAULT_STATIC_FALLBACK_EXCLUDE}), or `{ exclude }` for a custom
 *   excluded prefix.
 */
export interface StaticOptions {
	readonly root: string
	readonly prefix?: string
	readonly index?: string
	readonly dotfiles?: 'ignore' | 'deny' | 'allow'
	readonly cache?: number
	readonly etag?: boolean
	readonly fallback?: boolean | { readonly exclude?: string }
}

/**
 * Per-category size/count caps `createMultipart` enforces MID-STREAM.
 *
 * @remarks
 * - `file` — the maximum size in bytes of one uploaded file; defaults to
 *   {@link DEFAULT_MULTIPART_FILE}.
 * - `files` — the maximum number of file parts; defaults to
 *   {@link DEFAULT_MULTIPART_FILES}.
 * - `field` — the maximum size in bytes of one text field; defaults to
 *   {@link DEFAULT_MULTIPART_FIELD}.
 * - `fields` — the maximum number of text field parts; defaults to
 *   {@link DEFAULT_MULTIPART_FIELDS}.
 * - `total` — the maximum combined byte size of the whole request body;
 *   defaults to {@link DEFAULT_MULTIPART_TOTAL}.
 */
export interface MultipartLimits {
	readonly file?: number
	readonly files?: number
	readonly field?: number
	readonly fields?: number
	readonly total?: number
}

/**
 * Options for `createMultipart` — node `fs`/`os`/`crypto`-backed streaming
 * multipart upload parsing.
 *
 * @param options - See fields below
 * @remarks
 * - `limits` — see {@link MultipartLimits}.
 * - `allowed` — a MIME allow-list validated against SNIFFED (not merely
 *   declared) bytes; an empty array allows nothing. Omitted ⇒ no type
 *   rejection.
 * - `directory` — the directory staged files are written to; defaults to
 *   `os.tmpdir()`.
 */
export interface MultipartOptions {
	readonly limits?: MultipartLimits
	readonly allowed?: readonly string[]
	readonly directory?: string
}

/**
 * Why `createMultipart` rejected a request — the axis {@link MultipartError}
 * maps onto its HTTP status: `'limit'` → 413, `'malformed'` → 400,
 * `'rejected'` → 415.
 */
export type MultipartReason = 'limit' | 'malformed' | 'rejected'

/**
 * The lifecycle stage of one staged upload's temp file.
 *
 * @remarks
 * `'staged'` — written to the configured temp directory under a random name,
 * not yet moved. `'moved'` — relocated by `moveUploadedFile` to its final path.
 */
export type UploadStatus = 'staged' | 'moved'

/**
 * One uploaded file's post-parse record — the node-bound, richer sibling of
 * the pure core's {@link MultipartFile} (identical fields, `status` narrowed
 * to {@link UploadStatus}). Structurally assignable into {@link MultipartFile}
 * so a `createMultipart`-built {@link MultipartBody} satisfies the shared
 * core shape.
 *
 * @remarks
 * - `field` — the multipart field name the file was submitted under.
 * - `name` — the client-declared filename (METADATA ONLY — never used to
 *   build a filesystem path).
 * - `size` — the file's byte size.
 * - `mime` — the SNIFFED (magic-byte-detected) MIME type.
 * - `validated` — `true` when the sniffed type matches the declared
 *   `Content-Type`.
 * - `status` — see {@link UploadStatus}.
 * - `path` — the file's current on-disk path.
 */
export interface UploadedFileInterface extends Omit<MultipartFile, 'status'> {
	readonly status: UploadStatus
}
