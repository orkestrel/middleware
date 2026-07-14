import type { Encoding } from '@orkestrel/server'

// ============================================================================
//  @orkestrel/middleware — battery defaults (AGENTS §5 constants file).
//  Every default named in PROPOSAL.md §4 and the salvaged spec sheet.
//  Frozen where the value is a record/array so a consumer can read but never
//  mutate the shared default.
// ============================================================================

/** Default minimum buffered body size (bytes) `createCompression` will compress. */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024

/**
 * Default content-codings `createCompression` offers, in preference order —
 * intersected at construction with what the runtime's `CompressionStream`
 * actually supports.
 *
 * @remarks
 * The shipped `@orkestrel/server` peer's {@link Encoding} union is
 * `'gzip' | 'deflate' | 'identity'` — it does not include `'br'` (see the
 * deviation recorded against this constant in the build report). This
 * default therefore offers every non-`identity` coding the peer's type
 * admits; a node-face brotli variant, if one ships, extends this list there.
 */
export const DEFAULT_COMPRESSION_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])

/** Default `X-Frame-Options` value `createSecurity` sets. */
export const DEFAULT_FRAME_OPTIONS = 'DENY'

/**
 * Default `Content-Security-Policy` value `createSecurity` sets — a custom
 * `csp` option REPLACES this wholesale, never merges.
 */
export const DEFAULT_CSP =
	"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"

/** Default `Referrer-Policy` value `createSecurity` sets. */
export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin'

/** Default `Permissions-Policy` value `createSecurity` sets. */
export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()'

/** Default `Cross-Origin-Opener-Policy` value `createSecurity` sets. */
export const DEFAULT_COOP = 'same-origin'

/** Default `Cross-Origin-Resource-Policy` value `createSecurity` sets. */
export const DEFAULT_CORP = 'same-origin'

/** Default `Origin-Agent-Cluster` value `createSecurity` sets. */
export const DEFAULT_CLUSTER = '?1'

/** Value `createSecurity` sets for `Cross-Origin-Embedder-Policy` when `coep: true`. */
export const DEFAULT_COEP = 'require-corp'

/** Value `createSecurity` sets for `Strict-Transport-Security` when `hsts: true`. */
export const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains'

/** Default header `createSecurity` mints/echoes a request identifier into. */
export const DEFAULT_IDENTIFIER_HEADER = 'x-request-id'

/** Default methods `createCors` advertises on a preflight response. */
export const DEFAULT_CORS_METHODS: readonly string[] = Object.freeze([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
])

/** Default headers `createCors` advertises on a preflight response. */
export const DEFAULT_CORS_HEADERS: readonly string[] = Object.freeze([
	'Content-Type',
	'Authorization',
])

/** Default response status `createDeadline` returns when its deadline fires first. */
export const DEFAULT_DEADLINE_STATUS = 503

/** Default header `createBearer` reads the token from. */
export const DEFAULT_BEARER_HEADER = 'authorization'

/** Default scheme prefix `createBearer` strips before verification. */
export const DEFAULT_BEARER_SCHEME = 'Bearer'

/** Default maximum number of distinct rate-limit keys `createLimiter` tracks before LRU eviction. */
export const DEFAULT_LIMITER_CAPACITY = 10_000

/** Default maximum number of distinct session ids `createMemorySessionStore` tracks before LRU (by last write) eviction. */
export const DEFAULT_SESSION_CAPACITY = 10_000

/** Default 429 body message `createLimiter` sends when a key is over budget. */
export const DEFAULT_LIMITER_MESSAGE = 'rate limit exceeded'

/** Default cookie name `createCookieTransport` writes the signed session id under. */
export const DEFAULT_SESSION_COOKIE = 'session'

/** Default header `createHeaderTransport` carries the session id in. */
export const DEFAULT_SESSION_HEADER = 'session-id'

/** Default signed-cookie name `createCSRF` writes the CSRF token under. */
export const DEFAULT_CSRF_COOKIE = 'csrf'

/** Default header `createCSRF` reads a mutating request's submitted token from. */
export const DEFAULT_CSRF_HEADER = 'x-csrf-token'

/** Default body field `createCSRF` falls back to reading a mutating request's submitted token from. */
export const DEFAULT_CSRF_FIELD = '_csrf'

/** Default methods `createCSRF` treats as safe (mint instead of verify). */
export const DEFAULT_CSRF_SAFE_METHODS: readonly string[] = Object.freeze([
	'GET',
	'HEAD',
	'OPTIONS',
])
