import type {
	MultipartBody,
	MultipartFile,
	SessionControlInterface,
	SessionInterface,
} from './types.js'
import { isRecord, isString } from '@orkestrel/contract'

/**
 * Determine whether a value implements {@link SessionInterface} — a total
 * structural guard: an `id` string, a `state` `Map`, and the `set`, `delete`,
 * and `clear` mutators. Prototype-agnostic — accepts a plain object, a
 * null-prototype object, AND a class instance (a real `Session`), since a
 * restored/stored session is routinely a class instance, not a literal.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link SessionInterface}
 *
 * @example
 * ```ts
 * isSession(new Session('a')) // true
 * isSession({ id: 'a', state: new Map() }) // false — the mutators are missing
 * ```
 */
export function isSession(value: unknown): value is SessionInterface {
	if (typeof value !== 'object' || value === null) return false
	const id: unknown = Reflect.get(value, 'id')
	const state: unknown = Reflect.get(value, 'state')
	if (!isString(id) || !(state instanceof Map)) return false
	const set: unknown = Reflect.get(value, 'set')
	const remove: unknown = Reflect.get(value, 'delete')
	const clear: unknown = Reflect.get(value, 'clear')
	return typeof set === 'function' && typeof remove === 'function' && typeof clear === 'function'
}

/**
 * Determine whether a value implements {@link SessionControlInterface} — a
 * total structural guard: callable `regenerate` and `destroy`.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link SessionControlInterface}
 *
 * @example
 * ```ts
 * isSessionControl({ regenerate() {}, destroy() {} }) // true
 * ```
 */
export function isSessionControl(value: unknown): value is SessionControlInterface {
	if (!isRecord(value)) return false
	return typeof value.regenerate === 'function' && typeof value.destroy === 'function'
}

/**
 * Determine whether a value is one staged {@link MultipartFile} record — a
 * total structural guard checking every required field's shape.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link MultipartFile}
 *
 * @example
 * ```ts
 * isMultipartFile({
 * 	field: 'avatar',
 * 	name: 'a.png',
 * 	size: 3,
 * 	mime: 'image/png',
 * 	validated: true,
 * 	status: 'staged',
 * 	path: '/tmp/a',
 * }) // true
 * ```
 */
export function isMultipartFile(value: unknown): value is MultipartFile {
	if (!isRecord(value)) return false
	return (
		isString(value.field) &&
		isString(value.name) &&
		typeof value.size === 'number' &&
		isString(value.mime) &&
		typeof value.validated === 'boolean' &&
		isString(value.status) &&
		isString(value.path)
	)
}

/**
 * Determine whether a value implements {@link MultipartBody} — a total
 * structural guard: `files` keyed by field name to arrays of
 * {@link MultipartFile}, and a `fields` string record.
 *
 * @param value - The candidate value
 * @returns `true` when `value` is shaped like a {@link MultipartBody}
 *
 * @example
 * ```ts
 * isMultipartBody({ files: {}, fields: { name: 'a' } }) // true
 * ```
 */
export function isMultipartBody(value: unknown): value is MultipartBody {
	if (!isRecord(value)) return false
	if (!isRecord(value.files) || !isRecord(value.fields)) return false
	for (const entries of Object.values(value.files)) {
		if (!Array.isArray(entries)) return false
		for (const entry of entries) if (!isMultipartFile(entry)) return false
	}
	for (const fieldValue of Object.values(value.fields)) if (!isString(fieldValue)) return false
	return true
}
