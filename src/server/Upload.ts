import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { MultipartError } from './errors.js'
import { detectMIME } from './helpers.js'

/** Tracks one file part's size and signature, and stages its bytes only after the signature passes. */
export class Upload {
	readonly #path: string
	readonly #limit: number
	readonly #allowed: readonly string[] | undefined
	#handle: FileHandle | undefined
	#held: Buffer = Buffer.alloc(0)
	#head: Buffer = Buffer.alloc(0)
	#size = 0

	constructor(path: string, limit: number, allowed: readonly string[] | undefined) {
		this.#path = path
		this.#limit = limit
		this.#allowed = allowed
	}

	get size(): number {
		return this.#size
	}

	get head(): Buffer {
		return this.#head
	}

	async write(chunk: Buffer): Promise<void> {
		this.#size += chunk.length
		if (this.#size > this.#limit)
			throw new MultipartError('limit', 'multipart file exceeds size limit')
		if (this.#handle !== undefined) {
			await this.#handle.write(chunk)
			return
		}
		this.#held = this.#held.length === 0 ? chunk : Buffer.concat([this.#held, chunk])
		if (this.#held.length >= 16) await this.stage()
	}

	async stage(): Promise<void> {
		if (this.#handle !== undefined) return
		this.#head = this.#held.subarray(0, 16)
		const detected = detectMIME(this.#head)
		if (
			this.#allowed !== undefined &&
			(detected === undefined || !this.#allowed.includes(detected))
		)
			throw new MultipartError('rejected', 'multipart file failed type validation')
		this.#handle = await open(this.#path, 'w', 0o600)
		await this.#handle.write(this.#held)
		this.#held = Buffer.alloc(0)
	}

	async close(): Promise<void> {
		await this.#handle?.close()
	}
}
