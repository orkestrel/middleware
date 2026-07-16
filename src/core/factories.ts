import type {
	CookieTransportOptions,
	HeaderTransportOptions,
	MemorySessionStoreOptions,
	SessionInterface,
	SessionRow,
	SessionStoreInterface,
	SessionTransport,
} from './types.js'
import type { Session } from './Session.js'
import type { Guard } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { integerShape, isString, jsonShape, stringShape } from '@orkestrel/contract'
import { clearCookie, readSignedCookie, resolveSecure, writeSignedCookie } from '@orkestrel/server'
import { DEFAULT_SESSION_COOKIE, DEFAULT_SESSION_HEADER } from './constants.js'
import { DatabaseSessionStore } from './DatabaseSessionStore.js'
import { MemorySessionStore } from './MemorySessionStore.js'

// ============================================================================
//  @orkestrel/middleware — entity / transport / store factories
//  (AGENTS §5 factories.ts, kind-pure counterpart to middlewares.ts). Every
//  companion `createSession`'s option bag composes: the two `SessionTransport`
//  implementations, and the default `SessionStoreInterface`.
// ============================================================================

/**
 * Create a signed-cookie {@link SessionTransport} — the session id travels as
 * a `signToken`-signed cookie value.
 *
 * @param options - See {@link CookieTransportOptions}
 * @returns A {@link SessionTransport}
 * @throws {TypeError} When `options.secret` or `options.name` is malformed
 *
 * @example
 * ```ts
 * const transport = createCookieTransport({ secret: 'shh' })
 * ```
 */
export function createCookieTransport(options: CookieTransportOptions): SessionTransport {
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
 * Create a bare-header {@link SessionTransport} — the session id travels
 * verbatim in a request/response header.
 *
 * @param options - See {@link HeaderTransportOptions}
 * @returns A {@link SessionTransport}
 * @throws {TypeError} When `options.header` is malformed
 *
 * @example
 * ```ts
 * const transport = createHeaderTransport()
 * ```
 */
export function createHeaderTransport(options?: HeaderTransportOptions): SessionTransport {
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
 * @typeParam S - The session data payload type
 * @param options - See {@link MemorySessionStoreOptions}
 * @returns A {@link SessionStoreInterface}
 * @throws {TypeError} When `options.ttl` or `options.lifetime` is malformed
 *
 * @remarks
 * The {@link Session} entity is the `create` option's default value factory
 * for `createSession` and deliberately ships WITHOUT its own `create*`
 * factory — the name `createSession` belongs to the battery, not this class.
 *
 * @example
 * ```ts
 * const store = createMemorySessionStore({ ttl: 60_000 })
 * ```
 */
export function createMemorySessionStore<S>(
	options?: MemorySessionStoreOptions,
): SessionStoreInterface<S> {
	return new MemorySessionStore<S>(options)
}

/**
 * The `@orkestrel/database` column shape for a {@link SessionRow} table — pass
 * as-is to `createDatabase({ tables: { sessions: sessionColumns } })` so an
 * app declaring a durable session table never hand-writes the shape.
 *
 * @remarks
 * `lastSeen`/`createdAt` are `integerShape({ min: 0 })` — the table VALIDATES
 * them as integers, so `DatabaseSessionStore`'s `now` clock must yield
 * integer milliseconds (`Date.now()`, the implicit default `createSession`
 * clock). A fractional clock (`performance.now()`) fails the write with a
 * validation error; `MemorySessionStore` carries no such column shape and
 * accepts a fractional clock without complaint.
 *
 * @example
 * ```ts
 * const db = createDatabase({ driver, tables: { sessions: sessionColumns } })
 * ```
 */
export const sessionColumns = {
	id: stringShape(),
	session: jsonShape(),
	lastSeen: integerShape({ min: 0 }),
	createdAt: integerShape({ min: 0 }),
}

/**
 * Create a {@link DatabaseSessionStore} as a {@link SessionStoreInterface} —
 * the durable counterpart to `createMemorySessionStore`, over a caller-opened
 * `@orkestrel/database` table (declare it with {@link sessionColumns}).
 *
 * @typeParam S - The session data payload type
 * @param table - The backing `TableInterface<SessionRow>`
 * @param is - A {@link Guard} narrowing a restored snapshot to `S`
 * @param options - The idle `ttl` / absolute `lifetime` thresholds
 * @returns A {@link SessionStoreInterface}
 *
 * @remarks
 * This factory only wraps `new DatabaseSessionStore(...)` — it never opens a
 * database or driver itself; the caller owns that lifecycle and passes in an
 * already-open table.
 *
 * @example
 * ```ts
 * const store = createDatabaseSessionStore(db.table('sessions'), isSession, { ttl: 60_000 })
 * ```
 */
export function createDatabaseSessionStore<S extends SessionInterface = Session>(
	table: TableInterface<SessionRow>,
	is: Guard<S>,
	options?: { readonly ttl?: number; readonly lifetime?: number },
): SessionStoreInterface<S> {
	return new DatabaseSessionStore<S>(table, is, options)
}
