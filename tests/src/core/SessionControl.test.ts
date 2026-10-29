import { Session, SessionControl } from '@src/core'
import { createRecorder } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'

describe('SessionControl', () => {
	it('regenerates from current session state and replaces the prior successor', () => {
		const session = new Session('original')
		session.set('user', 'one')
		const control = new SessionControl(session)
		expect(control.destroyed).toBe(false)
		expect(control.successor).toBeUndefined()
		control.regenerate()
		const first = control.successor
		expect(first?.id).not.toBe(session.id)
		expect(first?.state.get('user')).toBe('one')
		session.set('user', 'two')
		control.regenerate()
		expect(control.successor).not.toBe(first)
		expect(control.successor?.state.get('user')).toBe('two')
		expect(session.id).toBe('original')
	})

	it('uses the supplied constructor and lets destruction supersede regeneration', () => {
		const ids = createRecorder<[string]>()
		const control = new SessionControl(new Session('original'), (id) => {
			ids.handler(id)
			return new Session(id)
		})
		control.regenerate()
		expect(ids.calls).toEqual([[control.successor?.id]])
		control.destroy()
		control.regenerate()
		expect(control.destroyed).toBe(true)
		expect(control.successor).toBeUndefined()
		expect(ids.calls).toHaveLength(1)
	})
})
