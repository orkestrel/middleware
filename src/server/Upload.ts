import type { FileHandle } from 'node:fs/promises'
import { MultipartError } from './errors.js'

/** Tracks one file part's size and signature while writing its bytes. */
export class Upload {
	readonly #handle: FileHandle
	readonly #limit: number
	#size = 0
	#head = Buffer.alloc(0)

	constructor(handle: FileHandle, limit: number) {
		this.#handle = handle
		this.#limit = limit
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
		if (this.#head.length < 16)
			this.#head = Buffer.concat([this.#head, chunk.subarray(0, 16 - this.#head.length)])
		await this.#handle.write(chunk)
	}
}
