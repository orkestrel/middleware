import type {
	CookieTransportOptions,
	HeaderTransportOptions,
	MemorySessionStoreOptions,
	SessionInterface,
	SessionLimits,
	SessionRow,
	SessionStoreInterface,
	SessionTransportInterface,
} from './types.js'
import type { Guard } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { isRecord, isString } from '@orkestrel/contract'
import { clearCookie, readSignedCookie, resolveSecure, writeSignedCookie } from '@orkestrel/server'
import { DEFAULT_SESSION_COOKIE, DEFAULT_SESSION_HEADER } from './constants.js'
import { Session } from './Session.js'
import { DatabaseSessionStore } from './stores/DatabaseSessionStore.js'
import { MemorySessionStore } from './stores/MemorySessionStore.js'

/**
 * Create a signed-cookie {@link SessionTransportInterface} — the session id travels as
 * a `signToken`-signed cookie value.
 *
 * @param options - See {@link CookieTransportOptions}
 * @returns A {@link SessionTransportInterface}
 * @throws {TypeError} When `options.secret` or `options.name` is malformed
 *
 * @example
 * ```ts
 * const transport = createCookieTransport({ secret: 'shh' })
 * ```
 */
export function createCookieTransport(options: CookieTransportOptions): SessionTransportInterface {
	if (
		!isString(options.secret) &&
		(!Array.isArray(options.secret) || !options.secret.every(isString))
	)
		throw new TypeError('CookieTransportOptions.secret must be a string or string array')
	if (options.name !== undefined && !isString(options.name))
		throw new TypeError('CookieTransportOptions.name must be a string when provided')
	const name = options.name ?? DEFAULT_SESSION_COOKIE
	const secret = options.secret
	const cookie = options.cookie
	return {
		read(request) {
			return readSignedCookie(request, name, secret)
		},
		async write(response, id, encrypted) {
			const secure = resolveSecure(cookie?.secure, encrypted)
			await writeSignedCookie(response.headers, name, id, secret, { ...cookie, secure })
		},
		clear(response) {
			clearCookie(response.headers, name, cookie)
		},
	}
}

/**
 * Create a bare-header {@link SessionTransportInterface} — the session id travels
 * verbatim in a request/response header.
 *
 * @param options - See {@link HeaderTransportOptions}
 * @returns A {@link SessionTransportInterface}
 * @throws {TypeError} When `options.header` is malformed
 *
 * @example
 * ```ts
 * const transport = createHeaderTransport()
 * ```
 */
export function createHeaderTransport(options?: HeaderTransportOptions): SessionTransportInterface {
	if (options?.header !== undefined && !isString(options.header))
		throw new TypeError('HeaderTransportOptions.header must be a string when provided')
	const header = options?.header ?? DEFAULT_SESSION_HEADER
	return {
		read(request) {
			return request.headers.get(header) ?? undefined
		},
		write(response, id) {
			response.headers.set(header, id)
		},
		clear(response) {
			response.headers.delete(header)
		},
	}
}

/**
 * Create the default in-process {@link SessionStoreInterface} — a `Map`-backed
 * store enforcing an idle timeout and an absolute lifetime.
 *
 * @typeParam S - The session entity type
 * @param options - See {@link MemorySessionStoreOptions}
 * @returns A {@link SessionStoreInterface}
 * @throws {TypeError} When `options.ttl` or `options.lifetime` is malformed
 *
 * @remarks
 * The store holds whatever {@link SessionInterface} entity `createSession`'s
 * `create` option produced, keyed by that entity's own `id`.
 *
 * @example
 * ```ts
 * const store = createMemorySessionStore({ ttl: 60_000 })
 * ```
 */
export function createMemorySessionStore<S extends SessionInterface>(
	options?: MemorySessionStoreOptions,
): SessionStoreInterface<S> {
	return new MemorySessionStore<S>(options)
}

/**
 * Create a {@link DatabaseSessionStore} as a {@link SessionStoreInterface} —
 * the durable counterpart to `createMemorySessionStore`, over a caller-opened
 * `@orkestrel/database` table (declare it with {@link sessionColumns}).
 *
 * @typeParam S - The session entity type
 * @param table - The backing `TableInterface<SessionRow>`
 * @param guard - A {@link Guard} narrowing a restored snapshot to `S`
 * @param options - See {@link SessionLimits}
 * @returns A {@link SessionStoreInterface}
 * @throws {TypeError} When `options.ttl` or `options.lifetime` is malformed
 *
 * @remarks
 * This factory only wraps `new DatabaseSessionStore(...)` — it never opens a
 * database or driver itself; the caller owns that lifecycle and passes in an
 * already-open table. It supplies {@link createRestoredSession} as the store's
 * snapshot rebuild step, which is why the store imports nothing from this
 * file.
 *
 * @example
 * ```ts
 * const store = createDatabaseSessionStore(db.table('sessions'), isSession, { ttl: 60_000 })
 * ```
 */
export function createDatabaseSessionStore<S extends SessionInterface = Session>(
	table: TableInterface<SessionRow>,
	guard: Guard<S>,
	options?: SessionLimits,
): SessionStoreInterface<S> {
	return new DatabaseSessionStore<S>(table, guard, createRestoredSession, options)
}

/**
 * Rebuilds a {@link Session} from an untrusted snapshot value — the inverse of
 * `snapshotSession` and a durable store's `get` deserialization step.
 *
 * @param value - The candidate snapshot, of unknown shape
 * @returns A rebuilt {@link Session}, or `undefined` when `value` is malformed
 *
 * @example
 * ```ts
 * createRestoredSession({ id: 'abc', state: { userId: 'u_1' } }) // Session { id: 'abc' }
 * createRestoredSession({ id: 1 }) // undefined
 * ```
 */
export function createRestoredSession(value: unknown): Session | undefined {
	if (!isRecord(value)) return undefined
	if (!isString(value.id) || !isRecord(value.state)) return undefined
	const session = new Session(value.id)
	for (const [key, entry] of Object.entries(value.state)) session.set(key, entry)
	return session
}
