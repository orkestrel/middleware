import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import {
	DatabaseSessionStore,
	Session,
	createDatabaseSessionStore,
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

describe('DatabaseSessionStore get/set', () => {
	it('resolves undefined for an id that was never set', async () => {
		const { store } = buildStore()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('round-trips a set session back through get, restoring id and data', async () => {
		const { store } = buildStore()
		const session = new Session('a')
		session.data.set('userId', 'u_1')
		await store.set('a', session, 0)
		const restored = await store.get('a', 0)
		expect(restored?.id).toBe('a')
		expect(restored?.data.get('userId')).toBe('u_1')
	})
})

describe('DatabaseSessionStore idle (ttl) eviction', () => {
	it('resolves the session right up to the boundary (exclusive)', async () => {
		const { store } = buildStore({ ttl: 1_000 })
		await store.set('a', new Session('a'), 0)
		expect(await store.get('a', 999)).not.toBeUndefined()
	})

	it('evicts exactly AT the idle boundary and removes the underlying row', async () => {
		const { table, store } = buildStore({ ttl: 1_000 })
		await store.set('a', new Session('a'), 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
		expect(await table.get('a')).toBeUndefined()
	})

	it('a live read touches lastSeen, resetting the idle window', async () => {
		const { store } = buildStore({ ttl: 1_000 })
		await store.set('a', new Session('a'), 0)
		expect(await store.get('a', 900)).not.toBeUndefined()
		expect(await store.get('a', 1_800)).not.toBeUndefined()
	})
})

describe('DatabaseSessionStore absolute lifetime eviction', () => {
	it('evicts a continuously-touched session once its absolute lifetime elapses', async () => {
		const { store } = buildStore({ ttl: 1_000, lifetime: 250 })
		await store.set('a', new Session('a'), 0)
		expect(await store.get('a', 50)).not.toBeUndefined()
		expect(await store.get('a', 200)).not.toBeUndefined()
		expect(await store.get('a', 250)).toBeUndefined()
	})
})

describe('DatabaseSessionStore createdAt stamping', () => {
	it('stamps createdAt once at the first set and preserves it across a later re-set', async () => {
		const { table, store } = buildStore({ lifetime: 1_000 })
		await store.set('a', new Session('a'), 0)
		await store.set('a', new Session('a'), 500)
		const row = await table.get('a')
		expect(row?.createdAt).toBe(0)
		expect(await store.get('a', 999)).not.toBeUndefined()
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('DatabaseSessionStore guard rejection', () => {
	it('resolves undefined when the restored session fails the caller-supplied guard', async () => {
		const { table } = buildStore()
		// Stricter than `isSession`: also requires a specific data entry, so a
		// structurally-valid session that lacks it is still rejected.
		const isAuthorized = (value: unknown): value is Session =>
			isSession(value) && value.data.get('authorized') === true
		const strict = new DatabaseSessionStore(table, isAuthorized)
		await strict.set('a', new Session('a'), 0)
		expect(await strict.get('a', 0)).toBeUndefined()
	})
})

describe('DatabaseSessionStore delete', () => {
	it('deletes a present session so a later get resolves undefined', async () => {
		const { store } = buildStore()
		await store.set('a', new Session('a'), 0)
		await store.delete('a')
		expect(await store.get('a', 0)).toBeUndefined()
	})

	it('is a total no-op deleting an absent id (never throws)', async () => {
		const { store } = buildStore()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})
})
