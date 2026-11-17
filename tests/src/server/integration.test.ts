import { afterAll, describe, expect, it } from 'vitest'
import { requireValue } from '@orkestrel/test'
import { createCookieJar } from '@orkestrel/test/server'
import {
	ARM_CELLS,
	BODY_CELLS,
	CANONICAL_HEADER_CELLS,
	CANONICAL_VARY_CELLS,
	FAULT_CELLS,
	FORWARDED_CELLS,
	HEADER_CELLS,
	RANGE_CELLS,
	SECURITY_HEADERS,
	STACK_FOREIGN_ORIGIN,
	STACK_ORIGIN,
	STACK_RANGE,
	STACK_VARIANTS,
	VARY_CELLS,
	buildEchoRequest,
	driveCell,
	holdsValue,
	isHttpOnlyCookie,
	listCORSHeaders,
	listGreenCells,
	listHeldValues,
	listRedCells,
	openSession,
	readArms,
	readBodies,
	readFlood,
	readForwarded,
	readRangeCell,
	readSecurityCell,
	readVaryCell,
	sendStack,
	startStacks,
} from '../../setupServer.js'

// The composed-stack oracle: a real `Server`, a real dispatcher, and a proxy fixture in front of
// the full onion. Each expectation comes from a declared invariant, from what the fixture itself
// sent or appended, or from a bare-route control; none comes from battery code. A cell the base
// holds red registers as `it.fails` and names the unit that closes it.

const stacks = await startStacks()
const oracle = stacks.orders.oracle

afterAll(async () => {
	await stacks.stop()
})

describe('invariant 1: no 5xx unless the handler threw a non-HTTPError', () => {
	it('a handler that throws a non-HTTPError answers 500 (control)', async () => {
		const reply = await sendStack(oracle.url, { path: '/fault' })
		expect(reply.status).toBe(500)
	})

	for (const cell of listGreenCells(FAULT_CELLS))
		it(`${cell.title}`, async () => {
			expect((await driveCell(oracle, cell, createCookieJar())).status).toBeLessThan(500)
		})

	for (const cell of listRedCells(FAULT_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			expect((await driveCell(oracle, cell, createCookieJar())).status).toBeLessThan(500)
		})
})

describe('invariant 2: the credentialed and uncredentialed arms agree, route by route', () => {
	for (const cell of listGreenCells(ARM_CELLS))
		it(`${cell.title}`, async () => {
			expect(await readArms(oracle, cell)).toEqual({ granted: 200, refused: true })
		})

	for (const cell of listRedCells(ARM_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			expect(await readArms(oracle, cell)).toEqual({ granted: 200, refused: true })
		})
})

describe('invariant 3: the resolved IP is the socket peer or a hop the fixture appended', () => {
	const direct = FORWARDED_CELLS.filter((cell) => !cell.proxied)
	const proxied = FORWARDED_CELLS.filter((cell) => cell.proxied)

	for (const cell of listGreenCells(direct))
		it(`${cell.title}`, async () => {
			const { resolved, expected } = await readForwarded(stacks, cell)
			expect(resolved).toBe(expected)
		})

	for (const cell of listRedCells(direct))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			const { resolved, expected } = await readForwarded(stacks, cell)
			expect(resolved).toBe(expected)
		})

	// A host that routes only 127.0.0.1 refuses the proxy's bind to a second loopback address
	// (`EADDRNOTAVAIL`), and then the hop the proxy appends equals the server's socket peer.
	describe.runIf(stacks.alias)(
		'through the proxy fixture from 127.0.0.2, run only where the host routes 127.0.0.2 (a bind refused with EADDRNOTAVAIL skips it)',
		() => {
			it('the proxy reaches the server from an address apart from the hop it appends (control)', async () => {
				await sendStack(oracle.proxy, { path: '/client' })
				expect(requireValue(oracle.hops.at(-1))).not.toBe(oracle.peer)
			})

			for (const cell of listGreenCells(proxied))
				it(`${cell.title}`, async () => {
					const { resolved, expected } = await readForwarded(stacks, cell)
					expect(resolved).toBe(expected)
				})

			for (const cell of listRedCells(proxied))
				it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
					const { resolved, expected } = await readForwarded(stacks, cell)
					expect(resolved).toBe(expected)
				})
		},
	)
})

describe('invariant 4: no script-readable value holds the session id', () => {
	it('the recognizer finds the session id in the HttpOnly session cookie (control)', async () => {
		const reply = await sendStack(oracle.url, { path: '/token' }, createCookieJar())
		const sealed = reply.cookies.filter((field) => isHttpOnlyCookie(field))
		expect(sealed.some((field) => oracle.ids.some((id) => holdsValue(field, id)))).toBe(true)
	})

	it.fails('a cookie-less GET /token [red until M3]', async () => {
		const reply = await sendStack(oracle.url, { path: '/token' }, createCookieJar())
		expect(listHeldValues(reply, oracle.ids)).toEqual([])
	})

	it.fails('GET /page inside an open session [red until M3]', async () => {
		const jar = createCookieJar()
		await openSession(oracle, jar)
		const reply = await sendStack(oracle.url, { path: '/page' }, jar)
		expect(listHeldValues(reply, oracle.ids)).toEqual([])
	})

	it.fails('GET /static/index.html inside an open session [red until M3]', async () => {
		const jar = createCookieJar()
		await openSession(oracle, jar)
		const reply = await sendStack(oracle.url, { path: '/static/index.html' }, jar)
		expect(listHeldValues(reply, oracle.ids)).toEqual([])
	})

	it.fails('POST /rotate, which regenerates the session [red until M3]', async () => {
		const jar = createCookieJar()
		const token = await openSession(oracle, jar)
		const reply = await sendStack(
			oracle.url,
			{ method: 'POST', path: '/rotate', headers: { 'x-csrf-token': token } },
			jar,
		)
		expect(listHeldValues(reply, oracle.ids)).toEqual([])
	})

	it('POST /echo inside an open session', async () => {
		const jar = createCookieJar()
		const token = await openSession(oracle, jar)
		const reply = await sendStack(oracle.url, buildEchoRequest(token), jar)
		expect(listHeldValues(reply, oracle.ids)).toEqual([])
	})
})

describe('invariant 5: Vary: Origin sits on every response and preflight in list mode', () => {
	for (const cell of listGreenCells(VARY_CELLS))
		it(`${cell.title}`, async () => {
			const { observed, expected } = await readVaryCell(oracle, cell)
			expect(observed).toEqual(expected)
		})

	for (const cell of listRedCells(VARY_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			const { observed, expected } = await readVaryCell(oracle, cell)
			expect(observed).toEqual(expected)
		})

	it('a preflight from the allowed origin carries CORS headers (control)', async () => {
		const reply = await sendStack(oracle.url, {
			method: 'OPTIONS',
			path: '/echo',
			headers: { origin: STACK_ORIGIN, 'access-control-request-method': 'POST' },
		})
		expect(listCORSHeaders(reply.headers)).toContain('access-control-allow-origin')
	})

	it('a preflight from a disallowed origin carries no CORS headers', async () => {
		const reply = await sendStack(oracle.url, {
			method: 'OPTIONS',
			path: '/echo',
			headers: { origin: STACK_FOREIGN_ORIGIN, 'access-control-request-method': 'POST' },
		})
		expect(listCORSHeaders(reply.headers)).toEqual([])
	})

	for (const cell of listGreenCells(CANONICAL_VARY_CELLS))
		it(`${cell.title}`, async () => {
			const { observed, expected } = await readVaryCell(stacks.orders.canonical, cell)
			expect(observed).toEqual(expected)
		})

	for (const cell of listRedCells(CANONICAL_VARY_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			const { observed, expected } = await readVaryCell(stacks.orders.canonical, cell)
			expect(observed).toEqual(expected)
		})
})

describe('invariant 6: every earlier CSRF token of the session passes', () => {
	it('the newest token passes (control)', async () => {
		const jar = createCookieJar()
		await openSession(oracle, jar)
		const token = await openSession(oracle, jar)
		expect((await sendStack(oracle.url, buildEchoRequest(token), jar)).status).toBe(200)
	})

	it('a token passes again after an unsafe request of the session', async () => {
		const jar = createCookieJar()
		const token = await openSession(oracle, jar)
		await sendStack(oracle.url, buildEchoRequest(token), jar)
		expect((await sendStack(oracle.url, buildEchoRequest(token), jar)).status).toBe(200)
	})

	it('the first tab token passes after a second tab opens', async () => {
		const jar = createCookieJar()
		const first = await openSession(oracle, jar)
		await openSession(oracle, jar)
		expect((await sendStack(oracle.url, buildEchoRequest(first), jar)).status).toBe(200)
	})

	it('a token passes after the page loads a static file', async () => {
		const jar = createCookieJar()
		const token = await openSession(oracle, jar)
		await sendStack(oracle.url, { path: '/static/index.html' }, jar)
		expect((await sendStack(oracle.url, buildEchoRequest(token), jar)).status).toBe(200)
	})

	// With no session the CSRF battery runs on its own nonce, so each page load mints a token
	// apart from the last; the battery's nonce is the session these tokens belong to.
	it('with no session, the newest token passes (control)', async () => {
		const jar = createCookieJar()
		await openSession(stacks.anonymous, jar)
		const token = await openSession(stacks.anonymous, jar)
		expect((await sendStack(stacks.anonymous.url, buildEchoRequest(token), jar)).status).toBe(200)
	})

	it.fails('with no session, the first tab token passes after a second tab opens [red until M3]', async () => {
		const jar = createCookieJar()
		const first = await openSession(stacks.anonymous, jar)
		await openSession(stacks.anonymous, jar)
		expect((await sendStack(stacks.anonymous.url, buildEchoRequest(first), jar)).status).toBe(200)
	})

	it.fails('with no session, a token passes after the page loads a static file [red until M3]', async () => {
		const jar = createCookieJar()
		const token = await openSession(stacks.anonymous, jar)
		await sendStack(stacks.anonymous.url, { path: '/static/index.html' }, jar)
		expect((await sendStack(stacks.anonymous.url, buildEchoRequest(token), jar)).status).toBe(200)
	})
})

describe('invariant 7: security headers sit on redirects and on errors', () => {
	it('the bare GET /page route carries every declared security header (control)', async () => {
		const reply = await sendStack(oracle.url, { path: '/page' })
		expect(SECURITY_HEADERS.filter((name) => !reply.headers.has(name))).toEqual([])
	})

	for (const cell of listGreenCells(HEADER_CELLS))
		it(`${cell.title}`, async () => {
			const { observed, expected } = await readSecurityCell(oracle, cell)
			expect(observed).toEqual(expected)
		})

	for (const cell of listRedCells(HEADER_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			const { observed, expected } = await readSecurityCell(oracle, cell)
			expect(observed).toEqual(expected)
		})

	it('the bare GET /page route carries every declared security header in the canonical order (control)', async () => {
		const reply = await sendStack(stacks.orders.canonical.url, { path: '/page' })
		expect(SECURITY_HEADERS.filter((name) => !reply.headers.has(name))).toEqual([])
	})

	for (const cell of listGreenCells(CANONICAL_HEADER_CELLS))
		it(`${cell.title}`, async () => {
			const { observed, expected } = await readSecurityCell(stacks.orders.canonical, cell)
			expect(observed).toEqual(expected)
		})

	for (const cell of listRedCells(CANONICAL_HEADER_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			const { observed, expected } = await readSecurityCell(stacks.orders.canonical, cell)
			expect(observed).toEqual(expected)
		})
})

describe('invariant 8: no 206 is content-coded', () => {
	it('a full GET /static/large.txt is gzip-coded for a client that accepts gzip (control)', async () => {
		const reply = await sendStack(oracle.url, {
			path: '/static/large.txt',
			headers: { 'accept-encoding': 'gzip' },
		})
		expect({ status: reply.status, coding: reply.headers.get('content-encoding') }).toEqual({
			status: 200,
			coding: 'gzip',
		})
	})

	it('a ranged GET /static/large.txt for a client that accepts identity is a 206 (control)', async () => {
		const reply = await sendStack(oracle.url, {
			path: '/static/large.txt',
			headers: { range: STACK_RANGE, 'accept-encoding': 'identity' },
		})
		expect({ status: reply.status, coding: reply.headers.get('content-encoding') }).toEqual({
			status: 206,
			coding: null,
		})
	})

	for (const cell of listGreenCells(RANGE_CELLS))
		it(`${cell.title}`, async () => {
			expect(await readRangeCell(stacks, cell)).toEqual({ status: 206, coding: null })
		})

	for (const cell of listRedCells(RANGE_CELLS))
		it.fails(`${cell.title} [red until ${cell.closer}]`, async () => {
			expect(await readRangeCell(stacks, cell)).toEqual({ status: 206, coding: null })
		})
})

describe('invariant 9: a cookie-less request that writes nothing leaves the store unchanged', () => {
	it('a flood of cookie-less writing requests evicts a written session (control)', async () => {
		expect(await readFlood(stacks.capacity, '/mark')).toBe('none')
	})

	it.fails('a flood of cookie-less GET /page requests keeps a written session [red until M3]', async () => {
		expect(await readFlood(stacks.capacity, '/page')).toBe('lamp')
	})
})

describe('invariant 10: the body is byte-equal in every order the guide permits', () => {
	for (const arrangement of STACK_VARIANTS)
		for (const cell of BODY_CELLS)
			it(`${cell.title}, the ${arrangement} order against the oracle order`, async () => {
				const { variant, reference } = await readBodies(stacks, arrangement, cell)
				expect(variant).toEqual(reference)
			})
})
