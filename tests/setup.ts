import type { MiddlewareContext, MiddlewareHandler, NextFunction } from '@orkestrel/server'
import { compose, readBody } from '@orkestrel/server'

// ── Middleware test harness (AGENTS §16.1) ───────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds
// ONLY helpers with no `node:*` / DOM / Vue dependency, so it is safe for
// `src:core`, `src:browser`, and `src:server` alike. Environment-specific
// helpers live in their own matching setup file. §16.1: never reimplement what
// `@orkestrel/server` or vitest already provides — this harness composes those
// primitives (`compose`, `readBody`) rather than re-deriving them.

/** The default request-body byte cap the test harness's {@link createTestContext} applies. */
export const TEST_BODY_LIMIT = 1_048_576

/**
 * Build a `Request` for a test — a tiny, centralized request builder (AGENTS
 * §16.1) so scenario setup stays uniform across the battery suite.
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
 * `body()` backed by the peer's `readBody` (§16.1: never reimplement the
 * substrate's body-collection pipeline).
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
	readonly calls: readonly {
		readonly request: Request
		readonly context: MiddlewareContext<TState>
	}[]
	readonly count: number
	readonly handler: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>
}

/**
 * Build a {@link RecordingTerminalInterface} — a real terminal handler (AGENTS
 * §16.1 recorder, not a mock) that records each invocation's `request` and
 * `context` before answering with the echo marker.
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
	const calls: { request: Request; context: MiddlewareContext<TState> }[] = []
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
	readonly calls: readonly (Request | undefined)[]
	readonly count: number
	readonly next: NextFunction
}

/**
 * Build a {@link RecordingNextInterface} — a real `NextFunction` (AGENTS
 * §16.1 recorder) for driving a SINGLE middleware in isolation (without a
 * full `compose` chain), recording each call's optional substituted
 * `Request`.
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
	const calls: (Request | undefined)[] = []
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
 * `request`/`context` — a thin `compose` invocation (§16.1: never
 * reimplement `@orkestrel/server`'s `compose`) so test files call one helper
 * instead of re-deriving the invocation shape everywhere.
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
	middleware: readonly MiddlewareHandler<TState>[],
	terminal: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>,
	request: Request,
	context: MiddlewareContext<TState>,
): Promise<Response> {
	return compose(middleware, terminal)(request, context)
}

/** A manually-advanced clock for limiter/session determinism — AGENTS §16 "no wall-clock sleeps". */
export interface ManualClockInterface {
	readonly clock: () => number
	advance(ms: number): void
	set(value: number): void
}

/**
 * Build a {@link ManualClockInterface} — an injectable `() => number` time
 * source a test advances explicitly, replacing every wall-clock sleep in the
 * limiter/session suites (AGENTS §16: deterministic, fast).
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
