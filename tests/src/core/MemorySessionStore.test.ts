import type { MemorySessionStoreOptions } from '@src/core'
import { DEFAULT_SESSION_CAPACITY, MemorySessionStore } from '@src/core'
import { describe, expect, it } from 'vitest'

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
		const store = new MemorySessionStore<string>()
		expect(await store.get('missing', 0)).toBeUndefined()
	})

	it('round-trips a set session back through get', async () => {
		const store = new MemorySessionStore<string>()
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 0)).toBe('payload')
	})

	it('a later set replaces the session payload for the same id', async () => {
		const store = new MemorySessionStore<string>()
		await store.set('a', 'first', 0)
		await store.set('a', 'second', 100)
		expect(await store.get('a', 100)).toBe('second')
	})
})

describe('MemorySessionStore idle (ttl) eviction', () => {
	it('resolves the session right up to the boundary (exclusive)', async () => {
		const store = new MemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 999)).toBe('payload')
	})

	it('evicts exactly AT the idle boundary (now - lastSeen >= ttl)', async () => {
		const store = new MemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
	})

	it('a live read touches lastSeen, resetting the idle window', async () => {
		const store = new MemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 900)).toBe('payload')
		expect(await store.get('a', 1_800)).toBe('payload')
	})

	it('evicting an idle-expired session removes it permanently', async () => {
		const store = new MemorySessionStore<string>({ ttl: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 1_000)).toBeUndefined()
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore absolute lifetime eviction', () => {
	it('evicts a continuously-touched session once its absolute lifetime elapses', async () => {
		const store = new MemorySessionStore<string>({ ttl: 1_000, lifetime: 250 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 50)).toBe('payload')
		expect(await store.get('a', 100)).toBe('payload')
		expect(await store.get('a', 200)).toBe('payload')
		expect(await store.get('a', 250)).toBeUndefined()
	})

	it('evicts exactly AT the lifetime boundary (now - createdAt >= lifetime)', async () => {
		const store = new MemorySessionStore<string>({ lifetime: 1_000 })
		await store.set('a', 'payload', 0)
		expect(await store.get('a', 999)).toBe('payload')
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore createdAt stamping', () => {
	it('stamps createdAt once at the first set and preserves it across a later re-set', async () => {
		const store = new MemorySessionStore<string>({ lifetime: 1_000 })
		await store.set('a', 'first', 0)
		await store.set('a', 'second', 500)
		expect(await store.get('a', 999)).toBe('second')
		expect(await store.get('a', 1_000)).toBeUndefined()
	})
})

describe('MemorySessionStore capacity', () => {
	it('defaults to DEFAULT_SESSION_CAPACITY and evicts the oldest-written entry once exceeded', async () => {
		const store = new MemorySessionStore<string>()
		for (let index = 0; index < DEFAULT_SESSION_CAPACITY; index += 1)
			await store.set(`id-${index}`, 'payload', 0)
		expect(await store.get('id-0', 0)).toBe('payload')
		await store.set('overflow', 'payload', 0)
		expect(await store.get('id-0', 0)).toBeUndefined()
		expect(await store.get('overflow', 0)).toBe('payload')
	})

	it('keeps size at or below an explicit capacity when inserting capacity+1 distinct never-read ids', async () => {
		const store = new MemorySessionStore<string>({ capacity: 5 })
		for (let index = 0; index < 6; index += 1) await store.set(`id-${index}`, 'payload', 0)
		let alive = 0
		for (let index = 0; index < 6; index += 1)
			if ((await store.get(`id-${index}`, 0)) !== undefined) alive += 1
		expect(alive).toBeLessThanOrEqual(5)
	})

	it('evicts the least-recently-WRITTEN id, not the least-recently-inserted', async () => {
		const store = new MemorySessionStore<string>({ capacity: 2 })
		await store.set('a', '1', 0)
		await store.set('b', '2', 0)
		// Touch 'a' again — refreshes its write recency, making 'b' the oldest.
		await store.set('a', '1-touched', 0)
		// Inserting a brand-new id exceeds capacity — evicts the least-recently-written, 'b'.
		await store.set('c', '3', 0)
		expect(await store.get('b', 0)).toBeUndefined()
		expect(await store.get('a', 0)).toBe('1-touched')
		expect(await store.get('c', 0)).toBe('3')
	})

	it('invokes evict with the evicted id on a capacity eviction', async () => {
		const evicted: string[] = []
		const store = new MemorySessionStore<string>({ capacity: 1, evict: (id) => evicted.push(id) })
		await store.set('a', '1', 0)
		await store.set('b', '2', 0)
		expect(evicted).toEqual(['a'])
	})

	it('swallows a throwing evict callback without affecting the store', async () => {
		const store = new MemorySessionStore<string>({
			capacity: 1,
			evict: () => {
				throw new Error('evict callback is broken')
			},
		})
		await store.set('a', '1', 0)
		await expect(store.set('b', '2', 0)).resolves.toBeUndefined()
		expect(await store.get('b', 0)).toBe('2')
	})

	it('throws a TypeError for capacity 0, negative, or non-integer', () => {
		expect(() => new MemorySessionStore({ capacity: 0 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ capacity: -1 })).toThrow(TypeError)
		expect(() => new MemorySessionStore({ capacity: 1.5 })).toThrow(TypeError)
	})
})

describe('MemorySessionStore delete', () => {
	it('deletes a present session so a later get resolves undefined', async () => {
		const store = new MemorySessionStore<string>()
		await store.set('a', 'payload', 0)
		await store.delete('a')
		expect(await store.get('a', 0)).toBeUndefined()
	})

	it('is a total no-op deleting an absent id (never throws)', async () => {
		const store = new MemorySessionStore<string>()
		await expect(store.delete('missing')).resolves.toBeUndefined()
	})
})
