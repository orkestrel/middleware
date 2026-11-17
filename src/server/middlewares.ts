import type {
	AssetOptions,
	BearerOptions,
	BearerState,
	BodyState,
	BoundaryOptions,
	ClientState,
	CompressionOptions,
	CORSOptions,
	CSRFOptions,
	CSRFState,
	DeadlineOptions,
	ETagOptions,
	ForwardedOptions,
	IdentifierState,
	LimiterOptions,
	MultipartOptions,
	MultipartState,
	NodeCompressionOptions,
	SecurityOptions,
	SessionControlInterface,
	SessionInterface,
	SessionOptions,
	SessionState,
	SessionStoreInterface,
	StaticOptions,
	TelemetryOptions,
} from './types.js'
import type { MiddlewareHandler } from '@orkestrel/server'
import { realpath } from 'node:fs/promises'
import { relative, resolve as resolvePath } from 'node:path'
import { ContractError, isArray, isError, isRecord, isString } from '@orkestrel/contract'
import { compilePath } from '@orkestrel/router'
import {
	HTTPError,
	isHTTPError,
	isValidRequestId,
	mergeVary,
	parseCookies,
	resolveOrigin,
	resolveSecure,
	resolveSecurityHeader,
	serializeCookie,
} from '@orkestrel/server'
import { createTimeout } from '@orkestrel/timeout'
import {
	CSRF_FIELD_TYPES,
	CSRF_NONCE_PATTERN,
	DEFAULT_BEARER_HEADER,
	DEFAULT_BEARER_SCHEME,
	DEFAULT_CLUSTER,
	DEFAULT_COEP,
	DEFAULT_COMPRESSION_ENCODINGS,
	DEFAULT_COMPRESSION_THRESHOLD,
	DEFAULT_COOP,
	DEFAULT_CORP,
	DEFAULT_CORS_HEADERS,
	DEFAULT_CORS_METHODS,
	DEFAULT_CSP,
	DEFAULT_CSRF_COOKIE,
	DEFAULT_CSRF_FIELD,
	DEFAULT_CSRF_HEADER,
	DEFAULT_CSRF_SAFE_METHODS,
	DEFAULT_DEADLINE_STATUS,
	DEFAULT_FRAME_OPTIONS,
	DEFAULT_HSTS,
	DEFAULT_IDENTIFIER_HEADER,
	DEFAULT_LIMITER_CAPACITY,
	DEFAULT_LIMITER_MESSAGE,
	DEFAULT_PERMISSIONS_POLICY,
	DEFAULT_REFERRER_POLICY,
	DEFAULT_STATIC_DOTFILES,
	DEFAULT_STATIC_FALLBACK_EXCLUDE,
	DEFAULT_STATIC_INDEX,
	NODE_COMPRESSION_ENCODINGS,
} from './constants.js'
import {
	ASSET_CONTRACT,
	ASSET_SOURCE_FOREIGN,
	ASSET_STORE_FOREIGN,
	BEARER_CONTRACT,
	BOUNDARY_CONTRACT,
	COMPRESSION_CONTRACT,
	CORS_CONTRACT,
	CSRF_CONTRACT,
	DEADLINE_CONTRACT,
	ETAG_CONTRACT,
	FORWARDED_CONTRACT,
	LIMITER_CONTRACT,
	LIMITER_STORE_FOREIGN,
	MULTIPART_CONTRACT,
	NODE_COMPRESSION_CONTRACT,
	SCOPE_CONTRACT,
	SECURITY_CONTRACT,
	SESSION_CONTRACT,
	SESSION_STORE_FOREIGN,
	SESSION_TRANSPORT_FOREIGN,
	SIGNER_FOREIGN,
	STATIC_CONTRACT,
	TELEMETRY_CONTRACT,
} from './contracts.js'
import { isMultipartError } from './errors.js'
import {
	admitForeign,
	admitOptions,
	buildAssetResponse,
	buildClient,
	buildRateLimitField,
	buildRateLimitPolicyField,
	buildRetryAfter,
	compressBytes,
	compressNodeBytes,
	compressResponse,
	detectEncodings,
	extractBearerToken,
	extractFieldToken,
	generateNonce,
	isDotfilePath,
	matchesScope,
	matchesSessionState,
	matchesUnbufferableResponse,
	isPreflight,
	openStaticFile,
	planStaticResponse,
	readAssetRecord,
	rebuildResponse,
	resolveAssetKey,
	resolveForwardedFor,
	renderChallenge,
	resolveKey,
	resolveOptInHeader,
	resolveStaticFallbackPath,
	resolveStaticFile,
	resolveStaticPath,
	signCSRFToken,
	streamFile,
	unlinkStagedFiles,
	verifyCSRFToken,
} from './helpers.js'
import { parseMultipartRequest } from './parsers.js'
import { MemoryAssetStore } from './stores/MemoryAssetStore.js'
import { MemorySessionStore } from './stores/MemorySessionStore.js'
import { MemoryLimiterStore } from './stores/MemoryLimiterStore.js'
import { Session } from './Session.js'
import { SessionControl } from './SessionControl.js'
import { computeBodyETag, matchesETag } from '@orkestrel/server'

/**
 * Creates the error-rendering battery — catches a downstream throw and renders it
 * as a `Response`.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link BoundaryOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, or a value outside its declared type
 *
 * @example Mount a battery
 * ```ts
 * import { createBoundary, createSecurity } from '@orkestrel/middleware'
 * import type { IdentifierState } from '@orkestrel/middleware'
 * import { compose } from '@orkestrel/server'
 *
 * interface State extends IdentifierState {}
 *
 * const boundary = createBoundary({ expose: false })
 * const security = createSecurity({ hsts: true })
 *
 * const handle = compose<State>([security, boundary], async (_request, context) => {
 * 	return Response.json({ identifier: context.state.identifier })
 * })
 * ```
 */
export function createBoundary<TState>(options?: BoundaryOptions): MiddlewareHandler<TState> {
	admitOptions('createBoundary', BOUNDARY_CONTRACT, options)
	const expose = options?.expose ?? false
	const report = options?.report
	// The boundary reads only what `next` throws, so the leading two positions of the
	// handler signature are conformance-only here.
	return async (_request, _context, next) => {
		try {
			return await next()
		} catch (error) {
			if (report !== undefined) {
				try {
					report(error)
				} catch {
					// report is fire-and-forget; its own throw can never alter the response.
				}
			}
			if (isHTTPError(error)) return new Response(error.message, { status: error.status })
			const message = expose
				? isError(error)
					? error.message
					: String(error)
				: 'internal server error'
			return new Response(message, { status: 500 })
		}
	}
}

/**
 * Creates the access-log/timing seam — records one {@link TelemetryEntry} per request
 * after the response settles.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link TelemetryOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a missing `record`, or a `record` that is not a function
 *
 * @example
 * ```ts
 * const telemetry = createTelemetry({ record: (entry) => console.log(entry) })
 * ```
 */
export function createTelemetry<TState>(options: TelemetryOptions): MiddlewareHandler<TState> {
	admitOptions('createTelemetry', TELEMETRY_CONTRACT, options)
	const record = options.record
	// The entry is built from `context` alone, so the first position is conformance-only.
	return async (_request, context, next) => {
		const start = Date.now()
		const [outcome] = await Promise.allSettled([
			new Promise<Response>((resolve) => resolve(next())),
		])
		const duration = Date.now() - start
		const status = outcome.status === 'fulfilled' ? outcome.value.status : 500
		try {
			record({ method: context.method, pathname: context.url.pathname, status, duration })
		} catch {
			// A broken sink cannot fail the response.
		}
		if (outcome.status === 'rejected') throw outcome.reason
		return outcome.value
	}
}

/**
 * Creates the response-body compression battery — negotiates and compresses a buffered response
 * body over the runtime's feature-detected `CompressionStream` codings.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link CompressionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a `threshold` that is negative or not finite, an `encodings` entry outside `Encoding`, or a `filter` that is not a function
 *
 * @example
 * ```ts
 * const compression = createCompression({ threshold: 1024 })
 * ```
 */
export function createCompression<TState>(options?: CompressionOptions): MiddlewareHandler<TState> {
	admitOptions('createCompression', COMPRESSION_CONTRACT, options)
	const threshold = options?.threshold ?? DEFAULT_COMPRESSION_THRESHOLD
	const encodings = detectEncodings(options?.encodings ?? DEFAULT_COMPRESSION_ENCODINGS)
	const filter = options?.filter
	return async (request, context, next) => {
		const response = await next()
		return compressResponse(request, context, response, {
			threshold,
			...(filter !== undefined ? { filter } : {}),
			encodings,
			compress: compressBytes,
		})
	}
}

/**
 * Creates the security-headers + request-identifier battery — sets each documented
 * header default, and mints or echoes a request identifier.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link IdentifierState}
 * @param options - See {@link SecurityOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, or a value outside its declared type
 *
 * @example
 * ```ts
 * const security = createSecurity({ hsts: true })
 * ```
 */
export function createSecurity<TState extends IdentifierState>(
	options?: SecurityOptions,
): MiddlewareHandler<TState> {
	admitOptions('createSecurity', SECURITY_CONTRACT, options)
	const frame = options?.frame
	const csp = options?.csp
	const referrer = options?.referrer
	const permissions = options?.permissions
	const coop = options?.coop
	const corp = options?.corp
	const cluster = options?.cluster
	const coep = options?.coep
	const hsts = options?.hsts
	const identifierOption = options?.identifier
	const identifierEnabled = identifierOption !== false
	const trust = isRecord(identifierOption) ? identifierOption.trust === true : false

	return async (request, context, next) => {
		const incoming = identifierEnabled ? request.headers.get(DEFAULT_IDENTIFIER_HEADER) : null
		const identifier = !identifierEnabled
			? undefined
			: trust && incoming !== null && isValidRequestId(incoming)
				? incoming
				: crypto.randomUUID()
		if (identifierEnabled) Object.assign(context.state, { identifier })
		const response = await next()
		response.headers.set('x-content-type-options', 'nosniff')
		const headerTable: ReadonlyArray<readonly [string, string | undefined]> = [
			['x-frame-options', resolveSecurityHeader(frame, DEFAULT_FRAME_OPTIONS)],
			['content-security-policy', resolveSecurityHeader(csp, DEFAULT_CSP)],
			['referrer-policy', resolveSecurityHeader(referrer, DEFAULT_REFERRER_POLICY)],
			['permissions-policy', resolveSecurityHeader(permissions, DEFAULT_PERMISSIONS_POLICY)],
			['cross-origin-opener-policy', resolveSecurityHeader(coop, DEFAULT_COOP)],
			['cross-origin-resource-policy', resolveSecurityHeader(corp, DEFAULT_CORP)],
			['origin-agent-cluster', resolveSecurityHeader(cluster, DEFAULT_CLUSTER)],
			['cross-origin-embedder-policy', resolveOptInHeader(coep, DEFAULT_COEP)],
			['strict-transport-security', resolveOptInHeader(hsts, DEFAULT_HSTS)],
		]
		for (const [name, value] of headerTable)
			if (value !== undefined) response.headers.set(name, value)
		if (identifierEnabled && identifier !== undefined)
			response.headers.set(DEFAULT_IDENTIFIER_HEADER, identifier)
		return response
	}
}

/**
 * Creates the Cross-Origin Resource Sharing battery — answers a preflight itself, and
 * reflects an allow-listed origin or serves the configured wildcard.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link CORSOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key such as `origins`, or a non-string `origin`, `methods`, or `headers` entry
 *
 * @example
 * ```ts
 * const cors = createCORS({ origin: ['https://app.example'] })
 * ```
 */
export function createCORS<TState>(options?: CORSOptions): MiddlewareHandler<TState> {
	admitOptions('createCORS', CORS_CONTRACT, options)
	const origin = options?.origin ?? '*'
	const methods = options?.methods ?? DEFAULT_CORS_METHODS
	const headers = options?.headers ?? DEFAULT_CORS_HEADERS
	const reflecting = isArray(origin)
	return async (request, context, next) => {
		const requestOrigin = request.headers.get('origin') ?? undefined
		const allowOrigin = resolveOrigin(origin, requestOrigin)
		if (isPreflight(context.method, request.headers)) {
			const preflightHeaders = new Headers()
			if (reflecting) preflightHeaders.set('vary', 'Origin')
			if (allowOrigin !== undefined) {
				preflightHeaders.set('access-control-allow-origin', allowOrigin)
				preflightHeaders.set('access-control-allow-methods', methods.join(', '))
				preflightHeaders.set('access-control-allow-headers', headers.join(', '))
			}
			return new Response(null, { status: 204, headers: preflightHeaders })
		}
		const response = await next()
		if (allowOrigin !== undefined) response.headers.set('access-control-allow-origin', allowOrigin)
		if (reflecting)
			response.headers.set('vary', mergeVary(response.headers.get('vary') ?? undefined, 'Origin'))
		return response
	}
}

/**
 * Creates the application-level per-request deadline battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link DeadlineOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, an `ms` that is not a positive finite number, or a `status` that is not an integer from 200 through 599
 *
 * @remarks
 * On expiry it calls `context.abort(reason)`, so the request's `signal` aborts
 * with the deadline's reason, and answers `status` with no body. It builds no
 * `Request`, so it composes with `createBody` in either order.
 *
 * @example
 * ```ts
 * const deadline = createDeadline({ ms: 5_000 })
 * ```
 */
export function createDeadline<TState>(options: DeadlineOptions): MiddlewareHandler<TState> {
	admitOptions('createDeadline', DEADLINE_CONTRACT, options)
	const ms = options.ms
	const status = options.status ?? DEFAULT_DEADLINE_STATUS
	// The deadline reads neither the request nor the state, so the first position is
	// conformance-only.
	return async (_request, context, next) => {
		const timeout = createTimeout({ ms })
		timeout.start()
		const downstream = next()
		const expired = new Response(null, { status })
		const deadline = new Promise<Response>((resolve) => {
			timeout.signal.addEventListener(
				'abort',
				() => {
					context.abort(timeout.signal.reason)
					resolve(expired)
				},
				{ once: true },
			)
		})
		try {
			const winner = await Promise.race([downstream, deadline])
			downstream
				.then((response) => {
					if (winner === expired) response.body?.cancel().catch(() => {})
				})
				.catch(() => {})
			return winner
		} finally {
			timeout.clear()
		}
	}
}

/**
 * Creates the trusted-proxy client-IP resolver battery — walks `X-Forwarded-For` past
 * the hops its options declare trusted.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link ClientState}
 * @param options - See {@link ForwardedOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: neither or both of `proxies` and `trusted`, a `proxies` that is not an integer of at least 1, or a non-string `trusted` entry
 *
 * @example
 * ```ts
 * const forwarded = createForwarded({ proxies: 1 })
 * ```
 */
export function createForwarded<TState extends ClientState>(
	options: ForwardedOptions,
): MiddlewareHandler<TState> {
	admitOptions('createForwarded', FORWARDED_CONTRACT, options)
	const trust = 'proxies' in options ? { proxies: options.proxies } : { trusted: options.trusted }
	return async (request, context, next) => {
		const header = request.headers.get('x-forwarded-for') ?? undefined
		const ip = resolveForwardedFor(header, trust, context.connection.ip)
		Object.assign(context.state, { client: buildClient(ip) })
		return next()
	}
}

/**
 * Creates the dynamic response `ETag` + conditional GET battery (RFC 7232).
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link ETagOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, or a `weak` that is not a boolean
 *
 * @example
 * ```ts
 * const etag = createETag({ weak: true })
 * ```
 */
export function createETag<TState>(options?: ETagOptions): MiddlewareHandler<TState> {
	admitOptions('createETag', ETAG_CONTRACT, options)
	const weak = options?.weak ?? true
	return async (request, context, next) => {
		const response = await next()
		if (context.method !== 'GET' || response.status !== 200) return response
		if (matchesUnbufferableResponse(context.method, response, 'etag')) return response
		const buffer = await response.arrayBuffer()
		const bytes = new Uint8Array(buffer)
		const etag = await computeBodyETag(bytes, weak)
		const ifNoneMatch = request.headers.get('if-none-match')
		if (ifNoneMatch !== null && matchesETag(ifNoneMatch, etag)) {
			const headers = new Headers(response.headers)
			headers.set('etag', etag)
			headers.set('content-length', String(bytes.byteLength))
			return new Response(null, { status: 304, headers })
		}
		const headers = new Headers(response.headers)
		headers.set('etag', etag)
		return rebuildResponse(bytes, response, headers)
	}
}

/**
 * Creates the bearer-token authentication battery — reads the token from its header, resolves its
 * credential through `verify`, and answers each `401` with a `WWW-Authenticate` challenge.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link BearerState}
 * @typeParam TCredential - The credential `verify` resolves; default `string`
 * @param options - See {@link BearerOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} Thrown when the bag is refused whole, when `challenge` names `error` in any case, or when `scheme` or a `challenge` entry breaks the RFC 9110 and RFC 6750 forms
 *
 * @example
 * ```ts
 * const bearer = createBearer({ verify: (token) => verifyToken(token, createSigner('shh')) })
 * ```
 */
export function createBearer<TState extends BearerState<TCredential>, TCredential = string>(
	options: BearerOptions<TCredential>,
): MiddlewareHandler<TState> {
	admitOptions('createBearer', BEARER_CONTRACT, options)
	const owned = Object.keys(options.challenge ?? {}).find((name) => name.toLowerCase() === 'error')
	if (owned !== undefined)
		throw new ContractError(
			'createBearer: options.challenge must not name error; the battery owns it',
			{ code: 'structure', context: { path: ['challenge', owned], shape: 'createBearer' } },
		)
	const verify = options.verify
	const header = (options.header ?? DEFAULT_BEARER_HEADER).toLowerCase()
	const scheme = options.scheme ?? DEFAULT_BEARER_SCHEME
	const name = scheme === '' ? DEFAULT_BEARER_SCHEME : scheme
	const missing = renderChallenge(name, options.challenge, 'createBearer')
	const invalid = renderChallenge(
		name,
		{ ...options.challenge, error: 'invalid_token' },
		'createBearer',
	)
	return async (request, context, next) => {
		const raw = request.headers.get(header)
		const token = raw === null ? undefined : extractBearerToken(raw, scheme)
		if (token === undefined || token === '')
			return new Response('missing token', {
				status: 401,
				headers: { 'www-authenticate': missing },
			})
		const credential = await verify(token, request)
		if (credential === undefined)
			return new Response('invalid token', {
				status: 401,
				headers: { 'www-authenticate': invalid },
			})
		Object.assign(context.state, { token: credential })
		return next()
	}
}

/**
 * Creates the fixed-window rate-limiting battery — checks a key's budget before
 * consuming it, so one window admits exactly `max` requests.
 *
 * @remarks
 * The store admits atomically. A fresh window takes the current maximum from its limits.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link BearerState} and {@link ClientState}
 * @param options - See {@link LimiterOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole, or when `store` lacks `consume`
 *
 * @example
 * ```ts
 * const limiter = createLimiter({ max: 100, window: 60_000 })
 * ```
 */
export function createLimiter<TState extends BearerState<unknown> & ClientState>(
	options: LimiterOptions<TState>,
): MiddlewareHandler<TState> {
	admitOptions('createLimiter', LIMITER_CONTRACT, options)
	if (options.store !== undefined)
		admitForeign('createLimiter', ['store'], LIMITER_STORE_FOREIGN, options.store)
	const max = options.max
	const window = options.window
	const capacity = options.capacity ?? DEFAULT_LIMITER_CAPACITY
	const deriveKey = options.key
	const message = options.message ?? DEFAULT_LIMITER_MESSAGE
	const clock = options.clock ?? Date.now
	const policy = options.policy ?? false
	const evict = options.evict
	const store =
		options.store ??
		new MemoryLimiterStore({
			capacity,
			...(evict === undefined ? {} : { evict }),
		})
	const limits = { max, window }
	// The key is derived from `context` alone, so the first position is conformance-only.
	return async (_request, context, next) => {
		const key =
			deriveKey === undefined ? resolveKey(context.state, context.connection) : deriveKey(context)
		const now = clock()
		const result = await store.consume(key, now, limits)
		if (!result.admitted) {
			const headers = new Headers()
			headers.set('retry-after', buildRetryAfter(result.expiry, now))
			if (policy) {
				headers.set('ratelimit', buildRateLimitField(0, result.expiry, now))
				headers.set('ratelimit-policy', buildRateLimitPolicyField(max, window))
			}
			return new Response(message, { status: 429, headers })
		}
		return next()
	}
}

/**
 * Creates the body-driving battery — eagerly awaits the cached `context.body()` so
 * its throws (or a malformed-JSON `undefined`) surface before the handler
 * runs, and stashes the resolved value onto {@link BodyState.body}.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link BodyState}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {HTTPError} `400` when the request declares `application/json` and the body resolves `undefined`
 *
 * @remarks
 * The shipped `MiddlewareContext.body()` is a parameterless, server-owned
 * cache (`ServerOptions.limit` governs its size cap) — this battery carries
 * no `limit`/`decompression` options. `state.body` is
 * stashed from the same awaited call the 400 check reads — `context.body()`
 * is never invoked twice.
 *
 * @example
 * ```ts
 * const body = createBody()
 * ```
 */
export function createBody<TState extends BodyState = BodyState>(): MiddlewareHandler<TState> {
	return async (request, context, next) => {
		const body = await context.body()
		if (body !== undefined) Object.assign(context.state, { body })
		const contentType = request.headers.get('content-type')
		if (
			contentType !== null &&
			contentType.toLowerCase().startsWith('application/json') &&
			body === undefined
		)
			throw new HTTPError(400, 'invalid json')
		return next()
	}
}

/**
 * Creates the generic session battery — resolves, mints, and persists a session
 * across the request, with a mid-handler `regenerate`/`destroy` control handle.
 *
 * @remarks
 * The battery stores a session, and writes its credential, only after the handler
 * writes to it or regenerates it. A write is a `set`, `delete`, or `clear` that
 * leaves the state holding other keys or other values by `Object.is` than it held
 * when the handler started; a `set` of the value a key already holds is none. A
 * session minted for a request with no credential reads `control.fresh` as true and
 * leaves no trace in the store or on the response unless it is written.
 *
 * @typeParam S - The session entity type the store persists (must implement {@link SessionInterface})
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link SessionState}
 * @param options - See {@link SessionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole, or when `transport` or `store` lacks a member its interface declares
 * @throws {HTTPError} `404` when `required` is set and no session resolves or mints
 *
 * @example
 * ```ts
 * const session = createSession({ transport: createHeaderTransport() })
 * ```
 */
export function createSession<
	S extends SessionInterface = SessionInterface,
	TState extends SessionState = SessionState,
>(options: SessionOptions<S, TState>): MiddlewareHandler<TState> {
	admitOptions('createSession', SESSION_CONTRACT, options)
	admitForeign('createSession', ['transport'], SESSION_TRANSPORT_FOREIGN, options.transport)
	if (options.store !== undefined)
		admitForeign('createSession', ['store'], SESSION_STORE_FOREIGN, options.store)

	const transport = options.transport
	const clock = options.clock ?? Date.now
	const store: SessionStoreInterface<SessionInterface> =
		options.store ??
		new MemorySessionStore<SessionInterface>({
			...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
			...(options.lifetime !== undefined ? { lifetime: options.lifetime } : {}),
			...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
			...(options.evict !== undefined ? { evict: options.evict } : {}),
		})
	const create = options.create
	const mint = options.mint
	const requireSession = options.required ?? false

	return async (request, context, next) => {
		const now = clock()
		const encrypted = context.connection.encrypted
		const incomingId = await transport.read(request)
		const resolved = incomingId !== undefined ? await store.get(incomingId, now) : undefined
		const shouldMint = resolved === undefined && (mint !== undefined ? await mint(context) : true)
		const minted = shouldMint
			? create === undefined
				? new Session(crypto.randomUUID())
				: create(crypto.randomUUID())
			: undefined
		if (requireSession && resolved === undefined && minted === undefined)
			throw new HTTPError(404, 'session required')
		const activeSession = resolved ?? minted
		if (activeSession === undefined) return next()
		const control = new SessionControl(activeSession, create, minted !== undefined)
		const arrived = new Map(activeSession.state)
		Object.assign<
			object,
			{ readonly session: SessionInterface; readonly control: SessionControlInterface }
		>(context.state, { session: activeSession, control })

		const response = await next()

		if (control.destroyed) {
			await store.delete(activeSession.id)
			await transport.clear(response)
		} else if (control.successor !== undefined) {
			await store.set(control.successor, clock())
			await store.delete(activeSession.id)
			await transport.write(response, control.successor.id, encrypted)
		} else if (!matchesSessionState(arrived, activeSession.state)) {
			await store.set(activeSession, clock())
			if (minted !== undefined) await transport.write(response, activeSession.id, encrypted)
		}
		return response
	}
}

/**
 * Creates the CSRF protection battery: a signed double submit bound to the session the
 * client holds, or to the battery's own nonce cookie when it holds none.
 *
 * @remarks
 * A token is `random.HMAC(label + binding + random)` ({@link signCSRFToken}) and carries no
 * form of its binding. With a session the client holds (`state.session` present and
 * `control.fresh` not true), the binding is the session id and the battery writes no cookie.
 * Otherwise the binding is the nonce in the `cookie` cookie, which a safe request without
 * one mints and sets HttpOnly, `SameSite=Lax`, and `Path=/`. Every request that passes,
 * safe or not, stashes a token bound to the binding it arrived with on `state.csrf`, so
 * every token the binding minted verifies while it holds. A mutating request submits its
 * token in the `header`, or in the `field` of a JSON or urlencoded body; the battery reads
 * no other body, so a multipart form sends its token in the header.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link CSRFState} and {@link SessionState}
 * @param options - See {@link CSRFOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key such as `secret`, a missing `signer`, or a value outside its declared type; or when `signer` lacks `sign` or `verify`
 * @throws {HTTPError} `403` when a mutating request submits no token, a malformed one, or one not bound to the session it holds or to its nonce
 *
 * @example
 * ```ts
 * const csrf = createCSRF({ signer: createSigner('shh') })
 * ```
 */
export function createCSRF<TState extends CSRFState & SessionState>(
	options: CSRFOptions,
): MiddlewareHandler<TState> {
	admitOptions('createCSRF', CSRF_CONTRACT, options)
	admitForeign('createCSRF', ['signer'], SIGNER_FOREIGN, options.signer)

	const signer = options.signer
	const cookieName = options.cookie ?? DEFAULT_CSRF_COOKIE
	const header = options.header ?? DEFAULT_CSRF_HEADER
	const field = options.field ?? DEFAULT_CSRF_FIELD
	const safe = options.safe ?? DEFAULT_CSRF_SAFE_METHODS

	return async (request, context, next) => {
		const held = context.state.control?.fresh === true ? undefined : context.state.session?.id
		const cookie = parseCookies(request.headers.get('cookie') ?? undefined)[cookieName]
		const nonce =
			held === undefined && cookie !== undefined && CSRF_NONCE_PATTERN.test(cookie)
				? cookie
				: undefined
		const binding = held ?? nonce
		if (!safe.includes(context.method)) {
			const media = (request.headers.get('content-type') ?? '').split(';', 1)[0] ?? ''
			const submitted =
				request.headers.get(header) ??
				(CSRF_FIELD_TYPES.includes(media.trim().toLowerCase())
					? extractFieldToken(await context.body(), field)
					: undefined)
			if (
				submitted === undefined ||
				binding === undefined ||
				!(await verifyCSRFToken(signer, binding, submitted))
			)
				throw new HTTPError(403, 'invalid csrf token')
		}
		const issued = binding ?? generateNonce()
		Object.assign(context.state, { csrf: await signCSRFToken(signer, issued) })

		const response = await next()

		if (binding === undefined)
			response.headers.append(
				'set-cookie',
				serializeCookie(cookieName, issued, {
					httpOnly: true,
					sameSite: 'Lax',
					path: '/',
					secure: resolveSecure(undefined, context.connection.encrypted),
				}),
			)
		return response
	}
}

/**
 * Scopes a battery to the paths its route patterns match and nowhere else — outside
 * them it steps aside through `next()`.
 *
 * @remarks
 * Each pattern compiles through the router's `compilePath` and matches
 * `context.url.pathname` through its `matchPath`: case-sensitive whatever the
 * dispatcher's `sensitive` option, with one trailing slash optional, so `/admin`
 * covers `/admin` and `/admin/`. Under a dispatcher created with `sensitive: false`,
 * a case variant such as `/ADMIN` reaches the `/admin` route but falls outside the
 * pattern, so the battery does not run. A pattern covers no path beneath it: `/admin`
 * skips `/admin/users`. Add `/admin/*rest` to cover the paths beneath, and `:name`
 * matches one segment.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param paths - One route pattern, or a set of route patterns
 * @param handler - The battery to run when a pattern matches
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When `paths` is not a string or a string array, `handler` is not a function, or a pattern places a `*name` wildcard before its final segment
 *
 * @example
 * ```ts
 * const scoped = only(
 * 	['/admin', '/admin/*rest'],
 * 	createBearer({ verify: (token) => verifyToken(token, signer) }),
 * )
 * ```
 */
export function only<TState>(
	paths: string | readonly string[],
	handler: MiddlewareHandler<TState>,
): MiddlewareHandler<TState> {
	admitOptions('only', SCOPE_CONTRACT, { paths, handler })
	const patterns = (isString(paths) ? [paths] : paths).map((path) => compilePath(path))
	return async (request, context, next) => {
		if (matchesScope(patterns, context.url.pathname)) return handler(request, context, next)
		return next()
	}
}

/**
 * Scopes a battery to every path its route patterns do not match — on the matched
 * paths it steps aside through `next()`.
 *
 * @remarks
 * A pattern matches as `only` documents: through the router's `compilePath` and
 * `matchPath`, case-sensitive whatever the dispatcher's `sensitive` option, with one
 * trailing slash optional, and covering no path beneath it unless it ends in a `*name`
 * wildcard. Under a dispatcher created with `sensitive: false`, a case variant such as
 * `/ADMIN` reaches the `/admin` route but falls outside the pattern, so the battery runs.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param paths - One route pattern, or a set of route patterns
 * @param handler - The battery to run when no pattern matches
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When `paths` is not a string or a string array, `handler` is not a function, or a pattern places a `*name` wildcard before its final segment
 *
 * @example
 * ```ts
 * const scoped = except('/health', createTelemetry({ record }))
 * ```
 */
export function except<TState>(
	paths: string | readonly string[],
	handler: MiddlewareHandler<TState>,
): MiddlewareHandler<TState> {
	admitOptions('except', SCOPE_CONTRACT, { paths, handler })
	const patterns = (isString(paths) ? [paths] : paths).map((path) => compilePath(path))
	return async (request, context, next) => {
		if (matchesScope(patterns, context.url.pathname)) return next()
		return handler(request, context, next)
	}
}

/**
 * Serves validated in-memory assets with identity/Brotli negotiation.
 *
 * @remarks
 * Only `GET` and `HEAD` are served. `/` resolves to `index.html`. Every other
 * key is decoded once, must remain relative, and refuses empty, dot, climbing,
 * backslash, and dotfile segments before the source is read. Successful source
 * values are copied and cached by key. Concurrent misses can compute a digest twice.
 * A Brotli value is decompressed for
 * the identity representation; both representations share an ETag computed
 * from those identity bytes. Responses always vary on `Accept-Encoding`.
 * Range requests are intentionally served as full responses because an asset
 * source exposes complete in-memory representations rather than file handles.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link AssetOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole, or when `source` or `store` lacks a member its interface declares
 * @throws {TypeError} When the source returns malformed asset data
 * @throws {Error} When a source marks bytes as Brotli but they cannot be decompressed
 *
 * @example
 * ```ts
 * import { createAssets } from '@orkestrel/middleware'
 *
 * const assets = createAssets({
 * 	source: {
 * 		read: (path) =>
 * 			path === 'index.html'
 * 				? { body: new TextEncoder().encode('home') }
 * 				: undefined,
 * 	},
 * })
 * ```
 */
export function createAssets<TState>(options: AssetOptions): MiddlewareHandler<TState> {
	admitOptions('createAssets', ASSET_CONTRACT, options)
	admitForeign('createAssets', ['source'], ASSET_SOURCE_FOREIGN, options.source)
	if (options.store !== undefined)
		admitForeign('createAssets', ['store'], ASSET_STORE_FOREIGN, options.store)
	const store = options.store ?? new MemoryAssetStore()

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()
		const key = resolveAssetKey(context.url.pathname)
		if (key === undefined) return next()
		const cached = await store.get(key)
		const record = cached ?? (await readAssetRecord(options.source, key))
		if (record === undefined) return next()
		if (cached === undefined) await store.set(record)
		return buildAssetResponse(request, context.method, record)
	}
}

/**
 * Serves static files from `options.root` over `node:fs` — the node-bound static-file
 * battery, answering conditional, ranged, and SPA-fallback requests.
 *
 * @remarks
 * Containment is enforced on canonical paths, not merely the lexically
 * resolved one: `options.root` is canonicalized per request and every
 * request's candidate path is re-canonicalized (`fs.realpath`) before it is
 * served, so a symlink whose target escapes `root` is refused (falls through
 * to `next()`) even though the lexical path resolved inside `root`. A
 * symlink that resolves to a target still inside `root` is unaffected and
 * still serves normally. A dangling symlink (`realpath` throws `ENOENT`) or
 * any other `realpath` failure is treated as a miss — this battery never
 * throws or 500s on a symlink surprise. On a streamed response (a 200 or 206
 * that carries a file body), the open `FileHandle` is owned by the
 * `Response` body and is released only once that body is fully read or
 * cancelled — Node HTTP servers do this automatically when sending the
 * response, but a caller that holds an unread `Response` (for example in a test)
 * must cancel its body to release the handle promptly.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link StaticOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a `root` that is not a non-empty string, or a `cache` that is negative or not finite
 *
 * @example
 * ```ts
 * import { createStatic } from '@orkestrel/middleware'
 *
 * const serveFiles = createStatic({ root: '/srv/public', fallback: true })
 * ```
 */
export function createStatic<TState>(options: StaticOptions): MiddlewareHandler<TState> {
	admitOptions('createStatic', STATIC_CONTRACT, options)
	const root = resolvePath(options.root)
	const index = options.index ?? DEFAULT_STATIC_INDEX
	const dotfiles = options.dotfiles ?? DEFAULT_STATIC_DOTFILES
	const useETag = options.etag ?? true
	const fallback =
		options.fallback === true
			? { exclude: DEFAULT_STATIC_FALLBACK_EXCLUDE }
			: options.fallback === false || options.fallback === undefined
				? undefined
				: { exclude: options.fallback.exclude ?? DEFAULT_STATIC_FALLBACK_EXCLUDE }

	return async (request, context, next) => {
		const method = context.method
		if (method !== 'GET' && method !== 'HEAD') return next()

		const target = resolveStaticPath(root, options.prefix, context.url.pathname)
		if (target === undefined) return next()

		const relativePath = relative(root, target)
		if (relativePath.length > 0 && isDotfilePath(relativePath)) {
			if (dotfiles === 'deny') throw new HTTPError(403, 'forbidden')
			if (dotfiles === 'ignore') return next()
		}

		const rootReal = await realpath(root).catch(() => undefined)
		if (rootReal === undefined) return next()
		const primary = await resolveStaticFile(target, rootReal, index)
		if (primary !== undefined && !primary.contained) return next()
		const direct = primary === undefined ? undefined : await openStaticFile(primary.path)
		const shellPath =
			direct === undefined && fallback !== undefined
				? resolveStaticFallbackPath(
						root,
						index,
						fallback.exclude,
						method,
						context.url.pathname,
						request.headers.get('accept') ?? '',
					)
				: undefined
		const shellReal =
			shellPath === undefined ? undefined : await resolveStaticFile(shellPath, rootReal, index)
		const shell =
			shellReal === undefined || !shellReal.contained
				? undefined
				: await openStaticFile(shellReal.path)
		const file = direct ?? shell
		if (file === undefined) return next()
		try {
			const plan = planStaticResponse(request, method, file.info, file.path, {
				...(options.cache === undefined ? {} : { cache: options.cache }),
				etag: useETag,
			})
			const streamed = method === 'GET' && (plan.status === 200 || plan.status === 206)
			if (!streamed) {
				await file.handle.close()
				return new Response(null, plan)
			}
			const body = streamFile(file.handle, plan.range)
			return new Response(body, plan)
		} catch (error) {
			await file.handle.close().catch(() => {})
			throw error
		}
	}
}

/**
 * Parses a streamed `multipart/form-data` request body and stashes its
 * {@link MultipartBody} on `context.state.multipart` — the node-bound
 * streaming multipart battery.
 *
 * @remarks
 * A non-multipart request passes through untouched. Consumes `request.body`
 * as a stream — `context.body()` must not be called for a request this
 * battery has processed (the underlying stream is exhausted). Every
 * {@link MultipartError} this battery's parser throws is re-thrown as an
 * {@link HTTPError} carrying the same status/message, so `createBoundary`
 * (or any HTTPError-aware renderer) maps it correctly without depending on
 * this node face's error type. When `next()` settles, by a return or a throw,
 * every uploaded file still at its staged path is unlinked (best-effort), so a
 * handler moves or reads each file it keeps before it returns.
 *
 * @typeParam TState - The consumer's state type, extending {@link MultipartState}
 * @param options - See {@link MultipartOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a size or total that is negative or not finite, or a count that is not a non-negative integer
 * @throws {HTTPError} When the underlying parse throws a {@link MultipartError}
 * (limit breach → 413, malformed structure → 400, rejected file type → 415)
 *
 * @example
 * ```ts
 * import { createMultipart } from '@orkestrel/middleware'
 *
 * const uploads = createMultipart({ allowed: ['image/png', 'image/jpeg'] })
 * ```
 */
export function createMultipart<TState extends MultipartState>(
	options: MultipartOptions = {},
): MiddlewareHandler<TState> {
	admitOptions('createMultipart', MULTIPART_CONTRACT, options)
	return async (request, context, next) => {
		const [outcome] = await Promise.allSettled([parseMultipartRequest(request, options)])
		if (outcome.status === 'rejected') {
			const error: unknown = outcome.reason
			if (isMultipartError(error)) throw new HTTPError(error.status, error.message, error.context)
			throw error
		}
		const body = outcome.value
		if (body === undefined) return next()
		Object.assign(context.state, { multipart: body })
		try {
			return await next()
		} finally {
			await unlinkStagedFiles(body)
		}
	}
}

/**
 * Compresses response bodies through `node:zlib`, which every Node runtime bundles,
 * instead of relying on the WHATWG `CompressionStream` global. This battery is the
 * node-bound sibling of the feature-detected `createCompression`, and both
 * compose the same `compressResponse` skeleton.
 *
 * @remarks
 * Peer-type limitation, the same one `createCompression` carries: the shipped
 * `@orkestrel/server` `Encoding` union is `'gzip' | 'deflate' | 'identity'`
 * — it does not include `'br'`, so this battery cannot type or negotiate a
 * brotli coding although `node:zlib` ships `brotliCompress`. It compresses
 * `gzip` and `deflate` through `node:zlib`, which every Node runtime bundles,
 * so it never feature-detects them, and it negotiates only those two.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link NodeCompressionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a `threshold` that is negative or not finite, or a `filter` that is not a function
 *
 * @example
 * ```ts
 * import { createNodeCompression } from '@orkestrel/middleware'
 *
 * const compress = createNodeCompression({ threshold: 512 })
 * ```
 */
export function createNodeCompression<TState>(
	options?: NodeCompressionOptions,
): MiddlewareHandler<TState> {
	admitOptions('createNodeCompression', NODE_COMPRESSION_CONTRACT, options)
	const threshold = options?.threshold ?? DEFAULT_COMPRESSION_THRESHOLD
	const filter = options?.filter
	const encodings = NODE_COMPRESSION_ENCODINGS
	return async (request, context, next) => {
		const response = await next()
		return compressResponse(request, context, response, {
			threshold,
			...(filter !== undefined ? { filter } : {}),
			encodings,
			compress: compressNodeBytes,
		})
	}
}
