import type { SessionInterface } from './types.js'

/**
 * A server-managed session's default entity — the `create` option's default
 * value for `createSession`. It ships without a `create*` factory of its own,
 * because the name `createSession` belongs to the battery.
 *
 * @remarks
 * `data` is a live, mutable `Map` a handler reads/writes directly;
 * `createSession` persists it to the configured store on the way out.
 *
 * @example
 * ```ts
 * const session = new Session('abc123')
 * session.data.set('userId', 'u_1')
 * ```
 */
export class Session implements SessionInterface {
	readonly id: string
	readonly data: Map<string, unknown>

	constructor(id: string) {
		this.id = id
		this.data = new Map()
	}
}
