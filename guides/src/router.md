# Router

> This package's ONE guide, covering all three faces (AGENTS §22 — one guide
> per package): the pure, environment-agnostic core — a registry-and-match
> engine (`Router`) plus a fetch-standard, method-dimensioned dispatcher
> (`Dispatcher`) layered over one internal `Router<RouteRecord<TState>>` —
> the browser navigation face (`Navigator`), and the node adapter face
> (`buildRequest` / `sendResponse` / `createListener`). `Router` is the ONE
> shared machine both `Navigator` and `Dispatcher` compose —
> literal-over-param-over-wildcard precedence, trailing-slash folding,
> tolerant percent-decoding, and the `answers` native-override seam all come
> from this single engine (AGENTS §21 "one engine, native overrides"); the
> core-first story is what makes the other two faces thin. Source:
> [`src/core`](../../src/core), [`src/browser`](../../src/browser),
> [`src/server`](../../src/server). Surfaced through the `@orkestrel/router`
> barrel (aliased `@src/core` / `@src/browser` / `@src/server` inside this
> repo).

## Surface

Register routes on a `Router`, resolve the most-specific match, and dispatch
fetch-standard requests through a `Dispatcher`:

```ts
import { createDispatcher, createRouter } from '@src/core'

const router = createRouter<{ readonly page: string }>()
router.add({ path: '/users/:id', meta: { page: 'profile' } })
router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }

const dispatcher = createDispatcher<{ readonly userId: string }>({
	routes: [
		{
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) => Response.json(context.params),
		},
	],
})
const response = await dispatcher.handle(new Request('http://x/users/7'), { userId: 'me' })
```

Path patterns are `/`-prefixed: a literal segment (`/users`), a `:name` param
(one segment), or a final `*name` wildcard (captures the rest of the path).
Matching is case-sensitive by default (`sensitive: false` opts out); a single
trailing slash is always optional except on the root `/` and the empty
pattern.

Browser and server usage appear under [Patterns](#patterns).

### Factories

| API                | Kind     | Summary                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `createRouter`     | function | Create a `RouterInterface<Meta>` — the shared matching + registry engine. |
| `createDispatcher` | function | Create a `DispatcherInterface<TState>` over one internal `Router`.        |
| `createNavigator`  | function | Create a `NavigatorInterface<Meta>` composing one core `Router`.          |

### Constants

| API             | Kind  | Summary                                                                  |
| --------------- | ----- | ------------------------------------------------------------------------ |
| `METHODS`       | const | The seven registrable HTTP methods (`GET`…`OPTIONS`) as a `ReadonlySet`. |
| `TIER_LITERAL`  | const | The highest path-segment specificity tier (a literal segment).           |
| `TIER_PARAM`    | const | The middle path-segment specificity tier (a `:name` param).              |
| `TIER_WILDCARD` | const | The lowest path-segment specificity tier (a final `*name` wildcard).     |

### Helpers

| API                   | Kind     | Summary                                                                         |
| --------------------- | -------- | ------------------------------------------------------------------------------- |
| `escapeRegExp`        | function | Escape regex metacharacters in a literal string.                                |
| `canonicalizePath`    | function | Strip one trailing slash off a path pattern (except `/` and `''`).              |
| `compilePath`         | function | Compile a path pattern into an anchored regex + ordered param names.            |
| `decodeParam`         | function | URL-decode one captured param, tolerating a malformed `%` escape.               |
| `matchPath`           | function | Extract decoded params from a compiled path against a pathname, or `undefined`. |
| `classifySegment`     | function | Classify one path segment into its specificity tier.                            |
| `parseMethod`         | function | Narrow a raw `request.method` string into a typed `Method`, or `undefined`.     |
| `computeSpecificity`  | function | Compute a path's per-segment specificity vector.                                |
| `compareSpecificity`  | function | Compare two paths by specificity for a descending sort.                         |
| `joinPaths`           | function | Join a group prefix and a route path into one `/`-prefixed path.                |
| `extractHashPath`     | function | Extract the `/`-prefixed pathname from a `location.hash` value.                 |
| `resolveLocationPath` | function | Resolve the `/`-prefixed pathname to match for the current location.            |
| `findAnchor`          | function | Find the nearest enclosing `<a>` element a DOM event originated from.           |
| `isEncryptedSocket`   | function | Whether a `node:http` connection socket is TLS-encrypted.                       |
| `buildRequest`        | function | Build a fetch `Request` from a `node:http` `IncomingMessage`.                   |
| `sendResponse`        | function | Write a fetch `Response` back to a `node:http` `ServerResponse`.                |
| `createListener`      | function | Create a `node:http` request listener over a core `DispatcherInterface`.        |

### Entities

| API             | Kind  | Summary                                                                         |
| --------------- | ----- | ------------------------------------------------------------------------------- |
| `Router`        | class | The path-matching + registry engine; entries compiled once, most-specific wins. |
| `Group`         | class | A prefix-scoped registration handle over a `Router` (pure string composition).  |
| `Dispatcher`    | class | The fetch-standard, method-dimensioned dispatch entity over one `Router`.       |
| `DispatchGroup` | class | A prefix-scoped registration handle over a `Dispatcher`.                        |
| `Navigator`     | class | The headless History/hash navigation entity composing one core `Router`.        |

### Types

| Type                     | Kind      | Shape                                                                                               |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------- |
| `PathParams`             | type      | Template-literal param extraction: `'/users/:id'` → `{ readonly id: string }`.                      |
| `PathParamsRaw`          | type      | The recursive, unflattened extractor behind `PathParams`; walks one path segment at a time.         |
| `IdentifierStartChar`    | type      | The identifier-grammar START char union (`[A-Za-z_]`) a type-level param name may begin with.       |
| `IdentifierChar`         | type      | The identifier-grammar CONTINUATION char union (`[A-Za-z0-9_]`) after the first char.               |
| `TakeIdentifierTail`     | type      | Char-by-char consumer of an identifier-continuation run off the front of a string literal.          |
| `IdentifierHead`         | type      | The identifier captured at the front of a string literal (empty when it doesn't start one).         |
| `SegmentParam`           | type      | One path segment's type-level param contribution — mirrors the runtime `classifySegment` grammar.   |
| `CompiledPath`           | interface | `{ regex: RegExp; params: readonly string[] }` — a compiled route pattern.                          |
| `RouteEntry`             | interface | `{ path: string; meta: Meta; name?: string }` — one registered entry.                               |
| `RouterMatch`            | interface | `{ path; params; meta; name? }` — the winning entry a `match` call returns.                         |
| `AnswerHandler`          | type      | `(meta: Meta) => boolean` — the native-override seam passed to `match`.                             |
| `RouterOptions`          | interface | `{ entries?; sensitive?; key? }` — options for `createRouter` / the constructor.                    |
| `RouterInterface`        | interface | `count` data member + `add` / `match` / `entries` / `group` / `clear`.                              |
| `GroupInterface`         | interface | `prefix` data member + `add` / `group`, forwarding to the owning router.                            |
| `Method`                 | type      | The seven registrable HTTP methods (`'GET' \| 'POST' \| … \| 'OPTIONS'`).                           |
| `RouteContext`           | interface | `{ params; pattern; url; state }` — the ambient context a `RouteHandler` receives.                  |
| `RouteHandler`           | type      | `(request, context) => Response \| Promise<Response>` — one route's handler.                        |
| `RouteInput`             | interface | `{ method; path; handler; name? }` — one `Dispatcher.add` registration input.                       |
| `RouteRecord`            | interface | `{ method; handler; name? }` — the `meta` payload a `Dispatcher` stores in its `Router`.            |
| `DispatchResult`         | type      | `'matched' \| 'unmethoded' \| 'unmatched'` discriminated union — `Dispatcher.match`'s outcome.      |
| `DispatcherEventMap`     | type      | `{ match: […]; miss: […] }` — the `Dispatcher`'s AGENTS §13 event map.                              |
| `DispatcherOptions`      | interface | `{ routes?; sensitive?; unmatched?; unmethoded?; on?; error? }` — options for `createDispatcher`.   |
| `DispatcherInterface`    | interface | `router` / `emitter` data members + `add` / `group` / `match` / `handle` / `destroy`.               |
| `DispatchGroupInterface` | interface | `prefix` data member + `add` / `group`, forwarding to the owning dispatcher.                        |
| `NavigatorEventMap`      | type      | `{ navigate: [match: RouterMatch<Meta>] }` — the `Navigator`'s AGENTS §13 event map.                |
| `NavigatorOptions`       | interface | `{ routes; history?; base?; fallback?; guard?; intercept?; sensitive?; on?; error? }`.              |
| `NavigatorInterface`     | interface | `router` / `emitter` / `active` data members + `start` / `stop` / `navigate` / `match` / `destroy`. |
| `RequestOptions`         | interface | `{ origin?: string }` — options for `buildRequest`.                                                 |
| `ListenerFunction`       | type      | `(request: IncomingMessage, response: ServerResponse) => void` — `createListener`'s return.         |
| `StateFunction`          | type      | `(message: IncomingMessage) => TState` — derives `createListener`'s per-request state.              |

The `count` member of `RouterInterface`, the `prefix` members of
`GroupInterface` / `DispatchGroupInterface`, the `router` / `emitter`
members of `DispatcherInterface`, and the `router` / `emitter` / `active`
members of `NavigatorInterface` are all `readonly` data members (Surface
rows, above) — the call-signature methods of `RouterInterface`,
`DispatcherInterface`, and `NavigatorInterface` are documented under
[Methods](#methods).

## Methods

The public methods of `RouterInterface`, `DispatcherInterface`, and
`NavigatorInterface` — every call-signature member listed (their `readonly`
data members stay Surface rows). `Router`, `Dispatcher`, and `Navigator`
implement their interfaces exactly, so this doubles as each class's
instance-method surface (AGENTS §22).

#### `RouterInterface`

`add` registers one/many entries (§9.2 batch), compiling each path once;
`match` resolves the most-specific matching entry, optionally filtered by the
`answers` seam; `entries` lists all entries, or only those matching a
pathname (the Allow-set source); `group` scopes a prefixed registration
handle; `clear` is the §10 reset.

| Method    | Returns                    | Behavior                                                                          |
| --------- | -------------------------- | --------------------------------------------------------------------------------- |
| `add`     | `void`                     | Register one entry, or many (§9.2 batch); throws `TypeError` on a malformed path. |
| `match`   | `RouterMatch \| undefined` | Resolve the most-specific matching entry for a pathname, or `undefined`.          |
| `entries` | `readonly RouteEntry[]`    | All registered entries, or only those whose path matches a given pathname.        |
| `group`   | `GroupInterface`           | A prefix-scoped registration handle over this router.                             |
| `clear`   | `void`                     | Drop every entry (§10); the router stays usable.                                  |

#### `DispatcherInterface`

`add` registers one/many route inputs (§9.2 batch); `group` scopes a
prefixed registration handle; `match` is the raw method+pathname decision;
`handle` runs the full fetch dispatch (auto-`HEAD`, auto-`OPTIONS`,
`unmatched`/`unmethoded` responders); `destroy` is the §10 teardown.

| Method    | Returns                  | Behavior                                                                                        |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `add`     | `void`                   | Register one route input, or many (§9.2 batch); throws `TypeError` on a malformed registration. |
| `group`   | `DispatchGroupInterface` | A prefix-scoped registration handle over this dispatcher.                                       |
| `match`   | `DispatchResult`         | The raw `'matched' \| 'unmethoded' \| 'unmatched'` decision for a method + pathname pair.       |
| `handle`  | `Promise<Response>`      | The full dispatch: parse, match, run the handler (or the `unmatched`/`unmethoded` responder).   |
| `destroy` | `void`                   | Tear down the `#emitter`; the underlying `router` is left registered (not cleared).             |

#### `NavigatorInterface`

`start` begins listening and resolves the current location now; `stop` stops
listening; `navigate` navigates programmatically; `match` is a pure lookup
with no side effects; `destroy` is the §10 teardown.

| Method     | Returns                    | Behavior                                                                                          |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `start`    | `void`                     | Begin listening (`hashchange`/`popstate` + optional interception) and resolve now (idempotent).   |
| `stop`     | `void`                     | Stop listening and abort any pending guard (idempotent).                                          |
| `navigate` | `void`                     | Navigate programmatically — set the hash or `pushState`, then resolve.                            |
| `match`    | `RouterMatch \| undefined` | A pure lookup through the underlying `Router` — no location read, no fallback, no guard, no emit. |
| `destroy`  | `void`                     | `stop()` plus tear down the `#emitter`.                                                           |

## Contract

These invariants hold across `src/core` / `src/browser` / `src/server` ↔
`router.md`.

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions (AGENTS §22).
2. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
   `RouterInterface`'s, `DispatcherInterface`'s, and `NavigatorInterface`'s
   public methods — exhaustive, both directions — and `Router` / `Dispatcher`
   / `Navigator` expose the same public methods, no more (AGENTS §22).
3. **Path grammar.** Three segment kinds: literal (`/users`), param
   (`:name`, one segment), wildcard (`*name`, final segment only, captures
   the rest of the path including slashes). A wildcard anywhere but the
   final segment throws `TypeError` at compile time (§14 boundary guard).
4. **Precedence tiers.** Literal (`TIER_LITERAL`, 2) > param (`TIER_PARAM`, 1)
   > wildcard (`TIER_WILDCARD`, 0), compared left-to-right at the earliest
   > differing segment; registration-order-independent. A shorter pattern that
   > is a prefix of a longer one ranks below it. Equal-specificity ties (only
   > possible between distinct wildcard shapes) resolve to the earliest
   > registered.
5. **Trailing slash is insensitive.** A single trailing slash on the request
   path is always optional, folded both at registration (`canonicalizePath`)
   and at match time — except the root `/` and the empty pattern, which are
   exempt and anchor exactly.
6. **Case-sensitive by default.** `sensitive: true` (`Router`/`Dispatcher`
   construction) is the default; `sensitive: false` folds case during
   matching without altering the pattern's own stored casing.
7. **Dedup via `key`.** When `RouterOptions.key` is set, an entry whose
   computed key already exists REPLACES the prior entry in place (last write
   wins, no engine rebuild); `Dispatcher` always constructs its internal
   `Router` with `key: (entry) => \`${entry.meta.method} ${entry.path}\``.
8. **The `answers` seam.** `RouterInterface.match`'s optional
   `AnswerHandler<Meta>` predicate is the single native-override point both
   faces compose differently: the `Dispatcher` passes a method-check, the
   browser `Navigator` omits it entirely — every path match answers.
9. **Dispatch semantics.** A `HEAD` request with no explicit `HEAD` route
   runs the matching `GET` handler and strips the response body. An
   `OPTIONS` request with no explicit `OPTIONS` route answers `204` with a
   derived `Allow` header (from `router.entries(pathname)`, `GET` implying
   `HEAD`). A path-matches-but-method-doesn't dispatch invokes the
   `unmethoded` responder (default `405` + `Allow`); nothing matching
   invokes the `unmatched` responder (default `404`). **A handler throw
   propagates uncaught** — the dispatcher never invents an error boundary
   (that is the consuming server's policy).
10. **Wildcard trailing-slash capture is asymmetric with param folding
    (intended).** A final `*name` wildcard captures ANY trailing slash on the
    request path into its own captured value (`/files/a/b/` → `rest: 'a/b/'`)
    — unlike a `:name` param segment, whose own trailing slash is folded away
    by the shared trailing-slash-insensitivity rule (§5 above). This is
    deliberate: the wildcard's capture is "the rest of the path, verbatim,"
    including whatever trailing slash the caller sent.
11. **Event map.** `DispatcherEventMap` carries `match` (emitted on every
    dispatch that resolves to a handler, including derived `HEAD`/`OPTIONS`)
    and `miss` (emitted on every non-matching dispatch, tagged
    `'unmatched'`/`'unmethoded'` via its `reason` field) — AGENTS §13, no
    `error`/`observerError` domain event (listener errors route through the
    emitter's own `error` option).
12. **Headless by design.** No `render`/`outlet`. The `Navigator` resolves,
    tracks `active`, and emits `navigate`; rendering is entirely the
    consumer's responsibility.
13. **One shared engine.** Each route's `path` is registered once on the same
    `Router` machine the core `Dispatcher` composes, keyed for dedup by its
    `canonicalizePath` (last write wins, replace-in-place). `Navigator` never
    rebuilds matching logic of its own.
14. **The history toggle.** `history: false` (default) reads/writes
    `location.hash` and binds `hashchange`; `history: true` reads/writes via
    `pushState`/`popstate`, with an optional `base` path prefix stripped
    before matching and prepended when navigating. `intercept: true`
    (history mode only) adds same-origin `<a>` click interception — a plain
    left-click with no modifier keys, no `target`, and no `download`
    attribute.
15. **Fallback semantics.** A location that matches nothing resolves the
    configured `fallback` pattern (default: the first route's path) through
    the SAME engine. A `fallback` that ALSO matches no registered route
    leaves `active` `undefined` and emits nothing — no phantom match is ever
    fabricated.
16. **Guard + supersede semantics.** An optional `guard(to, from, signal)` may
    veto (or asynchronously veto) a navigation. The `Navigator` mints an
    `@orkestrel/abort` handle per navigation and aborts the PREVIOUS handle
    when a newer navigation starts (or on `stop`/`destroy`) — a guard verdict
    that resolves after its navigation was superseded (`signal.aborted`) is
    discarded, same as a synchronous `false`/rejected verdict: `active` stays
    unchanged and nothing is emitted. A guard throw routes to the `error`
    handler (not through the emitter's own `emit`) and vetoes.
17. **Case-sensitive by default.** `sensitive: true` (forwarded to the
    underlying `Router`) is the default; `sensitive: false` folds case during
    matching.
18. **Intercepted links carry pathname only (known limitation).** Click
    interception passes only the intercepted link's `/`-prefixed pathname
    through to `navigate` — a query string on the link's `href` is NOT
    preserved (the pathname-only grammar has no query concept). A consumer
    needing query data reads it from `window.location.search` after
    navigating, or skips interception for that link.
19. **Only HTML `<a>` elements are intercepted (known limitation).** Click
    interception ({@link findAnchor}) walks up the event's composed path for
    an `HTMLAnchorElement` — an SVG `<a>` (`SVGAElement`) is NOT intercepted,
    even inside a same-origin document, and falls through to the browser's
    native navigation.
20. **Signal fires on client disconnect.** `buildRequest` mints an
    `@orkestrel/abort` handle and builds the `Request` over its `signal`; if
    the underlying connection closes before the message finished
    (`!message.complete`), the handle aborts — so `request.signal` fires the
    fetch-standard way, with zero router-specific cancellation API.
21. **Transport-level 500 is a last resort, not an error policy.**
    `createListener`'s handler wraps `dispatcher.handle` in a try/catch purely
    for the CONNECTION: when nothing has been sent yet, it writes a bare `500`
    head and ends the response (never leaking a hanging socket); once headers
    are already sent, it destroys the connection outright. The router still
    owns no error POLICY — a consumer wanting mapped error responses installs
    its own boundary around `dispatcher.handle` directly; a handler throw is
    NEVER silently swallowed into a generic response by the core `Dispatcher`
    itself (§9 above).
22. **Streaming both ways.** `buildRequest` streams a body-carrying method's
    message into the `Request` via a manual `ReadableStream` pump — a `for
await` loop over the `IncomingMessage` enqueueing each chunk, with
    `duplex: 'half'` set as Node's fetch implementation requires for a
    streamed request body; `sendResponse` streams a non-`null` `Response`
    body back to the `ServerResponse` chunk by chunk, ending the target when
    the stream completes (or stopping cleanly, without throwing, if the
    target was destroyed mid-stream by a client disconnect).
23. **Header fidelity.** `buildRequest` copies every incoming header
    (multi-value headers comma-joined, except `set-cookie`, appended
    individually); `sendResponse` writes every outgoing header and re-derives
    `set-cookie` via `Headers.getSetCookie()` so multiple response cookies
    stay distinct instead of collapsing into one comma-joined header.

## Patterns

### Groups and dedup

`group(prefix)` scopes a registration handle that composes its prefix onto
every entry it registers on the SAME underlying router; a `key` function
lets a later registration replace an earlier one in place instead of adding
a duplicate candidate.

```ts
import { createRouter } from '@src/core'

const router = createRouter<{ readonly page: string }>({
	key: (entry) => entry.path,
})
const api = router.group('/api')
api.add({ path: '/users', meta: { page: 'list' } })
router.match('/api/users')?.path // '/api/users'

router.add({ path: '/api/users', meta: { page: 'list-v2' } }) // replaces the prior entry
```

### Wildcard capture and precedence

A literal segment always outranks a param, which always outranks a wildcard,
compared left-to-right at the earliest differing segment:

```ts
import { createRouter } from '@src/core'

const router = createRouter<{ readonly handler: string }>()
router.add([
	{ path: '/files/*rest', meta: { handler: 'catchAll' } },
	{ path: '/files/:name', meta: { handler: 'named' } },
	{ path: '/files/readme', meta: { handler: 'literal' } },
])
router.match('/files/readme')?.meta.handler // 'literal'
router.match('/files/other')?.meta.handler // 'named'
router.match('/files/a/b.png')?.meta.handler // 'catchAll'
```

### Method-dimensioned dispatch (auto-HEAD, auto-OPTIONS, 405)

```ts
import { createDispatcher } from '@src/core'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const head = await dispatcher.handle(new Request('http://x/health', { method: 'HEAD' }), undefined)
head.body // null — auto-HEAD strips the GET handler's body

const options = await dispatcher.handle(
	new Request('http://x/health', { method: 'OPTIONS' }),
	undefined,
)
options.headers.get('Allow') // 'GET, HEAD, OPTIONS'

const notAllowed = await dispatcher.handle(
	new Request('http://x/health', { method: 'DELETE' }),
	undefined,
)
notAllowed.status // 405
```

### Observing dispatch outcomes

```ts
import { createDispatcher } from '@src/core'

const dispatcher = createDispatcher({
	on: {
		match: (method, pattern) => console.log('matched', method, pattern),
		miss: (method, pathname, reason) => console.log('missed', method, pathname, reason),
	},
})
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
await dispatcher.handle(new Request('http://x/missing'), undefined) // logs a 'miss'
```

### Introspection and reset

`entries()` lists every registration (or only those matching a pathname —
the same set a 405 response's `Allow` header derives from); `clear()` drops
every entry while leaving the router usable; `Dispatcher.destroy()` tears
down its emitter.

```ts
import { createDispatcher, createRouter } from '@src/core'

const router = createRouter<{ readonly page: string }>()
router.add([
	{ path: '/users/:id', meta: { page: 'profile' } },
	{ path: '/tokens', meta: { page: 'tokens' } },
])
router.entries().length // 2
router.entries('/users/7').length // 1 — only the matching entry
router.clear()
router.entries().length // 0 — the router stays usable

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
dispatcher.destroy() // tears down the #emitter; router.entries() is still valid afterward
```

### Hash-mode navigation

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/', meta: { title: 'Home' } },
		{ path: '/about', meta: { title: 'About' } },
	],
})
navigator.emitter.on('navigate', (match) => (document.title = match.meta.title))
navigator.start()
navigator.navigate('/about')
navigator.active?.path // '/about'
navigator.stop()
navigator.destroy() // stop() plus tear down the #emitter
```

### History mode with link interception

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [{ path: '/users/:id', meta: { title: 'User' } }],
	history: true,
	base: '/app',
	intercept: true,
})
navigator.start() // binds popstate + same-origin <a> click interception
```

### Guarding navigation (auth walls)

A guard may veto synchronously or asynchronously; a superseded guard's
verdict is discarded via its own `signal`.

```ts
import { createNavigator } from '@src/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/private', meta: { title: 'Private' } },
		{ path: '/', meta: { title: 'Home' } },
	],
	guard: async (to, _from, signal) => {
		const allowed = await checkAuth({ signal }) // cancels its own work if superseded
		return signal.aborted ? false : allowed
	},
})
navigator.start()
```

### Basic server

```ts
import { createListener } from '@src/server'
import { createDispatcher } from '@src/core'
import http from 'node:http'

const dispatcher = createDispatcher<{ readonly requestId: string }>()
dispatcher.add({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) =>
		Response.json({ id: context.params.id, requestId: context.state.requestId }),
})

const server = http.createServer(
	createListener(dispatcher, () => ({ requestId: crypto.randomUUID() })),
)
server.listen(0)
```

### Converting requests and responses directly

For a runtime seam that needs finer control than `createListener` (custom
error handling around `dispatcher.handle`, for instance), compose
`buildRequest`/`sendResponse` directly:

```ts
import { buildRequest, sendResponse } from '@src/server'
import { createDispatcher } from '@src/core'
import http from 'node:http'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const server = http.createServer(async (incoming, target) => {
	const request = buildRequest(incoming, { origin: 'https://api.example.com' })
	try {
		const response = await dispatcher.handle(request, undefined)
		await sendResponse(response, target)
	} catch (error) {
		target.writeHead(500).end(String(error)) // this consumer's own error policy
	}
})
server.listen(0)
```

### Observing client disconnect

```ts
import { buildRequest } from '@src/server'
import http from 'node:http'

const server = http.createServer((incoming) => {
	const request = buildRequest(incoming)
	request.signal.addEventListener('abort', () => console.log('client disconnected'))
})
```

### Practices

- **One engine, two seams** — compose `Router` directly for a method-less
  consumer (a `Navigator`), or through `Dispatcher` for method-dimensioned
  fetch dispatch; never rebuild the matching logic per face (AGENTS §21).
- **Guard the registration boundary, not the hot path** — `add` throws on a
  malformed entry; `match`/`handle` carry zero guards (AGENTS §14).
- **Let handler throws propagate** — the dispatcher is not an error
  boundary; a consuming server installs its own around `handle`.
- **Dedup with `key`, not manual lookups** — pass a `key` function instead of
  checking `router.entries()` before every `add`.
- **Never build a second registry** — compose the same core `Router` other
  faces use; a `Navigator` never hand-rolls its own path matching.
- **Thread `signal` into async guard work** — a slow guard can cancel its own
  work when it observes `signal.aborted`, closing the stale-guard race.
- **Keep rendering outside the Navigator** — subscribe to `navigate` and
  render in the consumer, never inside this headless entity.
- **`stop()`/`destroy()` before disposal** — releases listeners and aborts
  any pending guard; `destroy()` also tears down the `#emitter`.
- **Prefer `createListener` for the common case** — it wires conversion,
  dispatch, and the transport-level last-resort `500` together correctly.
- **Install your own error boundary for mapped error responses** — the
  router (core and this adapter) never invents one; a handler throw
  propagates.
- **Thread `request.signal` into downstream work** — a handler can cancel
  its own I/O when the client disconnects, the fetch-standard idiom.
- **Skip this face entirely on fetch-native runtimes** — Bun, Deno, and
  workers hand `Request`s to `dispatcher.handle` directly.

## Tests

- [`tests/src/core/Router.test.ts`](../../tests/src/core/Router.test.ts) —
  registration boundary guard, method-less matching, order-independent
  literal-over-param-over-wildcard precedence, wildcard capture, the
  `answers` seam, `entries()` (all + filtered), dedup via `key`, case
  sensitivity, and `RouterInterface` conformance.
- [`tests/src/core/Group.test.ts`](../../tests/src/core/Group.test.ts) —
  `Group` direct construction, prefix composition and nesting, batch
  registration, dedup-key collision across differently-nested group chains,
  and `GroupInterface` conformance.
- [`tests/src/core/Dispatcher.test.ts`](../../tests/src/core/Dispatcher.test.ts) —
  type-level surfaces (`RouteHandler` context typing, `TState` generic flow,
  `DispatcherInterface` member shape, factory return type), emitter event
  payload shapes, destroy idempotence, the cross-face grammar parity
  fixture, the full functional dispatch matrix (auto-HEAD, auto-OPTIONS,
  404/405 responders, handler-throw propagation), and per-method dedup.
- [`tests/src/core/DispatchGroup.test.ts`](../../tests/src/core/DispatchGroup.test.ts) —
  `DispatchGroup` direct construction and group + nested group registration
  with prefixes composed.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) —
  `escapeRegExp`, `canonicalizePath`, `compilePath` (literal/param/wildcard,
  trailing-slash folding, case sensitivity, the wildcard-not-final throw),
  `decodeParam` (including a malformed `%` escape), `matchPath`,
  `classifySegment` (the literal-vs-param classification fix regression
  case), `computeSpecificity`, `compareSpecificity`, and `joinPaths`.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) —
  `createRouter`/`createDispatcher` round-trips and factory return-type
  assertions.
- [`tests/src/browser/Navigator.test.ts`](../../tests/src/browser/Navigator.test.ts) —
  hash and history modes, `navigate()`/`active`/`navigate` event, fallback
  semantics, guard veto (sync + async, including supersede-discard), link
  interception on/off, `start`/`stop`/`destroy` idempotence, and
  `NavigatorInterface` conformance.
- [`tests/src/browser/factories.test.ts`](../../tests/src/browser/factories.test.ts) —
  `createNavigator` returns a working `NavigatorInterface`.
- [`tests/src/browser/helpers.test.ts`](../../tests/src/browser/helpers.test.ts) —
  `extractHashPath`, `resolveLocationPath` (hash + history, with/without
  `base`), and `findAnchor` (including a click on a styled child inside an
  anchor).
- [`tests/src/server/helpers.test.ts`](../../tests/src/server/helpers.test.ts) —
  `isEncryptedSocket`, `buildRequest` fidelity (method, URL from `Host`,
  headers including multi-value and `set-cookie`, body streaming, the
  disconnect-aborts-`signal` case), `sendResponse` (status, headers including
  `set-cookie`, streamed and empty bodies, a destroyed target mid-stream),
  and `createListener` end-to-end round-trips over real `node:http` sockets.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §13 the Emitter pattern, §14
  contract & validation architecture, §21 "one engine, native overrides",
  §22 documentation-as-contracts.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the supersede-safe guard
  cancellation primitive the Navigator composes, and the client-disconnect
  cancellation primitive the Listener composes.
- [`README.md`](../README.md) — the guides index.
