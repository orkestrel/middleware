import type { MemorySessionStoreOptions, SessionStoreInterface } from '../types.js'
import { DEFAULT_SESSION_CAPACITY } from '../constants.js'
import { sessionExpired } from '../helpers.js'
import { isFiniteNumber, isFunction } from '@orkestrel/contract'

/**
 * The default in-process {@link SessionStoreInterface} — a `Map`-backed store
 * enforcing both an idle timeout and an absolute lifetime, with lazy
 * (read-time) eviction, a bounded capacity, and no background timers.
 *
 * @typeParam S - The session data payload type
 *
 * @remarks
 * `get` evicts a session whose idle time (`now - lastSeen >= ttl`) or
 * absolute lifetime (`now - createdAt >= lifetime`) has elapsed — the
 * lifetime check fires EVEN IF the session was continuously touched, since
 * `createdAt` is stamped once at the first `set` and preserved across every
 * later re-`set` of the same id. A live read touches `lastSeen`. `delete` of
 * an absent id is a no-op.
 *
 * Capacity is enforced as least-recently-used **by last write**: `set`
 * refreshes an id's recency (deleting then re-inserting so the Map's
 * iteration tail is the most-recently-written id). Inserting a brand-new id
 * once the store is at `capacity` first prunes expired entries; if the store
 * is still full, the least-recently-written id (the Map's head) is evicted.
 * `options.evict` — when provided — is invoked (throw-isolated) with the id
 * on every eviction the store's own policy performs (a capacity eviction or
 * an expired-entry prune), but never for an explicit `delete`.
 *
 * @example
 * ```ts
 * const store = new MemorySessionStore({ ttl: 60_000, lifetime: 3_600_000 })
 * await store.set('abc', { userId: 'u_1' }, Date.now())
 * ```
 */
export class MemorySessionStore<S> implements SessionStoreInterface<S> {
	readonly #entries: Map<string, { session: S; lastSeen: number; readonly createdAt: number }>
	readonly #ttl: number | undefined
	readonly #lifetime: number | undefined
	readonly #capacity: number
	readonly #evict: ((id: string) => void) | undefined

	constructor(options?: MemorySessionStoreOptions) {
		if (options?.ttl !== undefined && !isFiniteNumber(options.ttl))
			throw new TypeError(
				'MemorySessionStore requires options.ttl to be a finite number when provided',
			)
		if (options?.ttl !== undefined && options.ttl <= 0)
			throw new TypeError('MemorySessionStore requires options.ttl to be positive when provided')
		if (options?.lifetime !== undefined && !isFiniteNumber(options.lifetime))
			throw new TypeError(
				'MemorySessionStore requires options.lifetime to be a finite number when provided',
			)
		if (options?.lifetime !== undefined && options.lifetime <= 0)
			throw new TypeError(
				'MemorySessionStore requires options.lifetime to be positive when provided',
			)
		if (
			options?.capacity !== undefined &&
			(!isFiniteNumber(options.capacity) ||
				!Number.isInteger(options.capacity) ||
				options.capacity <= 0)
		)
			throw new TypeError(
				'MemorySessionStore requires options.capacity to be a positive integer when provided',
			)
		if (options?.evict !== undefined && !isFunction(options.evict))
			throw new TypeError(
				'MemorySessionStore requires options.evict to be a function when provided',
			)
		this.#entries = new Map()
		this.#ttl = options?.ttl
		this.#lifetime = options?.lifetime
		this.#capacity = options?.capacity ?? DEFAULT_SESSION_CAPACITY
		this.#evict = options?.evict
	}

	async get(id: string, now: number): Promise<S | undefined> {
		const entry = this.#entries.get(id)
		if (entry === undefined) return undefined
		if (this.#expired(entry, now)) {
			this.#entries.delete(id)
			this.#notify(id)
			return undefined
		}
		entry.lastSeen = now
		return entry.session
	}

	async set(id: string, session: S, now: number): Promise<void> {
		const existing = this.#entries.get(id)
		if (existing === undefined) this.#reserve(now)
		const createdAt = existing?.createdAt ?? now
		this.#entries.delete(id)
		this.#entries.set(id, { session, lastSeen: now, createdAt })
	}

	async delete(id: string): Promise<void> {
		this.#entries.delete(id)
	}

	// Whether `entry` has aged past its idle timeout or absolute lifetime as of `now`.
	#expired(
		entry: { session: S; lastSeen: number; readonly createdAt: number },
		now: number,
	): boolean {
		return sessionExpired(entry, now, { ttl: this.#ttl, lifetime: this.#lifetime })
	}

	// Makes room for a brand-new id: prunes expired entries, then evicts the
	// least-recently-written id if the store is still at capacity.
	#reserve(now: number): void {
		if (this.#entries.size < this.#capacity) return
		for (const [id, entry] of this.#entries) {
			if (this.#expired(entry, now)) {
				this.#entries.delete(id)
				this.#notify(id)
			}
		}
		if (this.#entries.size >= this.#capacity) {
			const oldest = this.#entries.keys().next().value
			if (oldest !== undefined) {
				this.#entries.delete(oldest)
				this.#notify(oldest)
			}
		}
	}

	// Invokes the configured evict callback, throw-isolated.
	#notify(id: string): void {
		if (this.#evict === undefined) return
		try {
			this.#evict(id)
		} catch {
			// swallowed — a broken evict callback can never affect the store
		}
	}
}
