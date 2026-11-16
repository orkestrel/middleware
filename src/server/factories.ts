import type {
	CookieTransportOptions,
	HeaderTransportOptions,
	MemorySessionStoreOptions,
	MemoryLimiterStoreOptions,
	LimiterStoreInterface,
	SessionInterface,
	SessionLimits,
	SessionRow,
	SessionStoreInterface,
	SessionTransportInterface,
	AssetStoreInterface,
	UploadedFile,
} from './types.js'
import type { Guard } from '@orkestrel/contract'
import type { TableInterface } from '@orkestrel/database'
import { isRecord, isString } from '@orkestrel/contract'
import { clearCookie, readSignedCookie, resolveSecure, writeSignedCookie } from '@orkestrel/server'
import { DEFAULT_SESSION_COOKIE, DEFAULT_SESSION_HEADER } from './constants.js'
import {
	COOKIE_TRANSPORT_CONTRACT,
	HEADER_TRANSPORT_CONTRACT,
	SIGNER_FOREIGN,
	UPLOADED_FILE_CONTRACT,
} from './contracts.js'
import { admitForeign, admitOptions } from './helpers.js'
import { Session } from './Session.js'
import { DatabaseSessionStore } from './stores/DatabaseSessionStore.js'
import { MemorySessionStore } from './stores/MemorySessionStore.js'
import { MemoryLimiterStore } from './stores/MemoryLimiterStore.js'
import { MemoryAssetStore } from './stores/MemoryAssetStore.js'

/**
 * Creates a bounded in-memory atomic limiter store.
 * @param options - The capacity and eviction callback.
 * @returns An atomic limiter store.
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a `capacity` that is not an integer of at least 1, or an `evict` that is not a function.
 */
export function createMemoryLimiterStore(
	options?: MemoryLimiterStoreOptions,
): LimiterStoreInterface {
	return new MemoryLimiterStore(options)
}

/**
 * Creates a signed-cookie {@link SessionTransportInterface} — the session id travels as
 * a `signToken`-signed cookie value.
 *
 * @param options - See {@link CookieTransportOptions}
 * @returns A {@link SessionTransportInterface}
 * @throws {ContractError} When the bag is refused whole: an undeclared key such as `secret`, a missing `signer`, or a `cookie` that is not a plain record of `path`, `domain` (strings), `maxAge` (a finite number), `httpOnly`, `secure` (booleans), and `sameSite` (`'Strict'`, `'Lax'`, or `'None'`); or when `signer` lacks `sign` or `verify`
 *
 * @example
 * ```ts
 * const transport = createCookieTransport({ signer: createSigner('shh') })
 * ```
 */
export function createCookieTransport(options: CookieTransportOptions): SessionTransportInterface {
	admitOptions('createCookieTransport', COOKIE_TRANSPORT_CONTRACT, options)
	admitForeign('createCookieTransport', ['signer'], SIGNER_FOREIGN, options.signer)
	const name = options.name ?? DEFAULT_SESSION_COOKIE
	const signer = options.signer
	const cookie = options.cookie
	return {
		read(request) {
			return readSignedCookie(request, name, signer)
		},
		async write(response, id, encrypted) {
			const secure = resolveSecure(cookie?.secure, encrypted)
			await writeSignedCookie(response.headers, name, id, signer, { ...cookie, secure })
		},
		clear(response) {
			clearCookie(response.headers, name, cookie)
		},
	}
}

/**
 * Creates a bare-header {@link SessionTransportInterface} — the session id travels
 * verbatim in a request/response header.
 *
 * @param options - See {@link HeaderTransportOptions}
 * @returns A {@link SessionTransportInterface}
 * @throws {ContractError} When the bag is refused whole: an undeclared key, or a `header` that is not a string
 *
 * @example
 * ```ts
 * const transport = createHeaderTransport()
 * ```
 */
export function createHeaderTransport(options?: HeaderTransportOptions): SessionTransportInterface {
	admitOptions('createHeaderTransport', HEADER_TRANSPORT_CONTRACT, options)
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
 * Creates the default in-process {@link SessionStoreInterface} — a `Map`-backed
 * store enforcing an idle timeout and an absolute lifetime.
 *
 * @typeParam S - The session entity type
 * @param options - See {@link MemorySessionStoreOptions}
 * @returns A {@link SessionStoreInterface}
 * @throws {ContractError} When the bag is refused whole: an undeclared key, a `ttl` or `lifetime` that is not a positive finite number, or a `capacity` that is not an integer of at least 1
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
 * Creates a {@link DatabaseSessionStore} as a {@link SessionStoreInterface} —
 * the durable counterpart to `createMemorySessionStore`, over a caller-opened
 * `@orkestrel/database` table (declare it with {@link sessionColumns}).
 *
 * @typeParam S - The session entity type
 * @param table - The backing `TableInterface<SessionRow>`
 * @param guard - A {@link Guard} narrowing a restored snapshot to `S`
 * @param options - See {@link SessionLimits}
 * @returns A {@link SessionStoreInterface}
 * @throws {ContractError} When the bag is refused whole: an undeclared key, or a `ttl` or `lifetime` that is not a positive finite number
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

/**
 * Creates an in-memory asset representation store.
 * @returns A store retaining records until they are replaced or deleted.
 */
export function createMemoryAssetStore(): AssetStoreInterface {
	return new MemoryAssetStore()
}

/**
 * Builds a frozen {@link UploadedFile} record.
 *
 * @param input - Every field of the record
 * @returns A frozen {@link UploadedFile}
 * @throws {ContractError} Thrown when `input` omits a member, carries an undeclared member, or holds a member outside its range
 *
 * @example
 * ```ts
 * createUploadedFile({ field: 'avatar', name: 'a.png', size: 1024, mime: 'image/png', validated: true, status: 'staged', path: '/tmp/x' })
 * ```
 */
export function createUploadedFile(input: UploadedFile): UploadedFile {
	admitOptions('createUploadedFile', UPLOADED_FILE_CONTRACT, input)
	return Object.freeze({ ...input })
}
