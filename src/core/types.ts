import type {
	Connection,
	CookieOptions,
	Encoding,
	MiddlewareContext,
	TokenSecret,
} from '@orkestrel/server'

/**
 * Options for `createBoundary` — the outermost error-rendering battery.
 *
 * @remarks
 * - `expose` — when `true`, a non-`HTTPError` throw's `error.message` is
 *   surfaced in the 500 body instead of a generic message. Defaults to
 *   `false` (nothing leaks).
 * - `report` — an optional fire-and-forget sink invoked with every caught
 *   error; its own throw is swallowed and can never alter the response.
 */
export interface BoundaryOptions {
	readonly expose?: boolean
	readonly report?: (error: unknown) => void
}

/**
 * One access-log-style entry `createTelemetry` records after a response
 * settles — the access-log/timing seam's payload shape.
 *
 * @remarks
 * - `method` — the request's HTTP verb.
 * - `pathname` — the request URL's pathname.
 * - `status` — the response's final status (the boundary-mapped status when
 *   a downstream throw was rendered by `createBoundary`).
 * - `duration` — the wall-clock time in milliseconds the whole onion took
 *   beneath `createTelemetry`.
 */
export interface TelemetryEntry {
	readonly method: string
	readonly pathname: string
	readonly status: number
	readonly duration: number
}

/**
 * Options for `createTelemetry` — the request timing/access-log seam.
 *
 * @remarks
 * - `record` — invoked once per request with the settled {@link
 *   TelemetryEntry}; its own throw is swallowed so a broken sink can never
 *   fail the response.
 */
export interface TelemetryOptions {
	readonly record: (entry: TelemetryEntry) => void
}

/**
 * Options for `createCompression` — response-body compression.
 *
 * @remarks
 * - `threshold` — the minimum buffered body size (bytes) worth compressing;
 *   defaults to {@link DEFAULT_COMPRESSION_THRESHOLD}.
 * - `encodings` — the codings offered, in preference order, intersected at
 *   CONSTRUCTION with what the runtime's `CompressionStream` actually
 *   supports; defaults to {@link DEFAULT_COMPRESSION_ENCODINGS}.
 * - `filter` — an optional per-response opt-out predicate (the BREACH
 *   posture escape hatch); a response the predicate declines is never
 *   buffered or compressed. Defaults to always allowing.
 */
export interface CompressionOptions {
	readonly threshold?: number
	readonly encodings?: readonly Encoding[]
	readonly filter?: (request: Request, response: Response) => boolean
}

/**
 * The already-resolved settings `compressResponse` runs its shared
 * negotiate → skip → threshold → compress skeleton against — the shape each
 * face's `createCompression` builds from its own option bag.
 *
 * @remarks
 * - `threshold` — the minimum body size (bytes) worth compressing.
 * - `filter` — the per-response opt-out predicate; absent allows every
 *   response.
 * - `encodings` — the codings offered, in preference order, already narrowed
 *   to what this face can actually produce.
 * - `compress` — the runtime's compression primitive for one negotiated
 *   coding.
 */
export interface CompressResponseOptions {
	readonly threshold: number
	readonly filter?: (request: Request, response: Response) => boolean
	readonly encodings: readonly Encoding[]
	readonly compress: (
		bytes: Uint8Array<ArrayBuffer>,
		encoding: Exclude<Encoding, 'identity'>,
	) => Promise<Uint8Array<ArrayBuffer>>
}

/**
 * `createSecurity`'s `identifier` sub-option — request-id minting/echo
 * policy, or `false` to disable the feature entirely.
 *
 * @remarks
 * - `trust` — when `true`, an incoming `X-Request-ID` that passes {@link
 *   import('@orkestrel/server').isValidRequestId} is echoed back instead of
 *   replaced by a fresh mint. Defaults to `false` (always mint).
 */
export type SecurityIdentifierOptions = { readonly trust?: boolean } | false

/**
 * Options for `createSecurity` — the security-headers + request-id battery.
 *
 * @remarks
 * Every header option is `string | false` (a custom value replaces the
 * default wholesale, `false` omits the header) unless noted; unset uses the
 * documented default. `X-Content-Type-Options: nosniff` is unconditional and
 * has no option.
 * - `frame` — `X-Frame-Options`; `'DENY' | 'SAMEORIGIN' | false`, default `'DENY'`.
 * - `csp` — `Content-Security-Policy`; default {@link DEFAULT_CSP}.
 * - `referrer` — `Referrer-Policy`; default {@link DEFAULT_REFERRER_POLICY}.
 * - `permissions` — `Permissions-Policy`; default {@link DEFAULT_PERMISSIONS_POLICY}.
 * - `coop` — `Cross-Origin-Opener-Policy`; default {@link DEFAULT_COOP}.
 * - `corp` — `Cross-Origin-Resource-Policy`; default {@link DEFAULT_CORP}.
 * - `cluster` — `Origin-Agent-Cluster`; default {@link DEFAULT_CLUSTER}.
 * - `coep` — `Cross-Origin-Embedder-Policy`; `string | boolean`, OFF by
 *   default (opt-in, breaks cross-origin subresources); `true` → {@link DEFAULT_COEP}.
 * - `hsts` — `Strict-Transport-Security`; `string | boolean`, OFF by default
 *   (opt-in, destructive if misconfigured); `true` → {@link DEFAULT_HSTS}.
 * - `identifier` — {@link SecurityIdentifierOptions}; ON by default (mints
 *   and stashes {@link IdentifierState}).
 */
export interface SecurityOptions {
	readonly frame?: 'DENY' | 'SAMEORIGIN' | false
	readonly csp?: string | false
	readonly referrer?: string | false
	readonly permissions?: string | false
	readonly coop?: string | false
	readonly corp?: string | false
	readonly cluster?: string | false
	readonly coep?: string | boolean
	readonly hsts?: string | boolean
	readonly identifier?: SecurityIdentifierOptions
}

/**
 * Options for `createCors` — Cross-Origin Resource Sharing.
 *
 * @remarks
 * - `origin` — the allowed origin(s): `'*'` (default), a single origin
 *   string, or an allow-list `readonly string[]` (reflects the request
 *   `Origin` when it matches, and merges `Vary: Origin`). The literal
 *   `Origin: null` is never reflected even when `'null'` is allow-listed.
 * - `methods` — the methods advertised on a preflight; defaults to {@link DEFAULT_CORS_METHODS}.
 * - `headers` — the headers advertised on a preflight; defaults to {@link DEFAULT_CORS_HEADERS}.
 */
export interface CorsOptions {
	readonly origin?: string | readonly string[]
	readonly methods?: readonly string[]
	readonly headers?: readonly string[]
}

/**
 * Options for `createDeadline` — the application-level per-request deadline.
 *
 * @remarks
 * - `ms` — the deadline in milliseconds, armed via `@orkestrel/timeout` and
 *   linked to the request's `signal` via `@orkestrel/abort`'s `linkSignal`.
 * - `status` — the response status returned when the deadline fires before
 *   the downstream chain settles; defaults to {@link DEFAULT_DEADLINE_STATUS}.
 */
export interface DeadlineOptions {
	readonly ms: number
	readonly status?: number
}

/**
 * Options for `createForwarded` — the trusted-proxy client-IP resolver.
 *
 * @remarks
 * Construction requires EXACTLY ONE of the two forms (a `TypeError` guards
 * both-set and neither-set):
 * - `proxies` — trust exactly this many hops from the right of
 *   `X-Forwarded-For` / `Forwarded`.
 * - `trusted` — trust every hop matching one of these CIDR entries.
 */
export type ForwardedOptions =
	| { readonly proxies: number }
	| { readonly trusted: readonly string[] }

/**
 * Options for `createETag` — dynamic response ETag + conditional GET.
 *
 * @remarks
 * - `weak` — mint a weak `W/"…"` ETag (default `true`) or a strong `"…"` one
 *   (`false`).
 */
export interface ETagOptions {
	readonly weak?: boolean
}

/**
 * Options for `createBearer` — bearer-token authentication.
 *
 * @remarks
 * - `secret` — the {@link TokenSecret} `verifyToken` checks the extracted
 *   token against (rotation-aware).
 * - `header` — the header the token is read from; defaults to
 *   {@link DEFAULT_BEARER_HEADER}.
 * - `scheme` — the scheme prefix stripped before verification (case-
 *   insensitive); defaults to {@link DEFAULT_BEARER_SCHEME}. An empty string
 *   means the whole header value is the raw token.
 */
export interface BearerOptions {
	readonly secret: TokenSecret
	readonly header?: string
	readonly scheme?: string
}

/**
 * Options for `createLimiter` — fixed-window rate limiting.
 *
 * @typeParam TState - The consumer's opaque per-request state type `key` reads
 * @remarks
 * - `max` — the number of requests admitted per key per `window`.
 * - `window` — the window length in milliseconds.
 * - `capacity` — the maximum number of distinct keys tracked before the
 *   least-recently-used key is evicted (true LRU — every access, not just
 *   insertion, refreshes recency); defaults to {@link DEFAULT_LIMITER_CAPACITY}.
 * - `key` — derives the bucket key from the request; defaults to the
 *   bearer-token-then-client-IP idiom (see the battery's guide).
 * - `message` — the 429 body message; defaults to {@link DEFAULT_LIMITER_MESSAGE}.
 * - `clock` — the injected time source for all window math; defaults to `Date.now`.
 * - `policy` — when `true`, also emits the draft `RateLimit`/`RateLimit-Policy`
 *   structured header fields; defaults to `false`. `Retry-After` always ships.
 * - `evict` — invoked with a bucket's key when it is evicted for capacity;
 *   its own throw is swallowed and can never fail the request. It is a
 *   notification sink only — it must never call back into the limiter
 *   (no re-entrant reads/writes); mutations during eviction are unsupported.
 */
export interface LimiterOptions<TState = unknown> {
	readonly max: number
	readonly window: number
	readonly capacity?: number
	readonly key?: (context: MiddlewareContext<TState>) => string
	readonly message?: string
	readonly clock?: () => number
	readonly policy?: boolean
	readonly evict?: (key: string) => void
}

/**
 * The bearer-authentication state slice `createBearer` stashes on
 * `context.state` once a token verifies.
 *
 * @remarks
 * `token` is an optional readonly state contract: absent until
 * `createBearer` runs, then installed on the request-owned state object. A
 * consumer intersects only the slices it mounts into its own `TState`.
 */
export interface BearerState {
	readonly token?: string
}

/**
 * The request-identifier state slice `createSecurity` stashes when its
 * `identifier` option is enabled.
 */
export interface IdentifierState {
	readonly identifier?: string
}

/**
 * The connection-facts state slice `createLimiter`'s default key derivation
 * falls back to when neither {@link BearerState} nor {@link ClientState} is
 * present — the raw socket peer surfaced on `context.state` by the server's
 * `state` option.
 */
export interface ConnectionState {
	readonly connection?: Connection
}

/**
 * The resolved client connection facts `createForwarded` stashes.
 *
 * @remarks
 * `ip` is the first untrusted address walking `X-Forwarded-For` /
 * `Forwarded` right-to-left past the configured trusted hops, falling back
 * to the socket peer when no proxy hop qualifies.
 */
export interface Client {
	readonly ip?: string
}

/**
 * The client-facts state slice `createForwarded` stashes.
 */
export interface ClientState {
	readonly client?: Client
}

/**
 * A server-managed session's public surface — an id, its live state, and the
 * mutators that write it.
 *
 * @remarks
 * `state` is a `ReadonlyMap` view a handler reads directly: TypeScript
 * refuses a write through it, and `set`, `delete`, and `clear` are the write
 * path. `createSession` persists the state to the configured
 * {@link SessionStoreInterface} on the way out. `clear` empties the state
 * without ending the session — `SessionControlInterface.destroy` does that.
 */
export interface SessionInterface {
	readonly id: string
	readonly state: ReadonlyMap<string, unknown>
	set(key: string, value: unknown): void
	delete(key: string): boolean
	clear(): void
}

/**
 * The mid-handler control handle `createSession` stashes alongside the
 * session itself — the OWASP anti-fixation / logout primitives.
 *
 * @remarks
 * `regenerate` and `destroy` record intent SYNCHRONOUSLY when called; the
 * store I/O and transport write happen after the handler's `next()` returns
 * (`destroy` supersedes a prior `regenerate`). `regenerate` mints a new id,
 * carries the session's `state` over, and invalidates the old id.
 */
export interface SessionControlInterface {
	regenerate(): void
	destroy(): void
}

/**
 * The session state slice `createSession` stashes.
 *
 * @remarks
 * `session` is present whenever a request resolves or mints a session;
 * `control` is present whenever `session` is (the handle to act on it).
 */
export interface SessionState {
	readonly session?: SessionInterface
	readonly control?: SessionControlInterface
}

/**
 * The body state slice `createBody` stashes.
 *
 * @remarks
 * `body` holds the same defined value the cached `context.body()` resolved
 * to — a mid-handler read without a second `context.body()` await. The
 * property remains absent when the body resolves `undefined`.
 */
export interface BodyState {
	readonly body?: unknown
}

/**
 * The pluggable session persistence seam `createSession`'s `store` option
 * implements — a point-access store keyed by session id.
 *
 * @typeParam S - The stored session entity type
 * @remarks
 * Every primitive is async and takes a trailing `now` clock reading (the
 * same seam `createSession`'s `clock` option feeds) so a store can apply its
 * own idle/absolute expiry against the caller's injected time rather than
 * its own wall clock. `set` reads the id from the session it is handed —
 * a stored value carries its own id, so no separate id is passed. `delete` of
 * an absent id is a no-op, never throws.
 *
 * `get` must resolve a value satisfying {@link isSession} — an `id` string,
 * a `state` `Map` view, and the mutators — or `undefined`. `createSession`
 * dereferences the resolved value's `id` and `state` without re-checking
 * them, so a store that resolves an off-shape value corrupts the battery's
 * own state rather than being refused at the seam. The shipped
 * `DatabaseSessionStore` enforces this with the caller-supplied guard it is
 * constructed with.
 */
export interface SessionStoreInterface<S extends SessionInterface> {
	get(id: string, now: number): Promise<S | undefined>
	set(session: S, now: number): Promise<void>
	delete(id: string): Promise<void>
}

/**
 * The idle and absolute-lifetime thresholds a session store enforces —
 * `sessionExpired`'s limits argument and both shipped stores' construction
 * options.
 *
 * @remarks
 * - `ttl` — the idle timeout in milliseconds; absent means no idle expiry.
 * - `lifetime` — the absolute lifetime in milliseconds from the first `set`;
 *   absent means no absolute expiry.
 */
export interface SessionLimits {
	readonly ttl?: number | undefined
	readonly lifetime?: number | undefined
}

/**
 * The per-session instants a store stamps and `sessionExpired` measures
 * against.
 *
 * @remarks
 * - `seen` — the instant of the most recent live read or write.
 * - `created` — the instant of the first `set`, preserved across every
 *   later re-`set` of the same id.
 */
export interface SessionCursors {
	readonly seen: number
	readonly created: number
}

/**
 * One persisted session row — an opaque snapshot column plus the store-owned
 * idle/absolute-lifetime cursors, the shape a {@link DatabaseSessionStore}'s
 * backing table holds.
 */
export interface SessionRow extends SessionCursors {
	readonly id: string
	readonly session: unknown
}

/**
 * One in-process session entry — the payload {@link MemorySessionStore} holds
 * against an id, alongside the same cursors a persisted row carries.
 *
 * @typeParam S - The stored session entity type
 */
export interface SessionEntry<S extends SessionInterface> extends SessionCursors {
	readonly session: S
}

/**
 * A session's serializable projection — the value `snapshotSession` produces
 * and a durable store's `set` writes.
 *
 * @remarks
 * `state` is the wire member a persisted row carries, built on a
 * null-prototype record so a session key literally named `__proto__`
 * round-trips as an own enumerable property. It holds the same entries the
 * entity's own `state` view publishes.
 */
export interface SessionSnapshot {
	readonly id: string
	readonly state: Readonly<Record<string, unknown>>
}

/**
 * The transport seam `createSession`'s `transport` option implements — how a
 * session id travels to and from the client (a signed cookie, a header, …).
 *
 * @remarks
 * `read` is total (a malformed/tampered credential resolves `undefined`,
 * never throws). `write` and `clear` mutate the RETURNED `Response` on the
 * way out — the returning onion makes "before send" automatic. `write` is
 * called only when a session is freshly minted or regenerated; `clear` is
 * called on `destroy()`. `write`'s `encrypted` flag is the request's resolved
 * transport security (derived from `context.url.protocol`) so a cookie
 * transport can resolve its own `Secure` attribute via `resolveSecure`
 * without re-deriving connection facts itself.
 */
export interface SessionTransportInterface {
	read(request: Request): string | undefined | Promise<string | undefined>
	write(response: Response, id: string, encrypted: boolean): void | Promise<void>
	clear(response: Response): void
}

/**
 * Options for `createSession` — the generic session battery.
 *
 * @typeParam S - The session entity type `create` produces
 * @typeParam TState - The consumer's opaque per-request state type `mint` reads
 * @remarks
 * - `transport` — the {@link SessionTransportInterface} (`createCookieTransport(...)`,
 *   `createHeaderTransport(...)`, or a custom one).
 * - `store` — the {@link SessionStoreInterface}; defaults to
 *   `createMemorySessionStore({ ttl, lifetime, capacity, evict })`.
 * - `ttl` — the idle timeout in milliseconds.
 * - `lifetime` — the absolute session lifetime in milliseconds from mint.
 * - `capacity` — the maximum number of distinct session ids the DEFAULT
 *   memory store tracks before LRU eviction; ignored when `store` is
 *   provided. Defaults to {@link DEFAULT_SESSION_CAPACITY}.
 * - `evict` — invoked with a session id evicted by the DEFAULT memory
 *   store's own policy; ignored when `store` is provided. It is a
 *   notification sink only — it must never call back into the store
 *   (no re-entrant `get`/`set`); mutations during eviction are unsupported.
 * - `create` — builds a fresh session's public entity from a minted id;
 *   defaults to `new Session(id)`.
 * - `mint` — decides whether to auto-mint a session when none resolves;
 *   defaults to always minting (auto-session).
 * - `required` — when `true`, a request that resolves no session and does not
 *   mint one renders a 404 instead of proceeding sessionless. Defaults to `false`.
 * - `clock` — the injected time source fed to the store; defaults to `Date.now`.
 */
export interface SessionOptions<S extends SessionInterface, TState = unknown> {
	readonly transport: SessionTransportInterface
	readonly store?: SessionStoreInterface<S>
	readonly ttl?: number
	readonly lifetime?: number
	readonly capacity?: number
	readonly evict?: (id: string) => void
	readonly create?: (id: string) => S
	readonly mint?: (context: MiddlewareContext<TState>) => boolean | Promise<boolean>
	readonly required?: boolean
	readonly clock?: () => number
}

/**
 * Options for `createCookieTransport` — the signed-cookie {@link SessionTransportInterface}.
 *
 * @remarks
 * - `name` — the cookie name; defaults to {@link DEFAULT_SESSION_COOKIE}.
 * - `secret` — the {@link TokenSecret} the session id is signed with (`signToken`).
 * - `cookie` — extra {@link CookieOptions} attributes; `Max-Age` is derived
 *   from `SessionOptions.ttl` unless overridden here.
 */
export interface CookieTransportOptions {
	readonly name?: string
	readonly secret: TokenSecret
	readonly cookie?: CookieOptions
}

/**
 * Options for `createHeaderTransport` — the bare-header {@link SessionTransportInterface}.
 *
 * @remarks
 * - `header` — the header carrying the session id; defaults to
 *   {@link DEFAULT_SESSION_HEADER}.
 */
export interface HeaderTransportOptions {
	readonly header?: string
}

/**
 * Options for `createMemorySessionStore` — the default in-process {@link SessionStoreInterface}.
 *
 * @remarks
 * - `ttl` — the idle timeout in milliseconds (lazy eviction on `get`).
 * - `lifetime` — the absolute lifetime in milliseconds from first `set`
 *   (evicts even a continuously-touched session).
 * - `capacity` — the maximum number of distinct session ids tracked before
 *   the least-recently-written id is evicted (LRU by last write — every
 *   `set` refreshes an id's recency); defaults to {@link DEFAULT_SESSION_CAPACITY}.
 * - `evict` — invoked with a session id when it is evicted by the store's
 *   own policy (a capacity eviction or an expired-entry prune) — never for
 *   an explicit `delete`. Its own throw is swallowed. It is a notification
 *   sink only — it must never call back into the store (no re-entrant
 *   `get`/`set`); mutations during eviction are unsupported.
 */
export interface MemorySessionStoreOptions extends SessionLimits {
	readonly capacity?: number
	readonly evict?: (id: string) => void
}

/**
 * The CSRF state slice `createCSRF` stashes — the raw token a safe-method
 * response exposes for a subsequent mutating request to submit back.
 */
export interface CSRFState {
	readonly csrf?: string
}

/**
 * Options for `createCSRF` — session-bound double-submit CSRF protection.
 *
 * @remarks
 * - `secret` — the {@link TokenSecret} the CSRF token is signed with.
 * - `cookie` — the signed-cookie name; defaults to {@link DEFAULT_CSRF_COOKIE}.
 * - `header` — the header a mutating request submits its token in; defaults
 *   to {@link DEFAULT_CSRF_HEADER}.
 * - `field` — the body field a mutating request may submit its token in
 *   instead of the header (requires `createBody` ahead for form posts);
 *   defaults to {@link DEFAULT_CSRF_FIELD}.
 * - `safe` — the methods that mint instead of verify; defaults to
 *   {@link DEFAULT_CSRF_SAFE_METHODS}.
 */
export interface CSRFOptions {
	readonly secret: TokenSecret
	readonly cookie?: string
	readonly header?: string
	readonly field?: string
	readonly safe?: readonly string[]
}

/**
 * One staged multipart upload's public record — the shape the node-face
 * `createMultipart` battery (`@orkestrel/middleware/server`) produces per
 * uploaded file.
 *
 * @remarks
 * Declared here rather than in the node-bound server surface so the
 * fetch/string-pure {@link MultipartState} slice — referenced by any
 * environment narrowing `context.state` — never depends on the node face.
 * The server's concrete `UploadedFile` is structurally compatible
 * with this shape.
 */
export interface MultipartFile {
	readonly field: string
	readonly name: string
	readonly size: number
	readonly mime: string
	readonly validated: boolean
	readonly status: string
	readonly path: string
}

/**
 * The parsed multipart request body `createMultipart` stashes — files keyed
 * by their field name, plus every plain text field.
 */
export interface MultipartBody {
	readonly files: Readonly<Record<string, readonly MultipartFile[]>>
	readonly fields: Readonly<Record<string, string>>
}

/**
 * The multipart state slice `createMultipart` stashes.
 *
 * @remarks
 * Present only once `createMultipart` has fully parsed a multipart request.
 * After it runs, `context.body()` must not be called for that request — the
 * multipart battery consumes `request.body` as a stream, so the seam's
 * cached body has nothing left to read.
 */
export interface MultipartState {
	readonly multipart?: MultipartBody
}
