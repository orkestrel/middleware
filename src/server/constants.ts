import type { MultipartReason } from './types.js'

// ============================================================================
//  @orkestrel/middleware/server — node-face defaults (AGENTS §5
//  constants.ts). Not named in the original dispatch's owned-file list, but
//  added per AGENTS §5 (constants are centralized, never inlined) — the
//  natural completion of the pattern U1 already established on the core
//  face. Documented as a builder latitude decision, not a deviation.
// ============================================================================

/** The HTTP status `createMultipart` renders for each {@link MultipartReason}. */
export const MULTIPART_REASON_STATUS: Readonly<Record<MultipartReason, number>> = Object.freeze({
	limit: 413,
	malformed: 400,
	rejected: 415,
})

/** `createStatic`'s default directory-index filename. */
export const DEFAULT_STATIC_INDEX = 'index.html'

/** `createStatic`'s `fallback: true` default excluded path prefix. */
export const DEFAULT_STATIC_FALLBACK_EXCLUDE = '/api'

/** The MIME type served when a file extension has no known mapping. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** `createMultipart`'s default per-file byte-size cap. */
export const DEFAULT_MULTIPART_FILE = 10_485_760

/** `createMultipart`'s default maximum file-part count. */
export const DEFAULT_MULTIPART_FILES = 10

/** `createMultipart`'s default per-field byte-size cap. */
export const DEFAULT_MULTIPART_FIELD = 65_536

/** `createMultipart`'s default maximum field-part count. */
export const DEFAULT_MULTIPART_FIELDS = 100

/** `createMultipart`'s default combined request-body byte-size cap. */
export const DEFAULT_MULTIPART_TOTAL = 52_428_800

/** The maximum bytes a single multipart part's header block may occupy before it is malformed. */
export const MULTIPART_MAX_HEADER_BLOCK = 16_384

/**
 * Windows reserved device-name stems (CVE-2025-27210) — matched
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

/** File-extension (lowercase, with leading `.`) → MIME type lookup table for static serving. */
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
