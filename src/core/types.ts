import type { CookieOptions, Encoding, MiddlewareContext, TokenSecret } from '@orkestrel/server'

// ============================================================================
//  @orkestrel/middleware — core type surface (AGENTS §5 source of truth).
//  Every battery option bag, its state slice (when it stashes one), and the
//  session/transport/store seams from PROPOSAL.md §4, adapted per the
//  orchestrator's seam rulings (see the dispatch header). Peer types
//  (`TokenSecret`, `CookieOptions`, `Encoding`, `MiddlewareContext`,
//  `MiddlewareHandler`, `HTTPError`, …) are imported from `@orkestrel/server`
//  and never redeclared here.
// ============================================================================

/**
 * Options for `createBoundary` — the outermost error-rendering battery.
 *
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
 * @remarks
 * Construction requires EXACTLY ONE of the two forms (a `TypeError` guards
 * both-set and neither-set):
 * - `proxies` — trust exactly this many hops from the right of
 *   `X-Forwarded-For` / `Forwarded`.
 * - `trusted` — trust every hop matching one of these CIDR entries.
 */
export interface ForwardedOptions {
	readonly proxies?: number
	readonly trusted?: readonly string[]
}

/**
 * Options for `createETag` — dynamic response ETag + conditional GET.
 *
 * @param options - See fields below
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
 * @param options - See fields below
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
 * @param options - See fields below
 * @remarks
 * - `max` — the number of requests admitted per key per `window`.
 * - `window` — the window length in milliseconds.
 * - `capacity` — the maximum number of distinct keys tracked before the
 *   oldest-inserted is evicted (LRU); defaults to {@link DEFAULT_LIMITER_CAPACITY}.
 * - `key` — derives the bucket key from the request; defaults to the
 *   bearer-token-then-client-IP idiom (see the battery's guide).
 * - `message` — the 429 body message; defaults to {@link DEFAULT_LIMITER_MESSAGE}.
 * - `clock` — the injected time source for all window math; defaults to `Date.now`.
 * - `policy` — when `true`, also emits the draft `RateLimit`/`RateLimit-Policy`
 *   structured header fields; defaults to `false`. `Retry-After` always ships.
 */
export interface LimiterOptions<TState = unknown> {
	readonly max: number
	readonly window: number
	readonly capacity?: number
	readonly key?: (context: MiddlewareContext<TState>) => string
	readonly message?: string
	readonly clock?: () => number
	readonly policy?: boolean
}

/**
 * The bearer-authentication state slice `createBearer` stashes on
 * `context.state` once a token verifies.
 *
 * @remarks
 * `token` is optional-mutable: absent until `createBearer` runs, then
 * written in place — the pattern every stateful battery's slice follows so a
 * consumer intersects only the slices it mounts into its own `TState`.
 */
export interface BearerState {
	token?: string
}

/**
 * The request-identifier state slice `createSecurity` stashes when its
 * `identifier` option is enabled.
 */
export interface IdentifierState {
	identifier?: string
}

/**
 * The resolved client connection facts `createForwarded` stashes.
 *
 * @remarks
 * `ip` is the first untrusted address walking `X-Forwarded-For` /
 * `Forwarded` right-to-left past the configured trusted hops, falling back
 * to the socket peer when no proxy hop qualifies.
 */
export interface ClientInfo {
	readonly ip?: string
}

/**
 * The client-facts state slice `createForwarded` stashes.
 */
export interface ClientState {
	client?: ClientInfo
}

/**
 * A server-managed session's public surface — an id and its mutable data bag.
 *
 * @remarks
 * `data` is a live `Map` a handler reads/writes directly; `createSession`
 * persists it to the configured {@link SessionStoreInterface} on the way out.
 */
export interface SessionInterface {
	readonly id: string
	readonly data: Map<string, unknown>
}

/**
 * The mid-handler control handle `createSession` stashes alongside the
 * session itself — the OWASP anti-fixation / logout primitives.
 *
 * @remarks
 * `regenerate` and `destroy` record intent SYNCHRONOUSLY when called; the
 * store I/O and transport write happen after the handler's `next()` returns
 * (`destroy` supersedes a prior `regenerate`). `regenerate` mints a new id,
 * carries the session's `data` over, and invalidates the old id.
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
	session?: SessionInterface
	control?: SessionControlInterface
}

/**
 * The pluggable session persistence seam `createSession`'s `store` option
 * implements — a point-access store (AGENTS §5) keyed by session id.
 *
 * @typeParam S - The session data payload type
 * @remarks
 * Every primitive is async and takes a trailing `now` clock reading (the
 * same seam `createSession`'s `clock` option feeds) so a store can apply its
 * own idle/absolute expiry against the caller's injected time rather than
 * its own wall clock. `delete` of an absent id is a no-op, never throws.
 */
export interface SessionStoreInterface<S> {
	get(id: string, now: number): Promise<S | undefined>
	set(id: string, session: S, now: number): Promise<void>
	delete(id: string): Promise<void>
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
 * called on `destroy()`.
 */
export interface SessionTransport {
	read(request: Request): string | undefined | Promise<string | undefined>
	write(response: Response, id: string): void | Promise<void>
	clear(response: Response): void
}

/**
 * Options for `createSession` — the generic session battery.
 *
 * @typeParam S - The session data payload type `create` produces
 * @typeParam TState - The consumer's opaque per-request state type `mint` reads
 * @param options - See fields below
 * @remarks
 * - `transport` — the {@link SessionTransport} (`createCookieTransport(...)`,
 *   `createHeaderTransport(...)`, or a custom one).
 * - `store` — the {@link SessionStoreInterface}; defaults to
 *   `createMemorySessionStore({ ttl, lifetime })`.
 * - `ttl` — the idle timeout in milliseconds.
 * - `lifetime` — the absolute session lifetime in milliseconds from mint.
 * - `create` — builds a fresh session's public entity from a minted id;
 *   defaults to `new Session(id)`.
 * - `mint` — decides whether to auto-mint a session when none resolves;
 *   defaults to always minting (auto-session).
 * - `require` — when `true`, a request that resolves no session and does not
 *   mint one renders a 404 instead of proceeding sessionless. Defaults to `false`.
 * - `ends` — when `true`, a `DELETE` request carrying a valid session id
 *   deletes the session and short-circuits with `204`. Defaults to `false`.
 * - `clock` — the injected time source fed to the store; defaults to `Date.now`.
 */
export interface SessionOptions<S, TState = unknown> {
	readonly transport: SessionTransport
	readonly store?: SessionStoreInterface<S>
	readonly ttl?: number
	readonly lifetime?: number
	readonly create?: (id: string) => S
	readonly mint?: (context: MiddlewareContext<TState>) => boolean | Promise<boolean>
	readonly require?: boolean
	readonly ends?: boolean
	readonly clock?: () => number
}

/**
 * Options for `createCookieTransport` — the signed-cookie {@link SessionTransport}.
 *
 * @param options - See fields below
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
 * Options for `createHeaderTransport` — the bare-header {@link SessionTransport}.
 *
 * @param options - See fields below
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
 * @param options - See fields below
 * @remarks
 * - `ttl` — the idle timeout in milliseconds (lazy eviction on `get`).
 * - `lifetime` — the absolute lifetime in milliseconds from first `set`
 *   (evicts even a continuously-touched session).
 */
export interface MemorySessionStoreOptions {
	readonly ttl?: number
	readonly lifetime?: number
}

/**
 * The CSRF state slice `createCSRF` stashes — the raw token a safe-method
 * response exposes for a subsequent mutating request to submit back.
 */
export interface CSRFState {
	csrf?: string
}

/**
 * Options for `createCSRF` — session-bound double-submit CSRF protection.
 *
 * @param options - See fields below
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
 * The server's concrete `UploadedFileInterface` is structurally compatible
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
	multipart?: MultipartBody
}
