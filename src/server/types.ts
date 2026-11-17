import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { BudgetInterface } from '@orkestrel/budget'
import type { Guard } from '@orkestrel/contract'
import type { CookieOptions, Encoding, MiddlewareContext, SignerInterface } from '@orkestrel/server'

/**
 * Configures `createBoundary` — the error-rendering battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
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
 * Represents one access-log-style entry `createTelemetry` records after a response
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
 * Configures `createTelemetry` — the request timing/access-log seam. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
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
 * Configures `createCompression` — response-body compression. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `threshold` — the minimum buffered body size (bytes) worth compressing;
 *   defaults to {@link DEFAULT_COMPRESSION_THRESHOLD}.
 * - `encodings` — the codings offered, in preference order, intersected at
 *   construction with what the runtime's `CompressionStream` actually
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
 * Describes the already-resolved settings `compressResponse` runs its shared
 * negotiate → skip → threshold → compress skeleton against — the shape each
 * of `createCompression` and `createNodeCompression` builds from its own option bag.
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
 * Describes `createSecurity`'s `identifier` sub-option — request-id minting/echo
 * policy, or `false` to disable the feature entirely.
 *
 * @remarks
 * - `trust` — when `true`, an incoming `X-Request-ID` that passes {@link
 *   import('@orkestrel/server').isValidRequestId} is echoed back instead of
 *   replaced by a fresh mint. Defaults to `false` (always mint).
 */
export type SecurityIdentifierOptions = { readonly trust?: boolean } | false

/**
 * Configures `createSecurity` — the security-headers + request-id battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
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
 * - `coep` — `Cross-Origin-Embedder-Policy`; `string | boolean`, off by
 *   default (opt-in, breaks cross-origin subresources); `true` → {@link DEFAULT_COEP}.
 * - `hsts` — `Strict-Transport-Security`; `string | boolean`, off by default
 *   (opt-in, destructive if misconfigured); `true` → {@link DEFAULT_HSTS}.
 * - `identifier` — {@link SecurityIdentifierOptions}; on by default (mints
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
 * Configures `createCORS` — Cross-Origin Resource Sharing. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `origin` — the allowed origin(s): `'*'` (default), a single origin
 *   string, or an allow-list `readonly string[]`, which reflects the request
 *   `Origin` when it matches and merges `Vary: Origin` on every response and
 *   preflight. The literal
 *   `Origin: null` is never reflected even when `'null'` is allow-listed.
 * - `methods` — the methods advertised on a preflight; defaults to {@link DEFAULT_CORS_METHODS}.
 * - `headers` — the headers advertised on a preflight; defaults to {@link DEFAULT_CORS_HEADERS}.
 */
export interface CORSOptions {
	readonly origin?: string | readonly string[]
	readonly methods?: readonly string[]
	readonly headers?: readonly string[]
}

/**
 * Configures `createDeadline` — the application-level per-request deadline. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `ms` — the deadline in milliseconds, an integer from 1 through 2147483647 (the range
 *   `@orkestrel/timeout` enforces), armed through `@orkestrel/timeout`; on expiry the
 *   battery calls `context.abort(reason)`.
 * - `status` — the response status returned when the deadline fires before
 *   the downstream chain settles; defaults to {@link DEFAULT_DEADLINE_STATUS}.
 */
export interface DeadlineOptions {
	readonly ms: number
	readonly status?: number
}

/**
 * Configures `createForwarded` — the trusted-proxy client-IP resolver. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * Construction requires either `proxies` or `trusted`, never both and never
 * neither (a `ContractError` guards each). Only `X-Forwarded-For` is read; a
 * `Forwarded` header is ignored.
 * - `proxies` — the count of proxies that each append one hop to
 *   `X-Forwarded-For`; the client is the hop at index `length − proxies`, so
 *   `1` resolves the rightmost hop. Fit it only when every request arrives
 *   through exactly that many proxies.
 * - `trusted` — the exact addresses and IPv4 CIDR entries of the trusted
 *   proxies; the walk starts at the socket peer and the first address outside
 *   the roster is the client. An IPv4-mapped address (`::ffff:10.0.0.6`)
 *   compares by its embedded IPv4.
 *
 * The resolved address is not validated: it is the socket peer or a hop as
 * written, so a malformed hop or a hop with a port resolves unchanged.
 */
export type ForwardedOptions =
	| { readonly proxies: number }
	| { readonly trusted: readonly string[] }

/**
 * Configures `createETag` — dynamic response ETag + conditional GET. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `weak` — mint a weak `W/"…"` ETag (default `true`) or a strong `"…"` one
 *   (`false`).
 */
export interface ETagOptions {
	readonly weak?: boolean
}

/** Verifies a presented bearer token and resolves its credential, or `undefined` to refuse it. */
export type BearerVerifyFunction<TCredential> = (
	token: string,
	request: Request,
) => TCredential | undefined | Promise<TCredential | undefined>

/**
 * Configures `createBearer` — bearer-token authentication. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @typeParam TCredential - The credential `verify` resolves and `createBearer` stashes on {@link BearerState.token}
 * @remarks
 * - `verify` — resolves the credential for a presented token, or `undefined`
 *   to refuse it; a throw propagates unchanged.
 * - `header` — the header the token is read from; defaults to
 *   {@link DEFAULT_BEARER_HEADER}.
 * - `scheme` — the scheme prefix stripped before verification
 *   (case-insensitive); defaults to {@link DEFAULT_BEARER_SCHEME}. An empty
 *   string means the whole header value is the raw token.
 * - `challenge` — the auth-params every `WWW-Authenticate` challenge carries,
 *   mirroring the RFC 6750 § 3 names (`realm`, `scope`) and RFC 9728 § 5.1's
 *   `resource_metadata`; the battery owns `error`.
 */
export interface BearerOptions<TCredential = string> {
	readonly verify: BearerVerifyFunction<TCredential>
	readonly header?: string
	readonly scheme?: string
	readonly challenge?: Readonly<Record<string, string>>
}

/**
 * Configures `createLimiter` — fixed-window rate limiting. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @typeParam TState - The consumer's opaque per-request state type `key` reads
 * @remarks
 * - `max` — the number of requests admitted per key per `window`.
 * - `window` — the window length in milliseconds.
 * - `store` — the implementation checks only `consume`, accepts a class instance,
 *   and ignores every other member it carries.
 * - `capacity` — the maximum number of distinct keys tracked before the
 *   least-recently-used key is evicted (true LRU — every access, not only
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
	/** Supplies an atomic per-key budget store; defaults to MemoryLimiterStore. */
	readonly store?: LimiterStoreInterface
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
 * Describes the bearer-authentication state slice `createBearer` stashes on
 * `context.state` once a token verifies.
 *
 * @typeParam TCredential - The credential `createBearer`'s `verify` resolves
 * @remarks
 * `token` is an optional readonly state contract: absent until
 * `createBearer` runs, then installed on the request-owned state object. A
 * consumer intersects only the slices it mounts into its own `TState`.
 */
export interface BearerState<TCredential = string> {
	readonly token?: TCredential
}

/**
 * Describes the request-identifier state slice `createSecurity` stashes when its
 * `identifier` option is enabled.
 */
export interface IdentifierState {
	readonly identifier?: string
}

/** Describes the budget and duration used when a limiter window starts. */
export interface LimiterLimits {
	readonly max: number
	readonly window: number
}

/** Reports an atomic admission decision and its window expiry instant. */
export interface LimiterResult {
	readonly admitted: boolean
	readonly expiry: number
}

/** Holds the budget and expiry instant of an in-memory limiter entry. */
export interface LimiterEntry {
	readonly budget: BudgetInterface<number>
	readonly expiry: number
}

/** Provides atomic per-key fixed-window admission. */
export interface LimiterStoreInterface {
	/**
	 * Checks and consumes a budget without interleaving its admission decision.
	 * @param key - The request identity key.
	 * @param now - The caller's clock reading in milliseconds.
	 * @param limits - The maximum and duration applied to a fresh window.
	 * @returns The admission decision and reset instant.
	 */
	consume(key: string, now: number, limits: LimiterLimits): Promise<LimiterResult>
}

/** Configures the in-memory limiter's capacity and eviction observation. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses. */
export interface MemoryLimiterStoreOptions {
	readonly capacity?: number
	readonly evict?: (key: string) => void
}

/**
 * Describes the resolved client connection facts `createForwarded` stashes.
 *
 * @remarks
 * `ip` is the client address `resolveForwardedFor` resolves from
 * `X-Forwarded-For` and the socket peer under the configured trust, or the
 * socket peer itself when the header names no hop the trust admits.
 */
export interface Client {
	readonly ip?: string
}

/**
 * Describes the client-facts state slice `createForwarded` stashes.
 */
export interface ClientState {
	readonly client?: Client
}

/**
 * Represents a server-managed session's public surface — an id, its live state, and the
 * mutators that write it.
 *
 * @remarks
 * `state` is a `ReadonlyMap` view a handler reads directly: TypeScript
 * refuses a write through it, and `set`, `delete`, and `clear` are the write
 * path. `createSession` persists the state to the configured
 * {@link SessionStoreInterface} on the way out, after a handler wrote to it. `clear` empties the state
 * without ending the session — `SessionControlInterface.destroy` does that.
 */
export interface SessionInterface {
	readonly id: string
	readonly state: ReadonlyMap<string, unknown>
	/**
	 * Writes one key's value into the session's state.
	 *
	 * @param key - The state key to write
	 * @param value - The value to store under `key`
	 */
	set(key: string, value: unknown): void
	/**
	 * Removes one key from the session's state.
	 *
	 * @param key - The state key to remove
	 * @returns True when the session held `key`; false otherwise
	 */
	delete(key: string): boolean
	/** Empties the state, leaving the session and its id alive. */
	clear(): void
}

/**
 * Describes the mid-handler control handle `createSession` stashes alongside the
 * session itself — the OWASP anti-fixation / logout primitives.
 *
 * @remarks
 * `regenerate` and `destroy` record intent synchronously when called; the
 * store I/O and transport write happen after the handler's `next()` returns
 * (`destroy` supersedes a prior `regenerate`). `regenerate` mints a new id,
 * carries the session's `state` over, and invalidates the old id. `fresh`
 * is true for a session minted on this request: the client holds no credential
 * for it until a write or a `regenerate` persists it.
 */
export interface SessionControlInterface {
	/** Reports whether destruction superseded regeneration. */
	readonly destroyed: boolean
	/** Exposes the latest regenerated session, when one exists. */
	readonly successor: SessionInterface | undefined
	/** Reports whether the session was minted on this request, so the client does not hold it yet. */
	readonly fresh: boolean
	/** Mints a fresh id, carries the session's `state` over, and invalidates the old id. */
	regenerate(): void
	/** Ends the session — deletes it from the store and clears its transport. */
	destroy(): void
}

/**
 * Describes the session state slice `createSession` stashes.
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
 * Describes the body state slice `createBody` stashes.
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
 * Describes the pluggable session persistence seam `createSession`'s `store` option
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
	/**
	 * Reads a session by id, applying the idle and absolute expiry against `now`.
	 *
	 * @param id - The session id to read
	 * @param now - The caller's clock reading the expiry is measured against
	 * @returns The stored session, or `undefined` when it is absent or expired
	 */
	get(id: string, now: number): Promise<S | undefined>
	/**
	 * Persists a session under its own `id`, refreshing its idle window.
	 *
	 * @param session - The session to persist, keyed by its own `id`
	 * @param now - The caller's clock reading stamped as the session's `seen`
	 * @returns A promise that resolves once the session is stored
	 */
	set(session: S, now: number): Promise<void>
	/**
	 * Removes a session by id — a no-op on an absent id, never throws.
	 *
	 * @param id - The session id to remove
	 * @returns A promise that resolves once the id is absent from the store
	 */
	delete(id: string): Promise<void>
}

/**
 * Describes the idle and absolute-lifetime thresholds a session store enforces —
 * `sessionExpired`'s limits argument and both shipped stores' construction
 * options. `createDatabaseSessionStore` admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `ttl` — the idle timeout in milliseconds; absent means no idle expiry.
 * - `lifetime` — the absolute lifetime in milliseconds from the first `set`;
 *   absent means no absolute expiry.
 */
export interface SessionLimits {
	readonly ttl?: number
	readonly lifetime?: number
}

/**
 * Describes a foreign implementation contract an options key admits — the members its
 * published interface declares, checked as that interface declares them.
 *
 * @remarks
 * - `expected` — the shape named in a refusal message.
 * - `is` — the guard that accepts a class instance and unknown members.
 */
export interface ForeignContract {
	readonly expected: string
	readonly is: Guard<unknown>
}

/**
 * Describes the per-session instants a store stamps and `sessionExpired` measures
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
 * Represents one persisted session row — an opaque snapshot column plus the store-owned
 * idle/absolute-lifetime cursors, the shape a {@link DatabaseSessionStore}'s
 * backing table holds.
 */
export interface SessionRow extends SessionCursors {
	readonly id: string
	readonly session: unknown
}

/**
 * Represents one in-process session entry — the payload {@link MemorySessionStore} holds
 * against an id, alongside the same cursors a persisted row carries.
 *
 * @typeParam S - The stored session entity type
 */
export interface SessionEntry<S extends SessionInterface> extends SessionCursors {
	readonly session: S
}

/**
 * Represents a session's serializable projection — the value `snapshotSession` produces
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
 * Rebuilds a session entity from an untrusted stored snapshot, or resolves `undefined` when the value is malformed.
 *
 * @remarks
 * The step {@link DatabaseSessionStore} is constructed with, and the seam a
 * consumer implements to restore its own session entity from a persisted row.
 * `createDatabaseSessionStore` supplies `createRestoredSession` as that step.
 */
export type SessionRestoreFunction = (value: unknown) => SessionInterface | undefined

/**
 * Describes the transport seam `createSession`'s `transport` option implements — how a
 * session id travels to and from the client (a signed cookie, a header, …).
 *
 * @remarks
 * `read` is total (a malformed/tampered credential resolves `undefined`,
 * never throws). `write` and `clear` mutate the returned `Response` on the
 * way out — the returning onion makes "before send" automatic. `write` is
 * called only when a session minted on the request is first written, or when a
 * session is regenerated; `clear` is
 * called on `destroy()`. `write`'s `encrypted` flag is the request's resolved
 * transport security (derived from `context.url.protocol`) so a cookie
 * transport can resolve its own `Secure` attribute through `resolveSecure`
 * without re-deriving connection facts itself.
 */
export interface SessionTransportInterface {
	/**
	 * Reads the incoming session id from the request — `undefined` on any failure.
	 *
	 * @param request - The inbound request the credential travels on
	 * @returns The session id, or `undefined` when none is present or readable
	 */
	read(request: Request): string | undefined | Promise<string | undefined>
	/**
	 * Writes a freshly minted or regenerated session id onto the response, together with
	 * the request's encrypted-transport fact.
	 *
	 * @param response - The outgoing response the credential is written onto
	 * @param id - The session id carried to the client
	 * @param encrypted - Whether the request arrived over an encrypted transport
	 * @returns Nothing, or a promise that resolves once the credential is written
	 */
	write(response: Response, id: string, encrypted: boolean): void | Promise<void>
	/** Clears the transport's credential on `destroy()`. */
	clear(response: Response): void
}

/**
 * Configures `createSession` — the generic session battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @typeParam S - The session entity type `create` produces
 * @typeParam TState - The consumer's opaque per-request state type `mint` reads
 * @remarks
 * - `transport` — the {@link SessionTransportInterface} (`createCookieTransport(...)`,
 *   `createHeaderTransport(...)`, or a custom one); the implementation checks only
 *   `read`, `write`, and `clear`, accepts a class instance, and ignores every other member.
 * - `store` — the {@link SessionStoreInterface}; defaults to
 *   `createMemorySessionStore({ ttl, lifetime, capacity, evict })`; the implementation
 *   checks only `get`, `set`, and `delete`, accepts a class instance, and ignores every
 *   other member.
 * - `ttl` — the idle timeout in milliseconds.
 * - `lifetime` — the absolute session lifetime in milliseconds from mint.
 * - `capacity` — the maximum number of distinct session ids the default
 *   memory store tracks before LRU eviction; ignored when `store` is
 *   provided. Defaults to {@link DEFAULT_SESSION_CAPACITY}.
 * - `evict` — invoked with a session id evicted by the default memory
 *   store's own policy; ignored when `store` is provided. It is a
 *   notification sink only — it must never call back into the store
 *   (no re-entrant `get`/`set`); mutations during eviction are unsupported.
 * - `create` — builds a fresh session's public entity from a minted id;
 *   defaults to `new Session(id)`.
 * - `mint` — decides whether to auto-mint a session when none resolves;
 *   defaults to always minting (auto-session). A minted session is stored, and its
 *   credential written, only after a handler writes to it or regenerates it.
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
 * Configures `createCookieTransport` — the signed-cookie {@link SessionTransportInterface}. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `name` — the cookie name; defaults to {@link DEFAULT_SESSION_COOKIE}.
 * - `signer` — the {@link SignerInterface} the session id is signed with (`signToken`); the
 *   implementation checks only `sign` and `verify`, accepts a class instance, and ignores
 *   every other member.
 * - `cookie` — extra {@link CookieOptions} attributes; `Max-Age` is derived
 *   from `SessionOptions.ttl` unless overridden here. The record is admitted whole: it
 *   accepts only `path` and `domain` (strings), `maxAge` (a finite number, because a
 *   non-finite value writes `Max-Age=NaN` or `Max-Age=Infinity`), `httpOnly` and `secure`
 *   (booleans), and `sameSite` (`'Strict'`, `'Lax'`, or `'None'`), and refuses any other key.
 */
export interface CookieTransportOptions {
	readonly name?: string
	readonly signer: SignerInterface
	readonly cookie?: CookieOptions
}

/**
 * Configures `createHeaderTransport` — the bare-header {@link SessionTransportInterface}. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `header` — the header carrying the session id; defaults to
 *   {@link DEFAULT_SESSION_HEADER}.
 */
export interface HeaderTransportOptions {
	readonly header?: string
}

/**
 * Configures `createMemorySessionStore` — the default in-process {@link SessionStoreInterface}. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `ttl` — the idle timeout in milliseconds (lazy eviction on `get`).
 * - `lifetime` — the absolute lifetime in milliseconds from first `set`
 *   (evicts even a continuously-touched session).
 * - `capacity` — the maximum number of distinct session ids tracked before
 *   the least recently used id is evicted, in time that does not grow with the
 *   store's size (every `set` and every live `get` refreshes an id's recency);
 *   defaults to {@link DEFAULT_SESSION_CAPACITY}.
 * - `evict` — invoked with a session id when it is evicted by the store's
 *   own policy (a capacity eviction or an expired read) — never for
 *   an explicit `delete`. Its own throw is swallowed. It is a notification
 *   sink only — it must never call back into the store (no re-entrant
 *   `get`/`set`); mutations during eviction are unsupported.
 */
export interface MemorySessionStoreOptions extends SessionLimits {
	readonly capacity?: number
	readonly evict?: (id: string) => void
}

/**
 * Describes the CSRF state slice `createCSRF` stashes — a token bound to the session the
 * request arrived with, or to the battery's nonce, for the page to submit back.
 */
export interface CSRFState {
	readonly csrf?: string
}

/**
 * Configures `createCSRF` — signed double-submit CSRF protection, bound to the session the client holds or to the battery's own nonce. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `signer` — the {@link SignerInterface} the CSRF token is signed with; the
 *   implementation checks only `sign` and `verify`, accepts a class instance, and ignores
 *   every other member.
 * - `cookie` — the name of the HttpOnly cookie that holds the battery's nonce while the
 *   client holds no session; defaults to {@link DEFAULT_CSRF_COOKIE}.
 * - `header` — the header a mutating request submits its token in; defaults
 *   to {@link DEFAULT_CSRF_HEADER}.
 * - `field` — the body field a mutating request may submit its token in
 *   instead of the header, read from a JSON or urlencoded body only, so a multipart
 *   form sends its token in the header; defaults to {@link DEFAULT_CSRF_FIELD}.
 * - `safe` — the methods that mint instead of verify; defaults to
 *   {@link DEFAULT_CSRF_SAFE_METHODS}.
 */
export interface CSRFOptions {
	readonly signer: SignerInterface
	readonly cookie?: string
	readonly header?: string
	readonly field?: string
	readonly safe?: readonly string[]
}

/**
 * Represents one staged multipart upload's public record — the shape the node-face
 * `createMultipart` battery (`@orkestrel/middleware`) produces per
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
 * Describes the parsed multipart request body `createMultipart` stashes — files keyed
 * by their field name, plus every plain text field.
 */
export interface MultipartBody {
	readonly files: Readonly<Record<string, readonly MultipartFile[]>>
	readonly fields: Readonly<Record<string, string>>
}

/**
 * Describes the multipart state slice `createMultipart` stashes.
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

/** Describes a canonical static path and whether it lies inside the serving root. */
export interface StaticResolution {
	readonly path: string
	readonly contained: boolean
}

/** Describes an opened static file and the facts read from its handle. */
export interface StaticFile {
	readonly path: string
	readonly handle: FileHandle
	readonly info: Stats
}

/** Describes response headers and the optional byte interval of a static file. */
export interface StaticPlan {
	readonly status: number
	readonly headers: Headers
	readonly range: ByteRange | undefined
}

/**
 * Describes one in-memory asset representation returned by an {@link AssetSourceInterface}.
 *
 * @remarks
 * - `body` — the representation bytes. `createAssets` copies them before use.
 * - `encoding` — `'br'` when `body` is Brotli-compressed. Omission means the
 *   bytes are the identity representation.
 */
export interface AssetRepresentation {
	readonly body: ArrayBuffer | Uint8Array
	readonly encoding?: 'br'
}

/**
 * Reads in-memory assets by decoded, browser-build-relative path.
 *
 * @remarks
 * A successful result is cached by `createAssets`; later source changes do
 * not alter that path's response. A miss may be read again on a later request.
 * `read` therefore owes a bounded key set: that cache retains every
 * successful result for the factory's lifetime and evicts nothing.
 */
export interface AssetSourceInterface {
	/**
	 * Reads one identity or Brotli asset representation for a validated relative key.
	 *
	 * @param path - The validated relative asset path
	 * @returns The asset, or `undefined` when the path is absent
	 */
	read(path: string): AssetRepresentation | undefined
}

/**
 * Configures `createAssets` — in-memory identity/Brotli asset serving. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `source` — the required in-memory asset reader. The implementation checks only
 *   `read`, accepts a class instance, and ignores every other member. It must answer a bounded
 *   key set and return `undefined` for every key outside it, because
 *   `createAssets` retains every successful result for the factory's lifetime
 *   and evicts nothing. A `source` that synthesizes a representation for an
 *   arbitrary key therefore grows that cache without limit under request
 *   pressure.
 * - `store` — the pluggable representation cache; defaults to MemoryAssetStore. The
 *   implementation checks only `get`, `set`, and `delete`, accepts a class instance, and
 *   ignores every other member. Concurrent misses may read and hash the same source key independently.
 */
export interface AssetOptions {
	readonly source: AssetSourceInterface
	readonly store?: AssetStoreInterface
}

/** Holds copied asset representations and their shared identity validator. */
export interface AssetRecord {
	readonly key: string
	readonly identity: Uint8Array
	readonly brotli: Uint8Array | undefined
	readonly etag: string
}

/** Provides asynchronous point access to cached asset representations. */
export interface AssetStoreInterface {
	/**
	 * Reads a cached representation by key.
	 * @param key - The decoded relative asset key.
	 * @returns The record, or undefined on a miss.
	 */
	get(key: string): Promise<AssetRecord | undefined>
	/**
	 * Stores a representation under its own key.
	 * @param record - The owned representations and validator.
	 * @returns A promise settled after storage.
	 */
	set(record: AssetRecord): Promise<void>
	/**
	 * Removes a cached key; an absent key is a no-op.
	 * @param key - The key to invalidate.
	 * @returns A promise settled after deletion.
	 */
	delete(key: string): Promise<void>
}

/**
 * Configures `createStatic` — node `fs`-backed static file serving. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `root` — the required directory every request resolves under, resolved
 *   once at construction.
 * - `prefix` — a URL path prefix stripped (on a segment boundary) before
 *   resolving under `root`.
 * - `index` — the filename served for a directory hit and by the SPA
 *   fallback; defaults to {@link DEFAULT_STATIC_INDEX}. The fallback serves
 *   it whatever `dotfiles` is set to, because this path is
 *   operator-configured rather than request-derived.
 * - `dotfiles` — the policy for a path with a dotfile segment: `'ignore'`
 *   (falls through to `next()`), `'deny'` (403), or `'allow'` (serves it);
 *   defaults to {@link DEFAULT_STATIC_DOTFILES}.
 * - `cache` — `Cache-Control: max-age=<cache>` in seconds, when set.
 * - `etag` — whether to compute and honor a weak file `ETag`; defaults to `true`.
 * - `fallback` — SPA fallback: `false` (default, off), `true` (on, excluding
 *   {@link DEFAULT_STATIC_FALLBACK_EXCLUDE}), or `{ exclude }` for a custom
 *   excluded prefix. An eligible `GET` or `HEAD` navigation miss answers with
 *   `index` through the same handle-`fstat` header block a directly requested
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
 * Describes the caller's partial {@link MultipartLimits} — `createMultipart`'s `limits`
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
 * Describes the per-category size/count caps `createMultipart` enforces mid-stream — the
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
 * Configures `createMultipart` — node `fs`/`os`/`crypto`-backed streaming
 * multipart upload parsing. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `limits` — see {@link MultipartLimitsInput}.
 * - `allowed` — a MIME allow-list validated against sniffed (not merely
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
 * Names the reason `createMultipart` rejected a request — the machine-readable code
 * {@link MultipartError} carries and maps onto its HTTP status: `'limit'` →
 * 413, `'malformed'` → 400, `'rejected'` → 415.
 */
export type MultipartErrorCode = 'limit' | 'malformed' | 'rejected'

/**
 * Names the lifecycle stage of one staged upload's temp file.
 *
 * @remarks
 * `'staged'` — written to the configured temp directory under a random name,
 * not yet moved. `'moved'` — relocated by `moveUploadedFile` to its final path.
 */
export type UploadStatus = 'staged' | 'moved'

/**
 * Describes one uploaded file's post-parse record — the node-bound, richer sibling of
 * {@link MultipartFile} (identical fields, `status` narrowed
 * to {@link UploadStatus}). Structurally assignable into {@link MultipartFile}
 * so a `createMultipart`-built {@link MultipartBody} satisfies the shared
 * shape.
 *
 * @remarks
 * - `field` — the multipart field name the file was submitted under.
 * - `name` — the client-declared filename (metadata only — never used to
 *   build a filesystem path).
 * - `size` — the file's byte size.
 * - `mime` — the sniffed (magic-byte-detected) MIME type when a signature
 *   matches; otherwise the part's declared `Content-Type`; otherwise
 *   {@link DEFAULT_CONTENT_TYPE}. Read `validated` to tell which.
 * - `validated` — `true` when a signature matched and the sniffed type equals
 *   the declared `Content-Type`, so `mime` is the sniffed fact. `false` means
 *   `mime` may be the client-declared value.
 * - `status` — see {@link UploadStatus}.
 * - `path` — the file's current on-disk path.
 */
export interface UploadedFile extends Omit<MultipartFile, 'status'> {
	readonly status: UploadStatus
}

/**
 * Describes one multipart part's parsed header block — `parsePartHeaders`'s return
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
 * Describes one inclusive byte range over a file — `streamFile`'s optional
 * `range` argument and the shape `createStatic` builds for a satisfiable
 * `Range` request.
 *
 * @remarks
 * - `start` — the first byte offset served.
 * - `end` — the last byte offset served.
 *
 * Both bounds are 0-indexed and inclusive, matching `node:fs`'s
 * `createReadStream` options.
 */
export interface ByteRange {
	readonly start: number
	readonly end: number
}

/**
 * Configures `createNodeCompression` — `node:zlib`-backed response compression. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.
 *
 * @remarks
 * - `threshold` — the minimum buffered body size (bytes) worth compressing;
 *   defaults to {@link DEFAULT_COMPRESSION_THRESHOLD}.
 * - `filter` — an additional predicate a response must pass before
 *   compression is attempted; defaults to always-allow. The offered codings
 *   are fixed to {@link NODE_COMPRESSION_ENCODINGS} and are not configurable
 *   (see the peer `Encoding` type limitation documented on
 *   `createNodeCompression`).
 */
export interface NodeCompressionOptions {
	readonly threshold?: number
	readonly filter?: (request: Request, response: Response) => boolean
}
