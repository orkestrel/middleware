import type { MultipartErrorCode } from './types.js'
import {
	holds,
	INTRINSICS,
	isFunction,
	isInstance,
	isNumber,
	isObject,
	literalOf,
} from '@orkestrel/contract'
import { HTTPError } from '@orkestrel/server'
import { MULTIPART_ERROR_BRAND, MULTIPART_STATUS } from './constants.js'

/**
 * Represents an error `createMultipart` throws when a streamed multipart request fails
 * a mid-stream limit, is structurally malformed, or has a file whose sniffed
 * bytes are rejected by the configured `allowed` MIME list.
 *
 * @remarks
 * Extends the peer `HTTPError`, which already publishes the `status`,
 * `context`, and brand members every fleet error of this shape carries, and
 * adds the machine-readable `code` axis a caller narrows on. `status` is
 * derived from `code` through {@link MULTIPART_STATUS} (limit → 413, malformed →
 * 400, rejected → 415), so `createBoundary` — or any other `isHTTPError`-aware
 * renderer — maps it without knowing this face's error type. Narrow a caught
 * value to the richer type with {@link isMultipartError}.
 *
 * @example
 * ```ts
 * import { MultipartError } from '@orkestrel/middleware/server'
 *
 * throw new MultipartError('limit', 'too many files')
 * ```
 */
export class MultipartError extends HTTPError {
	readonly code: MultipartErrorCode
	declare readonly [MULTIPART_ERROR_BRAND]: MultipartError

	constructor(
		code: MultipartErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(MULTIPART_STATUS[code], message, context)
		Object.defineProperty(this, MULTIPART_ERROR_BRAND, { value: this })
		this.name = 'MultipartError'
		this.code = code
	}
}

/**
 * Narrows an unknown caught value to a {@link MultipartError}.
 *
 * @remarks
 * Requires an Error subclass with its own identity under {@link MULTIPART_ERROR_BRAND},
 * a numeric status, a declared code, and an optional object or callable context.
 * Accepts subclasses across package copies and refuses transparent proxies.
 * Returns false when inspection throws.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link MultipartError}; false otherwise
 *
 * @example
 * ```ts
 * import { isMultipartError } from '@orkestrel/middleware/server'
 *
 * try {
 * 	await parse(request)
 * } catch (error) {
 * 	if (isMultipartError(error)) console.log(error.status, error.code)
 * }
 * ```
 */
export function isMultipartError(value: unknown): value is MultipartError {
	return holds(() => {
		if (!isInstance(value, Error)) return false
		if (INTRINSICS.prototype(value) === Error.prototype) return false
		if (INTRINSICS.describe(value, MULTIPART_ERROR_BRAND)?.value !== value) return false
		const code = INTRINSICS.reflect.read(value, 'code')
		const status = INTRINSICS.reflect.read(value, 'status')
		const context = INTRINSICS.reflect.read(value, 'context')
		return (
			literalOf('limit', 'malformed', 'rejected')(code) &&
			isNumber(status) &&
			(context === undefined || isObject(context) || isFunction(context))
		)
	})
}
