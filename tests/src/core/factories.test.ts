import type { Session } from '@src/core'
import {
	createCookieTransport,
	createDatabaseSessionStore,
	createHeaderTransport,
	createMemorySessionStore,
	createRestoredSession,
	isSession,
	sessionColumns,
} from '@src/core'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { describe, expect, it } from 'vitest'
import { buildSession, TEST_SECRET } from '../../setup.js'

// ============================================================================
//  @orkestrel/middleware — factories.ts unit tests. Round-trips against real
//  Request/Response objects; the store portion mirrors
//  MemorySessionStore.test.ts shallowly, confirming the factory wires it up.
// ============================================================================

describe('createCookieTransport', () => {
	it('round-trips a written id back through a request carrying its Cookie header', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie')
		expect(setCookie).not.toBeNull()
		const cookieValue = (setCookie ?? '').split(';')[0] ?? ''
		const request = new Request('http://test.local/', { headers: { cookie: cookieValue } })
		expect(await transport.read(request)).toBe('session-id-1')
	})

	it('resolves undefined reading a tampered cookie value', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
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
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const request = new Request('http://test.local/')
		expect(await transport.read(request)).toBeUndefined()
	})

	it('clear emits an expiring Set-Cookie (Max-Age=0)', () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const response = new Response(null)
		transport.clear(response)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie).toContain('Max-Age=0')
	})

	it('defaults the cookie to name "session", Path=/, HttpOnly, SameSite=Lax', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie.startsWith('session=')).toBe(true)
		expect(setCookie).toContain('Path=/')
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('SameSite=Lax')
	})

	it('honors a custom cookie name', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET, name: 'sid' })
		const response = new Response(null)
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		expect(setCookie.startsWith('sid=')).toBe(true)
	})

	it('auto-Secure: encrypted true carries Secure, encrypted false omits it', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
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
		const store = createMemorySessionStore<Session>()
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 0))?.id).toBe('a')
	})

	it('resolves undefined for an id that was never set', async () => {
		const store = createMemorySessionStore<Session>()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('evicts at the idle (ttl) boundary', async () => {
		const store = createMemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
	})

	it('resolves the session right up to the idle boundary (exclusive)', async () => {
		const store = createMemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 999))?.id).toBe('a')
	})

	it('delete is a total no-op on an absent id', async () => {
		const store = createMemorySessionStore<Session>()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})

	it('throws a TypeError when ttl is malformed', () => {
		expect(() => createMemorySessionStore({ ttl: Number.NaN })).toThrow(TypeError)
	})
})

describe('createDatabaseSessionStore', () => {
	it('throws a TypeError when ttl or lifetime is malformed', () => {
		const db = createDatabase({
			driver: createMemoryDriver(),
			tables: { sessions: sessionColumns },
		})
		const table = db.table('sessions')
		expect(() => createDatabaseSessionStore(table, isSession, { ttl: Number.NaN })).toThrow(
			TypeError,
		)
		expect(() => createDatabaseSessionStore(table, isSession, { lifetime: 0 })).toThrow(TypeError)
	})
})

describe('createRestoredSession', () => {
	it('rebuilds a session with its id and every snapshot entry', () => {
		const restored = createRestoredSession({ id: 'abc', state: { userId: 'u_1', count: 3 } })
		expect(restored?.id).toBe('abc')
		expect(restored?.state.get('userId')).toBe('u_1')
		expect(restored?.state.get('count')).toBe(3)
	})

	it('rebuilds a "__proto__"-named key as an own state entry', () => {
		const snapshot: unknown = JSON.parse('{"id":"x","state":{"__proto__":"evil"}}')
		const restored = createRestoredSession(snapshot)
		expect(restored?.state.get('__proto__')).toBe('evil')
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)
	})

	it('returns undefined for malformed input', () => {
		expect(createRestoredSession(undefined)).toBeUndefined()
		expect(createRestoredSession(null)).toBeUndefined()
		expect(createRestoredSession('abc')).toBeUndefined()
		expect(createRestoredSession({})).toBeUndefined()
		expect(createRestoredSession({ id: 1, state: {} })).toBeUndefined()
		expect(createRestoredSession({ id: 'abc', state: 'not-a-record' })).toBeUndefined()
	})
})
