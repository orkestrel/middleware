import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createScratch } from '@orkestrel/test/server'
import { PNG_MAGIC } from '../../setupServer.js'
import { Upload } from '../../../src/server/Upload.js'

describe('Upload', () => {
	it('writes successive chunks and retains only the first signature bytes', async () => {
		const directory = createScratch({ prefix: 'upload-write-' })
		try {
			const path = join(directory.path, 'file')
			const upload = new Upload(path, 32, undefined)
			try {
				await upload.write(Buffer.from('abcdefghij'))
				expect(directory.names()).toEqual([])
				await upload.write(Buffer.from('klmnopqrst'))
				expect(upload.size).toBe(20)
				expect(upload.head.toString()).toBe('abcdefghijklmnop')
			} finally {
				await upload.close()
			}
			expect(await readFile(path, 'utf8')).toBe('abcdefghijklmnopqrst')
		} finally {
			directory.destroy()
		}
	})

	it('stages a file shorter than the signature window when asked', async () => {
		const directory = createScratch({ prefix: 'upload-short-' })
		try {
			const path = join(directory.path, 'file')
			const upload = new Upload(path, 32, undefined)
			try {
				await upload.write(Buffer.from('lamp'))
				expect(directory.names()).toEqual([])
				await upload.stage()
				await upload.stage()
				expect(upload.head.toString()).toBe('lamp')
			} finally {
				await upload.close()
			}
			expect(await readFile(path, 'utf8')).toBe('lamp')
		} finally {
			directory.destroy()
		}
	})

	it('refuses a signature off the allowed list before it opens the staged file', async () => {
		const directory = createScratch({ prefix: 'upload-screen-' })
		try {
			const upload = new Upload(join(directory.path, 'file'), 64, ['image/png'])
			try {
				await expect(
					upload.write(Buffer.from('<html>lamp oil and wick</html>')),
				).rejects.toMatchObject({ code: 'rejected' })
			} finally {
				await upload.close()
			}
			expect(directory.names()).toEqual([])
		} finally {
			directory.destroy()
		}
	})

	it('stages a signature on the allowed list', async () => {
		const directory = createScratch({ prefix: 'upload-screen-' })
		try {
			const path = join(directory.path, 'file')
			const bytes = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('lamp oil and wick')])
			const upload = new Upload(path, 64, ['image/png'])
			try {
				await upload.write(bytes)
			} finally {
				await upload.close()
			}
			expect(await readFile(path)).toEqual(bytes)
		} finally {
			directory.destroy()
		}
	})

	it('refuses an oversized chunk before writing it', async () => {
		const directory = createScratch({ prefix: 'upload-limit-' })
		try {
			const path = join(directory.path, 'file')
			const upload = new Upload(path, 18, undefined)
			try {
				await upload.write(Buffer.from('abcdefghijklmnop'))
				await expect(upload.write(Buffer.from('qrs'))).rejects.toMatchObject({ code: 'limit' })
				expect(upload.size).toBe(19)
				expect(upload.head.toString()).toBe('abcdefghijklmnop')
			} finally {
				await upload.close()
			}
			expect(await readFile(path, 'utf8')).toBe('abcdefghijklmnop')
		} finally {
			directory.destroy()
		}
	})
})
