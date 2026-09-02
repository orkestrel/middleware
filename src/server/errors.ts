import type { MultipartErrorCode } from './types.js'
import { HTTPError } from '@orkestrel/server'
import { MULTIPART_ERROR_BRAND, MULTIPART_STATUS } from './constants.js'

/**
 * An error `createMultipart` throws when a streamed multipart request fails
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
	readonly [MULTIPART_ERROR_BRAND] = true

	constructor(
		code: MultipartErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(MULTIPART_STATUS[code], message, context)
		this.name = 'MultipartError'
		this.code = code
	}
}

/**
 * Narrow an unknown caught value to a {@link MultipartError}.
 *
 * @remarks
 * Structural, not `instanceof` — tests that `value` is a non-null object
 * carrying {@link MULTIPART_ERROR_BRAND}, a numeric `status`, and a `code`
 * in the parser's {@link MultipartErrorCode} set (`'limit' | 'malformed' | 'rejected'`).
 * Total: never throws, returns `false` for any off-shape input.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns `true` when `value` is a {@link MultipartError}
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
	if (typeof value !== 'object' || value === null) return false
	if (!(MULTIPART_ERROR_BRAND in value)) return false
	if (!('status' in value) || !('code' in value)) return false
	if (typeof value.status !== 'number') return false
	if (value.code !== 'limit' && value.code !== 'malformed' && value.code !== 'rejected')
		return false
	return true
}
