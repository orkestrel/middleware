import type { AssetStoreInterface } from './types.js'
import { MemoryAssetStore } from './stores/MemoryAssetStore.js'

/**
 * Creates an in-memory asset representation store.
 * @returns A store retaining records until they are replaced or deleted.
 */
export function createMemoryAssetStore(): AssetStoreInterface {
	return new MemoryAssetStore()
}
