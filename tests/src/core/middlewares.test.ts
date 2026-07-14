import type {
	BearerState,
	ClientState,
	CSRFState,
	MultipartBody,
	SessionInterface,
	SessionState,
	SessionTransport,
} from '@src/core'
import type { ConnectionState } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	createBearer,
	createBody,
	createBoundary,
	createCompression,
	createCookieTransport,
	createCors,
	createCSRF,
	createDeadline,
	createETag,
	createForwarded,
	createHeaderTransport,
	createLimiter,
	createMemorySessionStore,
	createSecurity,
	createSession,
	createTelemetry,
	isMultipartBody,
} from '@src/core'
import { ContentTooLargeError, HTTPError, signToken } from '@orkestrel/server'
import {
	buildRequest,
	createEchoTerminal,
	createManualClock,
	createRecordingTerminal,
	createTestContext,
	ECHO_MARKER,
	runChain,
} from '../../setup.js'

const SECRET = 'test-secret'

// ── createBoundary ────────────────────────────────────────────────────────

describe('createBoundary', () => {
	it('renders a thrown HTTPError with its status and message', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildRequest('/'), {})
		const response = await boundary(buildRequest('/'), context, async () => {
			throw new HTTPError(404, 'not found')
		})
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('not found')
	})

	it('renders a ContentTooLargeError as a 413', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildRequest('/'), {})
		const response = await boundary(buildRequest('/'), context, async () => {
			throw new ContentTooLargeError(1024)
		})
		expect(response.status).toBe(413)
	})

	it('with expose false (default), a generic throw never leaks its message', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildRequest('/'), {})
		const response = await boundary(buildRequest('/'), context, async () => {
			throw new Error('secret internal detail')
		})
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain('secret internal detail')
	})

	it('with expose true, a generic throw surfaces its message', async () => {
		const boundary = createBoundary({ expose: true })
		const context = createTestContext(buildRequest('/'), {})
		const response = await boundary(buildRequest('/'), context, async () => {
			throw new Error('visible detail')
		})
		expect(await response.text()).toBe('visible detail')
	})

	it('a report sink is invoked with the caught error, and its own throw is swallowed', async () => {
		const seen: unknown[] = []
		const boundary = createBoundary({
			report: (error) => {
				seen.push(error)
				throw new Error('report sink is broken')
			},
		})
		const context = createTestContext(buildRequest('/'), {})
		const response = await boundary(buildRequest('/'), context, async () => {
			throw new HTTPError(400, 'bad')
		})
		expect(response.status).toBe(400)
		expect(seen).toHaveLength(1)
	})

	it('passes a successful response through unchanged', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([boundary], createEchoTerminal(), buildRequest('/'), context)
		expect(await response.text()).toBe(ECHO_MARKER)
	})
})

// ── createTelemetry ───────────────────────────────────────────────────────

describe('createTelemetry', () => {
	it('records one entry per request with method/pathname/status/duration', async () => {
		const entries: { method: string; pathname: string; status: number; duration: number }[] = []
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const context = createTestContext(buildRequest('/users?x=1'), {})
		await runChain([telemetry], createEchoTerminal(201), buildRequest('/users?x=1'), context)
		expect(entries).toHaveLength(1)
		expect(entries[0]?.method).toBe('GET')
		expect(entries[0]?.pathname).toBe('/users')
		expect(entries[0]?.status).toBe(201)
		expect(entries[0]?.duration).toBeGreaterThanOrEqual(0)
	})

	it('records status 500 when the downstream throws (no boundary present)', async () => {
		const entries: { status: number }[] = []
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const context = createTestContext(buildRequest('/'), {})
		await expect(
			telemetry(buildRequest('/'), context, async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(entries[0]?.status).toBe(500)
	})

	it('records the boundary-mapped status when boundary sits inside telemetry', async () => {
		const entries: { status: number }[] = []
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const boundary = createBoundary()
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain(
			[telemetry, boundary],
			async () => {
				throw new HTTPError(418, 'teapot')
			},
			buildRequest('/'),
			context,
		)
		expect(response.status).toBe(418)
		expect(entries[0]?.status).toBe(418)
	})

	it('a broken record sink is swallowed and never fails the response', async () => {
		const telemetry = createTelemetry({
			record: () => {
				throw new Error('sink broken')
			},
		})
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([telemetry], createEchoTerminal(), buildRequest('/'), context)
		expect(await response.text()).toBe(ECHO_MARKER)
	})
})

// ── createCompression ─────────────────────────────────────────────────────

async function decompress(bytes: ArrayBuffer, encoding: 'gzip' | 'deflate'): Promise<string> {
	const stream = new Response(bytes).body
	if (stream === null) throw new Error('no body stream')
	const decompressed = await new Response(
		stream.pipeThrough(new DecompressionStream(encoding)),
	).arrayBuffer()
	return new TextDecoder().decode(decompressed)
}

function compressibleBody(length: number): string {
	return 'a'.repeat(length)
}

describe('createCompression', () => {
	it('compresses an eligible, over-threshold, compressible response and the output round-trips via DecompressionStream', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const body = compressibleBody(2048)
		const context = createTestContext(
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('gzip')
		const compressed = await response.arrayBuffer()
		const decoded = await decompress(compressed, 'gzip')
		expect(decoded).toBe(body)
	})

	it('skips a response under the threshold', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 100_000 })
		const context = createTestContext(
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('skips an incompressible content type', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const context = createTestContext(
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'image/png' } }),
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('skips a response already carrying Content-Encoding', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const context = createTestContext(
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), {
					headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' },
				}),
			buildRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('identity')
	})

	it('skips a HEAD request, a 204, and an event-stream response', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const headRequest = buildRequest('/', {
			method: 'HEAD',
			headers: { 'accept-encoding': 'gzip' },
		})
		const headContext = createTestContext(headRequest, {})
		const headResponse = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			headRequest,
			headContext,
		)
		expect(headResponse.headers.has('content-encoding')).toBe(false)

		const noBodyRequest = buildRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const noBodyContext = createTestContext(noBodyRequest, {})
		const noBodyResponse = await runChain(
			[compression],
			async () => new Response(null, { status: 204 }),
			noBodyRequest,
			noBodyContext,
		)
		expect(noBodyResponse.headers.has('content-encoding')).toBe(false)

		const sseRequest = buildRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const sseContext = createTestContext(sseRequest, {})
		const sseResponse = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/event-stream' } }),
			sseRequest,
			sseContext,
		)
		expect(sseResponse.headers.has('content-encoding')).toBe(false)
	})

	it('merges Vary: Accept-Encoding onto an existing Vary header', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), {
					headers: { 'content-type': 'text/plain', vary: 'Origin' },
				}),
			request,
			context,
		)
		expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding')
	})

	it('respects a filter opt-out', async () => {
		const compression = createCompression<Record<string, never>>({
			threshold: 16,
			filter: () => false,
		})
		const request = buildRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('rejects a negative threshold at construction', () => {
		expect(() => createCompression({ threshold: -1 })).toThrow(TypeError)
	})

	it('rejects a q=0 coding via negotiation (nothing negotiated)', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildRequest('/', { headers: { 'accept-encoding': 'gzip;q=0, deflate;q=0' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})
})

// ── createSecurity ────────────────────────────────────────────────────────

describe('createSecurity', () => {
	it('sets the full default header set including nosniff and cluster', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-frame-options')).toBe('DENY')
		expect(response.headers.get('origin-agent-cluster')).toBe('?1')
		expect(response.headers.get('content-security-policy')).toBeTruthy()
		expect(response.headers.has('cross-origin-embedder-policy')).toBe(false)
		expect(response.headers.has('strict-transport-security')).toBe(false)
	})

	it('csp option replaces the default wholesale', async () => {
		const security = createSecurity<{ identifier?: string }>({ csp: "default-src 'none'" })
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
	})

	it('csp: false omits the header entirely', async () => {
		const security = createSecurity<{ identifier?: string }>({ csp: false })
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(response.headers.has('content-security-policy')).toBe(false)
	})

	it('mints a fresh identifier by default and stashes it on state', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const state: { identifier?: string } = {}
		const context = createTestContext(buildRequest('/'), state)
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(state.identifier).toBeTruthy()
		expect(response.headers.get('x-request-id')).toBe(state.identifier)
	})

	it('trust-echo matrix: with trust true, a valid incoming request id is echoed', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: { trust: true } })
		const state: { identifier?: string } = {}
		const request = buildRequest('/', { headers: { 'x-request-id': 'req_abc-123' } })
		const context = createTestContext(request, state)
		const response = await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).toBe('req_abc-123')
		expect(response.headers.get('x-request-id')).toBe('req_abc-123')
	})

	it('trust-echo matrix: a hostile incoming id (fails isValidRequestId) is regenerated, not echoed', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: { trust: true } })
		const state: { identifier?: string } = {}
		const request = buildRequest('/', { headers: { 'x-request-id': 'bad header with spaces!' } })
		const context = createTestContext(request, state)
		await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).not.toBe('bad header with spaces!')
	})

	it('trust-echo matrix: with trust false (default), an incoming id is always replaced by a fresh mint', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const state: { identifier?: string } = {}
		const request = buildRequest('/', { headers: { 'x-request-id': 'req_abc-123' } })
		const context = createTestContext(request, state)
		await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).not.toBe('req_abc-123')
	})

	it('identifier: false disables minting entirely', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: false })
		const state: { identifier?: string } = {}
		const context = createTestContext(buildRequest('/'), state)
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(state.identifier).toBeUndefined()
		expect(response.headers.has('x-request-id')).toBe(false)
	})

	it('coep/hsts are opt-in: true uses the secure default, a string overrides, omitted stays off', async () => {
		const security = createSecurity<{ identifier?: string }>({ coep: true, hsts: 'max-age=1' })
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([security], createEchoTerminal(), buildRequest('/'), context)
		expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
		expect(response.headers.get('strict-transport-security')).toBe('max-age=1')
	})
})

// ── createCors ────────────────────────────────────────────────────────────

describe('createCors', () => {
	it('wildcard origin sets Access-Control-Allow-Origin: * with no Vary', async () => {
		const cors = createCors()
		const request = buildRequest('/', { headers: { origin: 'https://app.example' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.has('vary')).toBe(false)
	})

	it('list origin reflects a matching request Origin and merges Vary: Origin', async () => {
		const cors = createCors({ origin: ['https://app.example'] })
		const request = buildRequest('/', { headers: { origin: 'https://app.example' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
		expect(response.headers.get('vary')).toBe('Origin')
	})

	it('the literal Origin: null is never reflected even when "null" is allow-listed', async () => {
		const cors = createCors({ origin: ['null'] })
		const request = buildRequest('/', { headers: { origin: 'null' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.has('access-control-allow-origin')).toBe(false)
	})

	it('preflight short-circuits with 204 and advertised methods/headers', async () => {
		const cors = createCors({ methods: ['GET', 'POST'], headers: ['Content-Type'] })
		const request = buildRequest('/', {
			method: 'OPTIONS',
			headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
		})
		const context = createTestContext(request, {})
		const terminal = createRecordingTerminal()
		const response = await runChain([cors], terminal.handler, request, context)
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST')
		expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type')
		expect(terminal.count).toBe(0)
	})

	it('a non-preflight OPTIONS (no Access-Control-Request-Method) passes through to the terminal', async () => {
		const cors = createCors()
		const request = buildRequest('/', { method: 'OPTIONS' })
		const context = createTestContext(request, {})
		const terminal = createRecordingTerminal()
		await runChain([cors], terminal.handler, request, context)
		expect(terminal.count).toBe(1)
	})

	it('fixed-string origin mode: the configured origin is set verbatim, matching or not, with no Vary', async () => {
		const cors = createCors({ origin: 'https://static.example' })

		const matching = buildRequest('/', { headers: { origin: 'https://static.example' } })
		const matchingResponse = await runChain(
			[cors],
			createEchoTerminal(),
			matching,
			createTestContext(matching, {}),
		)
		expect(matchingResponse.headers.get('access-control-allow-origin')).toBe(
			'https://static.example',
		)
		expect(matchingResponse.headers.has('vary')).toBe(false)

		const mismatched = buildRequest('/', { headers: { origin: 'https://evil.example' } })
		const mismatchedResponse = await runChain(
			[cors],
			createEchoTerminal(),
			mismatched,
			createTestContext(mismatched, {}),
		)
		expect(mismatchedResponse.headers.get('access-control-allow-origin')).toBe(
			'https://static.example',
		)
		expect(mismatchedResponse.headers.has('vary')).toBe(false)
	})
})

// ── createDeadline ────────────────────────────────────────────────────────

describe('createDeadline', () => {
	it('a fast handler is unaffected and the timer is cleared', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 200 })
		const context = createTestContext(buildRequest('/'), {})
		const response = await runChain([deadline], createEchoTerminal(), buildRequest('/'), context)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('a slow handler triggers the default 503 and the downstream sees an aborted signal', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20 })
		const context = createTestContext(buildRequest('/'), {})
		let sawAborted = false
		const response = await deadline(buildRequest('/'), context, async (substituted) => {
			const request = substituted ?? buildRequest('/')
			await new Promise((resolve) => setTimeout(resolve, 100))
			sawAborted = request.signal.aborted
			return new Response('too slow')
		})
		expect(response.status).toBe(503)
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(sawAborted).toBe(true)
	})

	it('accepts a custom status', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20, status: 504 })
		const context = createTestContext(buildRequest('/'), {})
		const response = await deadline(buildRequest('/'), context, async () => {
			await new Promise((resolve) => setTimeout(resolve, 100))
			return new Response('too slow')
		})
		expect(response.status).toBe(504)
	})

	it('rejects a non-finite ms at construction', () => {
		expect(() => createDeadline({ ms: Number.NaN })).toThrow(TypeError)
	})

	it('rejects a non-positive ms at construction', () => {
		expect(() => createDeadline({ ms: 0 })).toThrow(TypeError)
		expect(() => createDeadline({ ms: -1 })).toThrow(TypeError)
	})

	it('a downstream throw arriving AFTER the deadline wins never escapes as an unhandled rejection', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20 })
		const context = createTestContext(buildRequest('/'), {})
		const seen: unknown[] = []
		const onUnhandled = (reason: unknown) => seen.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			const response = await deadline(buildRequest('/'), context, async () => {
				await new Promise((resolve) => setTimeout(resolve, 20))
				throw new Error('downstream failed after deadline')
			})
			expect(response.status).toBe(503)
			await new Promise((resolve) => setTimeout(resolve, 60))
			expect(seen).toHaveLength(0)
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})
})

// ── createForwarded ───────────────────────────────────────────────────────

describe('createForwarded', () => {
	it('proxies-count walk: trusts exactly N hops from the right', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ proxies: 1 })
		const request = buildRequest('/', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })
		const state: ClientState & ConnectionState = {}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('203.0.113.7')
	})

	it('trusted-list walk: trusts consecutive hops matching the CIDR roster', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ trusted: ['10.0.0.0/8'] })
		const request = buildRequest('/', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })
		const state: ClientState & ConnectionState = {}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('203.0.113.7')
	})

	it('requires exactly one of proxies/trusted at construction', () => {
		expect(() => createForwarded({ proxies: 1, trusted: ['10.0.0.0/8'] })).toThrow(TypeError)
	})

	it('rejects a non-positive-integer proxies at construction (proxies:0 would trust zero hops, letting an attacker-controlled rightmost hop resolve as the client)', () => {
		expect(() => createForwarded({ proxies: 0 })).toThrow(TypeError)
		expect(() => createForwarded({ proxies: 1.5 })).toThrow(TypeError)
		expect(() => createForwarded({ proxies: -1 })).toThrow(TypeError)
	})

	it('with proxies:1 and a spoofed extra hop, the attacker-injected leftmost value is never selected', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ proxies: 1 })
		const request = buildRequest('/', {
			headers: { 'x-forwarded-for': 'attacker-injected-spoof, 203.0.113.7, 10.0.0.1' },
		})
		const state: ClientState & ConnectionState = {}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('203.0.113.7')
		expect(state.client?.ip).not.toBe('attacker-injected-spoof')
	})

	it('with a trusted roster, an untrusted rightmost (immediate sender) hop makes the whole header untrustworthy and falls back to the socket peer, never a client-supplied hop', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ trusted: ['10.0.0.0/8'] })
		const request = buildRequest('/', {
			headers: { 'x-forwarded-for': 'attacker-injected-spoof, 203.0.113.7, 198.51.100.9' },
		})
		const state: ClientState & ConnectionState = {
			connection: { ip: '192.0.2.55', encrypted: false },
		}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('192.0.2.55')
		expect(state.client?.ip).not.toBe('attacker-injected-spoof')
		expect(state.client?.ip).not.toBe('203.0.113.7')
	})

	it('a spoofed hop beyond the trusted count is ignored', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ proxies: 1 })
		const request = buildRequest('/', { headers: { 'x-forwarded-for': 'evil-spoofed-ip' } })
		const state: ClientState & ConnectionState = {}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBeUndefined()
	})

	it('falls back to the connection-state ip when no forwarded hop qualifies', async () => {
		const forwarded = createForwarded<ClientState & ConnectionState>({ proxies: 1 })
		const request = buildRequest('/')
		const state: ClientState & ConnectionState = {
			connection: { ip: '198.51.100.9', encrypted: false },
		}
		const context = createTestContext(request, state)
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('198.51.100.9')
	})
})

// ── createETag ────────────────────────────────────────────────────────────

describe('createETag', () => {
	it('mints a weak ETag by default', async () => {
		const etag = createETag<Record<string, never>>()
		const request = buildRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		const header = response.headers.get('etag')
		expect(header).not.toBeNull()
		expect(header?.startsWith('W/"')).toBe(true)
	})

	it('mints a strong ETag when weak: false', async () => {
		const etag = createETag<Record<string, never>>({ weak: false })
		const request = buildRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		expect(response.headers.get('etag')?.startsWith('W/')).toBe(false)
	})

	it('If-None-Match matching a single value returns 304 without a body', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		expect(known).not.toBeNull()
		const request = buildRequest('/', { headers: { 'if-none-match': known ?? '' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		expect(response.status).toBe(304)
		expect(await response.text()).toBe('')
	})

	it('the 304 response carries the ETag and never a stale Content-Length', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		expect(known).not.toBeNull()
		const request = buildRequest('/', { headers: { 'if-none-match': known ?? '' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content', { headers: { 'content-length': '12' } }),
			request,
			context,
		)
		expect(response.status).toBe(304)
		expect(response.headers.get('etag')).toBe(known)
		expect(response.headers.has('content-length')).toBe(false)
	})

	it('If-None-Match with a list or * short-circuits with 304', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		const listRequest = buildRequest('/', {
			headers: { 'if-none-match': `"other", ${known ?? ''}` },
		})
		const listResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			listRequest,
			createTestContext(listRequest, {}),
		)
		expect(listResponse.status).toBe(304)

		const starRequest = buildRequest('/', { headers: { 'if-none-match': '*' } })
		const starResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			starRequest,
			createTestContext(starRequest, {}),
		)
		expect(starResponse.status).toBe(304)
	})

	it('an existing ETag on the response is respected (skipped, not overwritten)', async () => {
		const etag = createETag<Record<string, never>>()
		const request = buildRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content', { headers: { etag: '"preset"' } }),
			request,
			context,
		)
		expect(response.headers.get('etag')).toBe('"preset"')
	})

	it('a non-GET or non-200 response is left untouched', async () => {
		const etag = createETag<Record<string, never>>()
		const postRequest = buildRequest('/', { method: 'POST' })
		const postResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(postResponse.headers.has('etag')).toBe(false)

		const errorRequest = buildRequest('/')
		const errorResponse = await runChain(
			[etag],
			async () => new Response('nope', { status: 404 }),
			errorRequest,
			createTestContext(errorRequest, {}),
		)
		expect(errorResponse.headers.has('etag')).toBe(false)
	})
})

// ── createBearer ──────────────────────────────────────────────────────────

describe('createBearer', () => {
	it('a valid token is stashed on state and the chain continues', async () => {
		const token = await signToken('user-1', { secret: SECRET })
		const bearer = createBearer<BearerState>({ secret: SECRET })
		const state: BearerState = {}
		const request = buildRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const context = createTestContext(request, state)
		const response = await runChain([bearer], createEchoTerminal(), request, context)
		expect(await response.text()).toBe(ECHO_MARKER)
		expect(state.token).toBe('user-1')
	})

	it('a missing token throws HTTPError 401', async () => {
		const bearer = createBearer<BearerState>({ secret: SECRET })
		const request = buildRequest('/')
		const context = createTestContext(request, {})
		await expect(bearer(request, context, async () => new Response())).rejects.toMatchObject({
			status: 401,
		})
	})

	it('a tampered token throws HTTPError 401', async () => {
		const token = await signToken('user-1', { secret: SECRET })
		const bearer = createBearer<BearerState>({ secret: SECRET })
		const request = buildRequest('/', { headers: { authorization: `Bearer ${token}xx` } })
		const context = createTestContext(request, {})
		await expect(bearer(request, context, async () => new Response())).rejects.toMatchObject({
			status: 401,
		})
	})

	it('an expired token throws HTTPError 401', async () => {
		const token = await signToken('user-1', { secret: SECRET, ttl: 1 })
		await new Promise((resolve) => setTimeout(resolve, 20))
		const bearer = createBearer<BearerState>({ secret: SECRET })
		const request = buildRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const context = createTestContext(request, {})
		await expect(bearer(request, context, async () => new Response())).rejects.toMatchObject({
			status: 401,
		})
	})

	it('rotation: a token signed with an older secret verifies against a rotation list', async () => {
		const oldToken = await signToken('user-1', { secret: 'old-secret' })
		const bearer = createBearer<BearerState>({ secret: ['new-secret', 'old-secret'] })
		const state: BearerState = {}
		const request = buildRequest('/', { headers: { authorization: `Bearer ${oldToken}` } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})

	it('the scheme prefix match is case-insensitive', async () => {
		const token = await signToken('user-1', { secret: SECRET })
		const bearer = createBearer<BearerState>({ secret: SECRET })
		const state: BearerState = {}
		const request = buildRequest('/', { headers: { authorization: `bearer ${token}` } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})

	it('scheme: "" treats the whole header value as the raw token', async () => {
		const token = await signToken('user-1', { secret: SECRET })
		const bearer = createBearer<BearerState>({ secret: SECRET, scheme: '' })
		const state: BearerState = {}
		const request = buildRequest('/', { headers: { authorization: token } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})
})

// ── createLimiter ─────────────────────────────────────────────────────────

describe('createLimiter', () => {
	it('admits exactly max requests then 429s with Retry-After >= 1', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 2,
			window: 1_000,
			clock: clock.clock,
		})
		const state: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildRequest('/'), state)
		const first = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		const second = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		const third = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(third.status).toBe(429)
		const retryAfter = Number(third.headers.get('retry-after'))
		expect(retryAfter).toBeGreaterThanOrEqual(1)
	})

	it('lazily rolls the window once the clock passes resetAt', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const state: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildRequest('/'), state)
		const first = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		const blocked = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		clock.advance(1_000)
		const afterRoll = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		expect(first.status).toBe(200)
		expect(blocked.status).toBe(429)
		expect(afterRoll.status).toBe(200)
	})

	it('isolates buckets per key, including the token: vs ip: idiom', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const tokenState: BearerState & ClientState & ConnectionState = { token: 'abc' }
		const ipState: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const tokenContext = createTestContext(buildRequest('/'), tokenState)
		const ipContext = createTestContext(buildRequest('/'), ipState)
		const tokenResponse1 = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			tokenContext,
		)
		const ipResponse1 = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			ipContext,
		)
		expect(tokenResponse1.status).toBe(200)
		expect(ipResponse1.status).toBe(200)
	})

	it('collapses an IPv6 client address to its /64 network for the bucket key', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const stateA: BearerState & ClientState & ConnectionState = {
			client: { ip: '2001:db8:1:2:dead:beef:0:9' },
		}
		const stateB: BearerState & ClientState & ConnectionState = {
			client: { ip: '2001:db8:1:2:aaaa:bbbb:0:1' },
		}
		const first = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		const second = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateB),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('true LRU: eviction follows access recency, not insertion order', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			capacity: 2,
			clock: clock.clock,
		})
		const stateA: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.2' } }
		const stateC: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.3' } }
		// Insert A then B (buckets: A, B — both exhausted at max:1).
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateB),
		)
		// Re-access A — under FIFO this would not matter, but true LRU moves A to
		// the most-recently-used position, leaving B as the least-recently-used.
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		// Inserting a brand-new key C exceeds capacity 2 — evicts the LRU entry, B.
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateC),
		)
		// A's bucket survived (still exhausted from its earlier requests) —
		// FIFO would instead have evicted A here, admitting it fresh.
		const retryA = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		expect(retryA.status).toBe(429)
		// B's bucket was evicted, so it is re-admitted fresh.
		const retryB = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateB),
		)
		expect(retryB.status).toBe(200)
	})

	it('invokes evict with the evicted bucket key', async () => {
		const clock = createManualClock()
		const evicted: string[] = []
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			capacity: 1,
			clock: clock.clock,
			evict: (key) => evicted.push(key),
		})
		const stateA: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.2' } }
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateB),
		)
		expect(evicted).toEqual(['ip:203.0.113.1'])
	})

	it('honors a custom key function', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
			key: () => 'fixed-key',
		})
		const stateA: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.2' } }
		const first = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateA),
		)
		const second = await runChain(
			[limiter],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), stateB),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('honors a custom message on the 429 body', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
			message: 'slow down',
		})
		const state: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildRequest('/'), state)
		await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		const second = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		expect(second.status).toBe(429)
		expect(await second.text()).toBe('slow down')
	})

	it('rejects malformed construction options with a TypeError', () => {
		expect(() => createLimiter({ max: 0, window: 1_000 })).toThrow(TypeError)
		expect(() => createLimiter({ max: 1.5, window: 1_000 })).toThrow(TypeError)
		expect(() => createLimiter({ max: 1, window: 0 })).toThrow(TypeError)
		expect(() => createLimiter({ max: 1, window: 1_000, capacity: 0 })).toThrow(TypeError)
		expect(() => createLimiter({ max: 1, window: 1_000, capacity: 1.5 })).toThrow(TypeError)
	})

	it('emits the exact RateLimit/RateLimit-Policy wire shape when policy: true', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 3,
			window: 60_000,
			policy: true,
			clock: clock.clock,
		})
		const state: BearerState & ClientState & ConnectionState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildRequest('/'), state)
		await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		const fourth = await runChain([limiter], createEchoTerminal(), buildRequest('/'), context)
		expect(fourth.status).toBe(429)
		expect(fourth.headers.get('ratelimit')).toBe('"default";r=0;t=60')
		expect(fourth.headers.get('ratelimit-policy')).toBe('"default";q=3;w=60')
	})
})

// ── createBody ────────────────────────────────────────────────────────────

describe('createBody', () => {
	it('eagerly reads the body before the handler runs', async () => {
		const body = createBody<Record<string, never>>()
		const request = buildRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		})
		const context = createTestContext(request, {})
		let sawBody: unknown
		await runChain(
			[body],
			async (_request, requestContext) => {
				sawBody = await requestContext.body()
				return new Response()
			},
			request,
			context,
		)
		expect(sawBody).toEqual({ a: 1 })
	})

	it('throws HTTPError 400 when application/json body resolves undefined (invalid JSON)', async () => {
		const body = createBody<Record<string, never>>()
		const request = buildRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '',
		})
		const context = createTestContext(request, {})
		await expect(body(request, context, async () => new Response())).rejects.toMatchObject({
			status: 400,
		})
	})

	it('propagates a ContentTooLargeError as a 413 through the chain', async () => {
		const body = createBody<Record<string, never>>()
		const oversized = 'x'.repeat(2_000_000)
		const request = new Request('http://test.local/', { method: 'POST', body: oversized })
		let cached: Promise<unknown> | undefined
		const context = {
			url: new URL(request.url),
			method: request.method,
			state: {},
			body() {
				if (cached === undefined)
					cached = (async () => Promise.reject(new ContentTooLargeError(1024)))()
				return cached
			},
		}
		await expect(body(request, context, async () => new Response())).rejects.toBeInstanceOf(
			ContentTooLargeError,
		)
	})
})

// ── Multipart guard (isMultipartBody) ───────────────────────────────────────

describe('isMultipartBody', () => {
	it('accepts a well-formed multipart body', () => {
		const value: MultipartBody = {
			files: {
				upload: [
					{
						field: 'upload',
						name: 'a.png',
						size: 10,
						mime: 'image/png',
						validated: true,
						status: 'ok',
						path: '/tmp/a',
					},
				],
			},
			fields: { name: 'a' },
		}
		expect(isMultipartBody(value)).toBe(true)
	})

	it('rejects a malformed multipart body', () => {
		expect(isMultipartBody({ files: {}, fields: { name: 42 } })).toBe(false)
		expect(isMultipartBody(null)).toBe(false)
	})
})

// ── createSession ─────────────────────────────────────────────────────────

function createTestTransport(): SessionTransport & {
	readonly written: { readonly response: Response; readonly id: string }[]
	readonly cleared: Response[]
} {
	const written: { response: Response; id: string }[] = []
	const cleared: Response[] = []
	const header = 'x-test-session'
	return {
		written,
		cleared,
		read(request) {
			return request.headers.get(header) ?? undefined
		},
		write(response, id) {
			written.push({ response, id })
			response.headers.set(header, id)
		},
		clear(response) {
			cleared.push(response)
			response.headers.delete(header)
		},
	}
}

describe('createSession', () => {
	it('auto-mints a session and writes the transport on the way out', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({ transport })
		const request = buildRequest('/')
		const state: SessionState = {}
		const context = createTestContext(request, state)
		const response = await runChain([session], createEchoTerminal(), request, context)
		expect(state.session).toBeDefined()
		expect(response.headers.get('x-test-session')).toBe(state.session?.id)
	})

	it('resolves an existing session and re-persists it without re-writing the transport', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		expect(id).not.toBeNull()

		const secondRequest = buildRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			createEchoTerminal(),
			secondRequest,
			createTestContext(secondRequest, state),
		)
		expect(state.session?.id).toBe(id)
		expect(response.headers.has('x-test-session')).toBe(false)
	})

	it('rejects a malformed capacity at construction (delegated to the default MemorySessionStore)', () => {
		const transport = createTestTransport()
		expect(() => createSession<SessionInterface, SessionState>({ transport, capacity: 0 })).toThrow(
			TypeError,
		)
	})

	it('require: true renders 404 when no session resolves and mint declines', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			mint: () => false,
			require: true,
		})
		const request = buildRequest('/')
		const context = createTestContext(request, {})
		await expect(session(request, context, async () => new Response())).rejects.toMatchObject({
			status: 404,
		})
	})

	it('ends: true + DELETE with a valid session id deletes it and short-circuits with 204', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store, ends: true })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')

		const deleteRequest = buildRequest('/', {
			method: 'DELETE',
			headers: { 'x-test-session': id ?? '' },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session],
			terminal.handler,
			deleteRequest,
			createTestContext(deleteRequest, {}),
		)
		expect(response.status).toBe(204)
		expect(terminal.count).toBe(0)

		const stored = await store.get(id ?? '', Date.now())
		expect(stored).toBeUndefined()
	})

	it('regenerate() rotates the id, keeps the data, and the old id is dead', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const oldId = first.headers.get('x-test-session')
		expect(oldId).not.toBeNull()
		const seeded = await store.get(oldId ?? '', Date.now())
		expect(seeded).toBeDefined()
		if (seeded !== undefined) seeded.data.set('k', 'v')
		if (seeded !== undefined) await store.set(oldId ?? '', seeded, Date.now())

		const request = buildRequest('/', { headers: { 'x-test-session': oldId ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.regenerate()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		const newId = response.headers.get('x-test-session')
		expect(newId).not.toBeNull()
		expect(newId).not.toBe(oldId)
		const newStored = await store.get(newId ?? '', Date.now())
		expect(newStored?.data.get('k')).toBe('v')
		const oldStored = await store.get(oldId ?? '', Date.now())
		expect(oldStored).toBeUndefined()
	})

	it('destroy() clears the session from the store and the transport', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')

		const request = buildRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.destroy()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		expect(response.headers.has('x-test-session')).toBe(false)
		const stored = await store.get(id ?? '', Date.now())
		expect(stored).toBeUndefined()
	})

	it('the mint predicate is honored, including async', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			mint: async () => Promise.resolve(false),
		})
		const request = buildRequest('/')
		const state: SessionState = {}
		const response = await runChain(
			[session],
			createEchoTerminal(),
			request,
			createTestContext(request, state),
		)
		expect(state.session).toBeUndefined()
		expect(response.headers.has('x-test-session')).toBe(false)
	})

	it('idle ttl evicts a session via the manual clock and an injected store', async () => {
		const clock = createManualClock()
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>({ ttl: 1_000 })
		const session = createSession<SessionInterface, SessionState>({
			transport,
			store,
			clock: clock.clock,
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		clock.advance(2_000)
		const request = buildRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		await runChain([session], createEchoTerminal(), request, createTestContext(request, state))
		expect(state.session?.id).not.toBe(id)
	})

	it('absolute lifetime evicts a session even when continuously touched', async () => {
		const clock = createManualClock()
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>({ lifetime: 1_000 })
		const session = createSession<SessionInterface, SessionState>({
			transport,
			store,
			clock: clock.clock,
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		clock.advance(500)
		const midRequest = buildRequest('/', { headers: { 'x-test-session': id ?? '' } })
		await runChain([session], createEchoTerminal(), midRequest, createTestContext(midRequest, {}))
		clock.advance(600)
		const lateRequest = buildRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		await runChain(
			[session],
			createEchoTerminal(),
			lateRequest,
			createTestContext(lateRequest, state),
		)
		expect(state.session?.id).not.toBe(id)
	})

	it('createdAt is preserved across a re-set of the same session', async () => {
		const store = createMemorySessionStore<{ id: string; data: Map<string, unknown> }>({
			lifetime: 10_000,
		})
		await store.set('s1', { id: 's1', data: new Map() }, 0)
		await store.set('s1', { id: 's1', data: new Map() }, 5_000)
		const stillAlive = await store.get('s1', 9_000)
		expect(stillAlive).toBeDefined()
		const expired = await store.get('s1', 10_500)
		expect(expired).toBeUndefined()
	})

	it('auto-Secure: the cookie transport carries Secure when connection.encrypted is true, omits it when false/absent', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const session = createSession<SessionInterface, SessionState & ConnectionState>({ transport })

		const secureState: SessionState & ConnectionState = {
			connection: { ip: '203.0.113.1', encrypted: true },
		}
		const secureRequest = buildRequest('/')
		const secureResponse = await runChain(
			[session],
			createEchoTerminal(),
			secureRequest,
			createTestContext(secureRequest, secureState),
		)
		expect(secureResponse.headers.get('set-cookie')).toContain('Secure')

		const plainState: SessionState & ConnectionState = {
			connection: { ip: '203.0.113.1', encrypted: false },
		}
		const plainRequest = buildRequest('/')
		const plainResponse = await runChain(
			[session],
			createEchoTerminal(),
			plainRequest,
			createTestContext(plainRequest, plainState),
		)
		expect(plainResponse.headers.get('set-cookie')).not.toContain('Secure')
	})

	it('persists a freshly-minted session exactly once (no redundant mint-time store.set)', async () => {
		let setCount = 0
		const transport = createTestTransport()
		const memory = createMemorySessionStore<SessionInterface>()
		const store = {
			get: (id: string, now: number) => memory.get(id, now),
			set: (id: string, value: SessionInterface, now: number) => {
				setCount += 1
				return memory.set(id, value, now)
			},
			delete: (id: string) => memory.delete(id),
		}
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const request = buildRequest('/')
		const state: SessionState = {}
		await runChain([session], createEchoTerminal(), request, createTestContext(request, state))
		expect(setCount).toBe(1)
	})

	it('threads capacity/evict into the default MemorySessionStore, which evicts and notifies at capacity', async () => {
		const evicted: string[] = []
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			capacity: 1,
			evict: (id) => evicted.push(id),
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const firstId = first.headers.get('x-test-session')
		expect(firstId).not.toBeNull()

		// A second, distinct incoming (unresolvable) session id forces the store to
		// mint a brand-new session, exceeding capacity:1 and evicting the first.
		const second = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		expect(second.headers.get('x-test-session')).not.toBe(firstId)
		expect(evicted).toContain(firstId)
	})

	it('DELETE with no resolvable session is a no-op — falls through to mint/next, never short-circuits', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({ transport, ends: true })
		const request = buildRequest('/', { method: 'DELETE' })
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session],
			terminal.handler,
			request,
			createTestContext(request, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).not.toBe(204)
	})

	it('destroy() after an earlier regenerate() wins — the session is not persisted', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const oldId = first.headers.get('x-test-session')
		expect(oldId).not.toBeNull()

		const request = buildRequest('/', { headers: { 'x-test-session': oldId ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.regenerate()
				requestContext.state.control?.destroy()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		expect(response.headers.has('x-test-session')).toBe(false)
		const oldStored = await store.get(oldId ?? '', Date.now())
		expect(oldStored).toBeUndefined()
	})
})

// ── createCSRF ────────────────────────────────────────────────────────────

describe('createCSRF', () => {
	it('a safe method mints a token, stashes it on state, and sets the signed cookie', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const request = buildRequest('/')
		const state: CSRFState & SessionState = {}
		const response = await runChain(
			[csrf],
			createEchoTerminal(),
			request,
			createTestContext(request, state),
		)
		expect(state.csrf).toBeTruthy()
		const setCookie = response.headers.get('set-cookie')
		expect(setCookie).toContain('csrf=')
		expect(setCookie).toContain('SameSite=Strict')
		expect(setCookie).not.toContain('HttpOnly')
	})

	it('mutating happy path: header submission matches the cookie and is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('mutating happy path: field submission matches the cookie and is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookieValue },
			body: JSON.stringify({ _csrf: token }),
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('a missing submitted token throws HTTPError 403', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const request = buildRequest('/', { method: 'POST' })
		const context = createTestContext(request, {})
		await expect(csrf(request, context, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('a mismatched submitted token throws HTTPError 403', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': 'wrong-value', cookie: cookieValue },
		})
		const context = createTestContext(postRequest, {})
		await expect(csrf(postRequest, context, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('SESSION-BOUND: a token minted under session A replayed under session B is rejected with 403; A-on-A is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const sessionA: SessionInterface = { id: 'session-a', data: new Map() }
		const sessionB: SessionInterface = { id: 'session-b', data: new Map() }

		const mintStateA: CSRFState & SessionState = { session: sessionA }
		const mintResponseA = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), mintStateA),
		)
		const setCookieA = mintResponseA.headers.get('set-cookie') ?? ''
		const cookieValueA = setCookieA.split(';')[0] ?? ''
		const tokenA = mintStateA.csrf ?? ''

		const aOnARequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': tokenA, cookie: cookieValueA },
		})
		const aOnAState: CSRFState & SessionState = { session: sessionA }
		const aOnAContext = createTestContext(aOnARequest, aOnAState)
		const aOnATerminal = createRecordingTerminal()
		const aOnAResponse = await runChain([csrf], aOnATerminal.handler, aOnARequest, aOnAContext)
		expect(aOnAResponse.status).toBe(200)
		expect(aOnATerminal.count).toBe(1)

		const bOnARequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': tokenA, cookie: cookieValueA },
		})
		const bOnAState: CSRFState & SessionState = { session: sessionB }
		const bOnAContext = createTestContext(bOnARequest, bOnAState)
		await expect(csrf(bOnARequest, bOnAContext, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('sessionless fallback still works (no session on state)', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''
		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('auto-Secure: the double-submit cookie carries Secure when connection.encrypted is true, omits it when false', async () => {
		const csrf = createCSRF<CSRFState & SessionState & ConnectionState>({ secret: SECRET })

		const secureState: CSRFState & SessionState & ConnectionState = {
			connection: { ip: '203.0.113.1', encrypted: true },
		}
		const secureResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), secureState),
		)
		expect(secureResponse.headers.get('set-cookie')).toContain('Secure')

		const plainState: CSRFState & SessionState & ConnectionState = {
			connection: { ip: '203.0.113.1', encrypted: false },
		}
		const plainResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), plainState),
		)
		expect(plainResponse.headers.get('set-cookie')).not.toContain('Secure')
	})
})

// ── Composition (the §5 canonical onion, end-to-end) ─────────────────────

describe('composition', () => {
	it('error body compressed: boundary sits INSIDE compression, so a rendered error body is still compressible', async () => {
		const boundary = createBoundary({ expose: true })
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression, boundary],
			async () => {
				throw new Error('x'.repeat(2048))
			},
			request,
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('gzip')
	})

	it('304 passes through compression untouched (no double body work)', async () => {
		const etag = createETag<Record<string, never>>()
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const first = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			buildRequest('/'),
			createTestContext(buildRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		const request = buildRequest('/', {
			headers: { 'if-none-match': known ?? '', 'accept-encoding': 'gzip' },
		})
		const response = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		expect(response.status).toBe(304)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('ETag hash is stable when computed inner-of-compression (etag mounted inside compression)', async () => {
		const etag = createETag<Record<string, never>>()
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildRequest('/')
		const first = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		const second = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		expect(first.headers.get('etag')).toBe(second.headers.get('etag'))
	})

	it('preflight preempts the terminal in a full onion', async () => {
		const cors = createCors()
		const boundary = createBoundary()
		const terminal = createRecordingTerminal()
		const request = buildRequest('/', {
			method: 'OPTIONS',
			headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
		})
		const response = await runChain(
			[boundary, cors],
			terminal.handler,
			request,
			createTestContext(request, {}),
		)
		expect(response.status).toBe(204)
		expect(terminal.count).toBe(0)
	})

	it('bearer -> limiter token-key idiom: the limiter keys off the bearer-stashed token', async () => {
		const clock = createManualClock()
		const token = await signToken('user-1', { secret: SECRET })
		const bearer = createBearer<BearerState & ClientState & ConnectionState>({ secret: SECRET })
		const limiter = createLimiter<BearerState & ClientState & ConnectionState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const request = buildRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const state: BearerState & ClientState & ConnectionState = {}
		const context = createTestContext(request, state)
		const first = await runChain([bearer, limiter], createEchoTerminal(), request, context)
		const second = await runChain([bearer, limiter], createEchoTerminal(), request, context)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('body -> csrf field read: csrf reads the field the body battery cached', async () => {
		const body = createBody<CSRFState & SessionState>()
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildRequest('/'),
			createTestContext(buildRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''
		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookieValue },
			body: JSON.stringify({ _csrf: token }),
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[body, csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('session -> csrf binding: the csrf battery binds to the session resolved upstream', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: SECRET })

		const mintRequest = buildRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session')
		expect(sessionId).not.toBeNull()
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': sessionId ?? '', 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session, csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})
})

// ── createCookieTransport / createHeaderTransport (from factories.ts, exercised indirectly above; direct smoke) ──

describe('transports', () => {
	it('createHeaderTransport reads/writes/clears the configured header', async () => {
		const transport = createHeaderTransport({ header: 'x-session' })
		const request = buildRequest('/', { headers: { 'x-session': 'abc' } })
		expect(await transport.read(request)).toBe('abc')
		const response = new Response()
		transport.write(response, 'xyz', false)
		expect(response.headers.get('x-session')).toBe('xyz')
		transport.clear(response)
		expect(response.headers.has('x-session')).toBe(false)
	})

	it('createCookieTransport signs and reads back a session id via a real cookie round-trip', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const response = new Response()
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const request = buildRequest('/', { headers: { cookie: cookieValue } })
		expect(await transport.read(request)).toBe('session-id-1')
	})
})
