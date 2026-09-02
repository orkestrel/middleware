import type { MemorySessionStoreOptions, Session } from '@src/core'
import { DEFAULT_SESSION_CAPACITY, MemorySessionStore } from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildSession } from '../../../setup.js'

// ============================================================================
//  @orkestrel/middleware — MemorySessionStore unit tests (§16 mirror). Every
//  scenario drives explicit `now` values — zero wall-clock, zero timers.
// ============================================================================

describe('MemorySessionStore construction', () => {
	it('accepts no options, a bare ttl, a bare lifetime, or both', () => {
		expect(() => new MemorySessionStore()).not.toThrow()
		expect(() => new MemorySessionStore({ ttl: 1_000 })).not.toThrow()
		expect(() => new MemorySessionStore({ lifetime: 1_000 })).not.toThrow()
		expect(() => new MemorySessionStore({ ttl: 1_000, lifetime: 2_000 })).not.toThrow()
	})

	it('throws a TypeError when ttl is non-finite', () => {
		expect(() => new MemorySessionStore({ ttl: Number.NaN })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ ttl: Number.POSITIVE_INFINITY })).toThrow(TypeError)
	})

	it('throws a TypeError when ttl is not positive', () => {
		expect(() => new MemorySessionStore({ ttl: 0 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ ttl: -1 })).toThrow(TypeError)
	})

	it('throws a TypeError when lifetime is non-finite or not positive', () => {
		expect(() => new MemorySessionStore({ lifetime: Number.NaN })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ lifetime: 0 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ lifetime: -1 })).toThrow(TypeError)
	})

	it('throws a TypeError when evict is provided but not a function', () => {
		// JSON.parse yields a structurally-invalid options bag (evict is a
		// string, not a function) without resorting to `as`/`any`/`!`.
		const invalid: MemorySessionStoreOptions = JSON.parse('{"evict":"not-a-function"}')
		expect(() => new MemorySessionStore(invalid)).toThrow(TypeError)
	})
})

describe('MemorySessionStore get/set', () => {
	it('resolves undefined for an id that was never set', async () => {
		const store = new MemorySessionStore<Session>()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('round-trips a set session back through get', async () => {
		const store = new MemorySessionStore<Session>()
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 0))?.id).toBe('a')
	})

	it('a later set replaces the session payload for the same id', async () => {
		const store = new MemorySessionStore<Session>()
		await store.set(buildSession('a', 'first'), 0)
		await store.set(buildSession('a', 'second'), 100)
		expect((await store.get('a', 100))?.state.get('mark')).toBe('second')
	})
})

describe('MemorySessionStore idle (ttl) eviction', () => {
	it('resolves the session right up to the boundary (exclusive)', async () => {
		const store = new MemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 999))?.id).toBe('a')
	})

	it('evicts exactly AT the idle boundary (now - seen >= ttl)', async () => {
		const store = new MemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
	})

	it('a live read touches seen, resetting the idle window', async () => {
		const store = new MemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 900))?.id).toBe('a')
		expect((await store.get('a', 1_800))?.id).toBe('a')
	})

	it('evicting an idle-expired session removes it permanently', async () => {
		const store = new MemorySessionStore<Session>({ ttl: 1_000 })
		await store.set(buildSession('a'), 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore absolute lifetime eviction', () => {
	it('evicts a continuously-touched session once its absolute lifetime elapses', async () => {
		const store = new MemorySessionStore<Session>({ ttl: 1_000, lifetime: 250 })
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 50))?.id).toBe('a')
		expect((await store.get('a', 100))?.id).toBe('a')
		expect((await store.get('a', 200))?.id).toBe('a')
		expect(await store.get('a', 250)).toBeUndefined()
	})

	it('evicts exactly AT the lifetime boundary (now - created >= lifetime)', async () => {
		const store = new MemorySessionStore<Session>({ lifetime: 1_000 })
		await store.set(buildSession('a'), 0)
		expect((await store.get('a', 999))?.id).toBe('a')
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore created stamping', () => {
	it('stamps created once at the first set and preserves it across a later re-set', async () => {
		const store = new MemorySessionStore<Session>({ lifetime: 1_000 })
		await store.set(buildSession('a', 'first'), 0)
		await store.set(buildSession('a', 'second'), 500)
		expect((await store.get('a', 999))?.state.get('mark')).toBe('second')
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore capacity', () => {
	it('defaults to DEFAULT_SESSION_CAPACITY and evicts the oldest-written entry once exceeded', async () => {
		const store = new MemorySessionStore<Session>()
		for (let index = 0; index < DEFAULT_SESSION_CAPACITY; index += 1)
			await store.set(buildSession(`id-${index}`), 0)
		expect((await store.get('id-0', 0))?.id).toBe('id-0')
		await store.set(buildSession('overflow'), 0)
		expect(await store.get('id-0', 0)).toBeUndefined()
		expect((await store.get('overflow', 0))?.id).toBe('overflow')
	})

	it('keeps size at or below an explicit capacity when inserting capacity+1 distinct never-read ids', async () => {
		const store = new MemorySessionStore<Session>({ capacity: 5 })
		for (let index = 0; index < 6; index += 1) await store.set(buildSession(`id-${index}`), 0)
		let alive = 0
		for (let index = 0; index < 6; index += 1)
			if ((await store.get(`id-${index}`, 0)) !== undefined) alive += 1
		expect(alive).toBeLessThanOrEqual(5)
	})

	it('evicts the least-recently-WRITTEN id, not the least-recently-inserted', async () => {
		const store = new MemorySessionStore<Session>({ capacity: 2 })
		await store.set(buildSession('a', '1'), 0)
		await store.set(buildSession('b', '2'), 0)
		// Touch 'a' again — refreshes its write recency, making 'b' the oldest.
		await store.set(buildSession('a', '1-touched'), 0)
		// Inserting a brand-new id exceeds capacity — evicts the least-recently-written, 'b'.
		await store.set(buildSession('c', '3'), 0)
		expect(await store.get('b', 0)).toBeUndefined()
		expect((await store.get('a', 0))?.state.get('mark')).toBe('1-touched')
		expect((await store.get('c', 0))?.state.get('mark')).toBe('3')
	})

	it('invokes evict with the evicted id on a capacity eviction', async () => {
		const evicted: string[] = []
		const store = new MemorySessionStore<Session>({ capacity: 1, evict: (id) => evicted.push(id) })
		await store.set(buildSession('a', '1'), 0)
		await store.set(buildSession('b', '2'), 0)
		expect(evicted).toEqual(['a'])
	})

	it('swallows a throwing evict callback without affecting the store', async () => {
		const store = new MemorySessionStore<Session>({
			capacity: 1,
			evict: () => {
				throw new Error('evict callback is broken')
			},
		})
		await store.set(buildSession('a', '1'), 0)
		await expect(store.set(buildSession('b', '2'), 0)).resolves.toBeUndefined()
		expect((await store.get('b', 0))?.state.get('mark')).toBe('2')
	})

	it('throws a TypeError for capacity 0, negative, or non-integer', () => {
		expect(() => new MemorySessionStore({ capacity: 0 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ capacity: -1 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ capacity: 1.5 })).toThrow(TypeError)
	})
})

describe('MemorySessionStore delete', () => {
	it('deletes a present session so a later get resolves undefined', async () => {
		const store = new MemorySessionStore<Session>()
		await store.set(buildSession('a'), 0)
		await store.delete('a')
		expect(await store.get('a', 0)).toBeUndefined()
	})

	it('is a total no-op deleting an absent id (never throws)', async () => {
		const store = new MemorySessionStore<Session>()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})
})
