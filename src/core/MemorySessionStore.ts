import type { MemorySessionStoreOptions, SessionStoreInterface } from './types.js'
import { isFiniteNumber } from '@orkestrel/contract'

/**
 * The default in-process {@link SessionStoreInterface} — a `Map`-backed store
 * enforcing both an idle timeout and an absolute lifetime, with lazy
 * (read-time) eviction and no background timers.
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
		this.#entries = new Map()
		this.#ttl = options?.ttl
		this.#lifetime = options?.lifetime
	}

	async get(id: string, now: number): Promise<S | undefined> {
		const entry = this.#entries.get(id)
		if (entry === undefined) return undefined
		if (this.#expired(entry, now)) {
			this.#entries.delete(id)
			return undefined
		}
		entry.lastSeen = now
		return entry.session
	}

	async set(id: string, session: S, now: number): Promise<void> {
		const existing = this.#entries.get(id)
		const createdAt = existing?.createdAt ?? now
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
		if (this.#ttl !== undefined && now - entry.lastSeen >= this.#ttl) return true
		if (this.#lifetime !== undefined && now - entry.createdAt >= this.#lifetime) return true
		return false
	}
}
