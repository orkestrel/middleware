import type {
	BearerState,
	ClientInfo,
	ClientState,
	ConnectionState,
	MultipartBody,
	MultipartFile,
	SessionControlInterface,
	SessionInterface,
} from './types.js'
import type { Encoding, MiddlewareContext } from '@orkestrel/server'
import { isRecord, isString } from '@orkestrel/contract'
import { clientRateKey, isCompressibleType, mergeVary, negotiateEncoding } from '@orkestrel/server'
import { Session } from './Session.js'

// ============================================================================
//  @orkestrel/middleware — core pure leaves (AGENTS §5 helpers.ts).
//  Every function here is a self-contained, referentially-transparent
//  computation the battery factories in middlewares.ts compose — key
//  derivation, wire-field builders, the forwarded-header hop walk,
//  compression feature detection, buffering-eligibility predicates, the
//  session data-carry, and the total state-slice guards.
// ============================================================================

/**
 * Derive `createLimiter`'s default rate-limit bucket key from a request's
 * resolved identity facts.
 *
 * @remarks
 * Prefers a verified bearer token ({@link BearerState.token}) as
 * `token:<value>`; else a resolved client IP ({@link ClientState.client.ip},
 * set when `createForwarded` is mounted) or the raw socket peer
 * ({@link ConnectionState.connection.ip}) collapsed via `clientRateKey`
 * (IPv6 to its `/64` network) as `ip:<key>`; else the literal `ip:unknown`.
 * Never reads `X-Forwarded-For` itself — that trust decision belongs solely
 * to `createForwarded`.
 *
 * @param state - The slices `createLimiter`'s default key may read
 * @returns The bucket key for the request
 *
 * @example
 * ```ts
 * resolveKey({ token: 'abc' }) // 'token:abc'
 * resolveKey({ client: { ip: '2001:db8::1' } }) // 'ip:2001:db8:0:0::/64'
 * ```
 */
export function resolveKey(state: BearerState & ClientState & ConnectionState): string {
	if (state.token !== undefined) return `token:${state.token}`
	const ip = state.client?.ip ?? state.connection?.ip
	if (ip !== undefined) return `ip:${clientRateKey(ip)}`
	return 'ip:unknown'
}

/**
 * Build the `Retry-After` header value — whole seconds until a window reset,
 * floored at a minimum of `1` (ruling I).
 *
 * @param resetAt - The window reset instant (same clock unit as `now`)
 * @param now - The current instant
 * @returns The `Retry-After` value in whole seconds, minimum `1`
 *
 * @example
 * ```ts
 * buildRetryAfter(1_500, 1_000) // '1'
 * ```
 */
export function buildRetryAfter(resetAt: number, now: number): string {
	const seconds = Math.ceil((resetAt - now) / 1000)
	return String(Math.max(1, seconds))
}

/**
 * Build the draft `RateLimit` structured header field (ruling I) — emitted
 * only when `createLimiter`'s `policy` option is `true`.
 *
 * @param remaining - The requests still admitted this window
 * @param resetAt - The window reset instant (same clock unit as `now`)
 * @param now - The current instant
 * @returns The `RateLimit` header value
 *
 * @example
 * ```ts
 * buildRateLimitField(4, 1_500, 1_000) // '"default";r=4;t=1'
 * ```
 */
export function buildRateLimitField(remaining: number, resetAt: number, now: number): string {
	const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
	return `"default";r=${remaining};t=${seconds}`
}

/**
 * Build the draft `RateLimit-Policy` structured header field (ruling I) —
 * emitted only when `createLimiter`'s `policy` option is `true`.
 *
 * @param max - The window's admitted request count
 * @param window - The window length in milliseconds
 * @returns The `RateLimit-Policy` header value
 *
 * @example
 * ```ts
 * buildRateLimitPolicyField(10, 60_000) // '"default";q=10;w=60'
 * ```
 */
export function buildRateLimitPolicyField(max: number, window: number): string {
	return `"default";q=${max};w=${Math.ceil(window / 1000)}`
}

/**
 * Whether a candidate address is a bare (non-CIDR) trusted-hop match — an
 * exact string match, or a simple prefix-CIDR match for IPv4 (`/8`–`/32`).
 * An IPv6 entry matches by exact string only — there is no IPv6 CIDR
 * support.
 *
 * @remarks
 * Supports exact addresses and dotted-decimal IPv4 CIDR (`10.0.0.0/8`
 * through `/32`) verbatim. An IPv6 entry is matched by exact string only
 * (no CIDR expansion) — documented as the supported subset; `createForwarded`
 * never claims full CIDR generality beyond IPv4.
 *
 * @remarks
 * An IPv6 `trusted` roster entry is compared as an EXACT string — it must be
 * supplied in canonical form (no zero-compression normalization, no case
 * folding) by the caller; this function performs no IPv6 normalization of
 * its own.
 *
 * @param address - The candidate hop address
 * @param entry - One `trusted` roster entry — an exact address or an IPv4 CIDR
 * @returns `true` when `address` is covered by `entry`
 *
 * @example
 * ```ts
 * matchesTrustedEntry('10.1.2.3', '10.0.0.0/8') // true
 * matchesTrustedEntry('192.168.1.1', '10.0.0.0/8') // false
 * ```
 */
export function matchesTrustedEntry(address: string, entry: string): boolean {
	const slash = entry.indexOf('/')
	if (slash === -1) return address === entry
	const network = entry.slice(0, slash)
	const bits = Number(entry.slice(slash + 1))
	const networkParts = network.split('.')
	const addressParts = address.split('.')
	if (networkParts.length !== 4 || addressParts.length !== 4) return false
	if (!Number.isInteger(bits) || bits < 8 || bits > 32) return false
	const networkOctets = networkParts.map(Number)
	const addressOctets = addressParts.map(Number)
	if (networkOctets.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
		return false
	if (addressOctets.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
		return false
	const networkInt =
		((networkOctets[0] ?? 0) << 24) |
		((networkOctets[1] ?? 0) << 16) |
		((networkOctets[2] ?? 0) << 8) |
		(networkOctets[3] ?? 0)
	const addressInt =
		((addressOctets[0] ?? 0) << 24) |
		((addressOctets[1] ?? 0) << 16) |
		((addressOctets[2] ?? 0) << 8) |
		(addressOctets[3] ?? 0)
	const mask = bits === 32 ? -1 : ~((1 << (32 - bits)) - 1)
	return (networkInt & mask) === (addressInt & mask)
}

/**
 * Walk `X-Forwarded-For` right-to-left and resolve the first UNTRUSTED hop
 * address — `createForwarded`'s core algorithm.
 *
 * @remarks
 * Parses `X-Forwarded-For` only. With `proxies` set, trusts exactly that
 * many hops counted from the right (the closest to this server) and returns
 * the next one left of them; with `trusted` set, trusts every CONSECUTIVE
 * hop from the right that matches one of the roster
 * ({@link matchesTrustedEntry}) and returns the first hop that does not. If
 * the rightmost hop (the immediate sender) does not match the roster, the
 * whole header is untrustworthy and this returns `undefined` rather than
 * returning any client-supplied hop value. When every hop is trusted, or the
 * header is absent/empty, returns `undefined` (the caller falls back to the
 * socket peer).
 *
 * @param header - The raw `X-Forwarded-For` header value (comma-separated hops), if present
 * @param trust - Either a trusted hop COUNT or a `trusted` CIDR/exact roster
 * @returns The first untrusted hop address, or `undefined` when none qualifies
 *
 * @example
 * ```ts
 * resolveForwardedFor('203.0.113.7, 10.0.0.1', { proxies: 1 }) // '203.0.113.7'
 * ```
 */
export function resolveForwardedFor(
	header: string | undefined,
	trust: { readonly proxies: number } | { readonly trusted: readonly string[] },
): string | undefined {
	if (header === undefined) return undefined
	const hops = header
		.split(',')
		.map((hop) => hop.trim())
		.filter((hop) => hop.length > 0)
	if (hops.length === 0) return undefined
	if ('proxies' in trust) {
		const index = hops.length - trust.proxies - 1
		return index >= 0 ? hops[index] : undefined
	}
	const rightmost = hops[hops.length - 1]
	if (rightmost === undefined) return undefined
	const rightmostTrusted = trust.trusted.some((entry) => matchesTrustedEntry(rightmost, entry))
	if (!rightmostTrusted) return undefined
	for (let index = hops.length - 2; index >= 0; index -= 1) {
		const hop = hops[index]
		if (hop === undefined) return undefined
		const trusted = trust.trusted.some((entry) => matchesTrustedEntry(hop, entry))
		if (!trusted) return hop
	}
	return undefined
}

/**
 * Feature-detect which of `candidates` the runtime's `CompressionStream`
 * actually supports — `createCompression`'s construction-time intersection
 * (ruling J).
 *
 * @remarks
 * Probes each candidate with `new CompressionStream(candidate)` inside a
 * `try`/`catch`; a coding the runtime rejects is dropped silently. `identity`
 * is never probed (it has no `CompressionStream` coding and is always
 * implicitly acceptable to negotiation).
 *
 * @param candidates - The codings to probe, in preference order
 * @returns The subset of `candidates` the runtime's `CompressionStream` supports, in order
 *
 * @example
 * ```ts
 * detectEncodings(['gzip', 'deflate']) // ['gzip', 'deflate'] on a runtime with both
 * ```
 */
export function detectEncodings(candidates: readonly Encoding[]): readonly Encoding[] {
	const supported: Encoding[] = []
	for (const candidate of candidates) {
		if (candidate === 'identity') continue
		try {
			// Construction throws when the runtime doesn't support this coding;
			// `readable` is checked only to use the instance, never inspected further.
			const stream = new CompressionStream(candidate)
			if (stream.readable) supported.push(candidate)
		} catch {
			// Unsupported coding on this runtime — drop it, never throw.
		}
	}
	return supported
}

/**
 * Whether a response is eligible for the compression/ETag buffering pipeline
 * (ruling J) — the shared cheap-skip predicate both batteries apply before
 * ever touching `response.arrayBuffer()`.
 *
 * @remarks
 * Skips a `HEAD` request, a `204`/`304` or otherwise bodyless response, an
 * `event-stream` response (SSE — buffering would hang the connection), and a
 * response that already carries the header the caller is about to set
 * (`skipHeader`, e.g. `Content-Encoding` for compression, `ETag` for the
 * ETag battery).
 *
 * @param method - The request's HTTP method
 * @param response - The candidate response
 * @param skipHeader - The response header whose presence means "already handled"
 * @returns `true` when the response should be left untouched
 *
 * @example
 * ```ts
 * isBufferingIneligible('GET', new Response(null, { status: 204 }), 'content-encoding') // true
 * ```
 */
export function isBufferingIneligible(
	method: string,
	response: Response,
	skipHeader: string,
): boolean {
	if (method === 'HEAD') return true
	if (response.status === 204 || response.status === 304) return true
	if (response.body === null) return true
	const contentType = response.headers.get('content-type')
	if (contentType !== null && contentType.toLowerCase().startsWith('text/event-stream')) return true
	if (response.headers.has(skipHeader)) return true
	return false
}

/**
 * Whether a negotiated `Accept-Encoding` outcome is worth acting on —
 * `createCompression`'s negotiation-eligibility half of ruling J's skip list.
 *
 * @param encoding - The negotiated coding, or `undefined` when negotiation failed
 * @returns `true` when `encoding` names an actionable, non-`identity` coding
 *
 * @example
 * ```ts
 * isCompressionNegotiated('gzip') // true
 * isCompressionNegotiated(undefined) // false
 * ```
 */
export function isCompressionNegotiated(
	encoding: Encoding | undefined,
): encoding is Exclude<Encoding, 'identity'> {
	return encoding !== undefined && encoding !== 'identity'
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
 * Rebuild a `Response` around a replacement body while preserving its
 * status/statusText — the buffered-response reconstruction shared by the
 * compression and ETag batteries after they have consumed
 * `response.arrayBuffer()`.
 *
 * @param body - The replacement body (already-buffered bytes, or `null`)
 * @param response - The original response whose status/statusText/headers are preserved
 * @param headers - The headers to apply; defaults to a fresh copy of `response.headers`
 * @returns A new `Response` carrying `body` with `response`'s status/statusText
 *
 * @example
 * ```ts
 * rebuildResponse(bytes, response) // same status/statusText, response's headers copied
 * rebuildResponse(bytes, response, headers) // explicit replacement headers
 * ```
 */
export function rebuildResponse(
	body: ConstructorParameters<typeof Response>[0],
	response: Response,
	headers?: ConstructorParameters<typeof Headers>[0],
): Response {
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: headers ?? new Headers(response.headers),
	})
}

/**
 * The shared negotiate → skip → threshold → compress → header-set skeleton
 * both faces' `createCompression` batteries compose — response-body
 * compression over a caller-supplied set of feature-detected codings.
 *
 * @remarks
 * Decision order: {@link isBufferingIneligible} → `options.filter` → stamp
 * `Vary: Accept-Encoding` (every negotiation-eligible response carries it,
 * even when a later skip declines to compress) → `negotiateEncoding` over
 * `options.encodings` → {@link isCompressionNegotiated} → `isCompressibleType`
 * on `Content-Type` → a fast skip when the response already carries a
 * numeric `Content-Length` BELOW `options.threshold` (avoids buffering a
 * body known too small to be worth compressing) → buffer via
 * `response.arrayBuffer()` → a threshold passthrough when the buffered size
 * is still below `options.threshold` → `options.compress` → set
 * `Content-Encoding` and a fresh `Content-Length` via {@link rebuildResponse}.
 * Returns `response` unchanged (aside from the `Vary` stamp) on any skip.
 *
 * @param request - The inbound `Request` (read for `Accept-Encoding`)
 * @param context - The `MiddlewareContext` (read for `context.method`)
 * @param response - The downstream `Response` to consider compressing
 * @param options - The threshold, optional filter, offered encodings, and the runtime's `compress` primitive
 * @returns The original `response` when skipped, or a new compressed `Response`
 *
 * @example
 * ```ts
 * await compressResponse(request, context, response, {
 * 	threshold: 1024,
 * 	encodings: ['gzip'],
 * 	compress: async (bytes, encoding) => gzip(bytes),
 * })
 * ```
 */
export async function compressResponse(
	request: Request,
	context: MiddlewareContext<unknown>,
	response: Response,
	options: {
		readonly threshold: number
		readonly filter?: (request: Request, response: Response) => boolean
		readonly encodings: readonly Encoding[]
		readonly compress: (
			bytes: Uint8Array<ArrayBuffer>,
			encoding: Exclude<Encoding, 'identity'>,
		) => Promise<Uint8Array<ArrayBuffer>>
	},
): Promise<Response> {
	if (isBufferingIneligible(context.method, response, 'content-encoding')) return response
	if (options.filter !== undefined && !options.filter(request, response)) return response
	response.headers.set(
		'vary',
		mergeVary(response.headers.get('vary') ?? undefined, 'Accept-Encoding'),
	)
	const acceptEncoding = request.headers.get('accept-encoding')
	if (acceptEncoding === null) return response
	const negotiated = negotiateEncoding(acceptEncoding, options.encodings)
	if (!isCompressionNegotiated(negotiated)) return response
	const contentType = response.headers.get('content-type')
	if (contentType === null || !isCompressibleType(contentType)) return response
	const declaredLength = response.headers.get('content-length')
	if (declaredLength !== null) {
		const declared = Number(declaredLength)
		if (Number.isFinite(declared) && declared < options.threshold) return response
	}
	const buffer = await response.arrayBuffer()
	if (buffer.byteLength < options.threshold) return rebuildResponse(buffer, response)
	const compressed = await options.compress(new Uint8Array(buffer), negotiated)
	const headers = new Headers(response.headers)
	headers.set('content-encoding', negotiated)
	headers.set('content-length', String(compressed.byteLength))
	return rebuildResponse(compressed, response, headers)
}

/**
 * Copy every entry of one session's `data` into another — the regenerate
 * data-carry `createSession`'s `control.regenerate()` applies (ruling D).
 *
 * @param from - The source session whose `data` is copied
 * @param to - The destination session `data` is copied into
 *
 * @example
 * ```ts
 * transferSessionData(oldSession, newSession)
 * ```
 */
export function transferSessionData(from: SessionInterface, to: SessionInterface): void {
	for (const [key, value] of from.data) to.data.set(key, value)
}

/**
 * Determine whether a value implements {@link SessionInterface} — a total
 * structural guard (§14): an `id` string plus a `data` `Map`. Prototype-agnostic
 * — accepts a plain object, a null-prototype object, AND a class instance
 * (a real `Session`), since a restored/stored session is routinely a class
 * instance, not a literal.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link SessionInterface}
 *
 * @example
 * ```ts
 * isSession({ id: 'a', data: new Map() }) // true
 * isSession(new Session('a')) // true
 * ```
 */
export function isSession(value: unknown): value is SessionInterface {
	if (typeof value !== 'object' || value === null) return false
	const id: unknown = Reflect.get(value, 'id')
	const data: unknown = Reflect.get(value, 'data')
	return isString(id) && data instanceof Map
}

/**
 * Determine whether a value implements {@link SessionControlInterface} — a
 * total structural guard (§14): callable `regenerate` and `destroy`.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link SessionControlInterface}
 *
 * @example
 * ```ts
 * isSessionControl({ regenerate() {}, destroy() {} }) // true
 * ```
 */
export function isSessionControl(value: unknown): value is SessionControlInterface {
	if (!isRecord(value)) return false
	return typeof value.regenerate === 'function' && typeof value.destroy === 'function'
}

/**
 * Determine whether a value is one staged {@link MultipartFile} record — a
 * total structural guard (§14) checking every required field's shape.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link MultipartFile}
 */
export function isMultipartFile(value: unknown): value is MultipartFile {
	if (!isRecord(value)) return false
	return (
		isString(value.field) &&
		isString(value.name) &&
		typeof value.size === 'number' &&
		isString(value.mime) &&
		typeof value.validated === 'boolean' &&
		isString(value.status) &&
		isString(value.path)
	)
}

/**
 * Determine whether a value implements {@link MultipartBody} — a total
 * structural guard (§14): `files` keyed by field name to arrays of
 * {@link MultipartFile}, and a `fields` string record.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link MultipartBody}
 *
 * @example
 * ```ts
 * isMultipartBody({ files: {}, fields: { name: 'a' } }) // true
 * ```
 */
export function isMultipartBody(value: unknown): value is MultipartBody {
	if (!isRecord(value)) return false
	if (!isRecord(value.files) || !isRecord(value.fields)) return false
	for (const entries of Object.values(value.files)) {
		if (!Array.isArray(entries)) return false
		for (const entry of entries) if (!isMultipartFile(entry)) return false
	}
	for (const fieldValue of Object.values(value.fields)) if (!isString(fieldValue)) return false
	return true
}

/**
 * Determine whether a request is a CORS PREFLIGHT — an `OPTIONS` request
 * carrying an `Access-Control-Request-Method` header.
 *
 * @param method - The request's HTTP method
 * @param headers - The request's `Headers`
 * @returns `true` when the request is a CORS preflight `createCors` must answer
 *
 * @example
 * ```ts
 * isPreflight('OPTIONS', new Headers({ 'access-control-request-method': 'POST' })) // true
 * ```
 */
export function isPreflight(method: string, headers: Headers): boolean {
	return method === 'OPTIONS' && headers.has('access-control-request-method')
}

/**
 * A parsed client-info fact for {@link ClientInfo} — a leaf shaping helper
 * `createForwarded` uses to build its stashed slice.
 *
 * @param ip - The resolved client IP, if any
 * @returns The {@link ClientInfo} slice value
 *
 * @example
 * ```ts
 * buildClientInfo('203.0.113.7') // { ip: '203.0.113.7' }
 * ```
 */
export function buildClientInfo(ip: string | undefined): ClientInfo {
	return { ip }
}

/**
 * Constant-time string equality — `createCSRF`'s double-submit token
 * comparison, avoiding a timing oracle on the submitted-vs-cookie match.
 *
 * @remarks
 * Length-guarded XOR-accumulate over char codes: a length mismatch short
 * circuits (safe — the lengths of two independently-generated tokens are
 * not a useful timing signal), but once lengths match every character is
 * compared with no early return, so a per-character mismatch never affects
 * how long the comparison takes.
 *
 * @param a - The first string
 * @param b - The second string
 * @returns `true` when `a` and `b` are exactly equal
 *
 * @example
 * ```ts
 * equalsConstantTime('abc', 'abc') // true
 * equalsConstantTime('abc', 'abd') // false
 * ```
 */
export function equalsConstantTime(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let index = 0; index < a.length; index += 1)
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
	return diff === 0
}

/**
 * Whether a session has aged past its idle timeout or absolute lifetime as
 * of `now` — the pure expiry predicate `MemorySessionStore` delegates to.
 *
 * @param cursors - The session's `lastSeen` (idle) and `createdAt` (absolute) instants
 * @param now - The current instant (same clock unit as `cursors`)
 * @param limits - The optional `ttl` (idle) and `lifetime` (absolute) thresholds
 * @returns `true` when either configured threshold has elapsed
 *
 * @example
 * ```ts
 * sessionExpired({ lastSeen: 0, createdAt: 0 }, 1_000, { ttl: 500 }) // true
 * ```
 */
export function sessionExpired(
	cursors: { readonly lastSeen: number; readonly createdAt: number },
	now: number,
	limits: { readonly ttl?: number; readonly lifetime?: number },
): boolean {
	if (limits.ttl !== undefined && now - cursors.lastSeen >= limits.ttl) return true
	if (limits.lifetime !== undefined && now - cursors.createdAt >= limits.lifetime) return true
	return false
}

/**
 * Snapshot a session's `data` Map into a plain, serializable record — the
 * projection a durable store's `set` writes to disk.
 *
 * @param session - The session to snapshot
 * @returns A plain-object copy of `session.data`, keyed alongside `session.id`
 *
 * @example
 * ```ts
 * snapshotSession(session) // { id: 'abc', data: { userId: 'u_1' } }
 * ```
 */
export function snapshotSession(session: SessionInterface): {
	readonly id: string
	readonly data: Record<string, unknown>
} {
	const data: Record<string, unknown> = {}
	for (const [key, value] of session.data) data[key] = value
	return { id: session.id, data }
}

/**
 * Rebuild a `Session` from an untrusted snapshot value (the inverse of
 * {@link snapshotSession}) — a durable store's `get` deserialization step.
 *
 * @param value - The candidate snapshot, of unknown shape
 * @returns A rebuilt `Session`, or `undefined` when `value` is malformed
 *
 * @example
 * ```ts
 * restoreSession({ id: 'abc', data: { userId: 'u_1' } }) // Session { id: 'abc', data: Map }
 * restoreSession({ id: 1 }) // undefined
 * ```
 */
export function restoreSession(value: unknown): Session | undefined {
	if (!isRecord(value)) return undefined
	if (!isString(value.id) || !isRecord(value.data)) return undefined
	const session = new Session(value.id)
	for (const [key, entry] of Object.entries(value.data)) session.data.set(key, entry)
	return session
}
