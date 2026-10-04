import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Column,
  convert,
  createWriter,
  type Database,
  type Row,
  registerTarget,
  type Table,
  targetNames,
  type Writer,
} from '../../src/index.ts'
import { bacpac, sampleTables } from '../support/build.ts'

const dir = mkdtempSync(join(tmpdir(), 'bacpac-targets-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A target written against the public interface alone, as a new database's would be. */
class MemoryWriter implements Writer {
  readonly target = 'memory'
  readonly warnings: string[] = []
  readonly events: string[] = []
  readonly rows = new Map<string, Row[]>()

  tableName(table: Table): string {
    return table.name.toLowerCase()
  }
  columnType(column: Column): string {
    return column.type.toUpperCase()
  }
  async begin(_database: Database, tables: Table[]): Promise<void> {
    this.events.push(`begin ${tables.length}`)
  }
  async beginTable(table: Table): Promise<void> {
    this.events.push(`table ${table.name}`)
    this.rows.set(table.name, [])
  }
  async writeRows(table: Table, rows: Row[]): Promise<void> {
    this.rows.get(table.name)?.push(...rows)
  }
  async endTable(table: Table): Promise<void> {
    this.events.push(`end ${table.name}`)
  }
  async end(): Promise<void> {
    this.events.push('end')
  }
  async abort(): Promise<void> {
    this.events.push('abort')
  }
}

const source = join(dir, 'sample.bacpac')
writeFileSync(source, bacpac(sampleTables(), { rows: 5 }))

describe('a target is anything that implements Writer', () => {
  test('convert drives a custom writer through the whole lifecycle', async () => {
    const writer = new MemoryWriter()
    const manifest = await convert(source, writer)

    expect(writer.events).toEqual([
      'begin 3',
      'table Author',
      'end Author',
      'table Post',
      'end Post',
      'table Empty',
      'end Empty',
      'end',
    ])
    expect(writer.rows.get('Author')?.length).toBe(2)
    expect(manifest.target).toBe('memory')
    expect(manifest.tables[0]?.targetName).toBe('author')
    expect(manifest.tables[0]?.columns[0]?.targetType).toBe('INT')
  })

  test('a writer that fails is aborted, not ended', async () => {
    const writer = new MemoryWriter()
    writer.writeRows = async () => {
      throw new Error('disk full')
    }
    expect(convert(source, writer)).rejects.toThrow('disk full')
    await convert(source, writer).catch(() => {})
    expect(writer.events.at(-1)).toBe('abort')
  })
})

describe('the target registry', () => {
  test('offers the built-in targets by name', () => {
    expect(targetNames()).toEqual(
      expect.arrayContaining(['sqlite', 'postgres-script', 'mysql-script']),
    )
    expect(createWriter('sqlite', { out: join(dir, 'x.sqlite') }).target).toBe('sqlite')
  })

  test('takes a new target without touching anything else', async () => {
    registerTarget('memory', () => new MemoryWriter())
    const writer = createWriter('memory', { out: '' })
    expect((await convert(source, writer)).rows).toBe(5)
  })

  test('names the choices when asked for one it does not have', () => {
    expect(() => createWriter('oracle', { out: 'x' })).toThrow('unknown target oracle; available:')
  })
})
