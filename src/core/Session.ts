import type { SessionInterface } from './types.js'

/**
 * Represents a server-managed session's default entity — the `create` option's default
 * value for `createSession`. It ships without a bare `create*` factory of its
 * own, because the name `createSession` belongs to the battery;
 * `createRestoredSession` rebuilds one from a stored snapshot.
 *
 * @remarks
 * `state` is a `ReadonlyMap` view over the entity's own `Map`: TypeScript
 * refuses a write through it, and `set`, `delete`, and `clear` are the write
 * path. `createSession` persists the state to the configured store on the way
 * out.
 *
 * @example
 * ```ts
 * const session = new Session('abc123')
 * session.set('userId', 'u_1')
 * ```
 */
export class Session implements SessionInterface {
	readonly id: string
	readonly #state: Map<string, unknown>

	constructor(id: string) {
		this.id = id
		this.#state = new Map()
	}

	get state(): ReadonlyMap<string, unknown> {
		return this.#state
	}

	set(key: string, value: unknown): void {
		this.#state.set(key, value)
	}

	delete(key: string): boolean {
		return this.#state.delete(key)
	}

	clear(): void {
		this.#state.clear()
	}
}
