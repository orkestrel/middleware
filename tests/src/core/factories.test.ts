import { createCookieTransport, createHeaderTransport, createMemorySessionStore } from '@src/core'
import { describe, expect, it } from 'vitest'

// ============================================================================
//  @orkestrel/middleware — factories.ts unit tests (§16 mirror). Round-trips
//  against real Request/Response objects; the store portion mirrors
//  MemorySessionStore.test.ts shallowly, confirming the factory wires it up.
// ============================================================================

const SECRET = 'test-secret'

describe('createCookieTransport', () => {
	it('round-trips a written id back through a request carrying its Cookie header', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie')
		expect(setCookie).not.toBeNull()
		const cookieValue = (setCookie ?? '').split(';')[0] ?? ''
		const request = new Request('http://test.local/', { headers: { cookie: cookieValue } })
		expect(await transport.read(request)).toBe('session-id-1')
	})

	it('resolves undefined reading a tampered cookie value', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const [name] = cookieValue.split('=')
		const tampered = `${name}=tampered.value`
		const request = new Request('http://test.local/', { headers: { cookie: tampered } })
		expect(await transport.read(request)).toBeUndefined()
	})

	it('resolves undefined reading a request carrying no cookie at all', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const request = new Request('http://test.local/')
		expect(await transport.read(request)).toBeUndefined()
	})

	it('clear emits an expiring Set-Cookie (Max-Age=0)', () => {
		const transport = createCookieTransport({ secret: SECRET })
		const response = new Response(null)
		transport.clear(response)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie).toContain('Max-Age=0')
	})

	it('defaults the cookie to name "session", Path=/, HttpOnly, SameSite=Lax', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie.startsWith('session=')).toBe(true)
		expect(setCookie).toContain('Path=/')
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('SameSite=Lax')
	})

	it('honors a custom cookie name', async () => {
		const transport = createCookieTransport({ secret: SECRET, name: 'sid' })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie.startsWith('sid=')).toBe(true)
	})

	it('auto-Secure: encrypted true carries Secure, encrypted false omits it', async () => {
		const transport = createCookieTransport({ secret: SECRET })
		const secureResponse = new Response(null)
		await transport.write(secureResponse, 'session-id-1', true)
		expect(secureResponse.headers.get('set-cookie')).toContain('Secure')

		const plainResponse = new Response(null)
		await transport.write(plainResponse, 'session-id-1', false)
		expect(plainResponse.headers.get('set-cookie')).not.toContain('Secure')
	})
})

describe('createHeaderTransport', () => {
	it('round-trips a written id back through a request carrying the header', async () => {
		const transport = createHeaderTransport()
		const response = new Response(null)
		transport.write(response, 'session-id-1', false)
		const headerValue = response.headers.get('session-id')
		expect(headerValue).toBe('session-id-1')
		const request = new Request('http://test.local/', {
			headers: { 'session-id': headerValue ?? '' },
		})
		expect(await transport.read(request)).toBe('session-id-1')
	})

	it('resolves undefined reading a request carrying no header at all', async () => {
		const transport = createHeaderTransport()
		const request = new Request('http://test.local/')
		expect(await transport.read(request)).toBeUndefined()
	})

	it('clear removes the header', () => {
		const transport = createHeaderTransport()
		const response = new Response(null)
		transport.write(response, 'session-id-1', false)
		expect(response.headers.has('session-id')).toBe(true)
		transport.clear(response)
		expect(response.headers.has('session-id')).toBe(false)
	})

	it('honors a custom header name', () => {
		const transport = createHeaderTransport({ header: 'x-session' })
		const response = new Response(null)
		transport.write(response, 'session-id-1', false)
		expect(response.headers.get('x-session')).toBe('session-id-1')
	})
})

describe('createMemorySessionStore', () => {
	it('returns a working store round-tripping a set session', async () => {
		const store = createMemorySessionStore<string>()
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 0)).toBe('payload')
	})

	it('resolves undefined for an id that was never set', async () => {
		const store = createMemorySessionStore<string>()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('evicts at the idle (ttl) boundary', async () => {
		const store = createMemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
	})

	it('resolves the session right up to the idle boundary (exclusive)', async () => {
		const store = createMemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 999)).toBe('payload')
	})

	it('delete is a total no-op on an absent id', async () => {
		const store = createMemorySessionStore<string>()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})

	it('throws a TypeError when ttl is malformed', () => {
		expect(() => createMemorySessionStore({ ttl: Number.NaN })).toThrow(TypeError)
	})
})
