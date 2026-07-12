# Budget

> The cost primitive: a cumulative consumption tally against a ceiling that exposes an `AbortSignal` firing the moment the budget is **exhausted**. You charge a `Budget<T>` as work spends — `consume(value)` adds to a running `consumed` total — and race its `signal` against that work to cap how much it may burn (tokens, bytes, calls). When `consumed` crosses `max`, `signal` aborts; fold it into a loop's bound so the loop stops generating once the budget is spent.
>
> This is the substrate's third bounding signal, a peer to a cancellation signal (fires on `abort()`) and a deadline signal (fires on expiry). All three are plain `AbortSignal`s by design, so an agent loop combines them into one bound with `AbortSignal.any([abort, timeout, budget])` and reacts to whichever trips first — cancel, deadline, or cost. What a budget deliberately is **not**: it carries no Emitter and no events (it is **event-free for now** — the observability pass owns that wiring), and it does no clock or I/O of its own. It is a pure, functional counter with a signal bolted to its ceiling — nothing more, so the surface stays small.
>
> Source: [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a cost handle, `start()` it, and race its `signal` against work; `consume(value)` to charge the tally as work spends:

```ts
import { createBudget } from '@src/core'

const budget = createBudget<number>({ max: 10_000, consume: (cost) => cost })
budget.start()
budget.signal.addEventListener('abort', () => stop()) // fires when exhausted
budget.consume(4_000) // remaining 6_000
budget.consume(7_000) // crosses 10_000 — fires `signal`
```

**What happens:** `consume(value)` runs your extractor and adds the result to `consumed`; the moment cumulative `consumed` reaches `max`, `exhausted` flips `true` and `signal` fires — exactly once. `consumed` is the lifetime spend and only ever grows. `start()` re-arms a fresh per-request `signal` WITHOUT resetting `consumed`, so the ceiling stays one running total across many requests; a budget already at or past `max` arms an immediately-aborted signal, bounding the next request from its first tick. `remaining` is `max - consumed` floored at zero, and `exhausted` is simply `consumed >= max` — both are live reads off the same counter.

**Options:** pass a parent `signal` to link an external cancel — the exposed `signal` then fires on EITHER exhaustion OR the parent aborting (via `AbortSignal.any`). Pass `id` to label a handle for tracing, or let it default to a random UUID. `max` should be a non-negative finite number; `max: 0` is exhausted from the first `start()` / `consume`.

### Factories

| API                 | Kind     | Summary                                                                                                             |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `createBudget`      | function | Create a `BudgetInterface<T>` for `max` with a `consume` extractor, optionally a trace `id` and a parent `signal`.  |
| `createTokenBudget` | function | Create a `BudgetInterface<TokenUsage>` charging a chosen `scope` field (`completion` default / `total` / `prompt`). |

### Entities

| API      | Kind  | Summary                                                                                        |
| -------- | ----- | ---------------------------------------------------------------------------------------------- |
| `Budget` | class | A cumulative consumption tally whose `signal` fires when `consumed` reaches the `max` ceiling. |

### Types

| Type                 | Kind      | Shape                                                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BudgetOptions`      | interface | `{ id?: string; max: number; consume: (value: T) => number; signal?: AbortSignal }` — options for `createBudget` / the constructor.  |
| `TokenBudgetOptions` | interface | `{ id?: string; max: number; scope?: 'completion' \| 'total' \| 'prompt'; signal?: AbortSignal }` — options for `createTokenBudget`. |
| `BudgetInterface`    | interface | `id` / `signal` / `max` / `consumed` / `remaining` / `exhausted` data members + the `start` / `consume` / `clear` methods.           |
| `TokenUsage`         | interface | `{ prompt: number; completion: number; total: number }` — the canonical LLM cost unit, the typical `T` for an agent budget.          |

The `id`, `signal`, `max`, `consumed`, `remaining`, and `exhausted` members of `BudgetInterface` are `readonly` data members (Surface rows, above) — its call-signature methods are documented under [Methods](#methods).

## Methods

The public methods of `BudgetInterface` — every call-signature member listed (its `readonly` data members `id` / `signal` / `max` / `consumed` / `remaining` / `exhausted` stay Surface rows). `Budget` implements the interface exactly, so this doubles as the class's instance-method surface (AGENTS §22).

#### `BudgetInterface`

`start` is the §10 begin/restart verb — it re-arms a fresh per-request `signal` without resetting the cumulative tally; `consume` charges the tally and trips `signal` at the ceiling; `clear` is the §10 reset — it zeroes the tally AND re-arms a fresh `signal`.

| Method    | Returns | Behavior                                                                                                             |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `start`   | `void`  | Re-arm a fresh `signal` for the next request WITHOUT resetting `consumed`; if already at/past `max`, arm it aborted. |
| `consume` | `void`  | Charge the cumulative tally by `consume(value)`; trip `signal` once when `consumed` reaches `max`.                   |
| `clear`   | `void`  | Reset the tally to `0` AND re-arm a fresh non-aborted `signal` (the §10 reset) — start the next window from zero.    |

## Contract

These invariants hold across `src/core` ↔ `budget.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the budgets module, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Ceiling signal.** `consume(value)` adds `consume(value)` to a cumulative `consumed`; the moment `consumed >= max` the handle flips `exhausted` to `true` and aborts a private controller, so `signal` fires. The trip happens exactly once per armed signal — consuming further once exhausted never re-aborts (idempotent), and a single `consume` that overshoots `max` trips it once.
3. **Cumulative tally, per-request signal (§10).** `consumed` only ever grows under `consume()` — it is the lifetime spend, never reset by `start()`. `start()` re-arms a FRESH per-request `signal` (a different `AbortSignal` from the prior run's) while leaving `consumed` untouched, so the ceiling stays the same running total across requests. `remaining` is `max - consumed` floored at `0` (never negative); `exhausted` is `consumed >= max`.
4. **`clear()` resets the tally (§10).** `clear()` is the §10 reset — it zeroes `consumed` AND re-arms a fresh `signal`, returning the budget to its born state (`consumed === 0`, `remaining === max`, `exhausted === false`, `signal.aborted === false` for a positive `max` (absent an already-aborted parent)), so `consume()` can refill the SAME ceiling from zero. It is the resettable counterpart to `start()` (which preserves the running total): a measure-since-an-event budget consumes toward `max`, takes its ceiling action, then `clear()`s to open the next window — e.g. an agent loop's compact-and-continue context window.
5. **Re-arm guard.** `start()` on a budget already at or past `max` (`consumed >= max`) arms an immediately-aborted signal — a request opened on a spent budget is bounded from the very first tick (mirroring how `Timeout.start` honors an already-aborted parent). `max: 0` is therefore exhausted from the first `start()` / `consume`. (`clear()`, by contrast, zeroes `consumed` first, so its fresh signal is born un-aborted for a positive `max`.)
6. **Parent links via `AbortSignal.any`.** With a parent `signal`, the exposed `signal` is `AbortSignal.any([own, parent])`, so it fires on EITHER exhaustion OR the parent aborting — without re-implementing listener wiring. Exhaustion still fires when the parent never aborts; a parent abort fires `signal` independent of consumption (the budget need not be exhausted). A parent ALREADY aborted at construction makes the current `signal` born aborted, carrying the parent's reason. The composite is computed once per arm (construction + each `start()` / `clear()`) and stored, never recomputed per read — so reads do not accumulate listeners (a peer to `Abort`'s composite handling).
7. **Composes with abort/timeout.** Because `signal` is a plain `AbortSignal`, a `Budget` folds into a combined bound with a cancellation signal and a deadline signal via `AbortSignal.any([abort, timeout, budget])` — the combined signal fires on whichever trips first (the agent-loop pattern).
8. **Traceable identity.** `id` is a stable string for the handle's lifetime — caller-supplied via `options.id`, or a `crypto.randomUUID()` default (used whenever `options.id` is absent or not a string) that is unique across instances. `max` is the configured ceiling, exposed read-only. The abort reason on exhaustion is the platform default `AbortError` `DOMException`.
9. **Construction guard.** A non-function `options.consume` throws a `TypeError` at construction — `Budget` refuses to build a handle it cannot charge.
10. **Event-free (for now).** A pure functional primitive: no Emitter, no `EventMap`, no `on` hook. Observability is a separate deferred pass (the ROADMAP), so the surface above stays minimal.
11. **DOC ↔ SOURCE method bijection.** The `## Methods` table lists exactly `BudgetInterface`'s public methods — exhaustive, both directions — and `Budget` exposes the same public methods, no more (AGENTS §22).

## Patterns

### Race work against the ceiling

The dominant use: bound how much work may spend by racing it against the budget `signal`.

```ts
import { createBudget } from '@src/core'

const budget = createBudget<number>({ max: 1_000_000, consume: (bytes) => bytes })
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
import { createTokenBudget } from '@src/core'

const cancel = new AbortController() // external cancel
const deadline = AbortSignal.timeout(60_000) // wall-clock deadline
const budget = createTokenBudget({ max: 50_000, scope: 'total' }) // cost ceiling

budget.start()
// The agent loop's single bound — fires on cancel OR deadline OR budget.
const bound = AbortSignal.any([cancel.signal, deadline, budget.signal])

while (!bound.aborted) {
	const usage = await callProvider() // → { prompt, completion, total }
	budget.consume(usage) // fires budget.signal once the ceiling is crossed
}
```

### Re-arm per request, spend across the session

`start()` re-arms the per-request `signal` while the cumulative spend carries forward — a session-long budget that bounds each request and is born exhausted once the lifetime ceiling is reached.

```ts
import { createTokenBudget } from '@src/core'

const budget = createTokenBudget({ max: 1_000_000, scope: 'total' })
for (const request of requests) {
	budget.start() // fresh per-request signal; cumulative spend preserved
	if (budget.signal.aborted) break // the session ceiling was already reached
	await runWithBound(request, budget) // consume(usage) inside, race budget.signal
}
```

### Reuse a handle with `clear()`

`clear()` zeroes the tally and re-arms a fresh signal, so a spent budget can open a new window from scratch — e.g. an agent loop that compacts context and continues.

```ts
import { createBudget } from '@src/core'

const budget = createBudget<number>({ max: 1_000, consume: (n) => n })
budget.start()
budget.consume(1_000) // crosses the ceiling — signal fires, exhausted is true

budget.clear() // consumed resets to 0, remaining is max again, signal is fresh
budget.consume(200) // spends against the new window
```

### Practices

- **`start()` then race the `signal`** — re-arm the per-request signal, then race `signal` against the work to bound its spend.
- **`consume()` as you spend** — charge the tally with the real cost (tokens, bytes, calls) at each step; the ceiling trips `signal` automatically.
- **Fold into the loop's bound** — combine `budget.signal` with an abort and a timeout via `AbortSignal.any` so one bound covers cancel, deadline, and cost.
- **Cumulative, not per-request** — remember `consumed` is the lifetime spend; `start()` re-arms the signal, it does NOT reset the tally.
- **No events yet** — this is a functional primitive; do not reach for an Emitter here (observability is a separate pass).

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/core/budgets` bijection (value + type exports) and the `BudgetInterface` ↔ `Budget` method bijection.
- [`tests/src/core/Budget.test.ts`](../../tests/src/core/Budget.test.ts) — `consume` accumulates and `consumed` / `remaining` / `exhausted` track each step; `signal` fires exactly when `consumed` reaches `max` (not before); a single overshooting `consume` trips it once; consuming past `max` is idempotent (no double-abort); `start()` re-arms a fresh non-aborted signal without resetting `consumed`, and arms an immediately-aborted signal when already exhausted (the re-arm guard); a sub-ceiling `start()` can later trip the fresh signal; `clear()` resets the tally to `0` and re-arms a fresh non-aborted signal (the §10 reset), after which `consume` can refill the same ceiling; parent linking (a parent abort fires `signal` independent of consumption; exhaustion still fires when the parent never aborts; an already-aborted parent makes `signal` born aborted with the parent reason); composition with an `Abort` via `AbortSignal.any` (whichever of cancel / ceiling trips first fires the combined signal); the parent-link composite holds no super-linear listener accumulation across `start()` cycles; `max: 0` boundaries (exhausted on first `consume` / `start()`); the exhaustion abort reason is the default `AbortError`; custom `consume` extraction and a `TokenUsage` field round-trip; and `id` defaulting / uniqueness.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createBudget` returns a working `BudgetInterface` that accumulates and exhausts, honors `id` and a parent `signal`; `createTokenBudget` charges the right `scope` field (`completion` default, `total`, `prompt`) and honors `id` / parent `signal`.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §10 lifecycle (`start`, `clear`), §4.1 single-word members, §22 documentation-as-contracts.
- [`../README.md`](../README.md) — the guides index.
