import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipFile } from '../../src/zip.ts'
import { zip } from '../support/build.ts'

const dir = mkdtempSync(join(tmpdir(), 'bacpac-zip-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, data: Buffer) => {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

describe('ZipFile', () => {
  const big = Buffer.alloc(600_000, 'abcdefghij')
  const path = write(
    'a.zip',
    zip([
      { name: 'model.xml', data: Buffer.from('<m/>') },
      { name: 'Data/dbo.t/TableData-000-00000.BCP', data: big },
      { name: 'stored.bin', data: Buffer.from([1, 2, 3]), store: true },
      { name: 'empty', data: Buffer.alloc(0) },
    ]),
  )

  test('lists entries with their sizes', async () => {
    const file = await ZipFile.open(path)
    expect(file.entries.map((e) => [e.name, e.size])).toEqual([
      ['model.xml', 4],
      ['Data/dbo.t/TableData-000-00000.BCP', 600_000],
      ['stored.bin', 3],
      ['empty', 0],
    ])
    await file.close()
  })

  test('reads deflated, stored and empty entries', async () => {
    const file = await ZipFile.open(path)
    const read = async (name: string) => file.read(file.entry(name) as never)
    expect((await read('model.xml')).toString()).toBe('<m/>')
    expect((await read('Data/dbo.t/TableData-000-00000.BCP')).equals(big)).toBe(true)
    expect([...(await read('stored.bin'))]).toEqual([1, 2, 3])
    expect((await read('empty')).length).toBe(0)
    await file.close()
  })

  test('streams a large entry in more than one chunk', async () => {
    const file = await ZipFile.open(path)
    let chunks = 0
    for await (const _ of file.stream(file.entries[1] as never)) chunks++
    expect(chunks).toBeGreaterThan(1)
    await file.close()
  })

  test('refuses a file that is not a zip', () => {
    expect(
      ZipFile.open(write('not.zip', Buffer.from('hello, this is not an archive'))),
    ).rejects.toThrow('not a zip file')
  })
})
