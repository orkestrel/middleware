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

	it('starts with an empty state view', () => {
		const session = new Session('abc123')
		expect(session.state).toBeInstanceOf(Map)
		expect(session.state.size).toBe(0)
	})

	it('a handler reads state directly and writes it through the mutators', () => {
		const session = new Session('abc123')
		session.set('userId', 'u_1')
		expect(session.state.get('userId')).toBe('u_1')
		expect(session.delete('userId')).toBe(true)
		expect(session.state.has('userId')).toBe(false)
	})

	it('delete reports false for a key the session never held', () => {
		const session = new Session('abc123')
		expect(session.delete('absent')).toBe(false)
	})

	it('clear empties the state and leaves the id in place', () => {
		const session = new Session('abc123')
		session.set('userId', 'u_1')
		session.set('role', 'admin')
		session.clear()
		expect(session.state.size).toBe(0)
		expect(session.id).toBe('abc123')
	})

	it('two sessions constructed with the same id carry independent state', () => {
		const first = new Session('same-id')
		const second = new Session('same-id')
		first.set('key', 'value')
		expect(second.state.has('key')).toBe(false)
	})
})
