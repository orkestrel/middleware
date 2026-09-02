import type {
	SessionInterface,
	SessionLimits,
	SessionRow,
	SessionStoreInterface,
} from '../types.js'
import type { Guard } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { sessionExpired, snapshotSession, validateSessionLimits } from '../helpers.js'
import { createRestoredSession } from '../factories.js'
import type { Session } from '../Session.js'

/**
 * A durable {@link SessionStoreInterface} over an `@orkestrel/database`
 * table — the same idle-timeout + absolute-lifetime contract as
 * {@link MemorySessionStore}, backed by a caller-supplied `TableInterface`
 * instead of an in-process `Map`.
 *
 * @typeParam S - The stored session entity type
 *
 * @remarks
 * `get` reads the row, evicts (removes the row) once `sessionExpired`
 * reports either threshold elapsed, then rebuilds the session via
 * {@link createRestoredSession} — a malformed snapshot or one that fails the
 * caller's guard resolves `undefined` rather than throwing. A live read
 * touches `seen`. `set` preserves an existing row's `created` across a
 * re-`set` of the same id (stamped once at the first `set`), mirroring
 * {@link MemorySessionStore}. `delete` of an absent id is a no-op (the
 * table's `remove` contract).
 *
 * A malformed-snapshot or failed-guard `undefined` LEAVES the row in place —
 * unlike the expired path, which removes it. This is deliberate: a
 * caller-contextual guard may reject a session that is still perfectly
 * valid for another flow reading the same table (a differently-shaped `S`,
 * a stricter guard mid-rollout), so `get` never destroys data on a guard
 * miss. A row that no caller's guard ever accepts again self-heals once its
 * `ttl`/`lifetime` elapses on a later `get`.
 *
 * @example
 * ```ts
 * const store = new DatabaseSessionStore(table, isSession, { ttl: 60_000 })
 * await store.set(new Session('abc'), Date.now())
 * ```
 */
export class DatabaseSessionStore<
	S extends SessionInterface = Session,
> implements SessionStoreInterface<S> {
	readonly #table: TableInterface<SessionRow>
	readonly #guard: Guard<S>
	readonly #ttl: number | undefined
	readonly #lifetime: number | undefined

	constructor(table: TableInterface<SessionRow>, guard: Guard<S>, options?: SessionLimits) {
		validateSessionLimits(options)
		this.#table = table
		this.#guard = guard
		this.#ttl = options?.ttl
		this.#lifetime = options?.lifetime
	}

	async get(id: string, now: number): Promise<S | undefined> {
		const row = await this.#table.get(id)
		if (row === undefined) return undefined
		if (sessionExpired(row, now, { ttl: this.#ttl, lifetime: this.#lifetime })) {
			await this.#table.remove(id)
			return undefined
		}
		const session = createRestoredSession(row.session)
		if (session === undefined || !this.#guard(session)) return undefined
		await this.#table.update(id, { seen: now })
		return session
	}

	async set(session: S, now: number): Promise<void> {
		const id = session.id
		const existing = await this.#table.get(id)
		const created = existing?.created ?? now
		await this.#table.set({ id, session: snapshotSession(session), seen: now, created })
	}

	async delete(id: string): Promise<void> {
		await this.#table.remove(id)
	}
}
