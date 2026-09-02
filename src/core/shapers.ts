import { integerShape, jsonShape, stringShape } from '@orkestrel/contract'

/**
 * The `@orkestrel/database` column shape for a
 * {@link import('./types.js').SessionRow} table — pass as-is to
 * `createDatabase({ tables: { sessions: sessionColumns } })` so an app
 * declaring a durable session table never hand-writes the shape.
 *
 * @remarks
 * `seen`/`created` are `integerShape({ min: 0 })` — the table validates
 * them as integers, so
 * {@link import('./stores/DatabaseSessionStore.js').DatabaseSessionStore}'s
 * `now` clock must yield integer milliseconds (`Date.now()`, the implicit
 * default `createSession` clock). A fractional clock (`performance.now()`)
 * fails the write with a validation error; `MemorySessionStore` carries no
 * such column shape and accepts a fractional clock without complaint.
 *
 * @example
 * ```ts
 * const db = createDatabase({ driver, tables: { sessions: sessionColumns } })
 * ```
 */
export const sessionColumns = {
	id: stringShape(),
	session: jsonShape(),
	seen: integerShape({ min: 0 }),
	created: integerShape({ min: 0 }),
}
