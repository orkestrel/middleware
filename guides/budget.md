# Budget

> The cost primitive: a cumulative consumption tally against a ceiling that exposes an
> `AbortSignal` firing the moment `consumed` reaches `max`.

A budget handle is what an agent loop holds to keep a whole run inside one cost limit, in place of a cost check written at every call site. Hand its `signal` to the work, race that signal against a call, or fold it into a loop's bound. You define what is spent — tokens, bytes, dollars, or calls — so the same handle covers a provider's token usage and a pipeline's byte throughput.

A budget is the substrate's third bounding signal, a peer to a cancellation signal (fires on `abort()`) and a deadline signal (fires on expiry). All three are plain `AbortSignal`s by design, so an agent loop combines them into one bound with `AbortSignal.any([abort, timeout, budget])` and reacts to whichever trips first — cancel, deadline, or cost. The primitive deliberately carries no Emitter, clock, or I/O: its native signal is the complete observation boundary. The budget is a functional counter with a signal bolted to its ceiling. The `Meter` beside it charges a budget as a stream arrives, for a cost that is a function of the whole streamed text rather than a sum of its pieces. When the ceiling is reached, the signal aborts with a `BudgetError` that names the budget and its readings, so a stop is traceable to the budget that caused it. Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a cost handle, `start()` it, and charge it as the work spends:

```ts
import { createBudget } from '@orkestrel/budget'

const budget = createBudget<number>({ max: 10_000, consumer: (cost) => cost })
budget.start()
budget.signal.addEventListener('abort', () => stop()) // fires when exhausted
budget.consume(4_000) // remaining 6_000
budget.consume(7_000) // crosses 10_000 — fires `signal`
```

**What happens:** `consume(value)` runs your consumer first, validates its result as a finite nonnegative charge, and atomically adds it to `consumed`; the moment cumulative `consumed` reaches `max`, `exhausted` flips `true` and `signal` fires — exactly once. A valid charge may overshoot the ceiling. A thrown consumer, invalid charge, or nonfinite cumulative overflow leaves the tally and signal unchanged. `consumed` is the lifetime spend and only ever grows after successful consumption. `start()` re-arms a fresh per-request `signal` WITHOUT resetting `consumed`, so the ceiling stays one running total across many requests; a budget already at or past `max` arms an immediately-aborted signal, bounding the next request from its first tick. `remaining` is `max - consumed` floored at zero, and `exhausted` is `consumed >= max` — both are live reads off the same counter.

**Options:** pass a parent `signal` to link an external cancel — the exposed `signal` then fires on EITHER exhaustion OR the parent aborting (through `AbortSignal.any`) and preserves the first reason. Pass a string `id` to label a handle for tracing, or omit it for a random UUID. Construction strictly requires a plain options record, a finite nonnegative `max`, a function `consumer`, and a native `AbortSignal` when `signal` is present. Invalid JavaScript-boundary input throws a structured `ContractError`. `max: 0` is derived as exhausted immediately, while its signal remains un-aborted until `start()` or `consume()` applies the ceiling.

### Factories

| Name                  | Kind     | Signature                                                      | Summary                                                                                                                                                            |
| --------------------- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createBudget`        | function | `<T>(options: BudgetOptions<T>) => BudgetInterface<T>`         | Creates a cumulative budget as a `BudgetInterface<T>` over a `max` ceiling and a `consumer`, whose native signal aborts the moment the tally reaches that ceiling. |
| `createTokenConsumer` | function | `(scope: TokenScope) => BudgetOptions<TokenUsage>['consumer']` | Creates a validated unary consumer that charges one selected `TokenUsage` field.                                                                                   |
| `createTokenBudget`   | function | `(options: TokenBudgetOptions) => BudgetInterface<TokenUsage>` | Creates a token budget as a `BudgetInterface<TokenUsage>` charging one validated `scope` field per provider call.                                                  |
| `createTokenMeter`    | function | `(options: TokenMeterOptions) => MeterInterface`               | Creates a token meter as a `MeterInterface` that charges a token budget each growth of a streamed answer's estimated token count as completion tokens.             |

### Validators

In a guard table a `Shape` cell holds the type the guard narrows to.

| Name             | Kind     | Signature                                               | Summary                                                                                                                                        |
| ---------------- | -------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `isBudget`       | function | `(value: unknown) => value is BudgetInterface<unknown>` | Determines whether a value implements `BudgetInterface`, returning `false` rather than throwing on hostile input.                              |
| `isBudgetError`  | function | `(value: unknown) => value is BudgetError`              | Checks whether an unknown value is a `BudgetError` built by any copy of this package, so an abort reason can be read as a budget's exhaustion. |
| `isBudgetAmount` | function | `(value: unknown) => value is number`                   | Determines whether a value is a finite nonnegative budget amount.                                                                              |
| `isBudgetSignal` | function | `(value: unknown) => value is AbortSignal`              | Determines whether a value is a genuine native `AbortSignal`, returning `false` rather than throwing on hostile input.                         |
| `isTokenScope`   | function | `(value: unknown) => value is TokenScope`               | Determines whether a value is a supported `TokenScope` field selector.                                                                         |
| `isTokenUsage`   | function | `(value: unknown) => value is TokenUsage`               | Determines whether a value is readable token usage carrying three finite nonnegative counts, returning `false` rather than throwing.           |

### Helpers

| Name                         | Kind     | Signature                                             | Summary                                                                                                       |
| ---------------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `validateBudgetOptions`      | function | `<T>(options: BudgetOptions<T>) => BudgetOptions<T>`  | Validates and normalizes budget construction options into a fresh copy that omits absent optional keys.       |
| `validateTokenBudgetOptions` | function | `(options: TokenBudgetOptions) => TokenBudgetOptions` | Validates and normalizes token-budget construction options into a fresh copy that omits absent optional keys. |
| `validateMeterOptions`       | function | `<T>(options: MeterOptions<T>) => MeterOptions<T>`    | Validates and normalizes meter construction options into a fresh copy.                                        |
| `validateTokenMeterOptions`  | function | `(options: TokenMeterOptions) => TokenMeterOptions`   | Validates and normalizes token-meter construction options into a fresh copy.                                  |

### Classes

| Name          | Kind  | Signature                                                  | Summary                                                                                                                                                                                                              |
| ------------- | ----- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Budget`      | class | `new <T>(options: BudgetOptions<T>) => BudgetInterface<T>` | Implements `BudgetInterface` over a private `AbortController` the instance owns, aborting the composed signal the moment `consumed` reaches the `max` ceiling.                                                       |
| `Meter`       | class | `new <T>(options: MeterOptions<T>) => MeterInterface`      | Implements `MeterInterface` for one stream, charging a budget the growth of the streamed text's estimated cost as each delta arrives.                                                                                |
| `BudgetError` | class | `new (context: BudgetErrorContext) => BudgetError`         | Reports a budget whose cumulative tally reached its ceiling — the abort reason of the budget's own `signal`, carrying the machine-readable `code` `'exhaust'` and the budget's `id`, `max`, and `consumed` readings. |

### Constants

| Name                 | Kind  | Signature       | Summary                                                                                     |
| -------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------- |
| `BUDGET_ERROR_BRAND` | const | `unique symbol` | Holds the registry-global key used to recognize `BudgetError` values across package copies. |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Name                 | Kind      | Signature                                                                          | Summary                                                                                                                                                                                                                     |
| -------------------- | --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BudgetOptions`      | interface | `{ id?, max, consumer, signal? }`                                                  | Represents the options for constructing a cumulative budget, accepted by the `createBudget` function and the `Budget` constructor.                                                                                          |
| `TokenBudgetOptions` | interface | `{ id?, max, scope?, signal? }`                                                    | Represents the options for constructing a token budget, accepted by the `createTokenBudget` function.                                                                                                                       |
| `BudgetInterface`    | interface | `{ id, signal, max, consumed, remaining, exhausted, start(), consume(), clear() }` | Represents the cumulative cost handle contract: a lifetime tally, its validated ceiling, and the native signal that aborts when the tally reaches that ceiling.                                                             |
| `TokenScope`         | type      | `'completion' \| 'total' \| 'prompt'`                                              | Names the token-usage field selected as the charge for a token budget.                                                                                                                                                      |
| `TokenUsage`         | interface | `{ prompt, completion, total }`                                                    | Represents the canonical LLM cost unit: the finite nonnegative token counts reported for one provider call, and the typical `T` for an agent budget.                                                                        |
| `MeterOptions`       | interface | `{ budget, estimator, producer }`                                                  | Represents the options for constructing a meter, accepted by the `Meter` constructor.                                                                                                                                       |
| `TokenMeterOptions`  | interface | `{ budget, estimator }`                                                            | Represents the options for constructing a token meter, accepted by the `createTokenMeter` function.                                                                                                                         |
| `MeterInterface`     | interface | `{ charged, charge() }`                                                            | Represents the stream meter contract: it measures text as it streams and charges a budget the growth of the text's estimated cost, keeping the cost already charged so a later reported total can be reconciled against it. |
| `BudgetErrorContext` | interface | `{ id, max, consumed }`                                                            | Represents the readings a `BudgetError` carries: the exhausted budget's trace `id`, its `max` ceiling, and its `consumed` tally at the moment the ceiling was reached.                                                      |

The `id`, `signal`, `max`, `consumed`, `remaining`, and `exhausted` members of `BudgetInterface` are `readonly` data members (the preceding Surface rows) — its call-signature methods are documented under [Methods](#methods). The `charged` member of `MeterInterface` is a `readonly` data member; its call-signature method is documented under [Methods](#methods).

## Methods

The public methods of `BudgetInterface` and `MeterInterface` — every call-signature member listed (the `readonly` data members `id` / `signal` / `max` / `consumed` / `remaining` / `exhausted` of the budget and `charged` of the meter stay Surface rows). `Budget` and `Meter` implement their interfaces exactly, so this doubles as each class's instance-method surface.

#### `BudgetInterface`

`start` is the begin-or-restart verb — it re-arms a fresh per-request `signal` without resetting the cumulative tally; `consume` charges the tally and trips `signal` at the ceiling; `clear` is the reset — it zeroes the tally AND re-arms a fresh `signal`.

| Method    | Returns | Summary                                                                                                                                                                                          |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`   | `void`  | Re-arms a fresh per-request `signal` without resetting the cumulative tally, arming it already aborted when `consumed` has reached `max`.                                                        |
| `consume` | `void`  | Runs the configured consumer first, then validates and atomically adds its charge, tripping `signal` the moment the tally reaches `max`; a valid charge that overshoots the ceiling is accepted. |
| `clear`   | `void`  | Resets the tally to `0` and re-arms a fresh unaborted `signal`, opening the next window from zero.                                                                                               |

#### `MeterInterface`

`charge` extends the measured text by one delta and charges the budget the growth of its estimated cost; a meter serves one stream and has no reset.

| Method   | Returns | Summary                                                                                                                                           |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charge` | `void`  | Extends the measured text by one delta and charges the budget the growth of its estimated cost, charging nothing when the estimate does not grow. |

## Contract

These invariants hold across `src/core` ↔ `budget.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the budgets module, and every export appears as a Surface row — exhaustive, both directions.
2. **Atomic ceiling signal.** `consume(value)` invokes the configured consumer before state changes. A finite nonnegative charge is added atomically; the moment `consumed >= max` the handle flips `exhausted` to `true` and aborts a private controller, so `signal` fires. The trip happens exactly once per armed signal — consuming further after exhaustion never re-aborts (idempotent), and a valid overshoot is accepted and trips it once. A consumer throw retains its identity; an invalid charge or nonfinite cumulative overflow throws a range-coded `ContractError`; every failure leaves `consumed` and `signal` unchanged.
3. **Cumulative tally, per-request signal.** `consumed` only ever grows under `consume()` — it is the lifetime spend, never reset by `start()`. `start()` re-arms a FRESH per-request `signal` (a different `AbortSignal` from the prior run's) while leaving `consumed` untouched, so the ceiling stays the same running total across requests. `remaining` is `max - consumed` floored at `0` (never negative); `exhausted` is `consumed >= max`.
4. **`clear()` resets the tally.** `clear()` is the lifecycle reset — it zeroes `consumed` AND re-arms a fresh `signal`, returning the budget to its born state (`consumed === 0`, `remaining === max`, `exhausted === false`, `signal.aborted === false` for a positive `max` (absent an already-aborted parent)), so `consume()` can refill the SAME ceiling from zero. It is the resettable counterpart to `start()` (which preserves the running total): a measure-since-an-event budget consumes toward `max`, takes its ceiling action, then `clear()`s to open the next window — for example an agent loop's compact-and-continue context window.
5. **Re-arm guard and zero ceiling.** `start()` on a budget already at or past `max` (`consumed >= max`) arms an immediately-aborted signal — a request opened on a spent budget is bounded from the very first tick. `max: 0` is derived as exhausted at construction and after `clear()`, while the newly composed signal remains un-aborted until `start()` or `consume()` applies that ceiling. (`clear()` on a positive `max` returns both derived state and signal to the unexhausted born state.)
6. **Parent links through `AbortSignal.any`.** With a parent `signal`, the exposed `signal` is `AbortSignal.any([own, parent])`, so it fires on EITHER exhaustion OR the parent aborting — without re-implementing listener wiring. Exhaustion still fires when the parent never aborts; a parent abort fires `signal` independent of consumption (the budget need not be exhausted). A parent ALREADY aborted at construction makes the current `signal` born aborted, carrying the parent's reason. The composite is computed once per arm (construction + each `start()` / `clear()`) and stored, never recomputed per read — so reads do not accumulate listeners (a peer to `Abort`'s composite handling).
7. **Composes with abort/timeout.** Because `signal` is a plain `AbortSignal`, a `Budget` folds into a combined bound with a cancellation signal and a deadline signal through `AbortSignal.any([abort, timeout, budget])` — the combined signal fires on whichever trips first (the agent-loop pattern).
8. **Traceable identity.** `id` is a stable string for the handle's lifetime — caller-supplied through `options.id`, including an empty string, or a `crypto.randomUUID()` default only when `id` is omitted. `max` is the validated ceiling, exposed read-only. The abort reason on owned exhaustion is a `BudgetError` coded `'exhaust'` with the fixed message `budget reached its ceiling`, whose `context` holds the `id`, `max`, and `consumed` at the crossing; a parent abort keeps the parent's reason, including when the parent aborted before the crossing and nothing had read the composite signal. `consume` tests the composed signal, not the owned controller, before it aborts the controller, so the parent's reason survives whether or not the host's `AbortSignal.any` has propagated the parent's abort yet; on Node 24.22.0 the propagation is eager and an owned-controller test gives the same reason.
9. **Strict once-read boundaries.** `validateBudgetOptions`, `validateTokenBudgetOptions`, `validateMeterOptions`, and `validateTokenMeterOptions` accept the typed contracts while defending their hostile JavaScript boundary: they require a plain record, read each declared property exactly once inside a contained boundary, validate with structured `ContractError` taxonomy/context, and return a fresh normalized object that omits absent optional keys. `Budget` calls the budget helper before allocating its controller; `createTokenBudget` calls the token helper before creating its consumer and public budget; `Meter` calls the meter helper before it stores anything; `createTokenMeter` calls the token-meter helper before it composes the meter.
10. **Validated token accounting.** `TokenScope` is the public `'completion' | 'total' | 'prompt'` selector and defaults to `completion` in `createTokenBudget`. Token factories reject unsupported scopes and malformed usage; all three `TokenUsage` fields must be finite and nonnegative before the selected charge is used.
11. **Total guards and cross-copy recognition.** `isBudget`, `isBudgetAmount`, `isBudgetError`, `isBudgetSignal`, `isTokenScope`, and `isTokenUsage` return `false`, rather than throw, for off-shape, hostile, or revoked input. `isBudgetError` uses the identity brand instead of `instanceof BudgetError`, while retaining the native `Error` base check. The constructor stamps `BUDGET_ERROR_BRAND`, the registry-global `Symbol.for('@orkestrel/budget.error')`, as a non-enumerable own property whose value is the error itself. The guard requires that exact identity, the native `Error` base, a prototype other than `Error.prototype`, the code `'exhaust'`, and a `context` holding a string `id` and number `max` and `consumed`. Subclass instances and renamed errors pass without reading `name`. One rule serves every copy: a reason built by another installation, or by the CommonJS entry when the guard came from the ESM entry, narrows exactly as one built by the same copy, and the reverse holds too. A transparent proxy over a genuine error is refused, because its forwarded descriptor stores the target. An unbranded `Error` carrying `code: 'exhaust'`, and an error from a copy that stamps no brand, such as 0.0.13, stay outside the type. The brand is a recognition marker, not proof of origin: a complete forgery that stamps its own identity under the key passes.
12. **Signal-only observation.** Neither `Budget` nor `Meter` has an Emitter, `EventMap`, or `on` hook. The budget's native `AbortSignal` is the observation mechanism.
13. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly the public methods of `BudgetInterface` and `MeterInterface` — exhaustive, both directions — and `Budget` and `Meter` expose the same public methods as their interfaces, no more.
14. **Growth metering.** `charge(delta)` refuses a non-string delta with a `literal`-coded `ContractError` before any state changes. It then counts the delta, estimates the whole text, refuses a nonfinite or negative estimate with a `range`-coded `ContractError`, and measures the estimate's growth over the growth the budget has accepted plus the growth of every charge still in flight. Only when that growth is positive does it consume `producer(growth)`. Each charge in flight holds a per-call claim of its growth from before the producer runs until the charge settles, so a charge that re-enters the meter synchronously, through the producer, the budget's consumer, or an abort listener the crossing fires, measures its own growth past the claims and the nested and outer charges sum to the serial result. `charged` is the total growth the budget accepted from this meter: it rises by a charge's growth only after the budget's `consume` returns, and a throw from the producer or the budget drops the claim and raises nothing. For a budget the meter alone charges and never clears, `charged` therefore equals the budget's `consumed` whenever no charge is in flight, in serial use, under re-entry through the producer or the budget's consumer, and under refusal. A nested charge an abort listener makes is added before the outer charge, which the budget added first, so with growths that are not integers the two can differ in the last digit. In serial use `charged` equals the latest accepted estimate up to floating-point rounding. A throw from the estimator, or a refused estimate, claims nothing. Every refusal leaves the delta counted, and the next charge measures the growth from the text that includes it. A meter has no reset; create one per stream.
15. **Token metering.** `createTokenMeter` consumes each growth `n` as `{ prompt: 0, completion: n, total: n }`. A `completion`- or `total`-scoped budget therefore tracks the answer, and a `prompt`-scoped budget is charged `0`. `charged` is the completion growth the budget accepted, which a reported usage is reconciled against.

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

### Meter a streamed answer

Charge a token budget while an answer streams, then charge the provider's reported usage less `meter.charged` so no token is charged twice.

```ts
import { createTokenBudget, createTokenMeter } from '@orkestrel/budget'

const budget = createTokenBudget({ max: 1_000, scope: 'completion' })
const meter = createTokenMeter({ budget, estimator: (text) => Math.ceil(text.length / 4) })
meter.charge('Once upon') // estimate 3 — consumes 3 completion tokens
meter.charge(' a') // estimate still 3 — charges nothing
meter.charge(' time') // estimate 4 — consumes 1 more
budget.consumed // 4
```

### Trace an exhaustion

When the ceiling is reached, the budget's `signal` aborts with a `BudgetError`. Narrow the reason with `isBudgetError` to read which budget stopped the work and where it stood.

```ts
import { createBudget, isBudgetError } from '@orkestrel/budget'

const budget = createBudget<number>({ id: 'tokens', max: 10, consumer: (tokens) => tokens })
budget.consume(12)
const reason = budget.signal.reason
if (isBudgetError(reason)) reason.context // { id: 'tokens', max: 10, consumed: 12 }
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
- **One meter per stream** — create a meter for each streamed answer; it has no reset, and its `charged` is the growth the budget accepted, which the final usage report reconciles against.
- **Read the reason, not the signal** — narrow `signal.reason` with `isBudgetError` to tell an exhaustion from a parent's cancel.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports), the `BudgetInterface` ↔ `Budget` and `MeterInterface` ↔ `Meter` method bijections, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Race work against the ceiling`, `Meter a streamed answer`, and `Trace an exhaustion` fences against the `@example` blocks of those titles (each title asserted on both the guide side and the source side, so untitling any one reddens its own case), and the README pitch against this guide's tagline. It also runs the flagship fences, the meter fence, and the exhaustion fence, and asserts the values their comments claim.
- [`tests/src/core/Budget.test.ts`](../tests/src/core/Budget.test.ts) — strict construction, cumulative and atomic consumption, valid overshoot, thrown-consumer identity, numeric overflow, zero-ceiling semantics, lifecycle re-arming/reset, parent reason preservation, the `BudgetError` reason at both abort sites, and public type shape.
- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — `BudgetError`'s brand stamp and `isBudgetError` recognition: the same copy, two source copies in both directions, the transparent proxy, a forgery whose brand stores another object, the complete self-branded forgery, renamed, recoded, and reshaped genuine errors, a branded plain `Error`, the unbranded `code: 'exhaust'` lookalike, a stripped brand, a `DOMException` `AbortError`, and `null`, primitives, hostile getters, and a revoked proxy without a throw.
- [`tests/src/core/Meter.test.ts`](../tests/src/core/Meter.test.ts) — the meter construction boundary, growth charging over the cumulative text, no-growth and decreasing estimates, throw atomicity of `charge`, refused estimates and deltas, re-entry through an abort listener and the producer with its nested and repeated refusals, `charged` equal to the budget's `consumed` after each, the budget signal trip, and the absence of a reset.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — real generic/token factory behavior plus untyped scope, usage, options, hostile, and revoked boundary failures with exact structured errors, and the token-meter charge shape and boundary.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — direct option-helper fresh-copy and optional-key omission, exactly-once property reads, hostile getter containment, generic preservation, and exact error taxonomy/context, for the budget, token-budget, meter, and token-meter helpers.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — total amount, native-signal, budget, token-scope, and token-usage guards across valid, off-shape, hostile, and revoked values.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts) — the packed package installed into a scratch consumer: its exports map, declarations, and runtime surface, and `isBudgetError` recognizing a reason built by the other module format, `import` against `require` and `require` against `import`.

## See also

- [`AGENTS.md`](../AGENTS.md) — the pointer to the `@orkestrel/scaffold` coding and orchestration authority.
- [`README.md`](README.md) — the guides index.
