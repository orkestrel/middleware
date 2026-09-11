# Router

> The typed request router: a path-matching engine (`Router`) that compiles route patterns,
> extracts URL-decoded params, and resolves the most specific match, with a fetch-standard,
> method-dimensioned dispatcher (`Dispatcher`), a headless History or hash `Navigator`, and a
> `node:http` adapter all composing that same engine.

This guide covers every face the package publishes. The core is pure and
environment-agnostic: it speaks `string`, `RegExp`, `URL`, `Request`, and `Response`, and
neither DOM nor `node:*`. Precedence, trailing-slash folding, tolerant percent-decoding, and
the `answers` override seam all live in the engine rather than in a face, which is what keeps
the browser and server faces thin; a native override earns its place only on a genuinely
faster path. Source: [`src/core`](../src/core), [`src/browser`](../src/browser), and
[`src/server`](../src/server), surfaced through the `@orkestrel/router` barrel (aliased
`@src/core` / `@src/browser` / `@src/server` inside this repo).

## Surface

### Register and match

Register routes on a `Router`, resolve the most-specific match, and dispatch
fetch-standard requests through a `Dispatcher`:

```ts
import { createDispatcher, createRouter } from '@orkestrel/router'

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

| API                | Kind     | Summary                                                                                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `createRouter`     | function | Creates a `RouterInterface` — the pure path-matching + registry engine shared by the browser `Navigator` and the core `Dispatcher`.       |
| `createDispatcher` | function | Creates a `DispatcherInterface` — the fetch-standard, method-dimensioned dispatch entity over one internal `Router<RouteRecord<TState>>`. |
| `createNavigator`  | function | Creates a `NavigatorInterface` — the headless History/hash navigation entity composing one core `Router<Meta>`.                           |

### Constants

A `Shape` cell holds the constant's declared type.

| API             | Kind  | Shape                                                                   | Summary                                                                                                                                                                                                           |
| --------------- | ----- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METHOD_LIST`   | const | `readonly ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']` | Lists the HTTP methods a `DispatcherInterface` registers routes under, in canonical order — a frozen literal tuple, and the single source the `Method` type, `METHODS`, and `parseMethod` are all derived from.   |
| `METHODS`       | const | `ReadonlySet<string>`                                                   | Holds every HTTP method a `DispatcherInterface` registers routes under as a `ReadonlySet` — backs the registration guard (`add` rejects any `method` outside this set) and the auto-`OPTIONS` `Allow` derivation. |
| `TIER_LITERAL`  | const | `number`                                                                | Names the specificity tier for a \*\*literal\*\* path segment (`/users`) — the highest tier, always outranking a param or wildcard segment at the same position.                                                  |
| `TIER_PARAM`    | const | `number`                                                                | Names the specificity tier for a \*\*param\*\* path segment (`:name`) — ranks below a literal segment and above a wildcard segment at the same position.                                                          |
| `TIER_WILDCARD` | const | `number`                                                                | Names the specificity tier for a \*\*wildcard\*\* path segment (`*name`) — the lowest tier; a wildcard only ever wins against another wildcard shape (an equal-specificity tie resolved by registration order).   |

### Helpers

| API                    | Kind     | Summary                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `escapeRegExp`         | function | Escapes every regex metacharacter in a literal string so it can be embedded inside a larger `RegExp` source without being interpreted as syntax.                                                                                                                                                                               |
| `canonicalizePath`     | function | Canonicalizes a route path for registry identity — strips a single trailing slash, except the root `/` (and the empty pattern). The trailing-slash fold `compilePath` normalizes a pattern through, so identity agrees with the matcher.                                                                                       |
| `computeDispatchKey`   | function | Computes the canonical `METHOD /path` registry key for a method-dimensioned dispatcher route.                                                                                                                                                                                                                                  |
| `compilePath`          | function | Compiles a route path pattern into an anchored regex and its ordered param names.                                                                                                                                                                                                                                              |
| `decodeParam`          | function | Decodes one captured param value from a URL, tolerating a malformed percent-escape — the decode `matchPath` applies to each captured group.                                                                                                                                                                                    |
| `matchPath`            | function | Extracts the URL-decoded params a compiled path captures from a concrete pathname, or `undefined` when the pathname does not match.                                                                                                                                                                                            |
| `classifySegment`      | function | Classifies one path segment into its specificity tier — the same syntax `compilePath` rewrites: a syntactically valid `:name` head is a param segment, a final `*name` is a wildcard segment, and everything else (including a literal segment that merely contains a `:` mid-string, for example `a:b`) is a literal segment. |
| `computeSpecificity`   | function | Computes a route path's specificity vector — the per-segment type ranking that breaks a tie when several registered routes match the same concrete pathname.                                                                                                                                                                   |
| `compareSpecificity`   | function | Compares two route paths by specificity — the comparator that picks the most-specific matching route (literal-over-param-over-wildcard, registration-order-independent).                                                                                                                                                       |
| `joinPaths`            | function | Joins a group prefix and a route path into one `/`-prefixed path, normalizing duplicate or missing joining slashes.                                                                                                                                                                                                            |
| `defineRoute`          | function | Provides an identity pass-through for a `RouteInput` that pins its `Path` generic to the literal registration-site string, so `context.params` types correctly through `PathParams` without an explicit type argument.                                                                                                         |
| `computeNavigationKey` | function | Computes the canonical path key a `Navigator` registers a browser navigation route under.                                                                                                                                                                                                                                      |
| `extractHashPath`      | function | Extracts the `/`-prefixed pathname from a `location.hash` value — strips the leading `#` (keeping the route's own leading `/`) and any `?query` suffix.                                                                                                                                                                        |
| `resolveLocationPath`  | function | Resolves the `/`-prefixed pathname to match for the current location, in either navigation mode — the one seam `extractHashPath` (hash mode) and history-mode base-stripping share.                                                                                                                                            |
| `findAnchor`           | function | Finds the nearest enclosing `<a>` element a DOM event originated from, by walking its composed path — the pure lookup behind history-mode link interception.                                                                                                                                                                   |
| `buildRequest`         | function | Builds a fetch-standard `Request` from a `node:http` `IncomingMessage` — the server-adapter half of the fetch/node conversion seam.                                                                                                                                                                                            |
| `sendResponse`         | function | Writes a fetch-standard `Response` back to a `node:http` `ServerResponse` — the reverse half of the fetch/node conversion seam.                                                                                                                                                                                                |

### Parsers

| API           | Kind     | Summary                                                                            |
| ------------- | -------- | ---------------------------------------------------------------------------------- |
| `parseMethod` | function | Narrows a raw `request.method` string into a typed `Method` — total, never throws. |

### Guards

In a guard table a `Shape` cell holds the type the guard narrows to.

| API                 | Kind     | Shape           | Summary                                                                                                                                                                    |
| ------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isEncryptedSocket` | function | `{ encrypted }` | Determines whether a `node:http` connection socket is TLS-encrypted — the total, never-throwing narrow `buildRequest` uses to pick the derived scheme (`https` vs `http`). |

### Handlers

| API                     | Kind     | Summary                                                                                                                                                                                                                                                                           |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleListenerRequest` | function | Handles one `node:http` request through a core dispatcher and writes its fetch-standard response.                                                                                                                                                                                 |
| `createListener`        | function | Creates a `node:http` request listener over a core `DispatcherInterface` — the whole server face's entry point: converts the incoming message to a fetch `Request`, hands it to the dispatcher with the consumer's per-request `state`, and writes the resulting `Response` back. |

### Classes

| API             | Kind  | Summary                                                                                                                                                                                                                                                                                                    |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Router`        | class | Represents the path-matching + registry engine — registers `{ path, meta, name? }` entries (compiling each path once) and resolves a concrete pathname to the most specific matching entry. The shared machine both the `Navigator` (browser) and the `Dispatcher` (core, method-dimensioned) compose.     |
| `Group`         | class | Represents a prefix-scoped registration handle over a `Router` — pure string composition, no independent state or storage.                                                                                                                                                                                 |
| `Dispatcher`    | class | Represents the fetch-standard, method-dimensioned dispatch entity — layers HTTP method dispatch and web-standard `Request`/`Response` handling over one internal `Router<RouteRecord<TState>>`. The core machine the server face and any fetch-native runtime consume directly.                            |
| `DispatchGroup` | class | Represents a prefix-scoped registration handle over a `Dispatcher` — the method-dimensioned counterpart of `Group`.                                                                                                                                                                                        |
| `Navigator`     | class | Represents the headless History/hash navigation entity — composes one core `Router<Meta>`, resolving the current location on `start()` and every subsequent navigation event, tracking `active`, and emitting `navigate` through the core `Emitter`. No `render` / `outlet` — the consumer owns rendering. |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                     | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                             | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PathParams`             | type      | `{ readonly [K in keyof PathParamsRaw<Path>]: PathParamsRaw<Path>[K] }`                                                                                                                                                                                                                                                                                                           | Extracts `{ name: string }` param records from a path pattern at the type level — the typed half of the path grammar.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PathParamsRaw`          | type      | ``string extends Path ? Readonly<Record<string, string>> : Path extends `${infer Segment}/${infer Rest}` ? SegmentParam<Segment> & PathParamsRaw<Rest> : SegmentParam<Path>``                                                                                                                                                                                                     | Performs recursive, unflattened param extraction for `PathParams` — walks a path pattern segment by segment (split on `/`), extracting each segment's `SegmentParam` contribution and intersecting the rest.                                                                                                                                                                                                                                                                                           |
| `IdentifierStartChar`    | type      | `'a' \| 'b' \| 'c' \| 'd' \| 'e' \| 'f' \| 'g' \| 'h' \| 'i' \| 'j' \| 'k' \| 'l' \| 'm' \| 'n' \| 'o' \| 'p' \| 'q' \| 'r' \| 's' \| 't' \| 'u' \| 'v' \| 'w' \| 'x' \| 'y' \| 'z' \| 'A' \| 'B' \| 'C' \| 'D' \| 'E' \| 'F' \| 'G' \| 'H' \| 'I' \| 'J' \| 'K' \| 'L' \| 'M' \| 'N' \| 'O' \| 'P' \| 'Q' \| 'R' \| 'S' \| 'T' \| 'U' \| 'V' \| 'W' \| 'X' \| 'Y' \| 'Z' \| '_'` | Names the identifier start characters an identifier-grammar param name may begin with — mirrors the runtime classifier's `[A-Za-z_]` head class, the one `classifySegment` and `compilePath` share.                                                                                                                                                                                                                                                                                                    |
| `IdentifierChar`         | type      | `IdentifierStartChar \| '0' \| '1' \| '2' \| '3' \| '4' \| '5' \| '6' \| '7' \| '8' \| '9'`                                                                                                                                                                                                                                                                                       | Names the identifier continuation characters after the first — mirrors the runtime classifier's `[A-Za-z0-9_]*` tail class.                                                                                                                                                                                                                                                                                                                                                                            |
| `TakeIdentifierTail`     | type      | ``S extends `${infer Head}${infer Tail}` ? Head extends IdentifierChar ? TakeIdentifierTail<Tail, `${Acc}${Head}`> : Acc : Acc``                                                                                                                                                                                                                                                  | Consumes the identifier-continuation run at the front of a string literal, char by char, appending each onto the accumulator.                                                                                                                                                                                                                                                                                                                                                                          |
| `IdentifierHead`         | type      | ``S extends `${infer Head}${infer Tail}` ? Head extends IdentifierStartChar ? TakeIdentifierTail<Tail, Head> : '' : ''``                                                                                                                                                                                                                                                          | Captures the identifier at the front of a string literal, or an empty string when the literal does not begin with an identifier-start char.                                                                                                                                                                                                                                                                                                                                                            |
| `SegmentParam`           | type      | ``Segment extends `:${infer Rest}` ? IdentifierHead<Rest> extends infer Name extends string ? Name extends '' ? unknown : { readonly [K in Name]: string } : unknown : Segment extends `*${infer Rest}` ? IdentifierHead<Rest> extends infer Name extends string ? Name extends '' ? unknown : { readonly [K in Name]: string } : unknown : unknown``                             | Contributes one path segment's type-level param record — the type-level mirror of the runtime `classifySegment` and `compilePath` segment parser.                                                                                                                                                                                                                                                                                                                                                      |
| `CompiledPath`           | interface | `{ regex, params }`                                                                                                                                                                                                                                                                                                                                                               | Represents a compiled route path — the anchored regex plus its ordered param names.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RouteEntry`             | interface | `{ path, meta, name? }`                                                                                                                                                                                                                                                                                                                                                           | Represents one registered route in a `RouterInterface` — the `path` pattern plus the opaque `meta` payload to return on a match, with an optional `name`.                                                                                                                                                                                                                                                                                                                                              |
| `RouterMatch`            | interface | `{ path, params, meta, name? }`                                                                                                                                                                                                                                                                                                                                                   | Represents one matched route — the winning entry's registered pattern, its decoded params, its `meta` payload, and its optional `name`.                                                                                                                                                                                                                                                                                                                                                                |
| `AnswerHandler`          | type      | `(meta: Meta) => boolean`                                                                                                                                                                                                                                                                                                                                                         | Represents the native-override seam — a predicate deciding whether an entry's `meta` answers a given `match` call, beyond path matching.                                                                                                                                                                                                                                                                                                                                                               |
| `RouterOptions`          | interface | `{ entries?, sensitive?, key? }`                                                                                                                                                                                                                                                                                                                                                  | Represents the options for `createRouter` — an optional initial entry set, the case-sensitivity toggle, and the dedup identity function.                                                                                                                                                                                                                                                                                                                                                               |
| `RouterInterface`        | interface | `{ count } plus add, match, entries, group, clear`                                                                                                                                                                                                                                                                                                                                | Represents the path-matching + registry engine contract (the behavioral-interface role for the one-class-per-file `Router`). Registers `{ path, meta, name? }` entries (compiling each path once) and resolves a concrete pathname to the most specific matching entry — a literal segment beats a param beats a wildcard at the earliest differing segment, registration-order-independent. The shared engine both the `Navigator` (browser) and the `Dispatcher` (core, method-dimensioned) compose. |
| `GroupInterface`         | interface | `{ prefix } plus add, group`                                                                                                                                                                                                                                                                                                                                                      | Represents a prefix-scoped registration handle over a `RouterInterface` — pure string composition, no independent state or storage.                                                                                                                                                                                                                                                                                                                                                                    |
| `Method`                 | type      | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'`                                                                                                                                                                                                                                                                                                          | Names the HTTP methods a `DispatcherInterface` dimensions dispatch over — derived from `METHOD_LIST`, whose membership counterpart is `METHODS`.                                                                                                                                                                                                                                                                                                                                                       |
| `RouteContext`           | interface | `{ params, pattern, url, state }`                                                                                                                                                                                                                                                                                                                                                 | Represents the ambient context a `RouteHandler` receives alongside the raw `Request` — decoded params, the winning pattern, the parsed URL, and the consumer's opaque per-request state.                                                                                                                                                                                                                                                                                                               |
| `RouteHandler`           | type      | `(request: Request, context: RouteContext<Path, TState>) => Response \| Promise<Response>`                                                                                                                                                                                                                                                                                        | Receives the raw fetch `Request` plus its typed `RouteContext` and returns (or resolves) a fetch `Response`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `RouteInput`             | interface | `{ method, path, handler, name? }`                                                                                                                                                                                                                                                                                                                                                | Represents one route registration input for `DispatcherInterface.add` — the method-dimensioned counterpart of `RouteEntry`.                                                                                                                                                                                                                                                                                                                                                                            |
| `RouteRecord`            | interface | `{ method, handler, name? }`                                                                                                                                                                                                                                                                                                                                                      | Represents the `meta` payload a `DispatcherInterface` stores in its underlying `Router` — what `RouterInterface.match` returns as `RouterMatch.meta` on a dispatch hit.                                                                                                                                                                                                                                                                                                                                |
| `DispatchResult`         | type      | `{ status: 'matched', match } \| { status: 'unmethoded', allow } \| { status: 'unmatched' }`                                                                                                                                                                                                                                                                                      | Represents the outcome of `DispatcherInterface.match` — a discriminated union over the dispatch tiers: a full hit, a path that matches with no route for the method (405 territory), or nothing matched at all (404 territory).                                                                                                                                                                                                                                                                        |
| `DispatcherEventMap`     | type      | `{ match, miss }`                                                                                                                                                                                                                                                                                                                                                                 | Represents the `Dispatcher`'s event map — the dispatch-outcome signals a consumer can observe alongside the return value of `handle`.                                                                                                                                                                                                                                                                                                                                                                  |
| `DispatcherOptions`      | interface | `{ routes?, sensitive?, unmatched?, unmethoded?, on?, error? }`                                                                                                                                                                                                                                                                                                                   | Represents the options for `createDispatcher` — initial routes, case sensitivity, the default-responder overrides, and the Emitter pattern's wiring.                                                                                                                                                                                                                                                                                                                                                   |
| `DispatcherInterface`    | interface | `{ router, emitter } plus add, group, match, handle, destroy`                                                                                                                                                                                                                                                                                                                     | Represents the fetch-standard, method-dimensioned dispatch entity contract (the behavioral-interface role for the one-class-per-file `Dispatcher`). Layers HTTP method dispatch and web-standard `Request`/`Response` handling over a single internal `Router<RouteRecord<TState>>`.                                                                                                                                                                                                                   |
| `DispatchGroupInterface` | interface | `{ prefix } plus add, group`                                                                                                                                                                                                                                                                                                                                                      | Represents a prefix-scoped registration handle over a `DispatcherInterface` — the method-dimensioned counterpart of `GroupInterface`.                                                                                                                                                                                                                                                                                                                                                                  |
| `NavigatorEventMap`      | type      | `{ navigate }`                                                                                                                                                                                                                                                                                                                                                                    | Represents the `Navigator`'s event map — the single `navigate` signal a consumer observes.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NavigatorOptions`       | interface | `{ routes, history?, base?, fallback?, guard?, intercept?, sensitive?, on?, error? }`                                                                                                                                                                                                                                                                                             | Represents the options for `createNavigator` — the `routes` to dispatch between, the navigation substrate, the optional guard hook, and the Emitter pattern's wiring.                                                                                                                                                                                                                                                                                                                                  |
| `NavigatorInterface`     | interface | `{ router, emitter, active } plus start, stop, navigate, match, destroy`                                                                                                                                                                                                                                                                                                          | Represents the headless History/hash navigation entity contract (the behavioral-interface role for the one-class-per-file `Navigator`). Composes a core `Router<Meta>`, resolves the current location on `start()` and on every subsequent navigation event, tracks `active`, and emits `navigate` through the `EmitterInterface`.                                                                                                                                                                     |
| `RequestOptions`         | interface | `{ origin?, response? }`                                                                                                                                                                                                                                                                                                                                                          | Represents the options for `buildRequest` — URL origin and response-side disconnect tracking.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ListenerFunction`       | type      | `(request: IncomingMessage, response: ServerResponse) => void`                                                                                                                                                                                                                                                                                                                    | Represents a `node:http` request handler — the function `createListener` returns, matching `http.createServer`'s handler signature.                                                                                                                                                                                                                                                                                                                                                                    |
| `StateFunction`          | type      | `(message: IncomingMessage) => TState`                                                                                                                                                                                                                                                                                                                                            | Derives a consumer's opaque per-request `TState` from the raw `IncomingMessage` — the `state` argument `createListener` threads into `dispatcher.handle`.                                                                                                                                                                                                                                                                                                                                              |

The `count` member of `RouterInterface`, the `prefix` member of `GroupInterface` and
`DispatchGroupInterface`, the `router` and `emitter` members of `DispatcherInterface`, and the
`router`, `emitter`, and `active` members of `NavigatorInterface` are all `readonly` data members
(the preceding Surface rows) — the call-signature members each `Shape` cell names after `plus` are
documented under [Methods](#methods).

## Methods

The public methods of `RouterInterface`, `GroupInterface`,
`DispatcherInterface`, `DispatchGroupInterface`, and `NavigatorInterface` —
every call-signature member listed (their `readonly` data members stay
Surface rows). `Router`, `Group`, `Dispatcher`, `DispatchGroup`, and
`Navigator` implement their interfaces exactly, so this doubles as each
class's instance-method surface.

#### `RouterInterface`

The registry engine's call-signature members, each documented on the interface
declaration it belongs to:

| Method    | Returns                    | Summary                                                                                                                                |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | `void`                     | Registers one entry, or many in one call (batch registration), compiling each path once; throws a `ContractError` on a malformed path. |
| `match`   | `RouterMatch \| undefined` | Resolves the most-specific matching entry for a pathname, or `undefined` when nothing matches.                                         |
| `entries` | `readonly RouteEntry[]`    | Lists every registered entry in registration order, or only those whose path matches a given pathname.                                 |
| `group`   | `GroupInterface`           | Returns a prefix-scoped registration handle over this router.                                                                          |
| `clear`   | `void`                     | Drops every entry, leaving the router reusable.                                                                                        |

#### `DispatcherInterface`

The dispatch entity's call-signature members, each documented on the interface
declaration it belongs to:

| Method    | Returns                  | Summary                                                                                                                                                             |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | `void`                   | Registers one route input, or many in one call (batch registration); throws a `ContractError` on a malformed registration.                                          |
| `group`   | `DispatchGroupInterface` | Returns a prefix-scoped registration handle over this dispatcher.                                                                                                   |
| `match`   | `DispatchResult`         | Decides the raw `DispatchResult` for a method and pathname pair, with no `Request` or `Response` involvement — the pure decision `handle` builds its response from. |
| `handle`  | `Promise<Response>`      | Runs the full dispatch: parses the request URL, matches, and invokes either the winning handler or the `unmatched`/`unmethoded` responder.                          |
| `destroy` | `void`                   | Tears down the emitter; the underlying router is left registered rather than cleared, so introspection stays valid afterwards.                                      |

#### `NavigatorInterface`

The navigation entity's call-signature members, each documented on the interface
declaration it belongs to:

| Method     | Returns                    | Summary                                                                                                                      |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `start`    | `void`                     | Begins listening and resolves the current location — idempotent, so a second call is a no-op.                                |
| `stop`     | `void`                     | Stops listening and aborts any pending guard — idempotent.                                                                   |
| `navigate` | `void`                     | Navigates programmatically — sets `location.hash` in hash mode or calls `history.pushState` in history mode, then resolves.  |
| `match`    | `RouterMatch \| undefined` | Looks one path up through the underlying `Router` — a pure lookup with no location read, no fallback, no guard, and no emit. |
| `destroy`  | `void`                     | Stops listening and tears down the emitter.                                                                                  |

#### `GroupInterface`

The group handle's call-signature members — a group holds no registry of its own,
and every registration lands on the owning router:

| Method  | Returns          | Summary                                                                                                          |
| ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `add`   | `void`           | Registers one entry, or many in one call, on the owning router with this group's prefix composed onto each path. |
| `group` | `GroupInterface` | Returns a nested group whose prefix is this prefix followed by the given one.                                    |

#### `DispatchGroupInterface`

The dispatch group handle's call-signature members — the owning dispatcher's
registration guard still applies to every route a group registers:

| Method  | Returns                  | Summary                                                                                                                    |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `add`   | `void`                   | Registers one route input, or many in one call, on the owning dispatcher with this group's prefix composed onto each path. |
| `group` | `DispatchGroupInterface` | Returns a nested group whose prefix is this prefix followed by the given one.                                              |

## Contract

These invariants hold across `src/core` / `src/browser` / `src/server` ↔
`router.md`.

1. **Doc-to-source bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions.
2. **Doc-to-source method bijection.** The `## Methods` tables list exactly
   `RouterInterface`'s, `GroupInterface`'s, `DispatcherInterface`'s,
   `DispatchGroupInterface`'s, and `NavigatorInterface`'s public methods —
   exhaustive, both directions — and `Router` / `Group` / `Dispatcher` /
   `DispatchGroup` / `Navigator` expose the same public methods, no more.
3. **Path grammar.** Segment kinds: literal (`/users`), param
   (`:name`, one segment), wildcard (`*name`, final segment only, captures
   the rest of the path including slashes). A wildcard anywhere but the
   final segment throws a `ContractError` at compile time, guarded at the boundary.
4. **Precedence tiers.** A literal segment (`TIER_LITERAL`, 2) outranks a
   param (`TIER_PARAM`, 1), which outranks a wildcard (`TIER_WILDCARD`, 0).
   Two matching routes compare left to right, and the higher tier at the
   earliest differing segment wins, independent of registration order. A
   shorter pattern that is a prefix of a longer one ranks below it. An
   equal-specificity tie, possible only between distinct wildcard shapes,
   resolves to the earliest registered.
5. **Trailing slash is insensitive.** A single trailing slash on the request
   path is always optional, folded both at registration (`canonicalizePath`)
   and at match time — except the root `/` and the empty pattern, which are
   exempt and anchor exactly.
6. **Case-sensitive by default.** `sensitive: true` (`Router`/`Dispatcher`
   construction) is the default; `sensitive: false` folds case during
   matching without altering the pattern's own stored casing.
7. **Dedup with `key`.** When `RouterOptions.key` is set, an entry whose
   computed key already exists replaces the prior entry in place (last write
   wins, no engine rebuild); `Dispatcher` always constructs its internal
   `Router` with `key: computeDispatchKey`, which pairs the route's method
   with `canonicalizePath(entry.path)`, so two registrations differing only
   by a trailing slash replace each other while different methods stay
   distinct.
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
    (intended).** A final `*name` wildcard captures any trailing slash on the
    request path into its own captured value (`/files/a/b/` → `rest: 'a/b/'`)
    — unlike a `:name` param segment, whose own trailing slash is folded away
    by the shared trailing-slash-insensitivity rule stated earlier. This is
    deliberate: the wildcard's capture is "the rest of the path, verbatim,"
    including whatever trailing slash the caller sent.
11. **Event map.** `DispatcherEventMap` carries `match` (emitted on every
    dispatch the dispatcher answers, the derived `HEAD` and `OPTIONS` cases
    included; for a derived `OPTIONS` answer the `pattern` is the
    most-specific pattern the pathname resolved to) and `miss` (emitted on
    every non-matching dispatch, tagged
    `'unmatched'`/`'unmethoded'` through its `status` field) — no
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
    `location.hash` and binds `hashchange`; `history: true` reads/writes through
    `pushState`/`popstate`, with an optional `base` path prefix stripped
    before matching and prepended when navigating. `intercept: true`
    (history mode only) adds same-origin `<a>` click interception — a plain
    left-click with no modifier keys, no `target`, and no `download`
    attribute.
15. **Fallback semantics.** A location that matches nothing resolves the
    configured `fallback` pattern (default: the first route's path) through
    the same engine. A `fallback` that itself matches no registered route
    leaves `active` `undefined` and emits nothing — no phantom match is ever
    fabricated.
16. **Guard + supersede semantics.** An optional `guard(to, from, signal)` may
    veto (or asynchronously veto) a navigation. The `Navigator` mints an
    `@orkestrel/abort` handle per navigation and aborts the previous handle
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
    through to `navigate` — a query string on the link's `href` is not
    preserved (the pathname-only grammar has no query concept). A consumer
    needing query data reads it from `window.location.search` after
    navigating, or skips interception for that link.
19. **Only HTML `<a>` elements are intercepted (known limitation).** Click
    interception ({@link findAnchor}) walks up the event's composed path for
    an `HTMLAnchorElement` — an SVG `<a>` (`SVGAElement`) is not intercepted,
    even inside a same-origin document, and falls through to the browser's
    native navigation.
20. **Signal fires on client disconnect.** `buildRequest` mints an
    `@orkestrel/abort` handle and builds the `Request` over its `signal`. The
    handle aborts if the request connection closes before the message finished
    (`!message.complete`), preserving that incomplete-request error, or if the
    paired `RequestOptions.response` closes before the response finished
    (`!response.writableEnded`). `handleListenerRequest` always supplies that
    response, so a handler observes both an incomplete request body and the
    ordinary post-request client disconnect through `request.signal`, with zero
    router-specific cancellation API. A normally completed response does not
    abort the signal, and each close observer is one-shot.
21. **Transport-level 500 is a last resort, not an error policy.**
    `createListener`'s handler wraps `dispatcher.handle` in a try/catch purely
    for the connection: when nothing has been sent yet, it writes a bare `500`
    head and ends the response (never leaking a hanging socket); after headers
    are already sent, it destroys the connection outright. The router still
    owns no error policy — a consumer wanting mapped error responses installs
    its own boundary around `dispatcher.handle` directly; and the core
    `Dispatcher` never swallows a handler throw into a generic response, as
    stated earlier.
22. **Streaming both ways.** `buildRequest` streams a body-carrying method's
    message into the `Request` through a manual `ReadableStream` pump — a `for
await` loop over the `IncomingMessage` enqueueing each chunk, with
    `duplex: 'half'` set as Node's fetch implementation requires for a
    streamed request body; `sendResponse` streams a non-`null` `Response`
    body back to the `ServerResponse` chunk by chunk, ending the target when
    the stream completes. When a write reports backpressure, it waits for
    `drain` before pulling the next body chunk, raced against target
    close/error/destruction so a client disconnect stops the pump promptly;
    every race listener is removed when that wait settles. A target destroyed
    mid-stream stops cleanly without throwing.
23. **Header fidelity.** `buildRequest` copies every incoming header
    (multi-value headers comma-joined, except `set-cookie`, appended
    individually); `sendResponse` writes every outgoing header and re-derives
    `set-cookie` through `Headers.getSetCookie()` so multiple response cookies
    stay distinct instead of collapsing into one comma-joined header.

## Patterns

### Groups and dedup

`group(prefix)` scopes a registration handle that composes its prefix onto
every entry it registers on the same underlying router; a `key` function
lets a later registration replace an earlier one in place instead of adding
a duplicate candidate.

```ts
import { createRouter } from '@orkestrel/router'

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
import { createRouter } from '@orkestrel/router'

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

Registering a single `GET` route yields an auto-derived `HEAD`, an auto-derived `OPTIONS`,
and a `405` for every other method on that path:

```ts
import { createDispatcher } from '@orkestrel/router'

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

The `on` hooks report every dispatch outcome, matched or missed, alongside the return
value of `handle`:

```ts
import { createDispatcher } from '@orkestrel/router'

const dispatcher = createDispatcher({
	on: {
		match: (method, pattern) => console.log('matched', method, pattern),
		miss: (method, pathname, status) => console.log('missed', method, pathname, status),
	},
})
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
await dispatcher.handle(new Request('http://x/missing'), undefined) // logs a 'miss'
```

### Typing a route input at the registration site

`defineRoute(...)` is a pure identity pass-through with a `const Path extends
string` generic — wrapping a route literal in it pins `Path` to the literal
string at the call site (instead of the widened `string` a bare intermediate
binding would get), so `context.params` types correctly through
`PathParams` even when the input is built before the `add` call:

```ts
import { createDispatcher, defineRoute } from '@orkestrel/router'

const input = defineRoute({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) => new Response(context.params.id), // typed string
})

const dispatcher = createDispatcher()
dispatcher.add(input)
```

A heterogeneous `RouteInput[]` built by collecting several `defineRoute(...)`
results still widens each element's `Path` to `string` the moment the array
type is inferred — TypeScript has no per-element literal-preserving array
type. The realistic ceiling `defineRoute` raises is per-call typing at the
registration site (a single `defineRoute({...})` or a direct `add({...})`
call), not a stored, still-literal-typed array of route records.

### Introspection and reset

`entries()` lists every registration (or only those matching a pathname —
the same set a 405 response's `Allow` header derives from); `clear()` drops
every entry while leaving the router usable; `Dispatcher.destroy()` tears
down its emitter.

```ts
import { createDispatcher, createRouter } from '@orkestrel/router'

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

A `Navigator` in hash mode dispatches on `location.hash` and updates `active` after
each `hashchange`:

```ts
import { createNavigator } from '@orkestrel/router/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/', meta: { title: 'Home' } },
		{ path: '/about', meta: { title: 'About' } },
	],
})
navigator.emitter.on('navigate', (match) => (document.title = match.meta.title))
navigator.start()
navigator.match('/about')?.meta.title // 'About' — a pure lookup, no location read
navigator.navigate('/about') // sets location.hash; `active` updates after the hashchange fires
navigator.stop()
navigator.destroy() // stop() plus tear down the #emitter
```

### History mode with link interception

History mode binds `popstate` and, with `intercept` set, same-origin `<a>` clicks:

```ts
import { createNavigator } from '@orkestrel/router/browser'

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
verdict is discarded through its own `signal`.

```ts
import { createNavigator } from '@orkestrel/router/browser'

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

`createListener` adapts a core `Dispatcher` into a `node:http` request listener:

```ts
import { createListener } from '@orkestrel/router/server'
import { createDispatcher } from '@orkestrel/router'
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
import { buildRequest, sendResponse } from '@orkestrel/router/server'
import { createDispatcher } from '@orkestrel/router'
import http from 'node:http'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const server = http.createServer(async (incoming, target) => {
	const request = buildRequest(incoming, {
		origin: 'https://api.example.com',
		response: target,
	})
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

The `Request` returned by `buildRequest` carries a `signal` that aborts when the connection
closes before the response completes:

```ts
import { buildRequest } from '@orkestrel/router/server'
import http from 'node:http'

const server = http.createServer((incoming, response) => {
	const request = buildRequest(incoming, { response })
	request.signal.addEventListener('abort', () => console.log('client disconnected'))
})
```

### Practices

- **One engine, one seam per face** — compose `Router` directly for a
  method-less consumer (a `Navigator`), or through `Dispatcher` for
  method-dimensioned fetch dispatch; never rebuild the matching logic per
  face.
- **Guard the registration boundary, not the hot path** — `add` throws a
  `ContractError` on a malformed entry; `match`/`handle` carry zero guards.
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

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔
  `src/core` / `src/browser` / `src/server` bijection (value + type exports), the
  interface-to-class method bijection for `RouterInterface`, `GroupInterface`,
  `DispatcherInterface`, `DispatchGroupInterface`, and `NavigatorInterface`, and the
  equality gate: every `Summary` cell against its declaration's description paragraph,
  the titled `Basic server` fence against the `@example` block of that title (pinned so
  the titled pair cannot be retired silently), and the README pitch against this guide's
  tagline. It also runs the flagship fences this project can execute and asserts the
  values their comments claim.
- [`tests/src/core/Router.test.ts`](../tests/src/core/Router.test.ts) —
  registration boundary guard, method-less matching, order-independent
  literal-over-param-over-wildcard precedence, wildcard capture, the
  `answers` seam, `entries()` (all + filtered), dedup through `key`, case
  sensitivity, and `RouterInterface` conformance.
- [`tests/src/core/Group.test.ts`](../tests/src/core/Group.test.ts) —
  `Group` direct construction, prefix composition and nesting, batch
  registration, dedup-key collision across differently-nested group chains,
  and `GroupInterface` conformance.
- [`tests/src/core/Dispatcher.test.ts`](../tests/src/core/Dispatcher.test.ts) —
  type-level surfaces (`RouteHandler` context typing, `TState` generic flow,
  `DispatcherInterface` member shape, factory return type), emitter event
  payload shapes, destroy idempotence, the cross-face grammar parity
  fixture, the full functional dispatch matrix (auto-HEAD, auto-OPTIONS,
  404/405 responders, handler-throw propagation), and per-method dedup.
- [`tests/src/core/DispatchGroup.test.ts`](../tests/src/core/DispatchGroup.test.ts) —
  `DispatchGroup` direct construction and group + nested group registration
  with prefixes composed.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) —
  `escapeRegExp`, `canonicalizePath`, `computeDispatchKey`, `compilePath` (literal/param/wildcard,
  trailing-slash folding, case sensitivity, the wildcard-not-final throw),
  `decodeParam` (including a malformed `%` escape), `matchPath`,
  `classifySegment` (the literal-vs-param classification fix regression
  case), `computeSpecificity`, `compareSpecificity`, `joinPaths`, and
  `defineRoute` (identity pass-through, literal `Path` preservation at the
  call site).
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) —
  `parseMethod` narrowing every registrable verb, rejecting an unknown verb
  and the wrong casing, and accepting exactly the verbs `METHOD_LIST`
  declares.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) —
  `createRouter`/`createDispatcher` round-trips and factory return-type
  assertions.
- [`tests/src/browser/Navigator.test.ts`](../tests/src/browser/Navigator.test.ts) —
  hash and history modes, `navigate()`/`active`/`navigate` event, fallback
  semantics, guard veto (sync + async, including supersede-discard), link
  interception on/off, `start`/`stop`/`destroy` idempotence,
  `NavigatorInterface` conformance, and the transcriptions of this guide's
  `@orkestrel/router/browser` fences.
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) —
  `createNavigator` returns a working `NavigatorInterface`.
- [`tests/src/browser/helpers.test.ts`](../tests/src/browser/helpers.test.ts) —
  `computeNavigationKey`, `extractHashPath`, `resolveLocationPath` (hash + history, with/without
  `base`), and `findAnchor` (including a click on a styled child inside an
  anchor).
- [`tests/src/server/validators.test.ts`](../tests/src/server/validators.test.ts) —
  `isEncryptedSocket` on an encrypted socket, a plain record, and every
  off-shape value.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  `buildRequest` fidelity (method, URL from `Host`, headers including
  multi-value and `set-cookie`, body streaming, the incomplete-request and
  complete-request response-side disconnect aborts, plus normal-response
  signal/listener cleanup) and `sendResponse` (status, headers including
  `set-cookie`, streamed and empty bodies, a destroyed target mid-stream)
  over real `node:http` sockets.
- [`tests/src/server/handlers.test.ts`](../tests/src/server/handlers.test.ts) —
  `handleListenerRequest` at the transport boundary and `createListener`
  end-to-end round-trips (matched, 404, 405, auto-HEAD, auto-OPTIONS, a
  handler throw, and per-request state) over real `node:http` sockets.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules: the Emitter pattern, the
  contract & validation architecture, one engine with native overrides,
  and documentation as contracts.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the supersede-safe guard
  cancellation primitive the Navigator composes, and the client-disconnect
  cancellation primitive the Listener composes.
- [`README.md`](README.md) — the guides index.
