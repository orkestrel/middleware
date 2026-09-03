import { isMultipartBody, isMultipartFile, isSession, isSessionControl, Session } from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildSession } from '../../setup.js'

// ============================================================================
//  @orkestrel/middleware — core validators.ts unit tests. Every guard is
//  driven as a total predicate: a well-shaped value, a real class instance
//  where one exists, and the hostile inputs a guard must answer `false` to
//  rather than throw on.
// ============================================================================

describe('isSession', () => {
	it('accepts a value shaped like a SessionInterface', () => {
		expect(
			isSession({
				id: 'a',
				state: new Map(),
				set: () => undefined,
				delete: () => true,
				clear: () => undefined,
			}),
		).toBe(true)
	})

	it('accepts a real Session class instance', () => {
		expect(isSession(new Session('a'))).toBe(true)
	})

	it('accepts a real Session instance with entries in state', () => {
		expect(isSession(buildSession('a', 'u_1'))).toBe(true)
	})

	it('rejects a class instance that does not match the shape', () => {
		class NotASession {
			readonly id = 42
			readonly state = []
		}
		expect(isSession(new NotASession())).toBe(false)

		class MissingState {
			readonly id = 'a'
		}
		expect(isSession(new MissingState())).toBe(false)
	})

	it('rejects a state-carrying value that publishes no mutators', () => {
		expect(isSession({ id: 'a', state: new Map() })).toBe(false)
		expect(isSession({ id: 'a', state: new Map(), set: () => undefined, delete: () => true })).toBe(
			false,
		)
	})

	it('rejects hostile inputs totally', () => {
		expect(isSession(null)).toBe(false)
		expect(isSession(undefined)).toBe(false)
		expect(isSession('a')).toBe(false)
		expect(isSession(42)).toBe(false)
		expect(isSession([])).toBe(false)
		expect(isSession({ id: 'a', state: [] })).toBe(false)
		expect(isSession({ id: 1, state: new Map() })).toBe(false)
		expect(isSession({})).toBe(false)
	})
})

describe('isSessionControl', () => {
	it('accepts a value with callable regenerate and destroy', () => {
		expect(isSessionControl({ regenerate: () => undefined, destroy: () => undefined })).toBe(true)
	})

	it('rejects hostile inputs totally', () => {
		expect(isSessionControl(null)).toBe(false)
		expect(isSessionControl(undefined)).toBe(false)
		expect(isSessionControl(42)).toBe(false)
		expect(isSessionControl({ regenerate: () => undefined })).toBe(false)
		expect(isSessionControl({ regenerate: 'nope', destroy: () => undefined })).toBe(false)
		expect(isSessionControl({})).toBe(false)
	})
})

describe('isMultipartFile', () => {
	it('accepts a well-shaped record', () => {
		expect(
			isMultipartFile({
				field: 'avatar',
				name: 'a.png',
				size: 10,
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: '/tmp/x',
			}),
		).toBe(true)
	})

	it('rejects a record missing/mistyping a required field', () => {
		expect(isMultipartFile({ field: 'avatar', name: 'a.png' })).toBe(false)
		expect(
			isMultipartFile({
				field: 'avatar',
				name: 'a.png',
				size: 'not-a-number',
				mime: 'image/png',
				validated: true,
				status: 'staged',
				path: '/tmp/x',
			}),
		).toBe(false)
	})

	it('is total on non-record input', () => {
		expect(isMultipartFile(null)).toBe(false)
		expect(isMultipartFile('nope')).toBe(false)
		expect(isMultipartFile(undefined)).toBe(false)
	})
})

describe('isMultipartBody', () => {
	const file = {
		field: 'avatar',
		name: 'a.png',
		size: 10,
		mime: 'image/png',
		validated: true,
		status: 'ok',
		path: '/tmp/a.png',
	}

	it('accepts a value shaped like a MultipartBody', () => {
		expect(isMultipartBody({ files: { avatar: [file] }, fields: { name: 'a' } })).toBe(true)
	})

	it('accepts empty files and fields records', () => {
		expect(isMultipartBody({ files: {}, fields: {} })).toBe(true)
	})

	it('rejects hostile inputs totally', () => {
		expect(isMultipartBody(null)).toBe(false)
		expect(isMultipartBody(undefined)).toBe(false)
		expect(isMultipartBody(42)).toBe(false)
		expect(isMultipartBody({ files: [], fields: {} })).toBe(false)
		expect(isMultipartBody({ files: {}, fields: [] })).toBe(false)
		expect(
			isMultipartBody({ files: { avatar: [{ ...file, size: 'not-a-number' }] }, fields: {} }),
		).toBe(false)
		expect(isMultipartBody({ files: { avatar: 'not-an-array' }, fields: {} })).toBe(false)
		expect(isMultipartBody({ files: {}, fields: { name: 1 } })).toBe(false)
	})
})
