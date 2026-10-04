/**
 * Loads generated scripts into a real MySQL. Runs when `BACPAC_TEST_MYSQL`
 * holds a connection URL, and is skipped otherwise:
 *
 *   docker run -d --rm -p 3399:3306 -e MYSQL_ROOT_PASSWORD=test mysql:8.4
 *   BACPAC_TEST_MYSQL=mysql://root:test@localhost:3399 bun run test:integration
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { convert, MysqlScriptWriter } from '../../src/index.ts'
import { bacpac, sampleTables } from '../support/build.ts'
import { realExports } from '../support/fixtures.ts'

const url = process.env.BACPAC_TEST_MYSQL
const dir = mkdtempSync(join(tmpdir(), 'bacpac-mysql-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The mysql client takes no connection URL, so one is unpacked into its flags. */
function connection(): string[] {
  const parsed = new URL(url as string)
  return [
    `-h${parsed.hostname}`,
    `-P${parsed.port || '3306'}`,
    `-u${decodeURIComponent(parsed.username) || 'root'}`,
    ...(parsed.password ? [`-p${decodeURIComponent(parsed.password)}`] : []),
    // Without this the client reaches for a Unix socket whenever the host is localhost.
    '--protocol=TCP',
    '--default-character-set=utf8mb4',
  ]
}

/** Sends a script down one connection the way `mysql < file.sql` does. */
async function load(script: string): Promise<void> {
  const child = Bun.spawn(['mysql', ...connection()], {
    stdin: Bun.file(script),
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const stderr = await new Response(child.stderr).text()
  if ((await child.exited) !== 0) throw new Error(stderr)
}

/** `--raw` so a tab or a newline in a value arrives as itself. */
async function query(sql: string, database?: string): Promise<string> {
  const child = Bun.spawn(
    [
      'mysql',
      ...connection(),
      ...(database ? [`-D${database}`] : []),
      '-N',
      '-B',
      '--raw',
      '-e',
      sql,
    ],
    { stderr: 'pipe' },
  )
  const out = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return out.trim()
}

const hasClient = Bun.which('mysql') !== null
const unique = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`.slice(0, 60)

describe.skipIf(!url || !hasClient)('loading a script into MySQL', () => {
  test('the sample database loads, with types, keys and auto-increment intact', async () => {
    const database = unique('sample')
    const source = join(dir, 'sample.bacpac')
    const script = join(dir, 'sample.sql')
    writeFileSync(source, bacpac(sampleTables(), { rows: 5 }))
    await convert(source, new MysqlScriptWriter(script, { database }))
    await load(script)

    expect(
      await query(
        'SELECT CONCAT_WS("|", id, `key`, name, active, created) FROM Author ORDER BY id',
        database,
      ),
    ).toBe(
      [
        '1|916724a5-173d-4619-b97e-b9de133dd6f5|Ada|1|2016-11-16 11:59:16.923',
        '2|0f582a79-1e41-4cf0-bfa0-76340651891a|Grace O’Néill|0|2023-12-14 20:49:34.023',
      ].join('\n'),
    )
    // Tabs, newlines and backslashes survive escaping, and a 64-bit integer is exact.
    expect(await query('SELECT CONCAT_WS("|", body, size) FROM Post WHERE id = 10', database)).toBe(
      'line one\nline\ttwo \\ end|9007199254740993',
    )
    expect(await query('SELECT COUNT(*) FROM Post WHERE title IS NULL', database)).toBe('1')
    // An empty string stayed one, rather than becoming NULL.
    expect(await query('SELECT COUNT(*) FROM Post WHERE title = ""', database)).toBe('1')

    // The auto-increment counter continues after the imported rows, and defaults fire.
    await query('INSERT INTO Author (name) VALUES ("New")', database)
    expect(
      await query(
        'SELECT CONCAT_WS("|", id, active, LENGTH(`key`)) FROM Author WHERE name = "New"',
        database,
      ),
    ).toBe('3|1|36')

    // The foreign key is enforced.
    expect(query('INSERT INTO Post (authorId, size) VALUES (999, 0)', database)).rejects.toThrow(
      'FK_Post_Author',
    )

    // The collation matches the source: case-insensitive, accent-sensitive.
    expect(await query('SELECT id FROM Author WHERE name = "ADA"', database)).toBe('1')
    expect(await query('SELECT COUNT(*) FROM Author WHERE name = "Grace O’Neill"', database)).toBe(
      '0',
    )
    await query(`DROP DATABASE \`${database}\``)
  })

  test('a case-sensitive source gets a case-sensitive collation', async () => {
    const database = unique('cs')
    const source = join(dir, 'cs.bacpac')
    const script = join(dir, 'cs.sql')
    writeFileSync(source, bacpac(sampleTables(), { caseSensitive: true }))
    await convert(source, new MysqlScriptWriter(script, { database }))
    await load(script)
    expect(await query('SELECT COUNT(*) FROM Author WHERE name = "ADA"', database)).toBe('0')
    await query(`DROP DATABASE \`${database}\``)
  })

  for (const path of realExports()) {
    const name = basename(path)
    test(`${name} loads, constraints and all, with every row`, async () => {
      const database = unique('real')
      const script = join(dir, `${name}.sql`)
      const manifest = await convert(path, new MysqlScriptWriter(script, { database }))
      await load(script)

      for (const table of manifest.tables) {
        const count = await query(
          `SELECT COUNT(*) FROM \`${table.targetName.replaceAll('`', '``')}\``,
          database,
        )
        expect(Number(count)).toBe(table.rows)
      }
      // Every table and index arrived under a name MySQL did not have to reject.
      expect(
        await query(
          `SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = '${database}' AND CHAR_LENGTH(table_name) > 64`,
        ),
      ).toBe('0')
      expect(
        await query(
          `SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = '${database}' AND CHAR_LENGTH(index_name) > 64`,
        ),
      ).toBe('0')
      await query(`DROP DATABASE \`${database}\``)
    })
  }
})
