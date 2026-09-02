import type { MultipartErrorCode, StaticOptions } from './types.js'
import type { Encoding } from '@orkestrel/server'

/** Holds the HTTP status `createMultipart` renders for each {@link MultipartErrorCode}. */
export const MULTIPART_STATUS: Readonly<Record<MultipartErrorCode, number>> = Object.freeze({
	limit: 413,
	malformed: 400,
	rejected: 415,
})

/**
 * Holds the `Symbol.for` brand {@link MultipartError} carries so
 * {@link isMultipartError} recognizes an instance across duplicate copies of
 * this package — a registry symbol rather than a module-local `Symbol()`,
 * which would mint an unequal symbol per copy.
 */
export const MULTIPART_ERROR_BRAND: unique symbol = Symbol.for(
	'@orkestrel/middleware.MultipartError',
)

/** Names `createStatic`'s default directory-index filename. */
export const DEFAULT_STATIC_INDEX = 'index.html'

/** Names `createStatic`'s `fallback: true` default excluded path prefix. */
export const DEFAULT_STATIC_FALLBACK_EXCLUDE = '/api'

/** Names `createStatic`'s default policy for a path carrying a dotfile segment. */
export const DEFAULT_STATIC_DOTFILES: NonNullable<StaticOptions['dotfiles']> = 'ignore'

/**
 * Lists the content-codings the node face's `createCompression` offers — the two
 * `node:zlib` guarantees on every Node runtime, so this face never
 * feature-detects.
 */
export const NODE_COMPRESSION_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])

/** Names the MIME type served when a file extension has no known mapping. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Holds `createMultipart`'s default per-file byte-size cap. */
export const DEFAULT_MULTIPART_FILE_SIZE = 10_485_760

/** Holds `createMultipart`'s default maximum file-part count. */
export const DEFAULT_MULTIPART_FILE_COUNT = 10

/** Holds `createMultipart`'s default per-field byte-size cap. */
export const DEFAULT_MULTIPART_FIELD_SIZE = 65_536

/** Holds `createMultipart`'s default maximum field-part count. */
export const DEFAULT_MULTIPART_FIELD_COUNT = 100

/** Holds `createMultipart`'s default combined request-body byte-size cap. */
export const DEFAULT_MULTIPART_TOTAL = 52_428_800

/** Holds the maximum bytes a single multipart part's header block may occupy before it is malformed. */
export const MULTIPART_MAX_HEADER_BLOCK = 16_384

/** Holds the maximum bytes scanned before the first multipart boundary is found before it is malformed. */
export const MULTIPART_MAX_PREAMBLE = 65_536

/**
 * Lists the Windows reserved device-name stems (CVE-2025-27210) — matched
 * case-insensitively against the segment's stem (before its first `.`).
 */
export const RESERVED_DEVICE_NAMES: ReadonlySet<string> = Object.freeze(
	new Set([
		'CON',
		'PRN',
		'AUX',
		'NUL',
		'COM1',
		'COM2',
		'COM3',
		'COM4',
		'COM5',
		'COM6',
		'COM7',
		'COM8',
		'COM9',
		'LPT1',
		'LPT2',
		'LPT3',
		'LPT4',
		'LPT5',
		'LPT6',
		'LPT7',
		'LPT8',
		'LPT9',
	]),
)

/** Holds the file-extension (lowercase, with leading `.`) → MIME type lookup table for static serving. */
export const EXTENSION_TYPES: Readonly<Record<string, string>> = Object.freeze({
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
})
