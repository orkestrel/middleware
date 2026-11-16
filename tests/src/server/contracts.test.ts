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
} from '@src/server'
import { requireValue } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
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
		expect(COOKIE_TRANSPORT_CONTRACT.is({ secret: 's', cookie: { maxAge: 60 } })).toBe(true)
		expect(COOKIE_TRANSPORT_CONTRACT.is({ secret: 's', cookie: { maxage: 60 } })).toBe(false)
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

describe.each(ADMISSION_DOORS)('$name', (door) => {
	it.each(listAdmissionRows(door))('$title', (row) => {
		const outcome = runAdmission(door, row)
		expect(outcome.refusal).toBe(row.path === undefined ? undefined : 'ContractError')
		expect(outcome.path).toEqual(row.path)
		expect(outcome.message).toContain(row.path === undefined ? '' : `${door.factory}:`)
	})
})
