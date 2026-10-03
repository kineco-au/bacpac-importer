/**
 * What is known about the committed demo store, checked value by value. This is
 * where a type's decoding is pinned against a real export rather than against
 * this project's own idea of the encoding.
 */
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convert,
  type Manifest,
  openBacpac,
  SqliteWriter,
  VERIFIED_TYPES,
} from '../../src/index.ts'
import { DEMO_STORE } from '../support/fixtures.ts'

const dir = mkdtempSync(join(tmpdir(), 'bacpac-demo-'))
const sqlite = join(dir, 'demo.sqlite')
let manifest: Manifest
let db: Database

beforeAll(async () => {
  manifest = await convert(DEMO_STORE, new SqliteWriter(sqlite))
  db = new Database(sqlite, { readonly: true })
})
afterAll(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

const values = (sql: string) => db.query(sql).values()

describe('the demo store', () => {
  test('is read as the database it is', async () => {
    const bacpac = await openBacpac(DEMO_STORE)
    expect(bacpac.tables.length).toBe(127)
    expect(bacpac.origin.rowCount).toBe(10305)
    expect(bacpac.origin.serverVersion).toStartWith('Microsoft SQL Server 2019')
    expect(bacpac.database.collation).toBe('SQL_Latin1_General_CP1_CI_AS')
    expect(bacpac.database.skipped).toEqual([])
    await bacpac.close()
  })

  test('converts whole, using only types that have been verified', () => {
    expect(manifest.rows).toBe(10305)
    expect(manifest.tables.length).toBe(127)
    expect(manifest.unverifiedTypes).toEqual([])
    const types = new Set(
      manifest.tables.flatMap((t) => t.columns.map((c) => c.sourceType.replace(/\(.*/, ''))),
    )
    for (const type of types) expect(VERIFIED_TYPES.has(type)).toBe(true)
    expect(values('SELECT COUNT(*) FROM umbracoNode')).toEqual([[548]])
    expect(values('SELECT COUNT(*) FROM umbracoPropertyData')).toEqual([[3462]])
  })

  test('uniqueidentifier: Umbraco’s well-known root node key', () => {
    expect(values('SELECT text, uniqueId FROM umbracoNode WHERE id = -1')).toEqual([
      ['SYSTEM DATA: umbraco master root', '916724a5-173d-4619-b97e-b9de133dd6f5'],
    ])
  })

  test('datetime2 keeps all seven fractional digits', () => {
    expect(
      values('SELECT MIN(CreationDate), MAX(CreationDate) FROM umbracoOpenIddictAuthorizations'),
    ).toEqual([['2025-03-15T19:44:16.1030448', '2025-12-16T10:43:47.3161243']])
  })

  test('decimal and numeric come back exact, at their declared scale', () => {
    expect(values('SELECT DISTINCT value FROM umbracoCommerceFrozenPrice ORDER BY 1')).toEqual([
      ['23.0000'],
      ['9.0000'],
    ])
    const all = new Set<string>()
    for (const table of manifest.tables)
      for (const column of table.columns)
        if (/^(decimal|numeric)\(19,8\)$/.test(column.sourceType))
          for (const [value] of values(
            `SELECT DISTINCT "${column.name}" FROM "${table.targetName}" WHERE "${column.name}" IS NOT NULL`,
          ))
            all.add(value as string)
    // A 23.00 item at 25% tax is 28.75, and 5.75 of that is the tax.
    expect([...all].sort()).toEqual([
      '0.00000000',
      '10.00000000',
      '2.25000000',
      '20.00000000',
      '23.00000000',
      '28.75000000',
      '5.75000000',
      '9.00000000',
    ])
  })

  test('nvarchar(max) holds whole JSON documents', () => {
    const rows = values('SELECT jsonInstruction FROM umbracoCacheInstruction') as [string][]
    expect(rows.length).toBeGreaterThan(0)
    for (const [json] of rows) expect(Array.isArray(JSON.parse(json))).toBe(true)
    expect(values('SELECT MAX(LENGTH(textValue)) FROM umbracoPropertyData')).toEqual([[4676]])
  })

  test('varbinary(max) comes back as bytes of the right length', () => {
    expect(
      values(
        'SELECT COUNT(*), MIN(LENGTH(dataRaw)), MAX(LENGTH(dataRaw)), typeof(dataRaw) FROM cmsContentNu WHERE dataRaw IS NOT NULL',
      ),
    ).toEqual([[619, 8, 2387, 'blob']])
  })

  test('the converted database is intact and its foreign keys hold', () => {
    expect(values('PRAGMA integrity_check')).toEqual([['ok']])
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
