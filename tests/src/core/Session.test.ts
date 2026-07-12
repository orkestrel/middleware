import { Session } from '@src/core'
import { describe, expect, it } from 'vitest'

// ============================================================================
//  @orkestrel/middleware — Session entity unit tests (§16 mirror).
// ============================================================================

describe('Session', () => {
	it('carries the given id as a readonly public field', () => {
		const session = new Session('abc123')
		expect(session.id).toBe('abc123')
	})

	it('starts with an empty, live, mutable data Map', () => {
		const session = new Session('abc123')
		expect(session.data).toBeInstanceOf(Map)
		expect(session.data.size).toBe(0)
	})

	it('a handler can read and write data directly through the live Map', () => {
		const session = new Session('abc123')
		session.data.set('userId', 'u_1')
		expect(session.data.get('userId')).toBe('u_1')
		session.data.delete('userId')
		expect(session.data.has('userId')).toBe(false)
	})

	it('two sessions constructed with the same id carry independent data Maps', () => {
		const first = new Session('same-id')
		const second = new Session('same-id')
		first.data.set('key', 'value')
		expect(second.data.has('key')).toBe(false)
	})
})
