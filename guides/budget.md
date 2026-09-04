# Budget

> The cost primitive: a cumulative consumption tally against a ceiling that exposes an `AbortSignal` firing the moment the budget is **exhausted**. You charge a `Budget<T>` as work spends — `consume(value)` adds to a running `consumed` total — and race its `signal` against that work to cap how much it may burn (tokens, bytes, calls). When `consumed` crosses `max`, `signal` aborts; fold it into a loop's bound so the loop stops generating after the budget is spent.
>
> This is the substrate's third bounding signal, a peer to a cancellation signal (fires on `abort()`) and a deadline signal (fires on expiry). All three are plain `AbortSignal`s by design, so an agent loop combines them into one bound with `AbortSignal.any([abort, timeout, budget])` and reacts to whichever trips first — cancel, deadline, or cost. A budget deliberately carries no Emitter, clock, or I/O: its native signal is the complete observation boundary. It is a functional counter with a signal bolted to its ceiling — nothing more, so the surface stays small.
>
> Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a cost handle, `start()` it, and race its `signal` against work; `consume(value)` to charge the tally as work spends:

```ts
import { createBudget } from '@orkestrel/budget'

const budget = createBudget<number>({ max: 10_000, consumer: (cost) => cost })
budget.start()
budget.signal.addEventListener('abort', () => stop()) // fires when exhausted
budget.consume(4_000) // remaining 6_000
budget.consume(7_000) // crosses 10_000 — fires `signal`
```

**What happens:** `consume(value)` runs your consumer first, validates its result as a finite nonnegative charge, and atomically adds it to `consumed`; the moment cumulative `consumed` reaches `max`, `exhausted` flips `true` and `signal` fires — exactly once. A valid charge may overshoot the ceiling. A thrown consumer, invalid charge, or nonfinite cumulative overflow leaves the tally and signal unchanged. `consumed` is the lifetime spend and only ever grows after successful consumption. `start()` re-arms a fresh per-request `signal` WITHOUT resetting `consumed`, so the ceiling stays one running total across many requests; a budget already at or past `max` arms an immediately-aborted signal, bounding the next request from its first tick. `remaining` is `max - consumed` floored at zero, and `exhausted` is simply `consumed >= max` — both are live reads off the same counter.

**Options:** pass a parent `signal` to link an external cancel — the exposed `signal` then fires on EITHER exhaustion OR the parent aborting (through `AbortSignal.any`) and preserves the first reason. Pass a string `id` to label a handle for tracing, or omit it for a random UUID. Construction strictly requires a plain options record, a finite nonnegative `max`, a function `consumer`, and a native `AbortSignal` when `signal` is present. Invalid JavaScript-boundary input throws a structured `ContractError`. `max: 0` is derived as exhausted immediately, while its signal remains un-aborted until `start()` or `consume()` applies the ceiling.

### Factories

| API                   | Kind     | Summary                                                                                                             |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `createBudget`        | function | Create a `BudgetInterface<T>` for `max` with a `consumer`, optionally a trace `id` and a parent `signal`.           |
| `createTokenConsumer` | function | Create a unary consumer that charges one selected `TokenUsage` field.                                               |
| `createTokenBudget`   | function | Create a `BudgetInterface<TokenUsage>` charging a chosen `scope` field (`completion` default / `total` / `prompt`). |

### Validators

| API              | Kind     | Summary                                                                 |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `isBudgetAmount` | function | Guard a finite nonnegative numeric budget amount.                       |
| `isBudgetSignal` | function | Guard a genuine native `AbortSignal` without throwing on hostile input. |
| `isTokenScope`   | function | Guard a supported `TokenScope` field selector.                          |
| `isTokenUsage`   | function | Guard three finite nonnegative token counts without throwing.           |

### Helpers

| API                          | Kind     | Summary                                                                                        |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `validateBudgetOptions`      | function | Validate once-read budget options and return a fresh copy omitting absent optional keys.       |
| `validateTokenBudgetOptions` | function | Validate once-read token-budget options and return a fresh copy omitting absent optional keys. |

### Entities

| API      | Kind  | Summary                                                                                        |
| -------- | ----- | ---------------------------------------------------------------------------------------------- |
| `Budget` | class | A cumulative consumption tally whose `signal` fires when `consumed` reaches the `max` ceiling. |

### Types

| Type                 | Kind      | Shape                                                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BudgetOptions`      | interface | `{ id?: string; max: number; consumer: (value: T) => number; signal?: AbortSignal }` — options for `createBudget` / the constructor. |
| `TokenBudgetOptions` | interface | `{ id?: string; max: number; scope?: 'completion' \| 'total' \| 'prompt'; signal?: AbortSignal }` — options for `createTokenBudget`. |
| `BudgetInterface`    | interface | `id` / `signal` / `max` / `consumed` / `remaining` / `exhausted` data members + the `start` / `consume` / `clear` methods.           |
| `TokenScope`         | type      | `'completion' \| 'total' \| 'prompt'` — the exported token-usage field selector.                                                     |
| `TokenUsage`         | interface | `{ prompt: number; completion: number; total: number }` — the canonical LLM cost unit, the typical `T` for an agent budget.          |

The `id`, `signal`, `max`, `consumed`, `remaining`, and `exhausted` members of `BudgetInterface` are `readonly` data members (the preceding Surface rows) — its call-signature methods are documented under [Methods](#methods).

## Methods

The public methods of `BudgetInterface` — every call-signature member listed (its `readonly` data members `id` / `signal` / `max` / `consumed` / `remaining` / `exhausted` stay Surface rows). `Budget` implements the interface exactly, so this doubles as the class's instance-method surface.

#### `BudgetInterface`

`start` is the begin-or-restart verb — it re-arms a fresh per-request `signal` without resetting the cumulative tally; `consume` charges the tally and trips `signal` at the ceiling; `clear` is the reset — it zeroes the tally AND re-arms a fresh `signal`.

| Method    | Returns | Behavior                                                                                                                       |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `start`   | `void`  | Re-arm a fresh `signal` for the next request WITHOUT resetting `consumed`; if already at/past `max`, arm it aborted.           |
| `consume` | `void`  | Run the consumer first, validate and atomically add its charge, then trip `signal` at `max`; valid overshoot remains accepted. |
| `clear`   | `void`  | Reset the tally to `0` AND re-arm a fresh non-aborted `signal` (the lifecycle reset) — start the next window from zero.        |

## Contract

These invariants hold across `src/core` ↔ `budget.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the budgets module, and every export appears as a Surface row — exhaustive, both directions.
2. **Atomic ceiling signal.** `consume(value)` invokes the configured consumer before state changes. A finite nonnegative charge is added atomically; the moment `consumed >= max` the handle flips `exhausted` to `true` and aborts a private controller, so `signal` fires. The trip happens exactly once per armed signal — consuming further after exhaustion never re-aborts (idempotent), and a valid overshoot is accepted and trips it once. A consumer throw retains its identity; an invalid charge or nonfinite cumulative overflow throws a range-coded `ContractError`; every failure leaves `consumed` and `signal` unchanged.
3. **Cumulative tally, per-request signal.** `consumed` only ever grows under `consume()` — it is the lifetime spend, never reset by `start()`. `start()` re-arms a FRESH per-request `signal` (a different `AbortSignal` from the prior run's) while leaving `consumed` untouched, so the ceiling stays the same running total across requests. `remaining` is `max - consumed` floored at `0` (never negative); `exhausted` is `consumed >= max`.
4. **`clear()` resets the tally.** `clear()` is the lifecycle reset — it zeroes `consumed` AND re-arms a fresh `signal`, returning the budget to its born state (`consumed === 0`, `remaining === max`, `exhausted === false`, `signal.aborted === false` for a positive `max` (absent an already-aborted parent)), so `consume()` can refill the SAME ceiling from zero. It is the resettable counterpart to `start()` (which preserves the running total): a measure-since-an-event budget consumes toward `max`, takes its ceiling action, then `clear()`s to open the next window — for example an agent loop's compact-and-continue context window.
5. **Re-arm guard and zero ceiling.** `start()` on a budget already at or past `max` (`consumed >= max`) arms an immediately-aborted signal — a request opened on a spent budget is bounded from the very first tick. `max: 0` is derived as exhausted at construction and after `clear()`, while the newly composed signal remains un-aborted until `start()` or `consume()` applies that ceiling. (`clear()` on a positive `max` returns both derived state and signal to the unexhausted born state.)
6. **Parent links through `AbortSignal.any`.** With a parent `signal`, the exposed `signal` is `AbortSignal.any([own, parent])`, so it fires on EITHER exhaustion OR the parent aborting — without re-implementing listener wiring. Exhaustion still fires when the parent never aborts; a parent abort fires `signal` independent of consumption (the budget need not be exhausted). A parent ALREADY aborted at construction makes the current `signal` born aborted, carrying the parent's reason. The composite is computed once per arm (construction + each `start()` / `clear()`) and stored, never recomputed per read — so reads do not accumulate listeners (a peer to `Abort`'s composite handling).
7. **Composes with abort/timeout.** Because `signal` is a plain `AbortSignal`, a `Budget` folds into a combined bound with a cancellation signal and a deadline signal through `AbortSignal.any([abort, timeout, budget])` — the combined signal fires on whichever trips first (the agent-loop pattern).
8. **Traceable identity.** `id` is a stable string for the handle's lifetime — caller-supplied through `options.id`, including an empty string, or a `crypto.randomUUID()` default only when `id` is omitted. `max` is the validated ceiling, exposed read-only. The abort reason on owned exhaustion is the platform default `AbortError` `DOMException`.
9. **Strict once-read boundaries.** `validateBudgetOptions` and `validateTokenBudgetOptions` accept the typed contracts while defending their hostile JavaScript boundary: they require a plain record, read each declared property exactly once inside a contained boundary, validate with structured `ContractError` taxonomy/context, and return a fresh normalized object that omits absent optional keys. `Budget` calls the budget helper before allocating its controller; `createTokenBudget` calls the token helper before creating its consumer and public budget.
10. **Validated token accounting.** `TokenScope` is the public `'completion' | 'total' | 'prompt'` selector and defaults to `completion` in `createTokenBudget`. Token factories reject unsupported scopes and malformed usage; all three `TokenUsage` fields must be finite and nonnegative before the selected charge is used.
11. **Total guards.** `isBudgetAmount`, `isBudgetSignal`, `isTokenScope`, and `isTokenUsage` return `false`, rather than throw, for off-shape, hostile, or revoked input.
12. **Signal-only observation.** This primitive has no Emitter, `EventMap`, or `on` hook. Its native `AbortSignal` is the observation mechanism.
13. **DOC ↔ SOURCE method bijection.** The `## Methods` table lists exactly `BudgetInterface`'s public methods — exhaustive, both directions — and `Budget` exposes the same public methods, no more.

## Patterns

### Race work against the ceiling

The dominant use: bound how much work may spend by racing it against the budget `signal`.

```ts
import { createBudget } from '@orkestrel/budget'

const budget = createBudget<number>({ max: 1_000_000, consumer: (bytes) => bytes })
budget.start()
budget.signal.addEventListener('abort', () => abortStream(), { once: true })

for await (const chunk of stream) {
	if (budget.signal.aborted) break // the ceiling was crossed mid-stream
	budget.consume(chunk.byteLength)
	process(chunk)
}
```

### A token budget folded into an agent loop's bound

The headline use the primitive exists for: a token budget consumed per provider call, its `signal` folded into the loop's abort alongside an external cancel and a deadline — `AbortSignal.any` over all three bounds, whichever trips first.

```ts
import { createTokenBudget } from '@orkestrel/budget'

const cancel = new AbortController() // external cancel
const deadline = AbortSignal.timeout(60_000) // wall-clock deadline
const budget = createTokenBudget({ max: 50_000, scope: 'total' }) // cost ceiling

budget.start()
// The agent loop's single bound — fires on cancel OR deadline OR budget.
const bound = AbortSignal.any([cancel.signal, deadline, budget.signal])

while (!bound.aborted) {
	const usage = await callProvider() // → { prompt, completion, total }
	budget.consume(usage) // fires budget.signal after the ceiling is crossed
}
```

### Re-arm per request, spend across the session

`start()` re-arms the per-request `signal` while the cumulative spend carries forward — a session-long budget that bounds each request and is born exhausted after the lifetime ceiling is reached.

```ts
import { createTokenBudget } from '@orkestrel/budget'

const budget = createTokenBudget({ max: 1_000_000, scope: 'total' })
for (const request of requests) {
	budget.start() // fresh per-request signal; cumulative spend preserved
	if (budget.signal.aborted) break // the session ceiling was already reached
	await runWithBound(request, budget) // consume(usage) inside, race budget.signal
}
```

### Reuse a handle with `clear()`

`clear()` zeroes the tally and re-arms a fresh signal, so a spent budget can open a new window from scratch — for example an agent loop that compacts context and continues.

```ts
import { createBudget } from '@orkestrel/budget'

const budget = createBudget<number>({ max: 1_000, consumer: (n) => n })
budget.start()
budget.consume(1_000) // crosses the ceiling — signal fires, exhausted is true

budget.clear() // consumed resets to 0, remaining is max again, signal is fresh
budget.consume(200) // spends against the new window
```

### Practices

- **`start()` then race the `signal`** — re-arm the per-request signal, then race `signal` against the work to bound its spend.
- **`consume()` as you spend** — charge the tally with the real cost (tokens, bytes, calls) at each step; the ceiling trips `signal` automatically.
- **Fold into the loop's bound** — combine `budget.signal` with an abort and a timeout through `AbortSignal.any` so one bound covers cancel, deadline, and cost.
- **Cumulative, not per-request** — remember `consumed` is the lifetime spend; `start()` re-arms the signal, it does NOT reset the tally.
- **Observe the signal** — this is a functional primitive; its native `AbortSignal` is the complete observation boundary.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports) and the `BudgetInterface` ↔ `Budget` method bijection.
- [`tests/src/core/Budget.test.ts`](../tests/src/core/Budget.test.ts) — strict construction, cumulative and atomic consumption, valid overshoot, thrown-consumer identity, numeric overflow, zero-ceiling semantics, lifecycle re-arming/reset, parent reason preservation, and public type shape.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — real generic/token factory behavior plus untyped scope, usage, options, hostile, and revoked boundary failures with exact structured errors.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — direct option-helper fresh-copy and optional-key omission, exactly-once property reads, hostile getter containment, generic preservation, and exact error taxonomy/context.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — total amount, native-signal, token-scope, and token-usage guards across valid, off-shape, hostile, and revoked values.

## See also

- [`AGENTS.md`](../AGENTS.md) — the pointer to the `@orkestrel/scaffold` coding and orchestration authority.
- [`../README.md`](README.md) — the guides index.
