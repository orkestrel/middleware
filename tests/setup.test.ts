import { describe, expect, it } from 'vitest'
import { ContentTooLargeError, signToken, verifyToken } from '@orkestrel/server'
import {
	buildRequest,
	buildSession,
	buildStore,
	compressibleBody,
	createEchoTerminal,
	createManualClock,
	createRecordingNext,
	createRecordingTerminal,
	createTestContext,
	createTestTransport,
	decompress,
	ECHO_MARKER,
	runChain,
	TEST_BODY_LIMIT,
	TEST_SECRET,
} from './setup.js'

// ── tests/setup.ts — the host-independent middleware harness ──────────────────
//
// Proves the exported behavior `tests/src/core/middlewares.test.ts` and
// `tests/src/server/middlewares.test.ts` drive their scenarios with: the fixed
// request origin, the context derivation and its cached capped body, the
// marker terminals, the recording continuation, the composition order, and the
// manual clock. Every expectation is derived by a route this module cannot
// share — a literal origin, a hand-written call order, the platform's own
// `JSON.parse` — so an assertion cannot pass merely because the harness agrees
// with itself.

describe('buildRequest', () => {
	it('joins the path and its query onto the fixed test origin and carries the init through', async () => {
		const request = buildRequest('/users?limit=2', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"name":"ada"}',
		})
		expect(request.url).toBe('http://test.local/users?limit=2')
		expect(request.method).toBe('POST')
		expect(request.headers.get('content-type')).toBe('application/json')
		expect(await request.text()).toBe('{"name":"ada"}')
		expect(buildRequest('/').url).toBe('http://test.local/')
		expect(buildRequest('/').method).toBe('GET')
	})
})

describe('createTestContext', () => {
	it('derives the url and method from the request and threads the caller state object in place', () => {
		const state = { seen: 0 }
		const context = createTestContext(buildRequest('/users?limit=2', { method: 'DELETE' }), state)
		expect(context.url.href).toBe('http://test.local/users?limit=2')
		expect(context.url.pathname).toBe('/users')
		expect(context.url.searchParams.get('limit')).toBe('2')
		expect(context.method).toBe('DELETE')
		expect(context.state).toBe(state)
		context.state.seen = 3
		expect(state.seen).toBe(3)
	})

	it('reads the request body once and answers every later call from the same promise', async () => {
		const payload = '{"name":"ada","tags":["a","b"]}'
		const context = createTestContext(
			buildRequest('/users', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: payload,
			}),
			{},
		)
		const first = context.body()
		expect(context.body()).toBe(first)
		expect(await first).toEqual(JSON.parse(payload))
		// A `Request` body is readable once, so a chain calling `body()` twice
		// proves the cache rather than the peer's reader.
		expect(await context.body()).toEqual(JSON.parse(payload))
	})

	it('caps the body it reads at the harness limit — reading at the cap, refusing one byte past it', async () => {
		const atCap = createTestContext(
			buildRequest('/upload', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'a'.repeat(TEST_BODY_LIMIT),
			}),
			{},
		)
		const value = await atCap.body()
		if (typeof value !== 'string') throw new Error('a text body must read back as a string')
		expect(value).toHaveLength(TEST_BODY_LIMIT)

		const pastCap = createTestContext(
			buildRequest('/upload', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'a'.repeat(TEST_BODY_LIMIT + 1),
			}),
			{},
		)
		await expect(pastCap.body()).rejects.toBeInstanceOf(ContentTooLargeError)
	})
})

describe('createEchoTerminal', () => {
	it('answers the marker body at the default status and at a requested one', async () => {
		const context = createTestContext(buildRequest('/'), {})
		const answered = await createEchoTerminal()(buildRequest('/'), context)
		expect(answered.status).toBe(200)
		expect(await answered.text()).toBe('echo')
		expect(ECHO_MARKER).toBe('echo')

		const created = await createEchoTerminal(201)(buildRequest('/'), context)
		expect(created.status).toBe(201)
		expect(await created.text()).toBe('echo')
	})
})

describe('createRecordingTerminal', () => {
	it('records every request and context it is reached with and answers the marker', async () => {
		const terminal = createRecordingTerminal<{ seen: number }>(202)
		const firstRequest = buildRequest('/first')
		const firstContext = createTestContext(firstRequest, { seen: 1 })
		const secondRequest = buildRequest('/second', { method: 'DELETE' })
		const secondContext = createTestContext(secondRequest, { seen: 2 })

		expect(terminal.count).toBe(0)
		const response = await terminal.handler(firstRequest, firstContext)
		await terminal.handler(secondRequest, secondContext)

		expect(terminal.count).toBe(2)
		expect(terminal.calls[0]?.request).toBe(firstRequest)
		expect(terminal.calls[0]?.context).toBe(firstContext)
		expect(terminal.calls[1]?.request).toBe(secondRequest)
		expect(terminal.calls[1]?.context).toBe(secondContext)
		expect(response.status).toBe(202)
		expect(await response.text()).toBe('echo')
	})
})

describe('createRecordingNext', () => {
	it('records each substituted request and answers with the response it was given', async () => {
		const downstream = new Response('downstream', { status: 202 })
		const recording = createRecordingNext(downstream)
		const substituted = buildRequest('/rewritten')

		expect(await recording.next(substituted)).toBe(downstream)
		expect(await recording.next()).toBe(downstream)
		expect(recording.count).toBe(2)
		expect(recording.calls[0]).toBe(substituted)
		expect(recording.calls[1]).toBeUndefined()

		const defaulted = await createRecordingNext().next()
		expect(defaulted.status).toBe(200)
		expect(await defaulted.text()).toBe('echo')
	})
})

describe('runChain', () => {
	it('runs the middleware outermost first around the terminal and returns the chain response', async () => {
		const trail: string[] = []
		const request = buildRequest('/orders')
		const context = createTestContext(request, { trail })
		const response = await runChain(
			[
				async (driving, outer, next) => {
					trail.push(`outer:enter:${outer.method}`)
					const answer = await next(driving)
					trail.push('outer:exit')
					return new Response(await answer.text(), {
						status: answer.status,
						headers: { 'x-outer': 'wrapped' },
					})
				},
				async (driving, inner, next) => {
					trail.push(`inner:${inner.method}:${new URL(driving.url).pathname}`)
					const answer = await next()
					trail.push('inner:exit')
					return answer
				},
			],
			async () => {
				trail.push('terminal')
				return new Response('reached', { status: 201 })
			},
			request,
			context,
		)

		expect(trail).toEqual([
			'outer:enter:GET',
			'inner:GET:/orders',
			'terminal',
			'inner:exit',
			'outer:exit',
		])
		expect(response.status).toBe(201)
		expect(await response.text()).toBe('reached')
		expect(response.headers.get('x-outer')).toBe('wrapped')
	})
})

describe('createManualClock', () => {
	it('starts at its start value, advances by each increment, and jumps to a set value', () => {
		const clock = createManualClock(500)
		expect(clock.clock()).toBe(500)
		clock.advance(250)
		clock.advance(0)
		expect(clock.clock()).toBe(750)
		clock.set(10)
		expect(clock.clock()).toBe(10)
		expect(createManualClock().clock()).toBe(0)
	})
})

describe('buildSession', () => {
	it('carries the given id and leaves the state empty when no mark is given', () => {
		const session = buildSession('id-1')
		expect(session.id).toBe('id-1')
		expect(session.state.size).toBe(0)
	})

	it('writes a given mark through the entity mutator and keeps sessions independent', () => {
		const first = buildSession('id-1', 'first')
		const second = buildSession('id-1', 'second')
		expect(first.state.get('mark')).toBe('first')
		expect(second.state.get('mark')).toBe('second')
		expect([...first.state.keys()]).toEqual(['mark'])
	})
})

describe('TEST_SECRET', () => {
	it('signs and verifies a token through the peer, so every battery shares one real secret', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET })
		expect(await verifyToken(token, TEST_SECRET)).toBe('user-1')
		expect(await verifyToken(token, `${TEST_SECRET}-other`)).toBeUndefined()
	})
})

describe('compressibleBody', () => {
	it('returns exactly the requested length of one repeated character', () => {
		expect(compressibleBody(0)).toBe('')
		expect(compressibleBody(4)).toBe('aaaa')
		expect(compressibleBody(2048)).toHaveLength(2048)
		expect(new Set(compressibleBody(2048)).size).toBe(1)
	})
})

describe('decompress', () => {
	it('reads back text the platform compressed, from an ArrayBuffer and from a view over one', async () => {
		const original = compressibleBody(1024)
		const source = new Response(original).body
		if (source === null) throw new Error('the encoded body carried no stream')
		const gzipped = await new Response(
			source.pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer()
		expect(await decompress(gzipped, 'gzip')).toBe(original)
		expect(await decompress(new Uint8Array(gzipped), 'gzip')).toBe(original)
	})

	it('rejects when the bytes are not the coding it was told to read', async () => {
		const notGzip = new TextEncoder().encode('plain text, never compressed')
		await expect(decompress(notGzip, 'gzip')).rejects.toBeDefined()
	})
})

describe('createTestTransport', () => {
	it('round-trips an id through its own header and records every write and clear', async () => {
		const transport = createTestTransport()
		const response = new Response(null)
		expect(await transport.read(buildRequest('/'))).toBeUndefined()

		await transport.write(response, 'session-1', false)
		expect(response.headers.get('x-test-session')).toBe('session-1')
		expect(transport.written).toHaveLength(1)
		expect(transport.written[0]?.id).toBe('session-1')
		expect(
			await transport.read(buildRequest('/', { headers: { 'x-test-session': 'session-1' } })),
		).toBe('session-1')

		transport.clear(response)
		expect(response.headers.get('x-test-session')).toBeNull()
		expect(transport.cleared).toHaveLength(1)
	})
})

describe('buildStore', () => {
	it('pairs a live table with a store that reads and writes the very rows the table holds', async () => {
		const { table, store } = buildStore()
		await store.set(buildSession('id-1', 'first'), 0)
		// The row is read back off the table directly, so the assertion does not
		// travel the same path the store wrote it through.
		expect(await table.get('id-1')).toMatchObject({ id: 'id-1', seen: 0, created: 0 })
		expect((await store.get('id-1', 0))?.state.get('mark')).toBe('first')
	})

	it('applies the given limits, so an idle session is evicted at its boundary', async () => {
		const untouched = buildStore({ ttl: 1_000 })
		await untouched.store.set(buildSession('id-1'), 0)
		expect(await untouched.store.get('id-1', 1_000)).toBeUndefined()

		// A store built with no limits keeps the same row at the same instant,
		// so the preceding eviction is the given `ttl` and not the default.
		const unlimited = buildStore()
		await unlimited.store.set(buildSession('id-1'), 0)
		expect(await unlimited.store.get('id-1', 1_000)).toBeDefined()
	})

	it('allocates an independent table per call', async () => {
		const first = buildStore()
		const second = buildStore()
		await first.store.set(buildSession('id-1'), 0)
		expect(await second.store.get('id-1', 0)).toBeUndefined()
	})
})
