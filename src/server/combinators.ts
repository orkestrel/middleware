import type { ForeignContract } from './types.js'
import { isFunction, objectOf } from '@orkestrel/contract'

/**
 * Builds a {@link ForeignContract} whose every declared member is a function — the
 * contract an implementation key admits, such as a store, a transport, or a source.
 *
 * @param members - The member names the published interface declares
 * @returns A {@link ForeignContract} accepting a class instance and unknown members
 *
 * @example
 * ```ts
 * buildForeignContract(['get', 'set']).is(new Map()) // true
 * buildForeignContract(['get', 'set']).is({ get() {} }) // false
 * ```
 */
export function buildForeignContract(members: readonly string[]): ForeignContract {
	return Object.freeze({
		expected: `an object with function members ${members.join(', ')}`,
		is: objectOf(Object.fromEntries(members.map((member) => [member, isFunction]))),
	})
}
