import type {
	MultipartBody,
	MultipartFile,
	SessionControlInterface,
	SessionInterface,
} from './types.js'
import {
	holds,
	isArray,
	isBoolean,
	isFunction,
	isInstance,
	isNumber,
	isObject,
	isRecord,
	isString,
} from '@orkestrel/contract'

/**
 * Determines whether a value implements {@link SessionInterface} — a total
 * structural guard: an `id` string, a `state` `Map`, and the `set`, `delete`,
 * and `clear` mutators. Prototype-agnostic — accepts a plain object, a
 * null-prototype object, and a class instance (a real `Session`), because a
 * restored or stored session is routinely a class instance rather than a literal.
 *
 * @param value - The candidate value
 * @returns True if `value` is shaped like a {@link SessionInterface}; false otherwise
 *
 * @example
 * ```ts
 * isSession(new Session('a')) // true
 * isSession({ id: 'a', state: new Map() }) // false — the mutators are missing
 * ```
 */
export function isSession(value: unknown): value is SessionInterface {
	if (!isObject(value)) return false
	return holds(
		() =>
			isString(Reflect.get(value, 'id')) &&
			isInstance(Reflect.get(value, 'state'), Map) &&
			isFunction(Reflect.get(value, 'set')) &&
			isFunction(Reflect.get(value, 'delete')) &&
			isFunction(Reflect.get(value, 'clear')),
	)
}

/**
 * Determines whether a value implements {@link SessionControlInterface} — a
 * total structural guard: callable `regenerate` and `destroy`. Prototype-agnostic
 * — accepts a plain object, a callable object, and a class instance (a real
 * `SessionControl`). A member read that throws, as on a revoked proxy, answers false.
 *
 * @param value - The candidate value
 * @returns True if `value` is shaped like a {@link SessionControlInterface}; false otherwise
 *
 * @example
 * ```ts
 * isSessionControl({ regenerate() {}, destroy() {} }) // true
 * isSessionControl(new SessionControl(new Session('a'))) // true
 * ```
 */
export function isSessionControl(value: unknown): value is SessionControlInterface {
	if (!isObject(value) && !isFunction(value)) return false
	return holds(
		() => isFunction(Reflect.get(value, 'regenerate')) && isFunction(Reflect.get(value, 'destroy')),
	)
}

/**
 * Determines whether a value is one staged {@link MultipartFile} record — a
 * total structural guard checking every required field's shape.
 *
 * @param value - The candidate value
 * @returns True if `value` is shaped like a {@link MultipartFile}; false otherwise
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
		isNumber(value.size) &&
		isString(value.mime) &&
		isBoolean(value.validated) &&
		isString(value.status) &&
		isString(value.path)
	)
}

/**
 * Determines whether a value implements {@link MultipartBody} — a total
 * structural guard: `files` keyed by field name to arrays of
 * {@link MultipartFile}, and a `fields` string record.
 *
 * @param value - The candidate value
 * @returns True if `value` is shaped like a {@link MultipartBody}; false otherwise
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
		if (!isArray(entries)) return false
		for (const entry of entries) if (!isMultipartFile(entry)) return false
	}
	for (const fieldValue of Object.values(value.fields)) if (!isString(fieldValue)) return false
	return true
}
