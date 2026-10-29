import type { AssetRecord, AssetStoreInterface } from '../types.js'

/** Stores asset representations by key for the lifetime of the store. */
export class MemoryAssetStore implements AssetStoreInterface {
	readonly #entries = new Map<string, AssetRecord>()

	/** Reads a cached asset without changing its representations. */
	async get(key: string): Promise<AssetRecord | undefined> {
		return this.#entries.get(key)
	}

	/** Stores a record under its own asset key. */
	async set(record: AssetRecord): Promise<void> {
		this.#entries.set(record.key, record)
	}

	/** Removes the key if present. */
	async delete(key: string): Promise<void> {
		this.#entries.delete(key)
	}
}
