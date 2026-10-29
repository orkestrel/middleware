import { isMultipartError, MultipartError } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('isMultipartError context', () => {
	it('accepts a class instance as context', () => {
		const context = new Date(0)
		const error = new MultipartError('limit', 'limit')
		Object.defineProperty(error, 'context', { value: context })
		expect(isMultipartError(error)).toBe(true)
		expect(error.context).toBe(context)
	})

	it('accepts a callable object as context', () => {
		const error = new MultipartError('limit', 'limit')
		Object.defineProperty(error, 'context', { value: Math.max })
		expect(isMultipartError(error)).toBe(true)
		expect(error.context).toBe(Math.max)
	})
})
