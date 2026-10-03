/**
 * Runs against real exports: the committed demo store, and anything in
 * `fixtures/local/`, which is not committed because real exports hold personal
 * data.
 *
 * These assertions are structural — counts, integrity, shapes — so they hold for
 * any export and print nothing from one. What is specific to the demo store is in
 * `demo-store.integration.ts`.
 */
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { convert, openBacpac, PostgresScriptWriter, SqliteWriter } from '../../src/index.ts'
import { realExports } from '../support/fixtures.ts'

const files = realExports()

const dir = mkdtempSync(join(tmpdir(), 'bacpac-real-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/
const DATETIME2 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/
const DECIMAL = /^-?\d+(\.\d+)?$/

for (const source of files) {
  const name = basename(source)

  describe(`a real export: ${name} (${statSync(source).size} bytes)`, () => {
    const sqlite = join(dir, `${name}.sqlite`)

    test('every table decodes, and the rows add up to what the export declares', async () => {
      const bacpac = await openBacpac(source)
      let rows = 0
      for (const table of bacpac.tables) {
        const guids = table.columns.flatMap((c, i) => (c.type === 'uniqueidentifier' ? i : []))
        const dates = table.columns.flatMap((c, i) => (c.type === 'datetime' ? i : []))
        const dates2 = table.columns.flatMap((c, i) => (c.type === 'datetime2' ? i : []))
        const decimals = table.columns.flatMap((c, i) =>
          c.type === 'decimal' || c.type === 'numeric' ? i : [],
        )
        for await (const batch of bacpac.rows(table)) {
          rows += batch.length
          for (const row of batch) {
            expect(row.length).toBe(table.columns.length)
            for (const i of guids) if (row[i] !== null) expect(row[i]).toMatch(GUID)
            for (const i of dates) if (row[i] !== null) expect(row[i]).toMatch(DATETIME)
            for (const i of dates2) if (row[i] !== null) expect(row[i]).toMatch(DATETIME2)
            for (const i of decimals) if (row[i] !== null) expect(row[i]).toMatch(DECIMAL)
          }
        }
      }
      expect(bacpac.origin.rowCount).toBeGreaterThan(0)
      expect(rows).toBe(bacpac.origin.rowCount as number)
      await bacpac.close()
    })

    test('NOT NULL columns never decode to null', async () => {
      const bacpac = await openBacpac(source)
      for (const table of bacpac.tables) {
        const required = table.columns.flatMap((c, i) => (c.nullable ? [] : i))
        for await (const batch of bacpac.rows(table))
          for (const row of batch) for (const i of required) expect(row[i]).not.toBeNull()
      }
      await bacpac.close()
    })

    test('converts to a SQLite database that is intact and consistent', async () => {
      const manifest = await convert(source, new SqliteWriter(sqlite))
      expect(manifest.rows).toBe(manifest.source.declaredRows as number)

      const db = new Database(sqlite, { readonly: true })
      expect(db.query('PRAGMA integrity_check').values()).toEqual([['ok']])
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
      for (const table of manifest.tables) {
        const [count] = db
          .query(`SELECT COUNT(*) FROM "${table.targetName.replaceAll('"', '""')}"`)
          .values()[0] as [number]
        expect(count).toBe(table.rows)
      }
      db.close()
    })

    test('writes a Postgres script with a COPY block per table and every row in it', async () => {
      const out = join(dir, `${name}.sql`)
      const manifest = await convert(source, new PostgresScriptWriter(out))
      expect(manifest.rows).toBe(manifest.source.declaredRows as number)

      // A data line is one row: newlines inside values are escaped.
      let copies = 0
      let rows = 0
      let inCopy = false
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of Bun.file(out).stream()) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          if (inCopy) {
            if (line === '\\.') inCopy = false
            else rows++
          } else if (line.startsWith('COPY ')) {
            inCopy = true
            copies++
          }
        }
      }
      expect(copies).toBe(manifest.tables.length)
      expect(rows).toBe(manifest.rows)
    })
  })
}
