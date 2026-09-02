import type {
	MemorySessionStoreOptions,
	SessionEntry,
	SessionInterface,
	SessionStoreInterface,
} from '../types.js'
import { DEFAULT_SESSION_CAPACITY } from '../constants.js'
import { sessionExpired, validateSessionLimits } from '../helpers.js'
import { isFiniteNumber, isFunction } from '@orkestrel/contract'

/**
 * The default in-process {@link SessionStoreInterface} — a `Map`-backed store
 * enforcing both an idle timeout and an absolute lifetime, with lazy
 * (read-time) eviction, a bounded capacity, and no background timers.
 *
 * @typeParam S - The stored session entity type
 *
 * @remarks
 * `get` evicts a session whose idle time (`now - seen >= ttl`) or
 * absolute lifetime (`now - created >= lifetime`) has elapsed — the
 * lifetime check fires EVEN IF the session was continuously touched, since
 * `created` is stamped once at the first `set` and preserved across every
 * later re-`set` of the same id. A live read touches `seen`. `delete` of
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
 * await store.set(new Session('abc'), Date.now())
 * ```
 */
export class MemorySessionStore<S extends SessionInterface> implements SessionStoreInterface<S> {
	readonly #entries: Map<string, SessionEntry<S>>
	readonly #ttl: number | undefined
	readonly #lifetime: number | undefined
	readonly #capacity: number
	readonly #evict: ((id: string) => void) | undefined

	constructor(options?: MemorySessionStoreOptions) {
		validateSessionLimits(options)
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
		this.#entries.set(id, { session: entry.session, seen: now, created: entry.created })
		return entry.session
	}

	async set(session: S, now: number): Promise<void> {
		const id = session.id
		const existing = this.#entries.get(id)
		if (existing === undefined) this.#reserve(now)
		const created = existing?.created ?? now
		this.#entries.delete(id)
		this.#entries.set(id, { session, seen: now, created })
	}

	async delete(id: string): Promise<void> {
		this.#entries.delete(id)
	}

	// Whether `entry` has aged past its idle timeout or absolute lifetime as of `now`.
	#expired(entry: SessionEntry<S>, now: number): boolean {
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
