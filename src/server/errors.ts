import type { MultipartReason } from './types.js'
import { MULTIPART_REASON_STATUS } from './constants.js'

// ============================================================================
//  @orkestrel/middleware/server — MultipartError (AGENTS §5 errors.ts).
//  Modeled on the peer `@orkestrel/server` HTTPError class shape (status +
//  message + optional context) — MultipartError additionally carries the
//  `reason` axis createMultipart's caller narrows on, mapped to its HTTP
//  status via {@link MULTIPART_REASON_STATUS}: 'limit' → 413, 'malformed' →
//  400, 'rejected' → 415.
// ============================================================================

/**
 * An error `createMultipart` throws when a streamed multipart request fails
 * a mid-stream limit, is structurally malformed, or has a file whose sniffed
 * bytes are rejected by the configured `allowed` MIME list.
 *
 * @remarks
 * Carries the HTTP `status` derived from `reason` (limit → 413, malformed →
 * 400, rejected → 415) and an optional `context` record. Rendered by
 * `createBoundary` like any other `HTTPError`-shaped throw. Narrow a caught
 * value with {@link isMultipartError}.
 *
 * @example
 * ```ts
 * import { MultipartError } from '@orkestrel/middleware/server'
 *
 * throw new MultipartError('limit', 'too many files')
 * ```
 */
export class MultipartError extends Error {
	readonly status: number
	readonly reason: MultipartReason
	readonly context?: Readonly<Record<string, unknown>>

	constructor(
		reason: MultipartReason,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		this.status = MULTIPART_REASON_STATUS[reason]
		this.reason = reason
		this.context = context
		Object.defineProperty(this, Symbol.for('@orkestrel/middleware.MultipartError'), {
			value: true,
		})
	}
}

/**
 * Narrow an unknown caught value to a {@link MultipartError}.
 *
 * @remarks
 * Structural, not `instanceof` — tests that `value` is a non-null object
 * carrying the module-scope brand, a numeric `status`, and a `reason` in the
 * parser's set of reason strings (`'limit' | 'malformed' | 'rejected'`).
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
 * 	if (isMultipartError(error)) console.log(error.status, error.reason)
 * }
 * ```
 */
export function isMultipartError(value: unknown): value is MultipartError {
	if (typeof value !== 'object' || value === null) return false
	if (!(Symbol.for('@orkestrel/middleware.MultipartError') in value)) return false
	if (!('status' in value) || !('reason' in value)) return false
	if (typeof value.status !== 'number') return false
	if (value.reason !== 'limit' && value.reason !== 'malformed' && value.reason !== 'rejected')
		return false
	return true
}
