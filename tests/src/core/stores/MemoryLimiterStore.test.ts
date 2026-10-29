import { createLimiter, createMemoryLimiterStore, MemoryLimiterStore } from '@src/core'
import { createRecorder } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { buildTestRequest, createTestContext } from '../../../setup.js'

describe('MemoryLimiterStore', () => {
	it('admits exactly the maximum under concurrent consumption', async () => {
		const store = createMemoryLimiterStore()
		const results = await Promise.all(
			Array.from({ length: 20 }, () => store.consume('key', 100, { max: 3, window: 50 })),
		)
		expect(results.filter((result) => result.admitted)).toHaveLength(3)
		expect(results.every((result) => result.resetAt === 150)).toBe(true)
	})

	it('retains active limits and takes the current maximum when a window resets', async () => {
		const store = new MemoryLimiterStore()
		expect(await store.consume('key', 0, { max: 1, window: 10 })).toEqual({
			admitted: true,
			resetAt: 10,
		})
		expect(await store.consume('key', 9, { max: 3, window: 20 })).toEqual({
			admitted: false,
			resetAt: 10,
		})
		const results = await Promise.all(
			Array.from({ length: 4 }, () => store.consume('key', 10, { max: 3, window: 20 })),
		)
		expect(results.map((result) => result.admitted)).toEqual([true, true, true, false])
		expect(results.every((result) => result.resetAt === 30)).toBe(true)
	})

	it('evicts the least recently consumed key and isolates eviction throws', async () => {
		const evictions = createRecorder<[string]>()
		const store = new MemoryLimiterStore({
			capacity: 2,
			evict: (key) => {
				evictions.handler(key)
				throw new Error('observer')
			},
		})
		const limits = { max: 1, window: 100 }
		await store.consume('a', 0, limits)
		await store.consume('b', 0, limits)
		await store.consume('a', 0, limits)
		expect((await store.consume('c', 0, limits)).admitted).toBe(true)
		expect(evictions.calls).toEqual([['b']])
		expect((await store.consume('b', 0, limits)).admitted).toBe(true)
		expect(evictions.calls).toEqual([['b'], ['a']])
	})

	it('refuses zero capacity and shares a supplied store across middleware instances', async () => {
		expect(() => new MemoryLimiterStore({ capacity: 0 })).toThrow(TypeError)
		const store = new MemoryLimiterStore()
		const first = createLimiter({ max: 1, window: 100, store, clock: () => 0 })
		const second = createLimiter({ max: 1, window: 100, store, clock: () => 0 })
		const request = buildTestRequest('/')
		const context = createTestContext(request, {})
		expect((await first(request, context, async () => new Response('ok'))).status).toBe(200)
		expect((await second(request, context, async () => new Response('ok'))).status).toBe(429)
	})
})
