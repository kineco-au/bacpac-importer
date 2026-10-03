import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convert,
  openBacpac,
  PostgresScriptWriter,
  type Progress,
  SqliteWriter,
} from '../../src/index.ts'
import { fitIdentifier } from '../../src/writers/postgres-script.ts'
import { bacpac, field, row, sampleTables } from '../support/build.ts'

const dir = mkdtempSync(join(tmpdir(), 'bacpac-convert-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const source = join(dir, 'sample.bacpac')
writeFileSync(source, bacpac(sampleTables(), { rows: 5 }))

describe('openBacpac', () => {
  test('exposes the schema, the origin and each table’s rows', async () => {
    const file = await openBacpac(source)
    expect(file.tables.map((t) => t.name)).toEqual(['Author', 'Post', 'Empty'])
    expect(file.origin.rowCount).toBe(5)
    expect(file.dataFiles(file.table('post') as never).length).toBe(2)

    const rows = []
    for await (const batch of file.rows(file.table('Post') as never)) rows.push(...batch)
    expect(rows).toEqual([
      [10, 1, 'Hello', 7, 'line one\nline\ttwo \\ end', 9_007_199_254_740_993n],
      [11, 2, null, null, null, -1n],
      [12, 2, '', 0, '', 0n],
    ])
    for await (const batch of file.rows(file.table('Empty') as never)) rows.push(...batch)
    expect(rows.length).toBe(3)
    await file.close()
  })

  test('refuses a zip with no model', async () => {
    const path = join(dir, 'empty.bacpac')
    const { zip } = await import('../support/build.ts')
    writeFileSync(path, zip([{ name: 'readme.txt', data: Buffer.from('x') }]))
    expect(openBacpac(path)).rejects.toThrow('no model.xml')
  })

  test('names the data file when a table is corrupt', async () => {
    const path = join(dir, 'corrupt.bacpac')
    const tables = sampleTables()
    ;(tables[0] as never as { data: Buffer[] }).data = [Buffer.from([1, 2, 3])]
    writeFileSync(path, bacpac(tables))
    const file = await openBacpac(path)
    const read = async () => {
      for await (const _ of file.rows(file.table('Author') as never)) {
      }
    }
    expect(read()).rejects.toThrow('Data/dbo.Author/TableData-000-00000.BCP')
    await read().catch(() => {})
    await file.close()
  })
})

describe('convert to SQLite', () => {
  const out = join(dir, 'sample.sqlite')

  test('writes every table and reports what it did', async () => {
    const progress: Progress[] = []
    const manifest = await convert(source, new SqliteWriter(out), {
      onProgress: (p) => progress.push(p),
    })

    expect(manifest.rows).toBe(5)
    expect(manifest.source.declaredRows).toBe(5)
    expect(manifest.target).toBe('sqlite')
    expect(manifest.tables.map((t) => [t.targetName, t.rows])).toEqual([
      ['Author', 2],
      ['Post', 3],
      ['Empty', 0],
    ])
    expect(manifest.tables[0]?.columns[1]).toEqual({
      name: 'key',
      sourceType: 'uniqueidentifier',
      targetType: 'TEXT',
      nullable: false,
    })
    expect(manifest.unverifiedTypes).toEqual([])
    expect(manifest.warnings).toEqual(['default (newid()) on Author.key was not translated'])
    expect(progress.filter((p) => p.done).map((p) => p.table)).toEqual([
      'dbo.Author',
      'dbo.Post',
      'dbo.Empty',
    ])
  })

  test('the values survive, including 64-bit integers and awkward text', () => {
    const db = new Database(out, { readonly: true, safeIntegers: true })
    expect(db.query('SELECT * FROM Author ORDER BY id').values()).toEqual([
      [1n, '916724a5-173d-4619-b97e-b9de133dd6f5', 'Ada', 1n, '2016-11-16T11:59:16.923'],
      [2n, '0f582a79-1e41-4cf0-bfa0-76340651891a', 'Grace O’Néill', 0n, '2023-12-14T20:49:34.023'],
    ])
    expect(
      db.query('SELECT title, views, body, size FROM Post ORDER BY id').values() as unknown[][],
    ).toEqual([
      ['Hello', 7n, 'line one\nline\ttwo \\ end', 9_007_199_254_740_993n],
      [null, null, null, -1n],
      ['', 0n, '', 0n],
    ])
    db.close()
  })

  test('the schema carries keys, defaults, indexes and case-insensitivity', () => {
    const db = new Database(out)
    const sql = (name: string) =>
      (db.query('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql
    expect(sql('Author')).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT')
    expect(sql('Author')).toContain('"name" TEXT COLLATE NOCASE NOT NULL')
    expect(sql('Author')).toContain('"active" INTEGER NOT NULL DEFAULT 1')
    expect(sql('Author')).toContain(
      '"created" TEXT COLLATE NOCASE NOT NULL DEFAULT CURRENT_TIMESTAMP',
    )
    expect(sql('Post')).toContain('FOREIGN KEY ("authorId") REFERENCES "Author" ("id")')
    expect(sql('Post')).toContain('"views" INTEGER DEFAULT 0')
    // Two tables had an index of the same name, which SQLite does not allow.
    expect(sql('IX_name')).toContain('UNIQUE INDEX')
    expect(sql('Post_IX_name')).toContain('ON "Post" ("title")')

    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.query("SELECT id FROM Author WHERE name = 'ADA'").values()).toEqual([[1]])
    db.run("INSERT INTO Author (key, name) VALUES ('k', 'New')")
    expect(db.query("SELECT id, active FROM Author WHERE name = 'New'").values()).toEqual([[3, 1]])
    db.close()
  })

  test('refuses to replace a file unless asked', async () => {
    expect(convert(source, new SqliteWriter(out))).rejects.toThrow('already exists')
    const manifest = await convert(source, new SqliteWriter(out, { overwrite: true }))
    expect(manifest.rows).toBe(5)
  })

  test('include and exclude choose tables, and a dropped foreign key is reported', async () => {
    const path = join(dir, 'partial.sqlite')
    const manifest = await convert(source, new SqliteWriter(path), {
      exclude: ['dbo.author', 'EMPTY'],
    })
    expect(manifest.tables.map((t) => t.name)).toEqual(['Post'])
    expect(manifest.excluded).toEqual(['dbo.Author', 'dbo.Empty'])
    expect(manifest.warnings).toContain(
      'foreign key FK_Post_Author points at a table that was not converted',
    )

    const only = await convert(source, new SqliteWriter(path, { overwrite: true }), {
      include: ['Author'],
    })
    expect(only.tables.map((t) => t.name)).toEqual(['Author'])
  })

  test('a case-sensitive source gets no NOCASE', async () => {
    const path = join(dir, 'cs.bacpac')
    writeFileSync(path, bacpac(sampleTables(), { caseSensitive: true }))
    const target = join(dir, 'cs.sqlite')
    await convert(path, new SqliteWriter(target))
    const db = new Database(target, { readonly: true })
    expect(db.query("SELECT id FROM Author WHERE name = 'ADA'").values()).toEqual([])
    db.close()
  })

  test('names a type nobody has verified', async () => {
    const path = join(dir, 'types.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [
            { name: 'a', type: 'int', nullable: false },
            { name: 'b', type: 'varchar', length: 10 },
          ],
          data: [row(field.raw(1, 4), field.varchar('x'))],
        },
      ]),
    )
    const manifest = await convert(path, new SqliteWriter(join(dir, 'types.sqlite')))
    expect(manifest.unverifiedTypes).toEqual(['varchar'])
  })

  test('a failed conversion closes the target and says why', async () => {
    const path = join(dir, 'bad.bacpac')
    writeFileSync(
      path,
      bacpac([
        { name: 't', columns: [{ name: 'a', type: 'sql_variant' }], data: [Buffer.alloc(4)] },
      ]),
    )
    expect(convert(path, new SqliteWriter(join(dir, 'bad.sqlite')))).rejects.toThrow(
      'sql_variant, which is not supported',
    )
  })
})

describe('convert to a Postgres script', () => {
  const out = join(dir, 'sample.sql')

  test('writes schema, data and constraints in loadable order', async () => {
    const manifest = await convert(source, new PostgresScriptWriter(out))
    const sql = readFileSync(out, 'utf8')

    expect(manifest.target).toBe('postgres-script')
    expect(manifest.tables[0]?.targetName).toBe('dbo.Author')
    expect(manifest.warnings[0]).toContain('case-insensitively')

    expect(sql.startsWith('BEGIN;')).toBe(true)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "dbo";')
    expect(sql).toContain(`CREATE TABLE "dbo"."Author" (
  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "key" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" varchar(100) NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PK_Author" PRIMARY KEY ("id")
);`)

    const order = [
      'CREATE TABLE "dbo"."Post"',
      'COPY "dbo"."Author"',
      'COPY "dbo"."Post"',
      'CREATE UNIQUE INDEX "IX_name" ON "dbo"."Author"',
      'CREATE INDEX "Post_IX_name" ON "dbo"."Post"',
      `SELECT setval(pg_get_serial_sequence('"dbo"."Post"', 'id')`,
      'ALTER TABLE "dbo"."Post" ADD CONSTRAINT "FK_Post_Author" FOREIGN KEY ("authorId") REFERENCES "dbo"."Author" ("id");',
    ].map((text) => sql.indexOf(text))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('escapes COPY data: nulls, booleans, tabs, newlines and backslashes', () => {
    const sql = readFileSync(out, 'utf8')
    expect(sql).toContain(
      '1\t916724a5-173d-4619-b97e-b9de133dd6f5\tAda\tt\t2016-11-16T11:59:16.923\n',
    )
    expect(sql).toContain('10\t1\tHello\t7\tline one\\nline\\ttwo \\\\ end\t9007199254740993\n')
    expect(sql).toContain('11\t2\t\\N\t\\N\t\\N\t-1\n')
    expect(sql).toContain('12\t2\t\t0\t\t0\n\\.\n')
  })

  test('binary becomes bytea hex, and NUL is removed from text with a warning', async () => {
    const path = join(dir, 'bin.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 'b',
          columns: [
            { name: 'data', type: 'varbinary', length: 8 },
            { name: 'text', type: 'nvarchar', length: 8 },
          ],
          data: [row(field.varbinary([0, 255, 16]), field.nvarchar('a\0b'))],
        },
      ]),
    )
    const target = join(dir, 'bin.sql')
    const manifest = await convert(path, new PostgresScriptWriter(target))
    expect(readFileSync(target, 'utf8')).toContain('\\\\x00ff10\tab\n')
    expect(manifest.warnings).toContain('NUL characters were removed from text in b')
  })

  test('an identity column holding only ids below 1 leaves its sequence at the start', async () => {
    const path = join(dir, 'negative.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 'u',
          columns: [{ name: 'id', type: 'int', nullable: false, identity: true }],
          data: [row(field.raw(-1, 4))],
        },
      ]),
    )
    const target = join(dir, 'negative.sql')
    await convert(path, new PostgresScriptWriter(target))
    const max = '(SELECT MAX("id") FROM "dbo"."u")'
    expect(readFileSync(target, 'utf8')).toContain(
      `GREATEST(COALESCE(${max}, 1), 1), COALESCE(${max}, 0) >= 1);`,
    )
  })

  test('a name longer than Postgres allows is shortened distinctly, not truncated', async () => {
    const long = `IX_${'a'.repeat(70)}`
    expect(fitIdentifier('short')).toBe('short')
    expect(Buffer.byteLength(fitIdentifier(`${long}_one`))).toBe(63)
    expect(fitIdentifier(`${long}_one`)).not.toBe(fitIdentifier(`${long}_two`))
    expect(fitIdentifier(`${long}_one`)).toBe(fitIdentifier(`${long}_one`))

    const path = join(dir, 'long.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [{ name: 'a', type: 'int', nullable: false }],
          indexes: [{ name: `${long}_one`, columns: ['a'] }],
        },
      ]),
    )
    const target = join(dir, 'long.sql')
    await convert(path, new PostgresScriptWriter(target))
    expect(readFileSync(target, 'utf8')).toContain(`INDEX "${fitIdentifier(`${long}_one`)}" ON`)
  })

  test('schema and skipForeignKeys options', async () => {
    const target = join(dir, 'public.sql')
    await convert(
      source,
      new PostgresScriptWriter(target, { schema: 'public', skipForeignKeys: true }),
    )
    const sql = readFileSync(target, 'utf8')
    expect(sql).toContain('CREATE TABLE "public"."Author"')
    expect(sql).not.toContain('"dbo"')
    expect(sql).not.toContain('FOREIGN KEY')
  })
})
