import type { MultipartFile } from '@src/core'

/**
 * One in-memory asset representation returned by an {@link AssetSourceInterface}.
 *
 * @remarks
 * - `body` — the representation bytes. `createAssets` copies them before use.
 * - `encoding` — `'br'` when `body` is Brotli-compressed. Omission means the
 *   bytes are the identity representation.
 */
export interface Asset {
	readonly body: ArrayBuffer | Uint8Array
	readonly encoding?: 'br'
}

/**
 * Read in-memory assets by decoded, browser-build-relative path.
 *
 * @remarks
 * A successful result is cached by `createAssets`; later source changes do
 * not alter that path's response. A miss may be read again on a later request.
 * `read` therefore owes a BOUNDED key set: that cache retains every
 * successful result for the factory's lifetime and evicts nothing.
 */
export interface AssetSourceInterface {
	/**
	 * Read one asset representation.
	 *
	 * @param path - The validated relative asset path
	 * @returns The asset, or `undefined` when the path is absent
	 */
	read(path: string): Asset | undefined
}

/**
 * Options for `createAssets` — in-memory identity/Brotli asset serving.
 *
 * @remarks
 * - `source` — the required in-memory asset reader. It MUST answer a bounded
 *   key set and return `undefined` for every key outside it, because
 *   `createAssets` retains every successful result for the factory's lifetime
 *   and evicts nothing. A `source` that synthesizes a representation for an
 *   arbitrary key therefore grows that cache without limit under request
 *   pressure.
 */
export interface AssetOptions {
	readonly source: AssetSourceInterface
}

/**
 * Options for `createStatic` — node `fs`-backed static file serving.
 *
 * @remarks
 * - `root` — the directory every request resolves under, resolved once at
 *   construction. REQUIRED.
 * - `prefix` — a URL path prefix stripped (on a segment boundary) before
 *   resolving under `root`.
 * - `index` — the filename served for a directory hit and by the SPA
 *   fallback; defaults to {@link DEFAULT_STATIC_INDEX}. The fallback serves
 *   it whatever `dotfiles` is set to, because this path is operator-
 *   configured rather than request-derived.
 * - `dotfiles` — the policy for a path with a dotfile segment: `'ignore'`
 *   (falls through to `next()`), `'deny'` (403), or `'allow'` (serves it);
 *   defaults to {@link DEFAULT_STATIC_DOTFILES}.
 * - `cache` — `Cache-Control: max-age=<cache>` in seconds, when set.
 * - `etag` — whether to compute and honor a weak file `ETag`; defaults to `true`.
 * - `fallback` — SPA fallback: `false` (default, off), `true` (on, excluding
 *   {@link DEFAULT_STATIC_FALLBACK_EXCLUDE}), or `{ exclude }` for a custom
 *   excluded prefix. An eligible `GET` or `HEAD` navigation miss answers with
 *   `index` through the SAME handle-`fstat` header block a directly requested
 *   file answers through, so `cache`, `etag`, conditional revalidation,
 *   `HEAD`, and ranges are identical on both routes; `index` reaches the
 *   client through this route whatever `dotfiles` is set to.
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
 * The caller's partial {@link MultipartLimits} — `createMultipart`'s `limits`
 * option, with every member optional.
 *
 * @remarks
 * `resolveMultipartLimits` applies each documented default to an omitted leaf,
 * so a caller states only the caps it wants to move.
 * - `file` — the per-file caps: `size` in bytes, `count` of file parts.
 * - `field` — the per-field caps: `size` in bytes, `count` of text field parts.
 * - `total` — the maximum combined byte size of the whole request body.
 */
export interface MultipartLimitsInput {
	readonly file?: { readonly size?: number; readonly count?: number }
	readonly field?: { readonly size?: number; readonly count?: number }
	readonly total?: number
}

/**
 * Per-category size/count caps `createMultipart` enforces MID-STREAM — the
 * effective limits, every documented default already applied.
 *
 * @remarks
 * - `file.size` — the maximum size in bytes of one uploaded file; defaults to
 *   {@link DEFAULT_MULTIPART_FILE_SIZE}.
 * - `file.count` — the maximum number of file parts; defaults to
 *   {@link DEFAULT_MULTIPART_FILE_COUNT}.
 * - `field.size` — the maximum size in bytes of one text field; defaults to
 *   {@link DEFAULT_MULTIPART_FIELD_SIZE}.
 * - `field.count` — the maximum number of text field parts; defaults to
 *   {@link DEFAULT_MULTIPART_FIELD_COUNT}.
 * - `total` — the maximum combined byte size of the whole request body;
 *   defaults to {@link DEFAULT_MULTIPART_TOTAL}.
 */
export interface MultipartLimits {
	readonly file: { readonly size: number; readonly count: number }
	readonly field: { readonly size: number; readonly count: number }
	readonly total: number
}

/**
 * Options for `createMultipart` — node `fs`/`os`/`crypto`-backed streaming
 * multipart upload parsing.
 *
 * @remarks
 * - `limits` — see {@link MultipartLimitsInput}.
 * - `allowed` — a MIME allow-list validated against SNIFFED (not merely
 *   declared) bytes; an empty array allows nothing. Omitted ⇒ no type
 *   rejection.
 * - `directory` — the directory staged files are written to; defaults to
 *   `os.tmpdir()`.
 */
export interface MultipartOptions {
	readonly limits?: MultipartLimitsInput
	readonly allowed?: readonly string[]
	readonly directory?: string
}

/**
 * Why `createMultipart` rejected a request — the machine-readable code
 * {@link MultipartError} carries and maps onto its HTTP status: `'limit'` →
 * 413, `'malformed'` → 400, `'rejected'` → 415.
 */
export type MultipartErrorCode = 'limit' | 'malformed' | 'rejected'

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
 * - `mime` — the SNIFFED (magic-byte-detected) MIME type when a signature
 *   matches; otherwise the part's declared `Content-Type`; otherwise
 *   {@link DEFAULT_CONTENT_TYPE}. Read `validated` to tell which.
 * - `validated` — `true` when a signature matched AND the sniffed type equals
 *   the declared `Content-Type`, so `mime` is the sniffed fact. `false` means
 *   `mime` may be the client-declared value.
 * - `status` — see {@link UploadStatus}.
 * - `path` — the file's current on-disk path.
 */
export interface UploadedFile extends Omit<MultipartFile, 'status'> {
	readonly status: UploadStatus
}

/**
 * One multipart part's parsed header block — `parsePartHeaders`'s return
 * shape.
 *
 * @remarks
 * - `name` — the `Content-Disposition` `name` parameter, or `undefined` when absent.
 * - `filename` — the `Content-Disposition` `filename` parameter, or `undefined` when absent.
 * - `mime` — the part's declared `Content-Type` header value, or `undefined` when absent.
 */
export interface PartHeaders {
	readonly name: string | undefined
	readonly filename: string | undefined
	readonly mime: string | undefined
}

/**
 * The full field set `createUploadedFile` needs to build an
 * {@link UploadedFile} record.
 *
 * @remarks
 * - `field` — the multipart field name the file was submitted under.
 * - `name` — the client-declared filename (metadata only).
 * - `size` — the file's byte size.
 * - `mime` — the SNIFFED (magic-byte-detected) MIME type when a signature
 *   matches; otherwise the part's declared `Content-Type`; otherwise
 *   {@link DEFAULT_CONTENT_TYPE}.
 * - `validated` — `true` when the sniffed type matches the declared `Content-Type`.
 * - `status` — see {@link UploadStatus}.
 * - `path` — the file's current on-disk path.
 */
export interface UploadedFileInput {
	readonly field: string
	readonly name: string
	readonly size: number
	readonly mime: string
	readonly validated: boolean
	readonly status: UploadStatus
	readonly path: string
}

/**
 * Options for the node face's `createCompression` — `node:zlib`-backed
 * response compression.
 *
 * @remarks
 * - `threshold` — the minimum buffered body size (bytes) worth compressing;
 *   defaults to {@link DEFAULT_COMPRESSION_THRESHOLD}.
 * - `filter` — an additional predicate a response must pass before
 *   compression is attempted; defaults to always-allow. The offered codings
 *   are fixed to {@link NODE_COMPRESSION_ENCODINGS} and are not configurable
 *   (see the peer `Encoding` type limitation documented on
 *   `createCompression`).
 */
export interface NodeCompressionOptions {
	readonly threshold?: number
	readonly filter?: (request: Request, response: Response) => boolean
}
