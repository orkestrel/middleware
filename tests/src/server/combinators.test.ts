import { buildForeignContract } from '@src/server'
import { describe, expect, it } from 'vitest'

// ============================================================================
//  @orkestrel/middleware — combinators. A foreign contract checks each member a
//  published interface declares and nothing else.
// ============================================================================

describe('buildForeignContract', () => {
	it('names the declared members in the expected shape', () => {
		expect(buildForeignContract(['get', 'set']).expected).toBe(
			'an object with function members get, set',
		)
	})

	it('accepts a class instance, an object literal, and unknown members', () => {
		class Store {
			readonly extra = 1
			get(): undefined {
				return undefined
			}
		}
		const foreign = buildForeignContract(['get'])
		expect(foreign.is(new Store())).toBe(true)
		expect(foreign.is({ get: () => 1, extra: 2 })).toBe(true)
	})

	it('refuses a missing member, a member that is not a function, an array, null, and a primitive', () => {
		const foreign = buildForeignContract(['get', 'set'])
		expect(foreign.is({ get: () => 1 })).toBe(false)
		expect(foreign.is({ get: () => 1, set: 1 })).toBe(false)
		expect(foreign.is([])).toBe(false)
		expect(foreign.is(null)).toBe(false)
		expect(foreign.is('store')).toBe(false)
	})
})
