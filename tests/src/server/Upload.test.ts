import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createScratch } from '@orkestrel/test/server'
import { Upload } from '../../../src/server/Upload.js'

describe('Upload', () => {
	it('writes successive chunks and retains only the first signature bytes', async () => {
		const directory = createScratch({ prefix: 'upload-write-' })
		try {
			const path = join(directory.path, 'file')
			const handle = await open(path, 'w')
			try {
				const upload = new Upload(handle, 32)
				await upload.write(Buffer.from('abcdefghij'))
				await upload.write(Buffer.from('klmnopqrst'))
				expect(upload.size).toBe(20)
				expect(upload.head.toString()).toBe('abcdefghijklmnop')
			} finally {
				await handle.close()
			}
			expect(await readFile(path, 'utf8')).toBe('abcdefghijklmnopqrst')
		} finally {
			await directory.destroy()
		}
	})

	it('refuses an oversized chunk before writing it', async () => {
		const directory = createScratch({ prefix: 'upload-limit-' })
		try {
			const path = join(directory.path, 'file')
			const handle = await open(path, 'w')
			try {
				const upload = new Upload(handle, 3)
				await upload.write(Buffer.from('ab'))
				await expect(upload.write(Buffer.from('cd'))).rejects.toMatchObject({ code: 'limit' })
				expect(upload.size).toBe(4)
				expect(upload.head.toString()).toBe('ab')
			} finally {
				await handle.close()
			}
			expect(await readFile(path, 'utf8')).toBe('ab')
		} finally {
			await directory.destroy()
		}
	})
})
