import type { SessionInterface, SessionStoreInterface } from './types.js'
import type { Guard } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { restoreSession, sessionExpired, snapshotSession } from './helpers.js'
import { Session } from './Session.js'

/**
 * One persisted session row — an opaque snapshot column plus the store-owned
 * idle/absolute-lifetime cursors, the shape a {@link DatabaseSessionStore}'s
 * backing table holds.
 */
export interface SessionRow {
	readonly id: string
	readonly session: unknown
	readonly lastSeen: number
	readonly createdAt: number
}

/**
 * A durable {@link SessionStoreInterface} over an `@orkestrel/database`
 * table — the same idle-timeout + absolute-lifetime contract as
 * {@link MemorySessionStore}, backed by a caller-supplied `TableInterface`
 * instead of an in-process `Map`.
 *
 * @typeParam S - The session data payload type
 *
 * @remarks
 * `get` reads the row, evicts (removes the row) once `sessionExpired`
 * reports either threshold elapsed, then rebuilds the session via
 * {@link restoreSession} — a malformed snapshot or one that fails the
 * caller's `is` guard resolves `undefined` rather than throwing. A live read
 * touches `lastSeen`. `set` preserves an existing row's `createdAt` across a
 * re-`set` of the same id (stamped once at the first `set`), mirroring
 * {@link MemorySessionStore}. `delete` of an absent id is a no-op (the
 * table's `remove` contract).
 *
 * @example
 * ```ts
 * const store = new DatabaseSessionStore(table, isSession, { ttl: 60_000 })
 * await store.set('abc', new Session('abc'), Date.now())
 * ```
 */
export class DatabaseSessionStore<
	S extends SessionInterface = Session,
> implements SessionStoreInterface<S> {
	readonly #table: TableInterface<SessionRow>
	readonly #is: Guard<S>
	readonly #ttl: number | undefined
	readonly #lifetime: number | undefined

	constructor(
		table: TableInterface<SessionRow>,
		is: Guard<S>,
		options?: { readonly ttl?: number; readonly lifetime?: number },
	) {
		this.#table = table
		this.#is = is
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
		const session = restoreSession(row.session)
		if (session === undefined || !this.#is(session)) return undefined
		await this.#table.update(id, { lastSeen: now })
		return session
	}

	async set(id: string, session: S, now: number): Promise<void> {
		const existing = await this.#table.get(id)
		const createdAt = existing?.createdAt ?? now
		await this.#table.set({ id, session: snapshotSession(session), lastSeen: now, createdAt })
	}

	async delete(id: string): Promise<void> {
		await this.#table.remove(id)
	}
}
