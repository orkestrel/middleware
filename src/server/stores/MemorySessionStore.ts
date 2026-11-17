import type {
	MemorySessionStoreOptions,
	SessionEntry,
	SessionInterface,
	SessionStoreInterface,
} from '../types.js'
import { DEFAULT_SESSION_CAPACITY } from '../constants.js'
import { MEMORY_SESSION_STORE_CONTRACT } from '../contracts.js'
import { admitOptions, sessionExpired } from '../helpers.js'

/**
 * Implements the default in-process {@link SessionStoreInterface} — a `Map`-backed store
 * enforcing both an idle timeout and an absolute lifetime, with lazy
 * (read-time) eviction, a bounded capacity, and no background timers.
 *
 * @typeParam S - The stored session entity type
 *
 * @remarks
 * `get` evicts a session whose idle time (`now - seen >= ttl`) or
 * absolute lifetime (`now - created >= lifetime`) has elapsed — the
 * lifetime check fires even if the session was continuously touched, because
 * `created` is stamped once at the first `set` and preserved across every
 * later re-`set` of the same id. A live read touches `seen`. `delete` of
 * an absent id is a no-op.
 *
 * Capacity is enforced as least-recently-used: a `set` and a live `get` each
 * refresh an id's recency (each write takes the next number from a counter, and the
 * lowest number held is the least recently used id). Inserting a brand-new id once the store
 * is at `capacity` evicts the least recently used id, in time that does not grow with
 * the store's size and without retaining heap per read; an expired entry leaves at its own
 * `get` or when it is the least recently used. `options.evict` — when provided — is
 * invoked (throw-isolated) with the id on every eviction the store's own
 * policy performs (a capacity eviction or an expired read), but never for an
 * explicit `delete`.
 *
 * @throws {ContractError} When the constructor refuses its options bag whole: an undeclared key, a `ttl` or `lifetime` that is not a positive finite number, a `capacity` that is not an integer of at least 1, or an `evict` that is not a function
 *
 * @example
 * ```ts
 * const store = new MemorySessionStore({ ttl: 60_000, lifetime: 3_600_000 })
 * await store.set(new Session('abc'), Date.now())
 * ```
 */
export class MemorySessionStore<S extends SessionInterface> implements SessionStoreInterface<S> {
	readonly #entries = new Map<string, SessionEntry<S> & { readonly tick: number }>()
	readonly #order = new Map<number, string>()
	readonly #ttl: number | undefined
	readonly #lifetime: number | undefined
	readonly #capacity: number
	readonly #evict: ((id: string) => void) | undefined
	#tick = 0
	#floor = 0

	constructor(options?: MemorySessionStoreOptions) {
		admitOptions('MemorySessionStore', MEMORY_SESSION_STORE_CONTRACT, options)
		this.#ttl = options?.ttl
		this.#lifetime = options?.lifetime
		this.#capacity = options?.capacity ?? DEFAULT_SESSION_CAPACITY
		this.#evict = options?.evict
	}

	async get(id: string, now: number): Promise<S | undefined> {
		const entry = this.#entries.get(id)
		if (entry === undefined) return undefined
		if (this.#expired(entry, now)) {
			this.#remove(id, entry.tick)
			this.#notify(id)
			return undefined
		}
		this.#place(id, entry.session, now, entry.created, entry.tick)
		return entry.session
	}

	async set(session: S, now: number): Promise<void> {
		const id = session.id
		if (!this.#entries.has(id)) this.#reserve()
		// An evict callback can write this id during `#reserve`, so read the entry after it.
		const existing = this.#entries.get(id)
		this.#place(id, session, now, existing?.created ?? now, existing?.tick)
	}

	async delete(id: string): Promise<void> {
		const entry = this.#entries.get(id)
		if (entry !== undefined) this.#remove(id, entry.tick)
	}

	// Whether `entry` has aged past its idle timeout or absolute lifetime as of `now`.
	#expired(entry: SessionEntry<S>, now: number): boolean {
		return sessionExpired(entry, now, {
			...(this.#ttl === undefined ? {} : { ttl: this.#ttl }),
			...(this.#lifetime === undefined ? {} : { lifetime: this.#lifetime }),
		})
	}

	// Stores `id` under the next tick, the most recent, and drops the tick it held before.
	#place(
		id: string,
		session: S,
		seen: number,
		created: number,
		previous: number | undefined,
	): void {
		if (previous !== undefined) this.#order.delete(previous)
		const tick = this.#tick
		this.#tick = tick + 1
		this.#order.set(tick, id)
		this.#entries.set(id, { session, seen, created, tick })
	}

	// Drops `id` and its tick together, so the two maps never disagree.
	#remove(id: string, tick: number): void {
		this.#entries.delete(id)
		this.#order.delete(tick)
	}

	// Makes room for a brand-new id at capacity by evicting the least recently used id, the
	// lowest live tick. The cursor crosses each tick once, so no eviction revisits an earlier one.
	#reserve(): void {
		if (this.#entries.size < this.#capacity) return
		while (!this.#order.has(this.#floor)) this.#floor += 1
		const oldest = this.#order.get(this.#floor)
		if (oldest === undefined) return
		this.#remove(oldest, this.#floor)
		this.#notify(oldest)
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
