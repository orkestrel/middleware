import type { SessionControlInterface, SessionInterface } from './types.js'
import { transferSessionState } from './helpers.js'
import { Session } from './Session.js'

/**
 * Records one request's session regeneration or destruction intent.
 * @example Session control intent
 * ```ts
 * import { Session, SessionControl } from '@orkestrel/middleware'
 *
 * const control = new SessionControl(new Session('original'))
 * console.log(control.fresh) // false
 * control.regenerate()
 * console.log(control.successor?.id)
 * control.destroy()
 * console.log(control.destroyed) // true
 * ```
 */
export class SessionControl implements SessionControlInterface {
	readonly #session: SessionInterface
	readonly #create: ((id: string) => SessionInterface) | undefined
	readonly #fresh: boolean
	#destroyed = false
	#successor: SessionInterface | undefined

	constructor(session: SessionInterface, create?: (id: string) => SessionInterface, fresh = false) {
		this.#session = session
		this.#create = create
		this.#fresh = fresh
	}

	get destroyed(): boolean {
		return this.#destroyed
	}

	get successor(): SessionInterface | undefined {
		return this.#successor
	}

	get fresh(): boolean {
		return this.#fresh
	}

	/** Mints a successor carrying the active session's current state unless destroyed. */
	regenerate(): void {
		if (this.#destroyed) return
		const id = crypto.randomUUID()
		const successor = this.#create === undefined ? new Session(id) : this.#create(id)
		transferSessionState(this.#session, successor)
		this.#successor = successor
	}

	/** Cancels a successor and records destruction for persistence after the handler. */
	destroy(): void {
		this.#destroyed = true
		this.#successor = undefined
	}
}
