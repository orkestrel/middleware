import type {
	LimiterEntry,
	LimiterLimits,
	LimiterResult,
	LimiterStoreInterface,
	MemoryLimiterStoreOptions,
} from '../types.js'
import { createBudget } from '@orkestrel/budget'
import { DEFAULT_LIMITER_CAPACITY } from '../constants.js'
import { MEMORY_LIMITER_STORE_CONTRACT } from '../contracts.js'
import { admitOptions } from '../helpers.js'

/**
 * Stores fixed-window budgets with atomic admission and bounded LRU retention.
 * @remarks
 * A fresh window takes the current max and duration. Active windows retain their budget.
 * Eviction callbacks are isolated from the admission decision.
 */
export class MemoryLimiterStore implements LimiterStoreInterface {
	readonly #entries = new Map<string, LimiterEntry>()
	readonly #capacity: number
	readonly #evict: ((key: string) => void) | undefined

	constructor(options?: MemoryLimiterStoreOptions) {
		admitOptions('MemoryLimiterStore', MEMORY_LIMITER_STORE_CONTRACT, options)
		this.#capacity = options?.capacity ?? DEFAULT_LIMITER_CAPACITY
		this.#evict = options?.evict
	}

	/** Atomically admits and consumes a request against its key's current window. */
	async consume(key: string, now: number, limits: LimiterLimits): Promise<LimiterResult> {
		const current = this.#entries.get(key)
		if (current === undefined && this.#entries.size >= this.#capacity) {
			const oldest = this.#entries.keys().next().value
			if (oldest !== undefined) {
				this.#entries.delete(oldest)
				try {
					this.#evict?.(oldest)
				} catch {
					// An observer cannot prevent admission.
				}
			}
		}
		const entry =
			current === undefined || now >= current.expiry
				? {
						budget: createBudget<number>({ max: limits.max, consumer: Number }),
						expiry: now + limits.window,
					}
				: current
		this.#entries.delete(key)
		this.#entries.set(key, entry)
		const admitted = !entry.budget.exhausted
		if (admitted) entry.budget.consume(1)
		return { admitted, expiry: entry.expiry }
	}
}
