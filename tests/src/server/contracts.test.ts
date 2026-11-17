import {
	ASSET_CONTRACT,
	BEARER_CONTRACT,
	BOUNDARY_CONTRACT,
	COMPRESSION_CONTRACT,
	COOKIE_TRANSPORT_CONTRACT,
	CORS_CONTRACT,
	CSRF_CONTRACT,
	DEADLINE_CONTRACT,
	ETAG_CONTRACT,
	FORWARDED_CONTRACT,
	HEADER_TRANSPORT_CONTRACT,
	LIMITER_CONTRACT,
	MEMORY_LIMITER_STORE_CONTRACT,
	MEMORY_SESSION_STORE_CONTRACT,
	MULTIPART_CONTRACT,
	NODE_COMPRESSION_CONTRACT,
	SCOPE_CONTRACT,
	SECURITY_CONTRACT,
	SESSION_CONTRACT,
	SESSION_LIMITS_CONTRACT,
	STATIC_CONTRACT,
	TELEMETRY_CONTRACT,
	UPLOADED_FILE_CONTRACT,
	admitOptions,
} from '@src/server'
import { attempt, ContractError, isRecord } from '@orkestrel/contract'
import { requireValue } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { TEST_SIGNER } from '../../setup.js'
import { ADMISSION_DOORS, listAdmissionRows, runAdmission } from '../../setupServer.js'

// ============================================================================
//  @orkestrel/middleware — compiled contracts. One table per door: every key at
//  a valid value, absent, at an explicit undefined, at each neighbor of its
//  range, and at a wrong type, plus an undeclared key, a misspelled key, and a
//  bag of the wrong type. Each refusal is a ContractError that names the
//  factory and carries the first fault's path.
// ============================================================================

describe('contracts', () => {
	it('compiles each bag contract as a closed object schema and the forwarded contract as two forms', () => {
		const contracts = [
			ASSET_CONTRACT,
			BEARER_CONTRACT,
			BOUNDARY_CONTRACT,
			COMPRESSION_CONTRACT,
			COOKIE_TRANSPORT_CONTRACT,
			CORS_CONTRACT,
			CSRF_CONTRACT,
			DEADLINE_CONTRACT,
			ETAG_CONTRACT,
			FORWARDED_CONTRACT,
			HEADER_TRANSPORT_CONTRACT,
			LIMITER_CONTRACT,
			MEMORY_LIMITER_STORE_CONTRACT,
			MEMORY_SESSION_STORE_CONTRACT,
			MULTIPART_CONTRACT,
			NODE_COMPRESSION_CONTRACT,
			SCOPE_CONTRACT,
			SECURITY_CONTRACT,
			SESSION_CONTRACT,
			SESSION_LIMITS_CONTRACT,
			STATIC_CONTRACT,
			TELEMETRY_CONTRACT,
			UPLOADED_FILE_CONTRACT,
		]
		for (const contract of contracts)
			expect(contract.schema).toMatchObject(
				contract === FORWARDED_CONTRACT
					? { anyOf: [{ additionalProperties: false }, { additionalProperties: false }] }
					: { type: 'object', additionalProperties: false },
			)
	})

	it('refuses a cookie record that names a key the server publishes in another case', () => {
		expect(COOKIE_TRANSPORT_CONTRACT.is({ signer: TEST_SIGNER, cookie: { maxAge: 60 } })).toBe(true)
		expect(COOKIE_TRANSPORT_CONTRACT.is({ signer: TEST_SIGNER, cookie: { maxage: 60 } })).toBe(
			false,
		)
	})

	it('refuses a bag that carries a secret where the signer belongs', () => {
		expect(COOKIE_TRANSPORT_CONTRACT.is({ signer: TEST_SIGNER })).toBe(true)
		expect(COOKIE_TRANSPORT_CONTRACT.is({ secret: 's' })).toBe(false)
		expect(COOKIE_TRANSPORT_CONTRACT.is({ signer: TEST_SIGNER, secret: 's' })).toBe(false)
		expect(CSRF_CONTRACT.is({ signer: TEST_SIGNER })).toBe(true)
		expect(CSRF_CONTRACT.is({ secret: ['current', 'previous'] })).toBe(false)
		expect(CSRF_CONTRACT.is({ signer: TEST_SIGNER, secret: 's' })).toBe(false)
	})

	it('refuses every key that its contract does not declare', () => {
		for (const door of ADMISSION_DOORS.filter((entry) => entry.positional !== true)) {
			const refused = requireValue(
				listAdmissionRows(door).find((row) => row.title === 'refuses an undeclared key'),
				`Missing undeclared-key case: ${door.name}`,
			)
			expect(runAdmission(door, refused).refusal).toBe('ContractError')
		}
	})
})

const SIGN_VERIFY = ['sign', 'verify']
const STORE_MEMBERS = ['get', 'set', 'delete']

// Each implementation key declares the members its published interface lists; a missing member refuses
// at the member's own path. Every row's door admits the bag whole through the contract's own.
const IMPLEMENTATION_ROWS = [
	{
		door: 'createLimiter',
		key: 'store',
		members: ['consume'],
		bag: { max: 1, window: 1_000 },
		own: (bag: unknown) => LIMITER_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createLimiter', LIMITER_CONTRACT, bag),
	},
	{
		door: 'createSession',
		key: 'transport',
		members: ['read', 'write', 'clear'],
		bag: { store: { get: () => undefined, set: () => undefined, delete: () => undefined } },
		own: (bag: unknown) => SESSION_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createSession', SESSION_CONTRACT, bag),
	},
	{
		door: 'createSession',
		key: 'store',
		members: STORE_MEMBERS,
		bag: { transport: { read: () => undefined, write: () => undefined, clear: () => undefined } },
		own: (bag: unknown) => SESSION_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createSession', SESSION_CONTRACT, bag),
	},
	{
		door: 'createCookieTransport',
		key: 'signer',
		members: SIGN_VERIFY,
		bag: {},
		own: (bag: unknown) => COOKIE_TRANSPORT_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createCookieTransport', COOKIE_TRANSPORT_CONTRACT, bag),
	},
	{
		door: 'createCSRF',
		key: 'signer',
		members: SIGN_VERIFY,
		bag: {},
		own: (bag: unknown) => CSRF_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createCSRF', CSRF_CONTRACT, bag),
	},
	{
		door: 'createAssets',
		key: 'source',
		members: ['read'],
		bag: {},
		own: (bag: unknown) => ASSET_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createAssets', ASSET_CONTRACT, bag),
	},
	{
		door: 'createAssets',
		key: 'store',
		members: STORE_MEMBERS,
		bag: { source: { read: () => undefined } },
		own: (bag: unknown) => ASSET_CONTRACT.own(bag),
		admit: (bag: unknown) => admitOptions('createAssets', ASSET_CONTRACT, bag),
	},
]

describe.each(IMPLEMENTATION_ROWS)('$door implementation key $key', (row) => {
	it('holds an implementation that carries its members on a prototype by identity', () => {
		const implementation: object = Object.create(
			Object.fromEntries(row.members.map((member) => [member, () => undefined])),
		)
		const outcome = row.own({ ...row.bag, [row.key]: implementation })
		expect(outcome.success).toBe(true)
		if (!outcome.success) return
		const held: unknown = outcome.value
		expect(isRecord(held)).toBe(true)
		if (!isRecord(held)) return
		expect(held[row.key]).toBe(implementation)
	})

	it('holds a callable that carries its members and an unknown member by identity', () => {
		const implementation = Object.assign(
			() => undefined,
			Object.fromEntries([...row.members, 'unknown'].map((member) => [member, () => undefined])),
		)
		const outcome = row.own({ ...row.bag, [row.key]: implementation })
		expect(outcome.success).toBe(true)
		if (!outcome.success) return
		const held: unknown = outcome.value
		expect(isRecord(held)).toBe(true)
		if (!isRecord(held)) return
		expect(held[row.key]).toBe(implementation)
	})

	it.each(row.members)('refuses an implementation that lacks %s at the member path', (member) => {
		const implementation = Object.fromEntries(
			row.members.filter((entry) => entry !== member).map((entry) => [entry, () => undefined]),
		)
		const outcome = attempt(() => row.admit({ ...row.bag, [row.key]: implementation }))
		expect(outcome.success).toBe(false)
		if (outcome.success || !(outcome.error instanceof ContractError)) return
		expect(outcome.error.message).toContain(`${row.door}: `)
		expect(outcome.error.code).toBe('structure')
		expect(outcome.error.context?.path).toEqual([row.key, member])
	})

	it.each(row.members)('refuses an implementation whose %s is not a function', (member) => {
		const implementation = Object.fromEntries([
			...row.members.filter((entry) => entry !== member).map((entry) => [entry, () => undefined]),
			[member, 1],
		])
		const outcome = attempt(() => row.admit({ ...row.bag, [row.key]: implementation }))
		expect(outcome.success).toBe(false)
		if (outcome.success || !(outcome.error instanceof ContractError)) return
		expect(outcome.error.context?.path).toEqual([row.key, member])
	})

	it('refuses a value that is not an object at the key path', () => {
		const outcome = attempt(() => row.admit({ ...row.bag, [row.key]: 'implementation' }))
		expect(outcome.success).toBe(false)
		if (outcome.success || !(outcome.error instanceof ContractError)) return
		expect(outcome.error.context?.path).toEqual([row.key])
	})
})

describe.each(ADMISSION_DOORS)('$name', (door) => {
	it.each(listAdmissionRows(door))('$title', (row) => {
		const outcome = runAdmission(door, row)
		expect(outcome.refusal).toBe(row.path === undefined ? undefined : 'ContractError')
		expect(outcome.path).toEqual(row.path)
		expect(outcome.message).toContain(row.path === undefined ? '' : `${door.factory}:`)
	})
})
