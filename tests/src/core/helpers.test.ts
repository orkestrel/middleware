import type { MiddlewareContext } from '@orkestrel/server'
import {
	buildClientInfo,
	buildRateLimitField,
	buildRateLimitPolicyField,
	buildRetryAfter,
	compressResponse,
	detectEncodings,
	equalsConstantTime,
	isBufferingIneligible,
	isCompressionNegotiated,
	isMultipartBody,
	isPreflight,
	isSession,
	isSessionControl,
	matchesTrustedEntry,
	rebuildResponse,
	resolveForwardedFor,
	resolveKey,
	transferSessionData,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// Minimal MiddlewareContext<unknown> stub — compressResponse only reads `method`.
function buildContext(method = 'GET'): MiddlewareContext<unknown> {
	return {
		url: new URL('https://example.test/'),
		method,
		state: {},
		body: async () => undefined,
	}
}

async function decompress(
	bytes: Uint8Array<ArrayBuffer>,
	encoding: 'gzip' | 'deflate',
): Promise<string> {
	const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream(encoding))
	const buffer = await new Response(stream).arrayBuffer()
	return new TextDecoder().decode(buffer)
}

// ============================================================================
//  @orkestrel/middleware — core helpers.ts unit tests (§16 mirror).
//  Self-contained: no tests/setup.ts import. Every scenario is built inline
//  with real Request/Response/Headers/Map values.
// ============================================================================

describe('resolveKey', () => {
	it('prefers a bearer token over client and connection facts', () => {
		expect(
			resolveKey({
				token: 'abc',
				client: { ip: '203.0.113.7' },
				connection: { ip: '10.0.0.1', encrypted: false },
			}),
		).toBe('token:abc')
	})

	it('falls back to client IP when no token is present', () => {
		expect(
			resolveKey({
				client: { ip: '203.0.113.7' },
				connection: { ip: '10.0.0.1', encrypted: false },
			}),
		).toBe('ip:203.0.113.7')
	})

	it('falls back to connection IP when neither token nor client is present', () => {
		expect(resolveKey({ connection: { ip: '10.0.0.1', encrypted: false } })).toBe('ip:10.0.0.1')
	})

	it('resolves the literal ip:unknown when no identity fact is present', () => {
		expect(resolveKey({})).toBe('ip:unknown')
	})

	it('collapses an IPv6 client IP to its /64 network via clientRateKey', () => {
		expect(resolveKey({ client: { ip: '2001:db8::1' } })).toBe('ip:2001:db8:0:0::/64')
	})
})

describe('buildRetryAfter', () => {
	it('returns whole seconds ceiling to the next second', () => {
		expect(buildRetryAfter(1_500, 1_000)).toBe('1')
		expect(buildRetryAfter(3_001, 1_000)).toBe('3')
	})

	it('floors at a minimum of 1 even when the reset has already passed', () => {
		expect(buildRetryAfter(500, 1_000)).toBe('1')
		expect(buildRetryAfter(1_000, 1_000)).toBe('1')
	})
})

describe('buildRateLimitField', () => {
	it('builds the exact draft RateLimit structured-field string', () => {
		expect(buildRateLimitField(4, 1_500, 1_000)).toBe('"default";r=4;t=1')
	})

	it('floors its seconds-to-reset at a minimum of 1', () => {
		expect(buildRateLimitField(0, 1_000, 1_000)).toBe('"default";r=0;t=1')
	})
})

describe('buildRateLimitPolicyField', () => {
	it('builds the exact draft RateLimit-Policy structured-field string', () => {
		expect(buildRateLimitPolicyField(10, 60_000)).toBe('"default";q=10;w=60')
	})

	it('ceils a fractional window to whole seconds', () => {
		expect(buildRateLimitPolicyField(5, 1_500)).toBe('"default";q=5;w=2')
	})
})

describe('matchesTrustedEntry', () => {
	it('matches an exact address', () => {
		expect(matchesTrustedEntry('203.0.113.7', '203.0.113.7')).toBe(true)
		expect(matchesTrustedEntry('203.0.113.8', '203.0.113.7')).toBe(false)
	})

	it('matches an IPv4 CIDR entry within its network', () => {
		expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/8')).toBe(true)
		expect(matchesTrustedEntry('192.168.1.1', '10.0.0.0/8')).toBe(false)
		expect(matchesTrustedEntry('10.0.0.0', '10.0.0.0/32')).toBe(true)
		expect(matchesTrustedEntry('10.0.0.1', '10.0.0.0/32')).toBe(false)
	})

	it('rejects a malformed CIDR total-safely (never throws)', () => {
		expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/99')).toBe(false)
		expect(matchesTrustedEntry('10.1.2.3', 'not-an-address/8')).toBe(false)
		expect(matchesTrustedEntry('not-an-address', '10.0.0.0/8')).toBe(false)
		expect(matchesTrustedEntry('2001:db8::1', '10.0.0.0/8')).toBe(false)
	})

	it('matches an IPv6 entry by exact string only', () => {
		expect(matchesTrustedEntry('2001:db8::1', '2001:db8::1')).toBe(true)
		expect(matchesTrustedEntry('2001:db8::2', '2001:db8::1')).toBe(false)
	})
})

describe('resolveForwardedFor', () => {
	it('resolves undefined when the header is absent', () => {
		expect(resolveForwardedFor(undefined, { proxies: 1 })).toBeUndefined()
	})

	it('resolves undefined when the header is present but empty', () => {
		expect(resolveForwardedFor('', { proxies: 1 })).toBeUndefined()
		expect(resolveForwardedFor('   ', { proxies: 1 })).toBeUndefined()
	})

	it('with a proxies count, trusts exactly that many hops from the right', () => {
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1', { proxies: 1 })).toBe('203.0.113.7')
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1, 10.0.0.2', { proxies: 2 })).toBe(
			'203.0.113.7',
		)
	})

	it('with a proxies count, resolves undefined when every hop is claimed as trusted', () => {
		expect(resolveForwardedFor('10.0.0.1', { proxies: 1 })).toBeUndefined()
		expect(resolveForwardedFor('10.0.0.1', { proxies: 5 })).toBeUndefined()
	})

	it('with a trusted roster, walks right-to-left past consecutive matches', () => {
		expect(resolveForwardedFor('203.0.113.7, 10.0.0.1', { trusted: ['10.0.0.0/8'] })).toBe(
			'203.0.113.7',
		)
		expect(
			resolveForwardedFor('203.0.113.7, 10.0.0.1, 10.0.0.2', { trusted: ['10.0.0.0/8'] }),
		).toBe('203.0.113.7')
	})

	it('with a trusted roster, resolves undefined when every hop is trusted', () => {
		expect(resolveForwardedFor('10.0.0.1, 10.0.0.2', { trusted: ['10.0.0.0/8'] })).toBeUndefined()
	})

	it('with a garbage header, remains total-safe and never throws', () => {
		expect(() => resolveForwardedFor(',,,', { proxies: 1 })).not.toThrow()
		expect(resolveForwardedFor(',,,', { proxies: 1 })).toBeUndefined()
		expect(() =>
			resolveForwardedFor('not-an-ip, also-not', { trusted: ['10.0.0.0/8'] }),
		).not.toThrow()
		// The rightmost hop ('also-not') does not match the trusted roster, so the
		// whole header is untrustworthy — falls back to undefined rather than
		// returning a client-supplied hop.
		expect(resolveForwardedFor('not-an-ip, also-not', { trusted: ['10.0.0.0/8'] })).toBeUndefined()
	})

	it('with a trusted roster, an untrusted rightmost (immediate sender) hop makes the whole header untrustworthy, even when an earlier hop would match', () => {
		expect(
			resolveForwardedFor('203.0.113.7, 10.0.0.1, attacker-injected', {
				trusted: ['10.0.0.0/8'],
			}),
		).toBeUndefined()
	})
})

describe('detectEncodings', () => {
	it('returns a subset of the candidates offered, in order', () => {
		const detected = detectEncodings(['gzip', 'deflate'])
		expect(detected.every((encoding) => ['gzip', 'deflate'].includes(encoding))).toBe(true)
		for (let index = 1; index < detected.length; index += 1) {
			expect(['gzip', 'deflate'].indexOf(detected[index] ?? '')).toBeGreaterThan(
				['gzip', 'deflate'].indexOf(detected[index - 1] ?? ''),
			)
		}
	})

	it('never probes identity and never throws on an empty candidate list', () => {
		expect(detectEncodings([])).toEqual([])
		expect(detectEncodings(['identity'])).toEqual([])
	})
})

describe('isBufferingIneligible', () => {
	it('is ineligible for a HEAD request', () => {
		expect(isBufferingIneligible('HEAD', new Response('body'), 'content-encoding')).toBe(true)
	})

	it('is ineligible for a 204 or 304 response', () => {
		expect(
			isBufferingIneligible('GET', new Response(null, { status: 204 }), 'content-encoding'),
		).toBe(true)
		expect(
			isBufferingIneligible('GET', new Response(null, { status: 304 }), 'content-encoding'),
		).toBe(true)
	})

	it('is ineligible for a bodyless response', () => {
		expect(
			isBufferingIneligible('GET', new Response(null, { status: 200 }), 'content-encoding'),
		).toBe(true)
	})

	it('is ineligible for a text/event-stream response', () => {
		const response = new Response('data: x\n\n', {
			headers: { 'content-type': 'text/event-stream' },
		})
		expect(isBufferingIneligible('GET', response, 'content-encoding')).toBe(true)
	})

	it('is ineligible when the skip header is already present', () => {
		const response = new Response('body', { headers: { 'content-encoding': 'gzip' } })
		expect(isBufferingIneligible('GET', response, 'content-encoding')).toBe(true)
	})

	it('is eligible for a plain buffered GET response', () => {
		const response = new Response('body', {
			status: 200,
			headers: { 'content-type': 'text/plain' },
		})
		expect(isBufferingIneligible('GET', response, 'content-encoding')).toBe(false)
	})
})

describe('isCompressionNegotiated', () => {
	it('is true for an actionable non-identity coding', () => {
		expect(isCompressionNegotiated('gzip')).toBe(true)
	})

	it('is false for identity and for undefined', () => {
		expect(isCompressionNegotiated('identity')).toBe(false)
		expect(isCompressionNegotiated(undefined)).toBe(false)
	})
})

describe('transferSessionData', () => {
	it('copies every entry from one session data Map into another', () => {
		const from = {
			id: 'a',
			data: new Map<string, unknown>([
				['userId', 'u_1'],
				['role', 'admin'],
			]),
		}
		const to = { id: 'b', data: new Map<string, unknown>() }
		transferSessionData(from, to)
		expect(to.data.get('userId')).toBe('u_1')
		expect(to.data.get('role')).toBe('admin')
		expect(to.data.size).toBe(2)
	})

	it('leaves the source untouched and overwrites an overlapping destination key', () => {
		const from = { id: 'a', data: new Map<string, unknown>([['key', 'new']]) }
		const to = {
			id: 'b',
			data: new Map<string, unknown>([
				['key', 'old'],
				['extra', 1],
			]),
		}
		transferSessionData(from, to)
		expect(to.data.get('key')).toBe('new')
		expect(to.data.get('extra')).toBe(1)
		expect(from.data.get('key')).toBe('new')
	})
})

describe('isSession', () => {
	it('accepts a value shaped like a SessionInterface', () => {
		expect(isSession({ id: 'a', data: new Map() })).toBe(true)
	})

	it('rejects hostile inputs totally', () => {
		expect(isSession(null)).toBe(false)
		expect(isSession(undefined)).toBe(false)
		expect(isSession('a')).toBe(false)
		expect(isSession(42)).toBe(false)
		expect(isSession([])).toBe(false)
		expect(isSession({ id: 'a', data: [] })).toBe(false)
		expect(isSession({ id: 1, data: new Map() })).toBe(false)
		expect(isSession({})).toBe(false)
	})
})

describe('isSessionControl', () => {
	it('accepts a value with callable regenerate and destroy', () => {
		expect(isSessionControl({ regenerate: () => undefined, destroy: () => undefined })).toBe(true)
	})

	it('rejects hostile inputs totally', () => {
		expect(isSessionControl(null)).toBe(false)
		expect(isSessionControl(undefined)).toBe(false)
		expect(isSessionControl(42)).toBe(false)
		expect(isSessionControl({ regenerate: () => undefined })).toBe(false)
		expect(isSessionControl({ regenerate: 'nope', destroy: () => undefined })).toBe(false)
		expect(isSessionControl({})).toBe(false)
	})
})

describe('isMultipartBody', () => {
	const file = {
		field: 'avatar',
		name: 'a.png',
		size: 10,
		mime: 'image/png',
		validated: true,
		status: 'ok',
		path: '/tmp/a.png',
	}

	it('accepts a value shaped like a MultipartBody', () => {
		expect(isMultipartBody({ files: { avatar: [file] }, fields: { name: 'a' } })).toBe(true)
	})

	it('accepts empty files and fields records', () => {
		expect(isMultipartBody({ files: {}, fields: {} })).toBe(true)
	})

	it('rejects hostile inputs totally', () => {
		expect(isMultipartBody(null)).toBe(false)
		expect(isMultipartBody(undefined)).toBe(false)
		expect(isMultipartBody(42)).toBe(false)
		expect(isMultipartBody({ files: [], fields: {} })).toBe(false)
		expect(isMultipartBody({ files: {}, fields: [] })).toBe(false)
		expect(
			isMultipartBody({ files: { avatar: [{ ...file, size: 'not-a-number' }] }, fields: {} }),
		).toBe(false)
		expect(isMultipartBody({ files: { avatar: 'not-an-array' }, fields: {} })).toBe(false)
		expect(isMultipartBody({ files: {}, fields: { name: 1 } })).toBe(false)
	})
})

describe('isPreflight', () => {
	it('is true for an OPTIONS request carrying Access-Control-Request-Method', () => {
		expect(isPreflight('OPTIONS', new Headers({ 'access-control-request-method': 'POST' }))).toBe(
			true,
		)
	})

	it('is false for a plain OPTIONS request or a non-OPTIONS method', () => {
		expect(isPreflight('OPTIONS', new Headers())).toBe(false)
		expect(isPreflight('GET', new Headers({ 'access-control-request-method': 'POST' }))).toBe(false)
	})
})

describe('equalsConstantTime', () => {
	it('is true for equal strings', () => {
		expect(equalsConstantTime('abc123', 'abc123')).toBe(true)
	})

	it('is false for different strings of the same length', () => {
		expect(equalsConstantTime('abc123', 'abc124')).toBe(false)
		expect(equalsConstantTime('aaaaaa', 'zzzzzz')).toBe(false)
	})

	it('is false for different-length strings', () => {
		expect(equalsConstantTime('abc', 'abcd')).toBe(false)
		expect(equalsConstantTime('', 'a')).toBe(false)
	})

	it('treats two empty strings as equal', () => {
		expect(equalsConstantTime('', '')).toBe(true)
	})
})

describe('buildClientInfo', () => {
	it('wraps a resolved IP into a ClientInfo slice', () => {
		expect(buildClientInfo('203.0.113.7')).toEqual({ ip: '203.0.113.7' })
	})

	it('wraps an undefined IP the same way', () => {
		expect(buildClientInfo(undefined)).toEqual({ ip: undefined })
	})
})

describe('rebuildResponse', () => {
	it('preserves status and statusText and copies the original headers', () => {
		const original = new Response('old', {
			status: 201,
			statusText: 'Created',
			headers: { 'content-type': 'text/plain', 'x-custom': 'yes' },
		})
		const rebuilt = rebuildResponse('new body', original)
		expect(rebuilt.status).toBe(201)
		expect(rebuilt.statusText).toBe('Created')
		expect(rebuilt.headers.get('content-type')).toBe('text/plain')
		expect(rebuilt.headers.get('x-custom')).toBe('yes')
	})

	it('overrides the body with the replacement', async () => {
		const original = new Response('old')
		const rebuilt = rebuildResponse('new body', original)
		expect(await rebuilt.text()).toBe('new body')
	})

	it('applies explicit replacement headers instead of copying the original', () => {
		const original = new Response('old', { headers: { 'x-original': 'yes' } })
		const headers = new Headers({ 'x-replacement': 'yes' })
		const rebuilt = rebuildResponse('new body', original, headers)
		expect(rebuilt.headers.get('x-replacement')).toBe('yes')
		expect(rebuilt.headers.has('x-original')).toBe(false)
	})

	it('accepts a null body', async () => {
		const original = new Response(null, { status: 304 })
		const rebuilt = rebuildResponse(null, original)
		expect(rebuilt.status).toBe(304)
		expect(rebuilt.body).toBeNull()
	})
})

describe('compressResponse', () => {
	const compress = async (
		bytes: Uint8Array<ArrayBuffer>,
		encoding: 'gzip' | 'deflate',
	): Promise<Uint8Array<ArrayBuffer>> => {
		const stream = new Response(bytes).body?.pipeThrough(new CompressionStream(encoding))
		const buffer = await new Response(stream).arrayBuffer()
		return new Uint8Array(buffer)
	}

	it('compresses an above-threshold compressible body and sets the coding headers', async () => {
		const body = 'x'.repeat(2_000)
		const response = new Response(body, { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 100,
			encodings: ['gzip'],
			compress,
		})
		expect(result.headers.get('content-encoding')).toBe('gzip')
		expect(result.headers.get('vary')).toBe('Accept-Encoding')
		const buffer = await result.arrayBuffer()
		expect(result.headers.get('content-length')).toBe(String(buffer.byteLength))
		expect(await decompress(new Uint8Array(buffer), 'gzip')).toBe(body)
	})

	it('passes through unchanged when the buffered body is below threshold', async () => {
		const response = new Response('short', { headers: { 'content-type': 'text/plain' } })
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 100_000,
			encodings: ['gzip'],
			compress,
		})
		expect(result.headers.has('content-encoding')).toBe(false)
		expect(await result.text()).toBe('short')
	})

	it('passes through an incompressible content-type unchanged', async () => {
		const response = new Response('x'.repeat(2_000), {
			headers: { 'content-type': 'image/png' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 100,
			encodings: ['gzip'],
			compress,
		})
		expect(result.headers.has('content-encoding')).toBe(false)
	})

	it('passes through an already-encoded response unchanged', async () => {
		const response = new Response('x'.repeat(2_000), {
			headers: { 'content-type': 'text/plain', 'content-encoding': 'br' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 100,
			encodings: ['gzip'],
			compress,
		})
		expect(result).toBe(response)
	})

	it('passes through an SSE response unchanged', async () => {
		const response = new Response('data: x\n\n', {
			headers: { 'content-type': 'text/event-stream' },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 1,
			encodings: ['gzip'],
			compress,
		})
		expect(result).toBe(response)
	})

	it('fast-skips without buffering when Content-Length is already below threshold', async () => {
		const body = 'short'
		const response = new Response(body, {
			headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
		})
		const request = new Request('https://example.test/', {
			headers: { 'accept-encoding': 'gzip' },
		})
		const result = await compressResponse(request, buildContext(), response, {
			threshold: 100_000,
			encodings: ['gzip'],
			compress,
		})
		expect(result).toBe(response)
	})
})
