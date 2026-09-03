import type { MiddlewareContext, MiddlewareHandler, NextFunction } from '@orkestrel/server'
import type { TableInterface } from '@orkestrel/database'
import type {
	SessionInterface,
	SessionLimits,
	SessionRow,
	SessionStoreInterface,
	SessionTransportInterface,
} from '@src/core'
import { compose, readBody } from '@orkestrel/server'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { createDatabaseSessionStore, isSession, Session, sessionColumns } from '@src/core'

// ── Middleware test harness ──────────────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds
// ONLY helpers with no `node:*` / DOM / Vue dependency, so it is safe for
// `src:core`, `src:browser`, and `src:server` alike. Environment-specific
// helpers live in their own matching setup file. This harness composes the
// primitives `@orkestrel/server` and vitest already provide (`compose`,
// `readBody`) rather than re-deriving them.

/** The default request-body byte cap the test harness's {@link createTestContext} applies. */
export const TEST_BODY_LIMIT = 1_048_576

/** The signing secret every bearer, CSRF, and cookie-transport scenario shares. */
export const TEST_SECRET = 'test-secret'

/**
 * Build a `Request` for a test — a tiny, centralized request builder so
 * scenario setup stays uniform across the battery suite.
 *
 * @param path - The request path (and optional query), joined onto a fixed test origin
 * @param init - Standard `RequestInit` fields (`method`, `headers`, `body`, `signal`, …)
 * @returns A `Request` ready to drive through a `MiddlewareHandler`
 *
 * @example
 * ```ts
 * const request = buildRequest('/users', { method: 'POST', body: '{"name":"a"}' })
 * ```
 */
export function buildRequest(path: string, init?: RequestInit): Request {
	return new Request(new URL(path, 'http://test.local/'), init)
}

/**
 * Build a {@link MiddlewareContext} over a `Request` — `url`/`method` derived
 * from the request, a given `state` object threaded through in place, and a
 * `body()` backed by the peer's `readBody`, so no suite reimplements the
 * substrate's body-collection pipeline.
 *
 * @typeParam TState - The state slice shape the scenario under test needs
 * @param request - The request the context is derived from
 * @param state - The mutable state object every battery under test reads/writes
 * @returns A {@link MiddlewareContext} ready to drive a `MiddlewareHandler`
 *
 * @example
 * ```ts
 * const context = createTestContext(buildRequest('/'), {})
 * ```
 */
export function createTestContext<TState>(
	request: Request,
	state: TState,
): MiddlewareContext<TState> {
	const url = new URL(request.url)
	let cached: Promise<unknown> | undefined
	return {
		url,
		method: request.method,
		state,
		body() {
			if (cached === undefined) cached = readBody(request, { limit: TEST_BODY_LIMIT })
			return cached
		},
	}
}

/** The marker body {@link createEchoTerminal}'s default `Response` carries, for chain-reached assertions. */
export const ECHO_MARKER = 'echo'

/**
 * Build a terminal handler for {@link runChain} that returns a fixed marker
 * `Response` — the default innermost handler for a composition scenario that
 * doesn't need its own route logic.
 *
 * @param status - The marker response's status; defaults to `200`
 * @returns A terminal `(request, context) => Promise<Response>` for `compose`
 *
 * @example
 * ```ts
 * const terminal = createEchoTerminal()
 * ```
 */
export function createEchoTerminal<TState>(
	status = 200,
): (request: Request, context: MiddlewareContext<TState>) => Promise<Response> {
	return async () => new Response(ECHO_MARKER, { status })
}

/** A terminal handler that also RECORDS every request/context it was reached with — for asserting the chain reached the terminal, and with what. */
export interface RecordingTerminalInterface<TState> {
	readonly calls: ReadonlyArray<{
		readonly request: Request
		readonly context: MiddlewareContext<TState>
	}>
	readonly count: number
	readonly handler: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>
}

/**
 * Build a {@link RecordingTerminalInterface} — a real terminal handler, not a
 * mock, that records each invocation's `request` and `context` before answering
 * with the echo marker.
 *
 * @param status - The marker response's status; defaults to `200`
 * @returns A {@link RecordingTerminalInterface}
 *
 * @example
 * ```ts
 * const terminal = createRecordingTerminal()
 * await runChain([middleware], terminal.handler, buildRequest('/'), context)
 * terminal.count // 1
 * ```
 */
export function createRecordingTerminal<TState>(status = 200): RecordingTerminalInterface<TState> {
	const calls: Array<{ request: Request; context: MiddlewareContext<TState> }> = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		async handler(request, context) {
			calls.push({ request, context })
			return new Response(ECHO_MARKER, { status })
		},
	}
}

/** A recording {@link NextFunction} — a real downstream continuation that records each call's substituted `request` before answering with a fixed `Response`. */
export interface RecordingNextInterface {
	readonly calls: ReadonlyArray<Request | undefined>
	readonly count: number
	readonly next: NextFunction
}

/**
 * Build a {@link RecordingNextInterface} — a real `NextFunction` recorder for
 * driving a SINGLE middleware in isolation (without a full `compose` chain),
 * recording each call's optional substituted `Request`.
 *
 * @param response - The `Response` the recorded `next()` resolves with; defaults to a fresh echo `Response`
 * @returns A {@link RecordingNextInterface}
 *
 * @example
 * ```ts
 * const next = createRecordingNext()
 * await middleware(request, context, next.next)
 * next.count // 1
 * ```
 */
export function createRecordingNext(response?: Response): RecordingNextInterface {
	const calls: Array<Request | undefined> = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		async next(request) {
			calls.push(request)
			return response ?? new Response(ECHO_MARKER, { status: 200 })
		},
	}
}

/**
 * Run an ordered middleware chain around a `terminal` handler against one
 * `request`/`context` — a thin invocation of `@orkestrel/server`'s own
 * `compose`, so test files call one helper instead of re-deriving the
 * invocation shape everywhere.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param middleware - The ordered chain, outermost first
 * @param terminal - The innermost handler the chain ultimately reaches
 * @param request - The request driving the chain
 * @param context - The request's {@link MiddlewareContext}
 * @returns The chain's resolved `Response`
 *
 * @example
 * ```ts
 * const response = await runChain([bearer], createEchoTerminal(), request, context)
 * ```
 */
export function runChain<TState>(
	middleware: ReadonlyArray<MiddlewareHandler<TState>>,
	terminal: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>,
	request: Request,
	context: MiddlewareContext<TState>,
): Promise<Response> {
	return compose(middleware, terminal)(request, context)
}

/** A manually-advanced clock for limiter/session determinism, so no suite sleeps on the wall clock. */
export interface ManualClockInterface {
	readonly clock: () => number
	advance(ms: number): void
	set(value: number): void
}

/**
 * Build a {@link ManualClockInterface} — an injectable `() => number` time
 * source a test advances explicitly, replacing every wall-clock sleep in the
 * limiter/session suites so each one stays deterministic and fast.
 *
 * @param start - The clock's initial value; defaults to `0`
 * @returns A {@link ManualClockInterface}
 *
 * @example
 * ```ts
 * const clock = createManualClock()
 * const limiter = createLimiter({ max: 1, window: 1_000, clock: clock.clock })
 * clock.advance(1_000)
 * ```
 */
export function createManualClock(start = 0): ManualClockInterface {
	let now = start
	return {
		clock: () => now,
		advance(ms) {
			now += ms
		},
		set(value) {
			now = value
		},
	}
}

/**
 * Build a {@link Session} carrying one optional state entry — the scenario
 * builder every session proof drives, so a store or battery test states an id
 * and one distinguishing value instead of re-deriving the entity.
 *
 * @param id - The session id the store keys the entity by
 * @param mark - The value written under the `mark` key; omitted leaves the state empty
 * @returns A `Session` ready to hand to a `SessionStoreInterface`
 *
 * @example
 * ```ts
 * await store.set(buildSession('id-1', 'first'), 0)
 * ```
 */
export function buildSession(id: string, mark?: string): Session {
	const session = new Session(id)
	if (mark !== undefined) session.set('mark', mark)
	return session
}

/**
 * Decompress response bytes back to text through the platform's
 * `DecompressionStream` — the round-trip read every compression proof asserts
 * against, over either shape a buffered body arrives in.
 *
 * @param bytes - The compressed body, as read from `arrayBuffer()` or as a view over one
 * @param encoding - The coding the bytes were compressed with
 * @returns The decoded original text
 *
 * @example
 * ```ts
 * expect(await decompress(await response.arrayBuffer(), 'gzip')).toBe(body)
 * ```
 */
export async function decompress(
	bytes: Uint8Array<ArrayBuffer> | ArrayBuffer,
	encoding: 'gzip' | 'deflate',
): Promise<string> {
	const stream = new Response(bytes).body
	if (stream === null) throw new Error('decompress: the compressed body carried no stream')
	const buffer = await new Response(
		stream.pipeThrough(new DecompressionStream(encoding)),
	).arrayBuffer()
	return new TextDecoder().decode(buffer)
}

/**
 * Build a body of `length` highly compressible bytes.
 *
 * @param length - The body's character length
 * @returns A single repeated character, so every codec clears its threshold
 *
 * @example
 * ```ts
 * const body = compressibleBody(2048)
 * ```
 */
export function compressibleBody(length: number): string {
	return 'a'.repeat(length)
}

/** A {@link SessionTransportInterface} that records every `write` and `clear` it was driven with. */
export interface RecordingTransportInterface extends SessionTransportInterface {
	readonly written: ReadonlyArray<{ readonly response: Response; readonly id: string }>
	readonly cleared: readonly Response[]
}

/**
 * Build a {@link RecordingTransportInterface} — a real header-backed session
 * transport that records each `write` and `clear` instead of standing in for one.
 *
 * @returns A {@link RecordingTransportInterface} carrying its own `x-test-session` header
 *
 * @example
 * ```ts
 * const transport = createTestTransport()
 * const session = createSession({ transport })
 * transport.written.length // 1 after a mint
 * ```
 */
export function createTestTransport(): RecordingTransportInterface {
	const written: Array<{ response: Response; id: string }> = []
	const cleared: Response[] = []
	const header = 'x-test-session'
	return {
		written,
		cleared,
		read(request) {
			return request.headers.get(header) ?? undefined
		},
		write(response, id) {
			written.push({ response, id })
			response.headers.set(header, id)
		},
		clear(response) {
			cleared.push(response)
			response.headers.delete(header)
		},
	}
}

/** A real in-memory database table paired with the {@link SessionStoreInterface} built over it. */
export interface SessionStoreFixtureInterface {
	readonly table: TableInterface<SessionRow>
	readonly store: SessionStoreInterface<SessionInterface>
}

/**
 * Build a durable session store over a real in-memory database table — the
 * scenario builder every `DatabaseSessionStore` proof drives, so a case states
 * its limits and reads the table directly rather than re-deriving the wiring.
 *
 * @param options - The store's idle and absolute-lifetime limits
 * @returns The table and the store built over it
 *
 * @example
 * ```ts
 * const { table, store } = buildStore({ ttl: 1_000 })
 * await store.set(buildSession('a'), 0)
 * ```
 */
export function buildStore(options?: SessionLimits): SessionStoreFixtureInterface {
	const database = createDatabase({
		driver: createMemoryDriver(),
		tables: { sessions: sessionColumns },
	})
	const table = database.table('sessions')
	return { table, store: createDatabaseSessionStore(table, isSession, options) }
}
