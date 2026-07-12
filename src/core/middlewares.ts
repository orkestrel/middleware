import type {
	BearerOptions,
	BearerState,
	BoundaryOptions,
	ClientState,
	CompressionOptions,
	CorsOptions,
	CSRFOptions,
	CSRFState,
	DeadlineOptions,
	ETagOptions,
	ForwardedOptions,
	LimiterOptions,
	SecurityOptions,
	SessionControlInterface,
	SessionInterface,
	SessionOptions,
	SessionState,
	SessionStoreInterface,
	TelemetryOptions,
} from './types.js'
import type { BudgetInterface } from '@orkestrel/budget'
import type { MiddlewareContext, MiddlewareHandler } from '@orkestrel/server'
import { isBoolean, isFiniteNumber, isFunction, isRecord, isString } from '@orkestrel/contract'
import { linkSignal } from '@orkestrel/abort'
import { createBudget } from '@orkestrel/budget'
import {
	HTTPError,
	isCompressibleType,
	isHTTPError,
	isValidRequestId,
	mergeVary,
	negotiateEncoding,
	readSignedCookie,
	resolveOrigin,
	resolveSecurityHeader,
	signToken,
	verifyToken,
	writeSignedCookie,
} from '@orkestrel/server'
import { createTimeout } from '@orkestrel/timeout'
import {
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
} from './constants.js'
import {
	buildClientInfo,
	buildRateLimitField,
	buildRateLimitPolicyField,
	buildRetryAfter,
	detectEncodings,
	equalsConstantTime,
	isBufferingIneligible,
	isCompressionNegotiated,
	isPreflight,
	resolveForwardedFor,
	resolveKey,
	transferSessionData,
} from './helpers.js'
import type { ConnectionState } from './helpers.js'
import { MemorySessionStore } from './MemorySessionStore.js'
import { Session } from './Session.js'
import { computeBodyETag, matchesETag } from '@orkestrel/server'

// ============================================================================
//  @orkestrel/middleware — the thirteen pure battery factories
//  (AGENTS §5 middlewares.ts). Each `create{Noun}` closes over its guarded
//  option bag and returns a `MiddlewareHandler<TState>` — a behavior, never a
//  class. See PROPOSAL.md §4 and the orchestrator's seam rulings A–K for the
//  exact semantics each battery pins.
// ============================================================================

/**
 * The outermost error-rendering battery — catches a downstream throw and
 * renders it as a `Response`.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link BoundaryOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.expose` or `options.report` is malformed
 *
 * @example
 * ```ts
 * const boundary = createBoundary({ expose: false })
 * ```
 */
export function createBoundary<TState>(options?: BoundaryOptions): MiddlewareHandler<TState> {
	if (options?.expose !== undefined && !isBoolean(options.expose))
		throw new TypeError('BoundaryOptions.expose must be a boolean when provided')
	if (options?.report !== undefined && !isFunction(options.report))
		throw new TypeError('BoundaryOptions.report must be a function when provided')
	const expose = options?.expose ?? false
	const report = options?.report
	return async (request, context, next) => {
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
				? error instanceof Error
					? error.message
					: String(error)
				: 'internal server error'
			return new Response(message, { status: 500 })
		}
	}
}

/**
 * The access-log/timing seam — records one {@link TelemetryEntry} per request
 * after the response settles.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link TelemetryOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.record` is not a function
 *
 * @example
 * ```ts
 * const telemetry = createTelemetry({ record: (entry) => console.log(entry) })
 * ```
 */
export function createTelemetry<TState>(options: TelemetryOptions): MiddlewareHandler<TState> {
	if (!isFunction(options.record)) throw new TypeError('TelemetryOptions.record must be a function')
	const record = options.record
	return async (request, context, next) => {
		const start = Date.now()
		let response: Response | undefined
		try {
			response = await next()
			return response
		} finally {
			const duration = Date.now() - start
			const status = response?.status ?? 500
			try {
				record({ method: context.method, pathname: context.url.pathname, status, duration })
			} catch {
				// record's own throw is swallowed — a broken sink can never fail the response.
			}
		}
	}
}

/**
 * Response-body compression — negotiates and compresses a buffered response
 * body over the runtime's feature-detected `CompressionStream` codings.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link CompressionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.threshold` or `options.filter` is malformed
 *
 * @example
 * ```ts
 * const compression = createCompression({ threshold: 1024 })
 * ```
 */
export function createCompression<TState>(options?: CompressionOptions): MiddlewareHandler<TState> {
	if (options?.threshold !== undefined && !isFiniteNumber(options.threshold))
		throw new TypeError('CompressionOptions.threshold must be a finite number when provided')
	if (options?.filter !== undefined && !isFunction(options.filter))
		throw new TypeError('CompressionOptions.filter must be a function when provided')
	const threshold = options?.threshold ?? DEFAULT_COMPRESSION_THRESHOLD
	const encodings = detectEncodings(options?.encodings ?? DEFAULT_COMPRESSION_ENCODINGS)
	const filter = options?.filter
	return async (request, context, next) => {
		const response = await next()
		if (isBufferingIneligible(context.method, response, 'content-encoding')) return response
		if (filter !== undefined && !filter(request, response)) return response
		const acceptEncoding = request.headers.get('accept-encoding')
		if (acceptEncoding === null) return response
		const negotiated = negotiateEncoding(acceptEncoding, encodings)
		if (!isCompressionNegotiated(negotiated)) return response
		const contentType = response.headers.get('content-type')
		if (contentType === null || !isCompressibleType(contentType)) return response
		const buffer = await response.arrayBuffer()
		if (buffer.byteLength < threshold)
			return new Response(buffer, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		const source = new Response(buffer).body
		if (source === null)
			return new Response(buffer, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		const compressed = await new Response(
			source.pipeThrough(new CompressionStream(negotiated)),
		).arrayBuffer()
		const headers = new Headers(response.headers)
		headers.set('content-encoding', negotiated)
		headers.set('vary', mergeVary(headers.get('vary') ?? undefined, 'Accept-Encoding'))
		headers.set('content-length', String(compressed.byteLength))
		return new Response(compressed, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
}

/**
 * Resolve an opt-in, value-bearing security header — `string | boolean`
 * (default OFF, `true` uses the secure default), the shape `createSecurity`'s
 * `coep`/`hsts` options use, distinct from the plain value-or-`false` shape
 * `resolveSecurityHeader` (the peer substrate) handles.
 *
 * @param value - The option value — a `string` override, `true` for the secure default, or `false`/`undefined` to omit
 * @param fallback - The secure-default value used when `value` is `true`
 * @returns The header value to set, or `undefined` to omit the header
 *
 * @example
 * ```ts
 * resolveOptInHeader(true, 'require-corp') // 'require-corp'
 * resolveOptInHeader(undefined, 'require-corp') // undefined — omitted
 * ```
 */
export function resolveOptInHeader(
	value: string | boolean | undefined,
	fallback: string,
): string | undefined {
	if (value === true) return fallback
	if (value === false || value === undefined) return undefined
	return value
}

/**
 * Security-headers + request-identifier battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link IdentifierState}
 * @param options - See {@link SecurityOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 *
 * @example
 * ```ts
 * const security = createSecurity({ hsts: true })
 * ```
 */
export function createSecurity<TState extends { identifier?: string }>(
	options?: SecurityOptions,
): MiddlewareHandler<TState> {
	if (
		options?.frame !== undefined &&
		options.frame !== false &&
		options.frame !== 'DENY' &&
		options.frame !== 'SAMEORIGIN'
	)
		throw new TypeError(
			"SecurityOptions.frame must be 'DENY', 'SAMEORIGIN', or false when provided",
		)
	if (options?.csp !== undefined && options.csp !== false && !isString(options.csp))
		throw new TypeError('SecurityOptions.csp must be a string or false when provided')
	if (options?.referrer !== undefined && options.referrer !== false && !isString(options.referrer))
		throw new TypeError('SecurityOptions.referrer must be a string or false when provided')
	if (
		options?.permissions !== undefined &&
		options.permissions !== false &&
		!isString(options.permissions)
	)
		throw new TypeError('SecurityOptions.permissions must be a string or false when provided')
	if (options?.coop !== undefined && options.coop !== false && !isString(options.coop))
		throw new TypeError('SecurityOptions.coop must be a string or false when provided')
	if (options?.corp !== undefined && options.corp !== false && !isString(options.corp))
		throw new TypeError('SecurityOptions.corp must be a string or false when provided')
	if (options?.cluster !== undefined && options.cluster !== false && !isString(options.cluster))
		throw new TypeError('SecurityOptions.cluster must be a string or false when provided')
	if (options?.coep !== undefined && !isBoolean(options.coep) && !isString(options.coep))
		throw new TypeError('SecurityOptions.coep must be a string or boolean when provided')
	if (options?.hsts !== undefined && !isBoolean(options.hsts) && !isString(options.hsts))
		throw new TypeError('SecurityOptions.hsts must be a string or boolean when provided')
	if (
		options?.identifier !== undefined &&
		options.identifier !== false &&
		!isRecord(options.identifier)
	)
		throw new TypeError('SecurityOptions.identifier must be an options bag or false when provided')
	if (
		isRecord(options?.identifier) &&
		options.identifier.trust !== undefined &&
		!isBoolean(options.identifier.trust)
	)
		throw new TypeError('SecurityOptions.identifier.trust must be a boolean when provided')

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
		let identifier: string | undefined
		if (identifierEnabled) {
			const incoming = request.headers.get(DEFAULT_IDENTIFIER_HEADER)
			identifier =
				trust && incoming !== null && isValidRequestId(incoming) ? incoming : crypto.randomUUID()
			context.state.identifier = identifier
		}
		const response = await next()
		response.headers.set('x-content-type-options', 'nosniff')
		const frameValue = resolveSecurityHeader(frame, DEFAULT_FRAME_OPTIONS)
		if (frameValue !== undefined) response.headers.set('x-frame-options', frameValue)
		const cspValue = resolveSecurityHeader(csp, DEFAULT_CSP)
		if (cspValue !== undefined) response.headers.set('content-security-policy', cspValue)
		const referrerValue = resolveSecurityHeader(referrer, DEFAULT_REFERRER_POLICY)
		if (referrerValue !== undefined) response.headers.set('referrer-policy', referrerValue)
		const permissionsValue = resolveSecurityHeader(permissions, DEFAULT_PERMISSIONS_POLICY)
		if (permissionsValue !== undefined) response.headers.set('permissions-policy', permissionsValue)
		const coopValue = resolveSecurityHeader(coop, DEFAULT_COOP)
		if (coopValue !== undefined) response.headers.set('cross-origin-opener-policy', coopValue)
		const corpValue = resolveSecurityHeader(corp, DEFAULT_CORP)
		if (corpValue !== undefined) response.headers.set('cross-origin-resource-policy', corpValue)
		const clusterValue = resolveSecurityHeader(cluster, DEFAULT_CLUSTER)
		if (clusterValue !== undefined) response.headers.set('origin-agent-cluster', clusterValue)
		const coepValue = resolveOptInHeader(coep, DEFAULT_COEP)
		if (coepValue !== undefined) response.headers.set('cross-origin-embedder-policy', coepValue)
		const hstsValue = resolveOptInHeader(hsts, DEFAULT_HSTS)
		if (hstsValue !== undefined) response.headers.set('strict-transport-security', hstsValue)
		if (identifierEnabled && identifier !== undefined)
			response.headers.set(DEFAULT_IDENTIFIER_HEADER, identifier)
		return response
	}
}

/**
 * Cross-Origin Resource Sharing battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link CorsOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 *
 * @example
 * ```ts
 * const cors = createCors({ origin: ['https://app.example'] })
 * ```
 */
export function createCors<TState>(options?: CorsOptions): MiddlewareHandler<TState> {
	if (options?.origin !== undefined && !isString(options.origin) && !Array.isArray(options.origin))
		throw new TypeError('CorsOptions.origin must be a string or string array when provided')
	if (options?.methods !== undefined && !Array.isArray(options.methods))
		throw new TypeError('CorsOptions.methods must be an array when provided')
	if (options?.headers !== undefined && !Array.isArray(options.headers))
		throw new TypeError('CorsOptions.headers must be an array when provided')
	const origin = options?.origin ?? '*'
	const methods = options?.methods ?? DEFAULT_CORS_METHODS
	const headers = options?.headers ?? DEFAULT_CORS_HEADERS
	const reflecting = Array.isArray(origin)
	return async (request, context, next) => {
		const requestOrigin = request.headers.get('origin') ?? undefined
		const allowOrigin = resolveOrigin(origin, requestOrigin)
		if (isPreflight(context.method, request.headers)) {
			const preflightHeaders = new Headers()
			if (allowOrigin !== undefined)
				preflightHeaders.set('access-control-allow-origin', allowOrigin)
			preflightHeaders.set('access-control-allow-methods', methods.join(', '))
			preflightHeaders.set('access-control-allow-headers', headers.join(', '))
			if (reflecting && allowOrigin !== undefined)
				preflightHeaders.set('vary', mergeVary(undefined, 'Origin'))
			return new Response(null, { status: 204, headers: preflightHeaders })
		}
		const response = await next()
		if (allowOrigin !== undefined) response.headers.set('access-control-allow-origin', allowOrigin)
		if (reflecting && allowOrigin !== undefined)
			response.headers.set('vary', mergeVary(response.headers.get('vary') ?? undefined, 'Origin'))
		return response
	}
}

/**
 * The application-level per-request deadline battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link DeadlineOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.ms` or `options.status` is malformed
 *
 * @example
 * ```ts
 * const deadline = createDeadline({ ms: 5_000 })
 * ```
 */
export function createDeadline<TState>(options: DeadlineOptions): MiddlewareHandler<TState> {
	if (!isFiniteNumber(options.ms)) throw new TypeError('DeadlineOptions.ms must be a finite number')
	if (options.status !== undefined && !isFiniteNumber(options.status))
		throw new TypeError('DeadlineOptions.status must be a finite number when provided')
	const ms = options.ms
	const status = options.status ?? DEFAULT_DEADLINE_STATUS
	return async (request, context, next) => {
		const timeout = createTimeout({ ms })
		const linked = linkSignal(timeout.signal, request.signal)
		timeout.start()
		const downstream = next(new Request(request, { signal: linked }))
		const deadline = new Promise<Response>((resolve) => {
			timeout.signal.addEventListener('abort', () => resolve(new Response(null, { status })), {
				once: true,
			})
		})
		try {
			return await Promise.race([downstream, deadline])
		} finally {
			timeout.clear()
			// The losing `next()` promise is settled-and-discarded — a late throw
			// from it can never surface as an unhandled rejection.
			downstream.catch(() => {})
		}
	}
}

/**
 * The trusted-proxy client-IP resolver battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link ClientState} and {@link ConnectionState}
 * @param options - See {@link ForwardedOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When neither or both of `proxies`/`trusted` are provided, or either is malformed
 *
 * @example
 * ```ts
 * const forwarded = createForwarded({ proxies: 1 })
 * ```
 */
export function createForwarded<TState extends ClientState & ConnectionState>(
	options: ForwardedOptions,
): MiddlewareHandler<TState> {
	const proxies = options.proxies
	const trusted = options.trusted
	if (proxies === undefined && trusted === undefined)
		throw new TypeError('ForwardedOptions requires exactly one of proxies or trusted')
	if (proxies !== undefined && trusted !== undefined)
		throw new TypeError('ForwardedOptions requires exactly one of proxies or trusted')
	if (
		proxies !== undefined &&
		(!isFiniteNumber(proxies) || !Number.isInteger(proxies) || proxies < 1)
	)
		throw new TypeError('ForwardedOptions.proxies must be a positive integer')
	if (trusted !== undefined && !Array.isArray(trusted))
		throw new TypeError('ForwardedOptions.trusted must be an array when provided')
	const trust = proxies !== undefined ? { proxies } : { trusted: trusted ?? [] }
	return async (request, context, next) => {
		const header = request.headers.get('x-forwarded-for') ?? undefined
		const resolved = resolveForwardedFor(header, trust)
		const ip = resolved ?? context.state.connection?.ip
		context.state.client = buildClientInfo(ip)
		return next()
	}
}

/**
 * Dynamic response `ETag` + conditional GET battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link ETagOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.weak` is not a boolean
 *
 * @example
 * ```ts
 * const etag = createETag({ weak: true })
 * ```
 */
export function createETag<TState>(options?: ETagOptions): MiddlewareHandler<TState> {
	if (options?.weak !== undefined && !isBoolean(options.weak))
		throw new TypeError('ETagOptions.weak must be a boolean when provided')
	const weak = options?.weak ?? true
	return async (request, context, next) => {
		const response = await next()
		if (context.method !== 'GET' || response.status !== 200) return response
		if (isBufferingIneligible(context.method, response, 'etag')) return response
		const buffer = await response.arrayBuffer()
		const bytes = new Uint8Array(buffer)
		const etag = await computeBodyETag(bytes, weak)
		const ifNoneMatch = request.headers.get('if-none-match')
		if (ifNoneMatch !== null && matchesETag(ifNoneMatch, etag))
			return new Response(null, { status: 304, headers: response.headers })
		const headers = new Headers(response.headers)
		headers.set('etag', etag)
		return new Response(bytes, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
}

/**
 * Bearer-token authentication battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link BearerState}
 * @param options - See {@link BearerOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 * @throws {HTTPError} `401` when the token is missing, invalid, or expired
 *
 * @example
 * ```ts
 * const bearer = createBearer({ secret: 'shh' })
 * ```
 */
export function createBearer<TState extends BearerState>(
	options: BearerOptions,
): MiddlewareHandler<TState> {
	if (!isString(options.secret) && !Array.isArray(options.secret))
		throw new TypeError('BearerOptions.secret must be a string or string array')
	if (options.header !== undefined && !isString(options.header))
		throw new TypeError('BearerOptions.header must be a string when provided')
	if (options.scheme !== undefined && !isString(options.scheme))
		throw new TypeError('BearerOptions.scheme must be a string when provided')
	const secret = options.secret
	const header = (options.header ?? DEFAULT_BEARER_HEADER).toLowerCase()
	const scheme = options.scheme ?? DEFAULT_BEARER_SCHEME
	return async (request, context, next) => {
		const raw = request.headers.get(header)
		if (raw === null) throw new HTTPError(401, 'missing token')
		let candidate = raw
		if (scheme !== '') {
			const prefix = `${scheme.toLowerCase()} `
			if (!raw.toLowerCase().startsWith(prefix)) throw new HTTPError(401, 'missing token')
			candidate = raw.slice(prefix.length)
		}
		const verified = await verifyToken(candidate, secret)
		if (verified === undefined) throw new HTTPError(401, 'invalid token')
		context.state.token = verified
		return next()
	}
}

/**
 * Fixed-window rate-limiting battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link BearerState}, {@link ClientState}, and {@link ConnectionState}
 * @param options - See {@link LimiterOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 *
 * @example
 * ```ts
 * const limiter = createLimiter({ max: 100, window: 60_000 })
 * ```
 */
export function createLimiter<TState extends BearerState & ClientState & ConnectionState>(
	options: LimiterOptions<TState>,
): MiddlewareHandler<TState> {
	if (!isFiniteNumber(options.max))
		throw new TypeError('LimiterOptions.max must be a finite number')
	if (!isFiniteNumber(options.window))
		throw new TypeError('LimiterOptions.window must be a finite number')
	if (options.capacity !== undefined && !isFiniteNumber(options.capacity))
		throw new TypeError('LimiterOptions.capacity must be a finite number when provided')
	if (options.key !== undefined && !isFunction(options.key))
		throw new TypeError('LimiterOptions.key must be a function when provided')
	if (options.message !== undefined && !isString(options.message))
		throw new TypeError('LimiterOptions.message must be a string when provided')
	if (options.clock !== undefined && !isFunction(options.clock))
		throw new TypeError('LimiterOptions.clock must be a function when provided')
	if (options.policy !== undefined && !isBoolean(options.policy))
		throw new TypeError('LimiterOptions.policy must be a boolean when provided')
	const max = options.max
	const window = options.window
	const capacity = options.capacity ?? DEFAULT_LIMITER_CAPACITY
	const deriveKey =
		options.key ?? ((context: MiddlewareContext<TState>) => resolveKey(context.state))
	const message = options.message ?? DEFAULT_LIMITER_MESSAGE
	const clock = options.clock ?? Date.now
	const policy = options.policy ?? false
	const buckets = new Map<string, { budget: BudgetInterface<number>; resetAt: number }>()
	return async (request, context, next) => {
		const key = deriveKey(context)
		const now = clock()
		let bucket = buckets.get(key)
		if (bucket === undefined) {
			if (buckets.size >= capacity) {
				const oldest = buckets.keys().next().value
				if (oldest !== undefined) buckets.delete(oldest)
			}
			bucket = {
				budget: createBudget<number>({ max, consume: (value) => value }),
				resetAt: now + window,
			}
			buckets.set(key, bucket)
		} else if (now >= bucket.resetAt) {
			bucket.budget.clear()
			bucket.resetAt = now + window
		}
		if (bucket.budget.exhausted) {
			const headers = new Headers()
			headers.set('retry-after', buildRetryAfter(bucket.resetAt, now))
			if (policy) {
				headers.set('ratelimit', buildRateLimitField(0, bucket.resetAt, now))
				headers.set('ratelimit-policy', buildRateLimitPolicyField(max, window))
			}
			return new Response(message, { status: 429, headers })
		}
		bucket.budget.consume(1)
		return next()
	}
}

/**
 * The body-driving battery — eagerly awaits the cached `context.body()` so
 * its throws (or a malformed-JSON `undefined`) surface before the handler runs.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @returns A `MiddlewareHandler<TState>`
 * @throws {HTTPError} `400` when the request declares `application/json` and the body resolves `undefined`
 *
 * @remarks
 * The shipped `MiddlewareContext.body()` is a parameterless, server-owned
 * cache (`ServerOptions.limit` governs its size cap) — this battery carries
 * no `limit`/`decompression` options (a deliberate break from the deleted old
 * `createBodyParser` surface, which configured them itself).
 *
 * @example
 * ```ts
 * const body = createBody()
 * ```
 */
export function createBody<TState>(): MiddlewareHandler<TState> {
	return async (request, context, next) => {
		const body = await context.body()
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
 * The generic session battery — resolves, mints, and persists a session
 * across the request, with a mid-handler `regenerate`/`destroy` control handle.
 *
 * @typeParam S - The session entity type the store persists (must implement {@link SessionInterface})
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link SessionState}
 * @param options - See {@link SessionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 * @throws {HTTPError} `404` when `require` is set and no session resolves or mints
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
	if (
		!isFunction(options.transport.read) ||
		!isFunction(options.transport.write) ||
		!isFunction(options.transport.clear)
	)
		throw new TypeError('SessionOptions.transport must implement SessionTransport')
	if (
		options.store !== undefined &&
		(!isFunction(options.store.get) ||
			!isFunction(options.store.set) ||
			!isFunction(options.store.delete))
	)
		throw new TypeError('SessionOptions.store must implement SessionStoreInterface when provided')
	if (options.ttl !== undefined && !isFiniteNumber(options.ttl))
		throw new TypeError('SessionOptions.ttl must be a finite number when provided')
	if (options.lifetime !== undefined && !isFiniteNumber(options.lifetime))
		throw new TypeError('SessionOptions.lifetime must be a finite number when provided')
	if (options.create !== undefined && !isFunction(options.create))
		throw new TypeError('SessionOptions.create must be a function when provided')
	if (options.mint !== undefined && !isFunction(options.mint))
		throw new TypeError('SessionOptions.mint must be a function when provided')
	if (options.require !== undefined && !isBoolean(options.require))
		throw new TypeError('SessionOptions.require must be a boolean when provided')
	if (options.ends !== undefined && !isBoolean(options.ends))
		throw new TypeError('SessionOptions.ends must be a boolean when provided')
	if (options.clock !== undefined && !isFunction(options.clock))
		throw new TypeError('SessionOptions.clock must be a function when provided')

	const transport = options.transport
	const clock = options.clock ?? Date.now
	const store: SessionStoreInterface<SessionInterface> =
		options.store ??
		new MemorySessionStore<SessionInterface>({ ttl: options.ttl, lifetime: options.lifetime })
	const create: (id: string) => SessionInterface =
		options.create ?? ((id: string) => new Session(id))
	const mint = options.mint
	const requireSession = options.require ?? false
	const ends = options.ends ?? false

	return async (request, context, next) => {
		const now = clock()
		const incomingId = await transport.read(request)
		let session = incomingId !== undefined ? await store.get(incomingId, now) : undefined

		if (ends && context.method === 'DELETE' && session !== undefined) {
			await store.delete(session.id)
			return new Response(null, { status: 204 })
		}

		let minted = false
		if (session === undefined) {
			const shouldMint = mint !== undefined ? await mint(context) : true
			if (shouldMint) {
				const id = crypto.randomUUID()
				session = create(id)
				await store.set(id, session, now)
				minted = true
			} else if (requireSession) {
				throw new HTTPError(404, 'session required')
			}
		}

		let destroyed = false
		let regenerated: SessionInterface | undefined
		const activeSession = session

		if (activeSession !== undefined) {
			const control: SessionControlInterface = {
				regenerate() {
					if (destroyed) return
					const newSession = create(crypto.randomUUID())
					transferSessionData(activeSession, newSession)
					regenerated = newSession
				},
				destroy() {
					destroyed = true
					regenerated = undefined
				},
			}
			context.state.session = activeSession
			context.state.control = control
		}

		const response = await next()

		if (activeSession !== undefined) {
			if (destroyed) {
				await store.delete(activeSession.id)
				await transport.clear(response)
			} else if (regenerated !== undefined) {
				await store.set(regenerated.id, regenerated, clock())
				await store.delete(activeSession.id)
				await transport.write(response, regenerated.id)
			} else {
				await store.set(activeSession.id, activeSession, clock())
				if (minted) await transport.write(response, activeSession.id)
			}
		}

		return response
	}
}

/**
 * Session-bound double-submit CSRF protection battery.
 *
 * @typeParam TState - The consumer's opaque per-request state type, must carry {@link CSRFState} and {@link SessionState}
 * @param options - See {@link CSRFOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When any option is malformed
 * @throws {HTTPError} `403` when the submitted token is missing, mismatched, or bound to a different session
 *
 * @example
 * ```ts
 * const csrf = createCSRF({ secret: 'shh' })
 * ```
 */
export function createCSRF<TState extends CSRFState & SessionState>(
	options: CSRFOptions,
): MiddlewareHandler<TState> {
	if (!isString(options.secret) && !Array.isArray(options.secret))
		throw new TypeError('CSRFOptions.secret must be a string or string array')
	if (options.cookie !== undefined && !isString(options.cookie))
		throw new TypeError('CSRFOptions.cookie must be a string when provided')
	if (options.header !== undefined && !isString(options.header))
		throw new TypeError('CSRFOptions.header must be a string when provided')
	if (options.field !== undefined && !isString(options.field))
		throw new TypeError('CSRFOptions.field must be a string when provided')
	if (options.safe !== undefined && !Array.isArray(options.safe))
		throw new TypeError('CSRFOptions.safe must be an array when provided')

	const secret = options.secret
	const cookieName = options.cookie ?? DEFAULT_CSRF_COOKIE
	const header = options.header ?? DEFAULT_CSRF_HEADER
	const field = options.field ?? DEFAULT_CSRF_FIELD
	const safe = options.safe ?? DEFAULT_CSRF_SAFE_METHODS

	return async (request, context, next) => {
		if (safe.includes(context.method)) {
			const bound = context.state.session?.id ?? crypto.randomUUID()
			const token = await signToken(bound, { secret })
			context.state.csrf = token
			const response = await next()
			await writeSignedCookie(response.headers, cookieName, token, secret, {
				sameSite: 'Strict',
				httpOnly: false,
				path: '/',
			})
			return response
		}

		const headerToken = request.headers.get(header)
		let submitted: string | undefined
		if (headerToken !== null) {
			submitted = headerToken
		} else {
			const body = await context.body()
			if (isRecord(body) && isString(body[field])) submitted = body[field]
		}
		if (submitted === undefined) throw new HTTPError(403, 'invalid csrf token')
		const cookieToken = await readSignedCookie(request, cookieName, secret)
		if (cookieToken === undefined || !equalsConstantTime(cookieToken, submitted))
			throw new HTTPError(403, 'invalid csrf token')
		const sessionId = context.state.session?.id
		if (sessionId !== undefined) {
			const boundId = await verifyToken(cookieToken, secret)
			if (boundId !== sessionId) throw new HTTPError(403, 'invalid csrf token')
		}
		return next()
	}
}
