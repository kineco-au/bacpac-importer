import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convert,
  MysqlScriptWriter,
  openBacpac,
  PostgresScriptWriter,
  type Progress,
  SqliteWriter,
} from '../../src/index.ts'
import { fitIdentifier } from '../../src/writers/postgres-script.ts'
import { bacpac, field, row, sampleTables, type TestTable } from '../support/build.ts'

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

describe('convert to a MySQL script', () => {
  const out = join(dir, 'sample.mysql.sql')

  test('writes session settings, schema, data and constraints in loadable order', async () => {
    const manifest = await convert(source, new MysqlScriptWriter(out, { database: 'demo' }))
    const sql = readFileSync(out, 'utf8')

    expect(manifest.target).toBe('mysql-script')
    // MySQL has no schemas, so a table keeps its bare name.
    expect(manifest.tables[0]?.targetName).toBe('Author')
    // MySQL's collation is case-insensitive, as the source is, so nothing is lost.
    expect(manifest.warnings).toEqual([])

    expect(sql).toContain("SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';")
    expect(sql).toContain(
      'CREATE DATABASE IF NOT EXISTS `demo` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;',
    )
    expect(sql).toContain('USE `demo`;')
    expect(sql).toContain(`CREATE TABLE \`Author\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`key\` char(36) NOT NULL DEFAULT (UUID()),
  \`name\` varchar(100) NOT NULL,
  \`active\` tinyint(1) NOT NULL DEFAULT 1,
  \`created\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci ROW_FORMAT=DYNAMIC;`)

    const order = [
      'CREATE TABLE `Post`',
      'INSERT INTO `Author`',
      'INSERT INTO `Post`',
      'CREATE UNIQUE INDEX `IX_name` ON `Author` (`name`);',
      // Restored before the foreign keys, so adding one checks the data against it.
      'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;',
      'ALTER TABLE `Post` ADD CONSTRAINT `FK_Post_Author` FOREIGN KEY (`authorId`) REFERENCES `Author` (`id`);',
      'SET SQL_MODE=@OLD_SQL_MODE;',
    ].map((text) => sql.indexOf(text))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('an index name is per table, as it is in SQL Server, so it is left alone', () => {
    const sql = readFileSync(out, 'utf8')
    expect(sql).toContain('CREATE INDEX `IX_name` ON `Post` (`title`);')
  })

  test('renders values: nulls, booleans, dates and escaped text', () => {
    const sql = readFileSync(out, 'utf8')
    expect(sql).toContain(
      "(1,'916724a5-173d-4619-b97e-b9de133dd6f5','Ada',1,'2016-11-16 11:59:16.923'),",
    )
    expect(sql).toContain("(2,'0f582a79-1e41-4cf0-bfa0-76340651891a','Grace O’Néill',0,")
    expect(sql).toContain("(10,1,'Hello',7,'line one\\nline\\ttwo \\\\ end',9007199254740993),")
    expect(sql).toContain('(11,2,NULL,NULL,NULL,-1),')
    expect(sql).toContain("(12,2,'',0,'',0);")
  })

  /** Every type whose MySQL rendering differs from the source's, in one table. */
  const types = (): TestTable[] => [
    {
      name: 't',
      columns: [
        { name: 'tiny', type: 'tinyint', nullable: false },
        { name: 'small', type: 'smallint', nullable: false },
        { name: 'amount', type: 'decimal', precision: 18, scale: 4, nullable: false },
        { name: 'owed', type: 'decimal', precision: 10, scale: 2, nullable: false },
        { name: 'cash', type: 'money', nullable: false },
        { name: 'day', type: 'date', nullable: false },
        { name: 'clock', type: 'time', scale: 7, nullable: false },
        { name: 'stamp', type: 'datetime2', scale: 7, nullable: false },
        { name: 'zoned', type: 'datetimeoffset', scale: 7, nullable: false },
        { name: 'note', type: 'nvarchar', isMax: true },
        { name: 'wide', type: 'char', length: 300 },
        { name: 'data', type: 'varbinary', isMax: true },
        { name: 'none', type: 'varbinary', length: 8 },
      ],
      data: [
        row(
          field.raw(255, 1),
          field.raw(-32768, 2),
          field.decimal('1234.5678'),
          field.decimal('-12.34'),
          Buffer.concat([Buffer.alloc(4), Buffer.from([0x40, 0x0d, 0x03, 0x00])]),
          field.date('2024-03-04'),
          field.time('05:06:07.1234567', 7),
          field.datetime2('2024-03-04T05:06:07.1234567', 7),
          field.datetimeoffset('2024-03-04T05:06:07.1234567', 600, 7),
          field.nvarcharMax("nul\0 ctrlZ\u001a quote' slash\\ tab\t nl\n"),
          field.varchar('wide text'),
          field.varbinaryMax([0, 255, 16]),
          field.varbinary([]),
        ),
      ],
    },
  ]

  test('maps the types MySQL spells differently', async () => {
    const path = join(dir, 'mysql-types.bacpac')
    writeFileSync(path, bacpac(types()))
    const manifest = await convert(path, new MysqlScriptWriter(join(dir, 'mysql-types.sql')))

    expect(manifest.tables[0]?.columns.map((column) => [column.name, column.targetType])).toEqual([
      // SQL Server's tinyint is unsigned and MySQL's is not.
      ['tiny', 'tinyint unsigned'],
      ['small', 'smallint'],
      ['amount', 'decimal(18,4)'],
      ['owed', 'decimal(10,2)'],
      ['cash', 'decimal(19,4)'],
      ['day', 'date'],
      // MySQL keeps six fractional digits where SQL Server keeps seven.
      ['clock', 'time(6)'],
      ['stamp', 'datetime(6)'],
      ['zoned', 'datetime(6)'],
      ['note', 'longtext'],
      // MySQL's char stops at 255 characters.
      ['wide', 'varchar(300)'],
      ['data', 'longblob'],
      ['none', 'varbinary(8)'],
    ])
  })

  test('renders decimals bare, binary as hex, and trims the seventh fractional digit', () => {
    const sql = readFileSync(join(dir, 'mysql-types.sql'), 'utf8')
    expect(sql).toContain(
      '(255,-32768,1234.5678,-12.34,20.0000,' +
        // A space replaces ISO 8601's T, the offset is dropped, and six digits are kept.
        "'2024-03-04','05:06:07.123456','2024-03-04 05:06:07.123456','2024-03-04 05:06:07.123456'," +
        "'nul\\0 ctrlZ\\Z quote\\' slash\\\\ tab\\t nl\\n'," +
        "'wide text',X'00ff10',X'');",
    )
  })

  test('says so when a zoned timestamp loses its offset', async () => {
    const path = join(dir, 'mysql-zoned.bacpac')
    writeFileSync(path, bacpac(types()))
    const manifest = await convert(path, new MysqlScriptWriter(join(dir, 'mysql-zoned.sql')))
    expect(manifest.warnings).toContain(
      'datetimeoffset zoned became datetime; MySQL has no zoned timestamp, so the time is kept as it was written and the offset is dropped',
    )
  })

  test('indexes a long column by a prefix, because MySQL cannot index the whole of one', async () => {
    const path = join(dir, 'mysql-prefix.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [{ name: 'note', type: 'nvarchar', isMax: true }],
          indexes: [{ name: 'IX_note', columns: ['note'] }],
        },
      ]),
    )
    const target = join(dir, 'mysql-prefix.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    // The whole 3072-byte budget, at four bytes a character.
    expect(readFileSync(target, 'utf8')).toContain('ON `t` (`note`(768));')
    expect(manifest.warnings).toContain(
      't.note is indexed by its first 768 characters; MySQL limits a key to 3072 bytes',
    )
  })

  test('cuts a key too wide to index down until it fits', async () => {
    const path = join(dir, 'mysql-wide-key.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [
            { name: 'a', type: 'nvarchar', length: 400, nullable: false },
            { name: 'b', type: 'nvarchar', length: 400, nullable: false },
          ],
          indexes: [{ name: 'IX_ab', unique: true, columns: ['a', 'b'] }],
        },
      ]),
    )
    const target = join(dir, 'mysql-wide-key.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    expect(readFileSync(target, 'utf8')).toContain('ON `t` (`a`(384), `b`(384));')
    expect(manifest.warnings).toContain(
      'unique key IX_ab on t is enforced on a prefix of its text, which is stricter than the source',
    )
  })

  test('a narrow column in a wide key keeps the whole of itself', async () => {
    const path = join(dir, 'mysql-share-key.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [
            // char(36) in MySQL, and its width is not in the model's Length.
            { name: 'entityId', type: 'uniqueidentifier', nullable: false },
            { name: 'entityType', type: 'nvarchar', length: 255, nullable: false },
            { name: 'key', type: 'nvarchar', length: 255, nullable: false },
            { name: 'lang', type: 'nvarchar', length: 255, nullable: false },
          ],
          uniqueConstraints: [{ name: 'UQ_t', columns: ['entityId', 'entityType', 'key', 'lang'] }],
        },
      ]),
    )
    const target = join(dir, 'mysql-share-key.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    expect(readFileSync(target, 'utf8')).toContain(
      'UNIQUE (`entityId`, `entityType`(244), `key`(244), `lang`(244));',
    )
    expect(manifest.warnings).not.toContain(
      't.entityId is indexed by its first 244 characters; MySQL limits a key to 3072 bytes',
    )
  })

  test('gives an auto-increment column a key of its own when the primary key is elsewhere', async () => {
    const path = join(dir, 'mysql-identity.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [
            { name: 'code', type: 'nvarchar', length: 20, nullable: false },
            { name: 'seq', type: 'int', nullable: false, identity: true },
          ],
          primaryKey: ['code'],
          uniqueConstraints: [{ name: 'UQ_t_seq', columns: ['seq'] }],
          data: [row(field.nvarchar('a'), field.raw(5, 4))],
        },
      ]),
    )
    const target = join(dir, 'mysql-identity.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    const sql = readFileSync(target, 'utf8')
    expect(sql).toContain('`seq` int NOT NULL AUTO_INCREMENT')
    expect(sql).toContain('KEY `IX_t_seq` (`seq`)')
    expect(sql).toContain('ALTER TABLE `t` ADD CONSTRAINT `UQ_t_seq` UNIQUE (`seq`);')
    expect(manifest.warnings).toContain(
      'an index was added on t.seq; MySQL needs an auto-increment column to be the first column of a key',
    )
  })

  test('drops a referential action InnoDB refuses, and keeps the ones it takes', async () => {
    const path = join(dir, 'mysql-actions.bacpac')
    writeFileSync(
      path,
      bacpac([
        { name: 'parent', columns: [{ name: 'id', type: 'int', nullable: false }] },
        {
          name: 'child',
          columns: [
            { name: 'a', type: 'int' },
            { name: 'b', type: 'int' },
          ],
          foreignKeys: [
            {
              name: 'FK_a',
              columns: ['a'],
              table: 'parent',
              foreignColumns: ['id'],
              onDelete: 'CASCADE',
              onUpdate: 'SET NULL',
            },
            {
              name: 'FK_b',
              columns: ['b'],
              table: 'parent',
              foreignColumns: ['id'],
              onDelete: 'SET DEFAULT',
            },
          ],
        },
      ]),
    )
    const target = join(dir, 'mysql-actions.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    const sql = readFileSync(target, 'utf8')
    expect(sql).toContain('`FK_a` FOREIGN KEY (`a`) REFERENCES `parent` (`id`) ON DELETE CASCADE')
    expect(sql).toContain('ON DELETE CASCADE ON UPDATE SET NULL;')
    expect(sql).toContain('`FK_b` FOREIGN KEY (`b`) REFERENCES `parent` (`id`);')
    expect(manifest.warnings).toContain(
      'ON DELETE SET DEFAULT on FK_b was dropped; InnoDB does not support it',
    )
  })

  test('two schemas sharing a table name keep both, prefixed', async () => {
    const path = join(dir, 'mysql-schemas.bacpac')
    const columns = [{ name: 'id', type: 'int', nullable: false }]
    writeFileSync(
      path,
      bacpac([
        { name: 'Thing', columns, data: [row(field.raw(1, 4))] },
        { schema: 'audit', name: 'Thing', columns, data: [row(field.raw(2, 4))] },
      ]),
    )
    const target = join(dir, 'mysql-schemas.sql')
    const manifest = await convert(path, new MysqlScriptWriter(target))
    expect(manifest.tables.map((table) => table.targetName)).toEqual(['dbo_Thing', 'audit_Thing'])
    expect(readFileSync(target, 'utf8')).toContain('INSERT INTO `audit_Thing` (`id`) VALUES\n(2);')
  })

  test('a name longer than MySQL allows is shortened distinctly, not truncated', async () => {
    const long = `IX_${'a'.repeat(70)}`
    const path = join(dir, 'mysql-long.bacpac')
    writeFileSync(
      path,
      bacpac([
        {
          name: 't',
          columns: [{ name: 'a', type: 'int', nullable: false }],
          indexes: [{ name: long, columns: ['a'] }],
        },
      ]),
    )
    const target = join(dir, 'mysql-long.sql')
    await convert(path, new MysqlScriptWriter(target))
    const name = /CREATE INDEX `([^`]+)`/.exec(readFileSync(target, 'utf8'))?.[1] as string
    expect(Buffer.byteLength(name)).toBe(64)
    expect(long.startsWith(name.slice(0, -9))).toBe(true)
  })

  test('a case-sensitive source gets a case-sensitive collation, and an explicit one wins', async () => {
    const path = join(dir, 'mysql-cs.bacpac')
    writeFileSync(path, bacpac(sampleTables(), { caseSensitive: true }))
    const target = join(dir, 'mysql-cs.sql')
    await convert(path, new MysqlScriptWriter(target))
    expect(readFileSync(target, 'utf8')).toContain('COLLATE=utf8mb4_0900_as_cs')

    const chosen = join(dir, 'mysql-collation.sql')
    await convert(path, new MysqlScriptWriter(chosen, { collation: 'utf8mb4_unicode_ci' }))
    expect(readFileSync(chosen, 'utf8')).toContain('COLLATE=utf8mb4_unicode_ci')
  })

  test('without a database the script names none, and foreign keys can be left out', async () => {
    const target = join(dir, 'mysql-bare.sql')
    await convert(source, new MysqlScriptWriter(target, { skipForeignKeys: true }))
    const sql = readFileSync(target, 'utf8')
    expect(sql).not.toContain('CREATE DATABASE')
    expect(sql).not.toContain('USE ')
    expect(sql).not.toContain('FOREIGN KEY')
  })

  test('rows are split across statements so none outgrows max_allowed_packet', async () => {
    const target = join(dir, 'mysql-batched.sql')
    await convert(source, new MysqlScriptWriter(target, { maxStatementBytes: 1 }))
    const sql = readFileSync(target, 'utf8')
    expect(sql.match(/INSERT INTO `Post`/g)?.length).toBe(3)
    // An empty table still gets no statement at all.
    expect(sql).not.toContain('INSERT INTO `Empty`')
  })
})
