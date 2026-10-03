/**
 * Loads generated scripts into a real Postgres. Runs when `BACPAC_TEST_POSTGRES`
 * holds a connection URL, and is skipped otherwise:
 *
 *   docker run -d --rm -p 5439:5432 -e POSTGRES_PASSWORD=test postgres:18-alpine
 *   BACPAC_TEST_POSTGRES=postgres://postgres:test@localhost:5439/postgres bun run test:integration
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { convert, PostgresScriptWriter } from '../../src/index.ts'
import { bacpac, sampleTables } from '../support/build.ts'
import { realExports } from '../support/fixtures.ts'

const url = process.env.BACPAC_TEST_POSTGRES
const dir = mkdtempSync(join(tmpdir(), 'bacpac-pg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Sends a script down one connection the way `psql -f` does, COPY data included. */
async function load(script: string): Promise<void> {
  const child = Bun.spawn(['psql', url as string, '-v', 'ON_ERROR_STOP=1', '-q', '-f', script], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const stderr = await new Response(child.stderr).text()
  if ((await child.exited) !== 0) throw new Error(stderr)
}

async function query(sql: string): Promise<string> {
  const child = Bun.spawn(['psql', url as string, '-At', '-c', sql], { stderr: 'pipe' })
  const out = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return out.trim()
}

const hasPsql = Bun.which('psql') !== null

describe.skipIf(!url || !hasPsql)('loading a script into Postgres', () => {
  test('the sample database loads, with types, keys and sequences intact', async () => {
    const schema = `sample_${Date.now()}`
    const source = join(dir, 'sample.bacpac')
    const script = join(dir, 'sample.sql')
    writeFileSync(source, bacpac(sampleTables(), { rows: 5 }))
    await convert(source, new PostgresScriptWriter(script, { schema }))
    await load(script)

    expect(
      await query(`SELECT id, key, name, active, created FROM ${schema}."Author" ORDER BY id`),
    ).toBe(
      [
        '1|916724a5-173d-4619-b97e-b9de133dd6f5|Ada|t|2016-11-16 11:59:16.923',
        '2|0f582a79-1e41-4cf0-bfa0-76340651891a|Grace O’Néill|f|2023-12-14 20:49:34.023',
      ].join('\n'),
    )
    expect(await query(`SELECT body, size FROM ${schema}."Post" WHERE id = 10`)).toBe(
      'line one\nline\ttwo \\ end|9007199254740993',
    )
    expect(await query(`SELECT count(*) FROM ${schema}."Post" WHERE title IS NULL`)).toBe('1')
    // The identity sequence continues after the imported rows.
    expect(
      await query(`INSERT INTO ${schema}."Author" (name) VALUES ('New') RETURNING id, active`),
    ).toStartWith('3|t')
    // The foreign key is enforced.
    expect(
      query(`INSERT INTO ${schema}."Post" ("authorId", size) VALUES (999, 0)`),
    ).rejects.toThrow('FK_Post_Author')
    await query(`DROP SCHEMA ${schema} CASCADE`)
  })

  for (const path of realExports()) {
    const name = basename(path)
    test(`${name} loads, constraints and all, with every row`, async () => {
      const schema = `real_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
      const script = join(dir, `${name}.sql`)
      const manifest = await convert(path, new PostgresScriptWriter(script, { schema }))
      await load(script)
      for (const table of manifest.tables) {
        const count = await query(
          `SELECT count(*) FROM ${schema}."${table.name.replaceAll('"', '""')}"`,
        )
        expect(Number(count)).toBe(table.rows)
      }
      // Every index and constraint arrived under a name Postgres did not have to truncate.
      expect(
        await query(
          `SELECT count(*) FROM pg_indexes WHERE schemaname = '${schema}' AND octet_length(indexname) > 63`,
        ),
      ).toBe('0')
      await query(`DROP SCHEMA ${schema} CASCADE`)
    })
  }
})
