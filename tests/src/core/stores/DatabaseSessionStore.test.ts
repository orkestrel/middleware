import { integerShape, jsonShape, stringShape } from '@orkestrel/contract'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import {
	DatabaseSessionStore,
	Session,
	createDatabaseSessionStore,
	createRestoredSession,
	isSession,
	sessionColumns,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// ============================================================================
//  @orkestrel/middleware — DatabaseSessionStore unit tests (§16 mirror). Every
//  scenario drives explicit `now` values against a real in-memory database
//  table (`createMemoryDriver`) — no mocks, zero wall-clock, zero timers. Uses
//  the shipped `isSession` guard throughout — an end-to-end proof of the
//  natural composition `createDatabaseSessionStore(table, isSession)`.
// ============================================================================

function buildStore(options?: { readonly ttl?: number; readonly lifetime?: number }) {
	const db = createDatabase({ driver: createMemoryDriver(), tables: { sessions: sessionColumns } })
	const table = db.table('sessions')
	const store = createDatabaseSessionStore(table, isSession, options)
	return { table, store }
}

describe('DatabaseSessionStore construction', () => {
	it('accepts no options, a bare ttl, a bare lifetime, or both', () => {
		const { table } = buildStore()
		const build = (options?: { readonly ttl?: number; readonly lifetime?: number }) =>
			new DatabaseSessionStore(table, isSession, createRestoredSession, options)
		expect(() => build()).not.toThrow()
		expect(() => build({ ttl: 1_000 })).not.toThrow()
		expect(() => build({ lifetime: 1_000 })).not.toThrow()
		expect(() => build({ ttl: 1_000, lifetime: 2_000 })).not.toThrow()
	})

	it('throws a TypeError when ttl is non-finite or not positive', () => {
		const { table } = buildStore()
		const build = (options: { readonly ttl: number }) =>
			new DatabaseSessionStore(table, isSession, createRestoredSession, options)
		expect(() => build({ ttl: Number.NaN })).toThrow(TypeError)
		expect(() => build({ ttl: Number.POSITIVE_INFINITY })).toThrow(TypeError)
		expect(() => build({ ttl: 0 })).toThrow(TypeError)
		expect(() => build({ ttl: -1 })).toThrow(TypeError)
	})

	it('throws a TypeError when lifetime is non-finite or not positive', () => {
		const { table } = buildStore()
		const build = (options: { readonly lifetime: number }) =>
			new DatabaseSessionStore(table, isSession, createRestoredSession, options)
		expect(() => build({ lifetime: Number.NaN })).toThrow(TypeError)
		expect(() => build({ lifetime: 0 })).toThrow(TypeError)
		expect(() => build({ lifetime: -1 })).toThrow(TypeError)
	})
})

describe('DatabaseSessionStore get/set', () => {
	it('resolves undefined for an id that was never set', async () => {
		const { store } = buildStore()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('round-trips a set session back through get, restoring id and state', async () => {
		const { store } = buildStore()
		const session = new Session('a')
		session.set('userId', 'u_1')
		await store.set(session, 0)
		const restored = await store.get('a', 0)
		expect(restored?.id).toBe('a')
		expect(restored?.state.get('userId')).toBe('u_1')
	})
})

describe('DatabaseSessionStore idle (ttl) eviction', () => {
	it('resolves the session right up to the boundary (exclusive)', async () => {
		const { store } = buildStore({ ttl: 1_000 })
		await store.set(new Session('a'), 0)
		expect(await store.get('a', 999)).not.toBeUndefined()
	})

	it('evicts exactly AT the idle boundary and removes the underlying row', async () => {
		const { table, store } = buildStore({ ttl: 1_000 })
		await store.set(new Session('a'), 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
		expect(await table.get('a')).toBeUndefined()
	})

	it('a live read touches seen, resetting the idle window', async () => {
		const { store } = buildStore({ ttl: 1_000 })
		await store.set(new Session('a'), 0)
		expect(await store.get('a', 900)).not.toBeUndefined()
		expect(await store.get('a', 1_800)).not.toBeUndefined()
	})
})

describe('DatabaseSessionStore absolute lifetime eviction', () => {
	it('evicts a continuously-touched session once its absolute lifetime elapses', async () => {
		const { store } = buildStore({ ttl: 1_000, lifetime: 250 })
		await store.set(new Session('a'), 0)
		expect(await store.get('a', 50)).not.toBeUndefined()
		expect(await store.get('a', 200)).not.toBeUndefined()
		expect(await store.get('a', 250)).toBeUndefined()
	})
})

describe('DatabaseSessionStore created stamping', () => {
	it('stamps created once at the first set and preserves it across a later re-set', async () => {
		const { table, store } = buildStore({ lifetime: 1_000 })
		await store.set(new Session('a'), 0)
		await store.set(new Session('a'), 500)
		const row = await table.get('a')
		expect(row?.created).toBe(0)
		expect(await store.get('a', 999)).not.toBeUndefined()
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('DatabaseSessionStore snapshot rebuild', () => {
	it('rebuilds a Session from a row the store never wrote itself', async () => {
		const { table, store } = buildStore()
		// The wire shape spelled out, so the proof does not re-derive the row
		// through the same `snapshotSession` the store writes it with.
		await table.set({
			id: 'a',
			session: { id: 'a', state: { userId: 'u_1' } },
			seen: 0,
			created: 0,
		})
		const restored = await store.get('a', 0)
		expect(restored).toBeInstanceOf(Session)
		expect(restored?.id).toBe('a')
		expect(restored?.state.get('userId')).toBe('u_1')
	})

	it('rebuilds through the step it was constructed with, not one of its own', async () => {
		const { table } = buildStore()
		// A rebuild step distinguishable from `createRestoredSession`: it marks
		// every session it produces, so a store using its own step fails here.
		const restore = (value: unknown): Session | undefined => {
			const session = createRestoredSession(value)
			session?.set('rebuilt', 'injected')
			return session
		}
		const store = new DatabaseSessionStore(table, isSession, restore)
		await table.set({ id: 'a', session: { id: 'a', state: {} }, seen: 0, created: 0 })
		const restored = await store.get('a', 0)
		expect(restored?.state.get('rebuilt')).toBe('injected')
	})
})

describe('DatabaseSessionStore guard rejection', () => {
	it('resolves undefined when the restored session fails the caller-supplied guard', async () => {
		const { table } = buildStore()
		// Stricter than `isSession`: also requires a specific state entry, so a
		// structurally-valid session that lacks it is still rejected.
		const isAuthorized = (value: unknown): value is Session =>
			isSession(value) && value.state.get('authorized') === true
		const strict = new DatabaseSessionStore(table, isAuthorized, createRestoredSession)
		await strict.set(new Session('a'), 0)
		expect(await strict.get('a', 0)).toBeUndefined()
	})
})

describe('DatabaseSessionStore delete', () => {
	it('deletes a present session so a later get resolves undefined', async () => {
		const { store } = buildStore()
		await store.set(new Session('a'), 0)
		await store.delete('a')
		expect(await store.get('a', 0)).toBeUndefined()
	})

	it('is a total no-op deleting an absent id (never throws)', async () => {
		const { store } = buildStore()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})
})

describe('DatabaseSessionStore earlier column names', () => {
	it('refuses a row declared under the earlier cursor columns instead of reading it as live', async () => {
		// A table declared before `lastSeen`/`createdAt` became `seen`/`created`,
		// written through the real database layer over a shared driver.
		const driver = createMemoryDriver()
		const earlier = createDatabase({
			driver,
			tables: {
				sessions: {
					id: stringShape(),
					session: jsonShape(),
					lastSeen: integerShape({ min: 0 }),
					createdAt: integerShape({ min: 0 }),
				},
			},
		})
		await earlier
			.table('sessions')
			.set({ id: 'a', session: { id: 'a', state: {} }, lastSeen: 0, createdAt: 0 })
		// The row really is in the driver under the earlier column names.
		expect(await driver.read('sessions', 'a')).toMatchObject({ lastSeen: 0, createdAt: 0 })

		// The same data opened under the current `sessionColumns`.
		const current = createDatabase({ driver, tables: { sessions: sessionColumns } })
		const table = current.table('sessions')
		const store = createDatabaseSessionStore(table, isSession, { ttl: 1_000 })
		// The table's own read guard refuses the row, so the store never reads a
		// missing `seen`/`created` into `sessionExpired`.
		expect(await table.get('a')).toBeUndefined()
		expect(await store.get('a', 10_000_000)).toBeUndefined()
		expect(await driver.read('sessions', 'a')).toMatchObject({ lastSeen: 0, createdAt: 0 })
	})
})
