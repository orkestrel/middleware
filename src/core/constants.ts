import type { Encoding } from '@orkestrel/server'

/** Holds the default minimum buffered body size (bytes) `createCompression` will compress. */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024

/**
 * Lists the default content-codings `createCompression` offers, in preference order —
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

/** Holds the default `X-Frame-Options` value `createSecurity` sets. */
export const DEFAULT_FRAME_OPTIONS = 'DENY'

/**
 * Holds the default `Content-Security-Policy` value `createSecurity` sets — a custom
 * `csp` option REPLACES this wholesale, never merges.
 */
export const DEFAULT_CSP =
	"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"

/** Holds the default `Referrer-Policy` value `createSecurity` sets. */
export const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin'

/** Holds the default `Permissions-Policy` value `createSecurity` sets. */
export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()'

/** Holds the default `Cross-Origin-Opener-Policy` value `createSecurity` sets. */
export const DEFAULT_COOP = 'same-origin'

/** Holds the default `Cross-Origin-Resource-Policy` value `createSecurity` sets. */
export const DEFAULT_CORP = 'same-origin'

/** Holds the default `Origin-Agent-Cluster` value `createSecurity` sets. */
export const DEFAULT_CLUSTER = '?1'

/** Holds the value `createSecurity` sets for `Cross-Origin-Embedder-Policy` when `coep: true`. */
export const DEFAULT_COEP = 'require-corp'

/** Holds the value `createSecurity` sets for `Strict-Transport-Security` when `hsts: true`. */
export const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains'

/** Names the default header `createSecurity` mints/echoes a request identifier into. */
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

/** Holds the default response status `createDeadline` returns when its deadline fires first. */
export const DEFAULT_DEADLINE_STATUS = 503

/** Names the default header `createBearer` reads the token from. */
export const DEFAULT_BEARER_HEADER = 'authorization'

/** Names the default scheme prefix `createBearer` strips before verification. */
export const DEFAULT_BEARER_SCHEME = 'Bearer'

/** Holds the default maximum number of distinct rate-limit keys `createLimiter` tracks before LRU eviction. */
export const DEFAULT_LIMITER_CAPACITY = 10_000

/** Holds the default maximum number of distinct session ids `createMemorySessionStore` tracks before LRU (by last write) eviction. */
export const DEFAULT_SESSION_CAPACITY = 10_000

/** Holds the default 429 body message `createLimiter` sends when a key is over budget. */
export const DEFAULT_LIMITER_MESSAGE = 'rate limit exceeded'

/** Names the default cookie `createCookieTransport` writes the signed session id under. */
export const DEFAULT_SESSION_COOKIE = 'session'

/** Names the default header `createHeaderTransport` carries the session id in. */
export const DEFAULT_SESSION_HEADER = 'session-id'

/** Names the default signed cookie `createCSRF` writes the CSRF token under. */
export const DEFAULT_CSRF_COOKIE = 'csrf'

/** Names the default header `createCSRF` reads a mutating request's submitted token from. */
export const DEFAULT_CSRF_HEADER = 'x-csrf-token'

/** Names the default body field `createCSRF` falls back to reading a mutating request's submitted token from. */
export const DEFAULT_CSRF_FIELD = '_csrf'

/** Lists the default methods `createCSRF` treats as safe (mint instead of verify). */
export const DEFAULT_CSRF_SAFE_METHODS: readonly string[] = Object.freeze([
	'GET',
	'HEAD',
	'OPTIONS',
])
