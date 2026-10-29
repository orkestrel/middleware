import { createMemoryAssetStore, MemoryAssetStore } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('MemoryAssetStore', () => {
	it('stores replaces and deletes records under their own keys', async () => {
		const store = createMemoryAssetStore()
		const record = { key: 'a', identity: new Uint8Array([1]), brotli: undefined, etag: 'one' }
		expect(await store.get('a')).toBeUndefined()
		await store.set(record)
		expect(await store.get('a')).toBe(record)
		const replacement = { ...record, etag: 'two' }
		await store.set(replacement)
		expect(await store.get('a')).toBe(replacement)
		await store.delete('a')
		await store.delete('a')
		expect(await store.get('a')).toBeUndefined()
	})

	it('keeps separate store instances independent', async () => {
		const first = new MemoryAssetStore()
		const second = new MemoryAssetStore()
		await first.set({ key: 'a', identity: new Uint8Array([1]), brotli: undefined, etag: 'one' })
		expect(await second.get('a')).toBeUndefined()
	})
})
