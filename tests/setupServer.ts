import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'

// ── Server-only test harness (AGENTS §16.1 / §17.6) ──────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-file / real-multipart-body / real-socket
// tests (§16: no mocks). Environment-agnostic helpers stay in `setup.ts`. This
// file REPLACES the router-template's upgrade-seam-oriented setup (this
// package has no protocol-upgrade concept) with the fixtures this package's
// node-face suites actually need.

/** A real PNG magic-byte header (8 bytes) — the shortest genuine PNG signature. */
export const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A real JPEG magic-byte header (3 bytes) — the shortest genuine JPEG signature. */
export const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff])

/** A temp-dir static fixture tree — the seeded directory plus its known file paths, ready for `createStatic` tests. */
export interface StaticFixtureInterface {
	readonly root: string
	readonly indexPath: string
	readonly nestedPath: string
	readonly dotfilePath: string
	readonly binaryPath: string
	readonly largePath: string
	readonly reservedPath: string
	readonly reservedLikePath: string
	cleanup(): Promise<void>
}

/**
 * Build a real temp-dir static-file fixture: nested directories, an
 * `index.html`, a dotfile, a binary file with real PNG magic bytes, a large
 * file (for Range tests), and a Windows-reserved-device-name file alongside
 * a merely reserved-LOOKING one — the seeded tree `createStatic`'s node-face
 * suite serves real files from (§16: no mocks).
 *
 * @returns A {@link StaticFixtureInterface} with a `cleanup()` teardown every caller MUST invoke
 *
 * @example
 * ```ts
 * const fixture = await buildStaticFixture()
 * try {
 * 	// ... drive createStatic({ root: fixture.root }) ...
 * } finally {
 * 	await fixture.cleanup()
 * }
 * ```
 */
export async function buildStaticFixture(): Promise<StaticFixtureInterface> {
	const root = await mkdtemp(join(tmpdir(), 'middleware-static-'))
	const indexPath = join(root, 'index.html')
	await writeFile(indexPath, '<!doctype html><html><body>root index</body></html>')

	const nestedDir = join(root, 'nested', 'deep')
	await mkdir(nestedDir, { recursive: true })
	const nestedPath = join(nestedDir, 'page.html')
	await writeFile(nestedPath, '<!doctype html><html><body>nested page</body></html>')

	const dotfilePath = join(root, '.env')
	await writeFile(dotfilePath, 'SECRET=hidden')

	const binaryPath = join(root, 'image.png')
	await writeFile(
		binaryPath,
		Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('rest of a fake png body')]),
	)

	const largePath = join(root, 'large.bin')
	await writeFile(largePath, Buffer.alloc(200_000, 0x41))

	const reservedPath = join(root, 'NUL.json')
	if (process.platform !== 'win32') {
		// On Windows, NUL is a reserved device name — the write would hit the null device, not disk.
		await writeFile(reservedPath, '{}')
	}

	const reservedLikePath = join(root, 'nullable.css')
	await writeFile(reservedLikePath, 'body { color: red }')

	async function cleanup(): Promise<void> {
		await rm(root, { recursive: true, force: true })
	}

	return {
		root,
		indexPath,
		nestedPath,
		dotfilePath,
		binaryPath,
		largePath,
		reservedPath,
		reservedLikePath,
		cleanup,
	}
}

/** One part of a real `multipart/form-data` body — either a text field or a file. */
export type MultipartPartInput =
	| { readonly kind: 'field'; readonly name: string; readonly value: string }
	| {
			readonly kind: 'file'
			readonly name: string
			readonly filename: string
			readonly contentType?: string
			readonly bytes: Uint8Array
	  }

/**
 * Compose a real `multipart/form-data` request body from a list of parts —
 * a genuine wire-format payload (§16.1: reuse the framework's own boundary
 * grammar, never a fabricated shortcut), with a caller-controllable
 * `boundary` so malformed-boundary test cases stay explicit.
 *
 * @param parts - The ordered parts to encode
 * @param boundary - The multipart boundary token; defaults to a fresh random one
 * @returns The encoded body bytes plus the `contentType` header value carrying the boundary
 *
 * @example
 * ```ts
 * const { body, contentType } = buildMultipartBody([
 * 	{ kind: 'field', name: 'title', value: 'hello' },
 * 	{ kind: 'file', name: 'avatar', filename: 'a.png', contentType: 'image/png', bytes: PNG_MAGIC },
 * ])
 * ```
 */
export function buildMultipartBody(
	parts: readonly MultipartPartInput[],
	boundary = `test-boundary-${randomUUID()}`,
): { readonly body: Uint8Array; readonly contentType: string } {
	const chunks: Uint8Array[] = []
	const encoder = new TextEncoder()
	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`))
		if (part.kind === 'field') {
			chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`))
			chunks.push(encoder.encode(part.value))
			chunks.push(encoder.encode('\r\n'))
		} else {
			chunks.push(
				encoder.encode(
					`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
				),
			)
			if (part.contentType !== undefined)
				chunks.push(encoder.encode(`Content-Type: ${part.contentType}\r\n`))
			chunks.push(encoder.encode('\r\n'))
			chunks.push(part.bytes)
			chunks.push(encoder.encode('\r\n'))
		}
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`))
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Build a `Request` carrying a real multipart body — composes
 * {@link buildMultipartBody} with a `POST` request the multipart battery can
 * stream-parse.
 *
 * @param parts - The ordered parts to encode
 * @param boundary - An optional explicit boundary token
 * @returns A `POST` `Request` with a real multipart body and matching `Content-Type`
 *
 * @example
 * ```ts
 * const request = buildMultipartRequest([{ kind: 'field', name: 'a', value: '1' }])
 * ```
 */
export function buildMultipartRequest(
	parts: readonly MultipartPartInput[],
	boundary?: string,
): Request {
	const { body, contentType } = buildMultipartBody(parts, boundary)
	return new Request('http://test.local/upload', {
		method: 'POST',
		headers: { 'content-type': contentType },
		body: new Blob([Buffer.from(body)]),
	})
}

/** A temp directory a multipart test can point `createMultipart`'s `directory` option at, with its own teardown. */
export interface TempDirectoryInterface {
	readonly path: string
	cleanup(): Promise<void>
}

/**
 * Create a fresh temp directory for a multipart test's staged uploads.
 *
 * @returns A {@link TempDirectoryInterface} with a `cleanup()` teardown every caller MUST invoke
 *
 * @example
 * ```ts
 * const directory = await buildTempDirectory()
 * try {
 * 	// ... drive createMultipart({ directory: directory.path }) ...
 * } finally {
 * 	await directory.cleanup()
 * }
 * ```
 */
export async function buildTempDirectory(): Promise<TempDirectoryInterface> {
	const path = await mkdtemp(join(tmpdir(), 'middleware-multipart-'))
	async function cleanup(): Promise<void> {
		await rm(path, { recursive: true, force: true })
	}
	return { path, cleanup }
}

/** A running real `node:http` test server bound to an ephemeral port, for the integration capstone. */
export interface TestServerInterface {
	readonly url: string
	readonly port: number
	close(): Promise<void>
}

/**
 * Determine whether a `net.Server#address()` result is the `AddressInfo`
 * shape (rather than a pipe-name `string` or `null`) — the total narrow
 * {@link startServer} uses to read the bound ephemeral port.
 *
 * @param value - The raw `server.address()` return value
 * @returns `true` when `value` is a non-null `AddressInfo` object
 *
 * @example
 * ```ts
 * isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 }) // true
 * isAddressInfo(null) // false
 * ```
 */
export function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
	return typeof value === 'object' && value !== null
}

/**
 * Start a real `node:http` server on an ephemeral port for a test — the
 * capstone's real socket (§16: no mocks).
 *
 * @remarks
 * Binds `listener` to `127.0.0.1:0` (OS-assigned free port) and resolves
 * once listening, with `url`/`port` derived from the bound address and a
 * `close()` that tears the server down. Every caller MUST call `close()`
 * to avoid leaking sockets across tests.
 *
 * @param listener - The `node:http` request listener to serve
 * @returns A {@link TestServerInterface} bound and ready to receive requests
 *
 * @example
 * ```ts
 * const server = await startServer((_request, response) => response.end('ok'))
 * const response = await fetch(server.url)
 * await server.close()
 * ```
 */
export function startServer(listener: http.RequestListener): Promise<TestServerInterface> {
	return new Promise((resolve, reject) => {
		const server = http.createServer(listener)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!isAddressInfo(address)) {
				reject(new Error('test server failed to bind to an ephemeral port'))
				return
			}
			const port = address.port
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res())
					}),
			})
		})
	})
}
