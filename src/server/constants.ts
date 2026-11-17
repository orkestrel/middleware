import type { MultipartErrorCode, StaticOptions } from './types.js'
import type { Encoding } from '@orkestrel/server'

/** Holds `1024`, the default minimum buffered body size in bytes `createCompression` will compress. */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024

/**
 * Lists `['gzip', 'deflate']`, the default content-codings `createCompression` offers in
 * preference order — intersected at construction with what the runtime's
 * `CompressionStream` actually supports.
 *
 * @remarks
 * The shipped `@orkestrel/server` peer's {@link Encoding} union is
 * `'gzip' | 'deflate' | 'identity'` — it does not include `'br'` (see the
 * deviation recorded against this constant in the build report). This
 * default therefore offers every non-`identity` coding the peer's type
 * admits; a node-face brotli variant, if one ships, extends this list there.
 */
export const DEFAULT_COMPRESSION_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])

/** Holds `'DENY'`, the default `X-Frame-Options` value `createSecurity` sets. */
export const DEFAULT_FRAME_OPTIONS = 'DENY'

/**
 * Holds `"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"`,
 * the default `Content-Security-Policy` value `createSecurity` sets — a custom
 * `csp` option replaces this wholesale, never merges.
 */
export const DEFAULT_CSP =
	"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"

/** Holds `'strict-origin-when-cross-origin'`, the default `Referrer-Policy` value `createSecurity` sets. */
export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin'

/** Holds `'camera=(), microphone=(), geolocation=()'`, the default `Permissions-Policy` value `createSecurity` sets. */
export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()'

/** Holds `'same-origin'`, the default `Cross-Origin-Opener-Policy` value `createSecurity` sets. */
export const DEFAULT_COOP = 'same-origin'

/** Holds `'same-origin'`, the default `Cross-Origin-Resource-Policy` value `createSecurity` sets. */
export const DEFAULT_CORP = 'same-origin'

/** Holds `'?1'`, the default `Origin-Agent-Cluster` value `createSecurity` sets. */
export const DEFAULT_CLUSTER = '?1'

/** Holds `'require-corp'`, the value `createSecurity` sets for `Cross-Origin-Embedder-Policy` when `coep: true`. */
export const DEFAULT_COEP = 'require-corp'

/** Holds `'max-age=31536000; includeSubDomains'`, the value `createSecurity` sets for `Strict-Transport-Security` when `hsts: true`. */
export const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains'

/** Names `'x-request-id'`, the default header `createSecurity` mints or echoes a request identifier into. */
export const DEFAULT_IDENTIFIER_HEADER = 'x-request-id'

/** Lists the default methods `createCors` advertises on a preflight response. */
export const DEFAULT_CORS_METHODS: readonly string[] = Object.freeze([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
])

/** Lists the default headers `createCors` advertises on a preflight response. */
export const DEFAULT_CORS_HEADERS: readonly string[] = Object.freeze([
	'Content-Type',
	'Authorization',
])

/** Holds `503`, the default response status `createDeadline` returns when its deadline fires first. */
export const DEFAULT_DEADLINE_STATUS = 503

/** Names `'authorization'`, the default header `createBearer` reads the token from. */
export const DEFAULT_BEARER_HEADER = 'authorization'

/** Names `'Bearer'`, the default scheme prefix `createBearer` strips before verification. */
export const DEFAULT_BEARER_SCHEME = 'Bearer'

/** Matches an RFC 9110 `token`, the form a challenge scheme and an auth-param name take. */
export const CHALLENGE_TOKEN = Object.freeze(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u)

/** Matches the characters RFC 6750 § 3 admits in a quoted auth-param value: `%x20-21 / %x23-5B / %x5D-7E`. */
export const CHALLENGE_VALUE = Object.freeze(/^[\x20\x21\x23-\x5B\x5D-\x7E]*$/u)

/** Matches a dotted-decimal IPv4 address: four decimal octets from 0 to 255, with no sign, hex digit, leading zero, or empty octet. */
export const IPV4_ADDRESS = Object.freeze(
	/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u,
)

/** Matches the `::ffff:` prefix, in either case, of an IPv4-mapped IPv6 address written with its embedded dotted IPv4. */
export const IPV4_MAPPED_PREFIX = Object.freeze(/^::ffff:(?=[\d.]+$)/iu)

/** Matches an IPv4 CIDR prefix length `createForwarded`'s roster admits: a decimal from 8 to 32, with no sign or leading zero. */
export const CIDR_LENGTH = Object.freeze(/^(?:[89]|[12]\d|3[0-2])$/u)

/** Holds `10_000`, the default maximum number of distinct rate-limit keys `createLimiter` tracks before LRU eviction. */
export const DEFAULT_LIMITER_CAPACITY = 10_000

/** Holds `10_000`, the default maximum number of distinct session ids `createMemorySessionStore` tracks before least-recently-used eviction. */
export const DEFAULT_SESSION_CAPACITY = 10_000

/** Holds `'rate limit exceeded'`, the default 429 body message `createLimiter` sends when a key is over budget. */
export const DEFAULT_LIMITER_MESSAGE = 'rate limit exceeded'

/** Names `'session'`, the default cookie `createCookieTransport` writes the signed session id under. */
export const DEFAULT_SESSION_COOKIE = 'session'

/** Names `'session-id'`, the default header `createHeaderTransport` carries the session id in. */
export const DEFAULT_SESSION_HEADER = 'session-id'

/** Names `'csrf'`, the default cookie `createCSRF` keeps its nonce in when the client holds no session. */
export const DEFAULT_CSRF_COOKIE = 'csrf'

/** Opens every message `createCSRF` signs; its `:` lies outside the base64url alphabet, so no base64url `signToken` payload equals a CSRF message. */
export const CSRF_LABEL = 'csrf:'

/** Holds `32`, the byte count of a CSRF nonce and of a CSRF token's random part. */
export const CSRF_NONCE_BYTES = 32

/** Matches a CSRF nonce or a CSRF token's random part: the 43 base64url characters that encode {@link CSRF_NONCE_BYTES} bytes. */
export const CSRF_NONCE_PATTERN = Object.freeze(/^[A-Za-z0-9_-]{43}$/)

/** Lists the media types whose body `createCSRF` reads its field from: the two the server decodes to a record. */
export const CSRF_FIELD_TYPES: readonly string[] = Object.freeze([
	'application/json',
	'application/x-www-form-urlencoded',
])

/** Names `'x-csrf-token'`, the default header `createCSRF` reads a mutating request's submitted token from. */
export const DEFAULT_CSRF_HEADER = 'x-csrf-token'

/** Names `'_csrf'`, the default body field `createCSRF` falls back to reading a mutating request's submitted token from. */
export const DEFAULT_CSRF_FIELD = '_csrf'

/** Lists `['GET', 'HEAD', 'OPTIONS']`, the default methods `createCSRF` treats as safe (mint instead of verify). */
export const DEFAULT_CSRF_SAFE_METHODS: readonly string[] = Object.freeze([
	'GET',
	'HEAD',
	'OPTIONS',
])

/**
 * Holds the HTTP status `createMultipart` renders for each {@link MultipartErrorCode}:
 * `'limit'` is 413, `'malformed'` is 400, and `'rejected'` is 415.
 */
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

/** Names `'index.html'`, `createStatic`'s default directory-index filename. */
export const DEFAULT_STATIC_INDEX = 'index.html'

/** Names `'/api'`, `createStatic`'s `fallback: true` default excluded path prefix. */
export const DEFAULT_STATIC_FALLBACK_EXCLUDE = '/api'

/** Names `'ignore'`, `createStatic`'s default policy for a path carrying a dotfile segment. */
export const DEFAULT_STATIC_DOTFILES: NonNullable<StaticOptions['dotfiles']> = 'ignore'

/**
 * Lists `['gzip', 'deflate']`, the content-codings `createNodeCompression`
 * offers — what `node:zlib` guarantees on every Node runtime, so this face never
 * feature-detects.
 */
export const NODE_COMPRESSION_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])

/** Names `'application/octet-stream'`, the MIME type served when a file extension has no known mapping. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Holds `10_485_760`, `createMultipart`'s default per-file byte-size cap. */
export const DEFAULT_MULTIPART_FILE_SIZE = 10_485_760

/** Holds `10`, `createMultipart`'s default maximum file-part count. */
export const DEFAULT_MULTIPART_FILE_COUNT = 10

/** Holds `65_536`, `createMultipart`'s default per-field byte-size cap. */
export const DEFAULT_MULTIPART_FIELD_SIZE = 65_536

/** Holds `100`, `createMultipart`'s default maximum field-part count. */
export const DEFAULT_MULTIPART_FIELD_COUNT = 100

/** Holds `52_428_800`, `createMultipart`'s default combined request-body byte-size cap. */
export const DEFAULT_MULTIPART_TOTAL = 52_428_800

/** Holds `16_384`, the maximum bytes a single multipart part's header block may occupy before it is malformed. */
export const MULTIPART_MAX_HEADER_BLOCK = 16_384

/** Holds `65_536`, the maximum bytes scanned before the first multipart boundary is found before it is malformed. */
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
