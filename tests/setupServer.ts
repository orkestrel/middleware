import type { AddressInfo } from 'node:net'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath, URL } from 'node:url'

// ── Server-only setup (AGENTS §16.1 / §17.6) ─────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (§8/§16: no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller).

/** The workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A running test server bound to an ephemeral port, with its base `url` and a `close` teardown. */
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
 * import { isAddressInfo } from '../setupServer.js'
 *
 * isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 }) // true
 * isAddressInfo(null) // false
 * ```
 */
export function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
	return typeof value === 'object' && value !== null
}

/**
 * Start a real `node:http` server on an ephemeral port for a test.
 *
 * @remarks
 * Binds `listener` to `127.0.0.1:0` (OS-assigned free port) and resolves
 * once listening, with `url`/`port` derived from the bound address and a
 * `close()` that tears the server down. Every caller MUST call `close()`
 * (typically in the test itself or an `afterEach`) to avoid leaking sockets
 * across tests.
 *
 * @param listener - The `node:http` request listener to serve
 * @returns A {@link TestServerInterface} bound and ready to receive requests
 *
 * @example
 * ```ts
 * import { startServer } from '../setupServer.js'
 *
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

/** The outcome of a raw `upgradeRequest` probe: whether a handler claimed the socket. */
export interface UpgradeOutcomeInterface {
	readonly claimed: boolean
	readonly status: number
}

/**
 * Drive a raw `node:http` protocol-upgrade request against a running server —
 * the real-socket probe the server face's upgrade-seam tests use (§16: no
 * mocks). Resolves once the outcome is known: a `101` upgrade response means
 * a registered handler CLAIMED the socket, an ordinary HTTP response (or a
 * connection error from a destroyed socket) means none did.
 *
 * @param base - The server's base URL (`http://127.0.0.1:PORT`)
 * @param path - The request path to upgrade
 * @param headers - Extra request headers merged with the upgrade handshake headers
 * @returns An {@link UpgradeOutcomeInterface}
 *
 * @example
 * ```ts
 * import { upgradeRequest } from '../setupServer.js'
 *
 * const outcome = await upgradeRequest(handle.url, '/ws')
 * ```
 */
/**
 * Send a raw, hand-written HTTP request over a bare `node:net` socket and
 * resolve with whatever bytes come back — the real-socket probe for
 * malformed-request vectors (a bad `Host` header) that `fetch` would refuse
 * to send (§16: no mocks, a genuinely raw wire payload).
 *
 * @param port - The target server's bound port (assumed `127.0.0.1`)
 * @param raw - The complete raw HTTP request text (including the trailing
 *   `\r\n\r\n`)
 * @returns The raw response bytes received, decoded as UTF-8
 *
 * @example
 * ```ts
 * import { rawRequest } from '../setupServer.js'
 *
 * const response = await rawRequest(port, 'GET / HTTP/1.1\r\nHost: foo bar\r\n\r\n')
 * ```
 */
export function rawRequest(port: number, raw: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
			socket.write(raw)
		})
		let data = ''
		socket.on('data', (chunk: Buffer) => {
			data += chunk.toString('utf8')
			socket.end()
		})
		socket.on('close', () => resolve(data))
		socket.on('error', reject)
	})
}

export function upgradeRequest(
	base: string,
	path = '/',
	headers: Record<string, string> = {},
): Promise<UpgradeOutcomeInterface> {
	return new Promise((resolve) => {
		const request = http.request(base + path, {
			headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
		})
		request.on('upgrade', (response, socket) => {
			socket.end()
			resolve({ claimed: true, status: response.statusCode ?? 0 })
		})
		request.on('response', (response) => {
			response.resume()
			resolve({ claimed: false, status: response.statusCode ?? 0 })
		})
		request.on('error', () => {
			resolve({ claimed: false, status: 0 })
		})
		request.end()
	})
}
