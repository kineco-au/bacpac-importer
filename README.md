# bacpac-importer

Reads a SQL Server `.bacpac` and converts its tables and data to SQLite or
Postgres. No SQL Server, no SqlPackage and no .NET: the file is decoded directly,
in TypeScript, on [Bun](https://bun.sh).

```bash
bun add @kineco-au/bacpac-importer
bunx bacpac-importer convert site.bacpac --to sqlite --out site.sqlite
```

Or from a checkout:

```bash
bun install
bun src/cli.ts inspect site.bacpac
bun src/cli.ts convert site.bacpac --to sqlite --out site.sqlite
bun src/cli.ts convert site.bacpac --to postgres-script --out site.sql   # then: psql -f site.sql
```

A manifest is written beside the output (`<out>.manifest.json`): every table with
its row count, every column with its original SQL Server type and the type it
became, what was left out, and any warnings.

## What it converts

Tables and their data, with primary keys, unique constraints, indexes, foreign
keys, identity columns and the default constraints that translate mechanically
(literals, the current time, a new GUID).

Views, procedures, functions, triggers and computed columns are T-SQL and are
**not** converted. They are listed in the manifest under `skipped`.

## As a library

```ts
import { convert, openBacpac, SqliteWriter } from '@kineco-au/bacpac-importer'

// Convert
const manifest = await convert('site.bacpac', new SqliteWriter('site.sqlite'), {
  exclude: ['umbracoLog'],
  onProgress: ({ table, rows }) => console.log(table, rows),
})

// Or just read
const bacpac = await openBacpac('site.bacpac')
for (const table of bacpac.tables)
  for await (const batch of bacpac.rows(table)) {
    // batch is an array of rows; a row is an array of values in column order
  }
await bacpac.close()
```

Rows are streamed in batches and never held per table.

### How values arrive

| SQL Server | JavaScript | SQLite | Postgres |
| --- | --- | --- | --- |
| `tinyint`, `smallint`, `int` | `number` | `INTEGER` | `smallint`, `integer` |
| `bigint` | `bigint` | `INTEGER` | `bigint` |
| `bit` | `boolean` | `INTEGER` 0/1 | `boolean` |
| `decimal`, `numeric`, `money` | `string`, exact | `TEXT` | `numeric(p,s)` |
| `float`, `real` | `number` | `REAL` | `double precision`, `real` |
| `uniqueidentifier` | `string`, lower case | `TEXT` | `uuid` |
| `datetime`, `datetime2`, `smalldatetime` | `string`, ISO 8601, no zone | `TEXT` | `timestamp` |
| `date`, `time`, `datetimeoffset` | `string`, ISO 8601 | `TEXT` | `date`, `time`, `timestamptz` |
| `char`, `varchar`, `text` and Unicode forms, `xml` | `string` | `TEXT` | `varchar(n)`, `char(n)`, `text` |
| `binary`, `varbinary`, `image`, `rowversion` | `Uint8Array` | `BLOB` | `bytea` |

When the source database is case-insensitive, SQLite text columns get
`COLLATE NOCASE` so lookups and unique indexes behave as they did. Postgres has
no direct equivalent, and the manifest warns about it.

## Adding a target

A target is a class that implements `Writer` (`src/writer.ts`). The reader, the
decoder and `convert` know nothing about which target is in use, so adding MySQL,
say, touches no existing code:

```ts
import { registerTarget, type Writer } from '@kineco-au/bacpac-importer'

class MySqlWriter implements Writer {
  readonly target = 'mysql'
  readonly warnings: string[] = []
  tableName(table) { /* the table's name in the target */ }
  columnType(column) { /* the column's type in the target */ }
  async begin(database, tables) { /* create the tables */ }
  async beginTable(table) {}
  async writeRows(table, rows) { /* one batch */ }
  async endTable(table) {}
  async end() { /* indexes, foreign keys, sequences */ }
  async abort() { /* release the target after a failure */ }
}

registerTarget('mysql', ({ out }) => new MySqlWriter(out))   // makes --to mysql work
```

`parseDefault` turns a default constraint into a dialect-neutral value for the
writer to render, and `sourceType` gives a column's type as SQL Server declares
it. `tests/unit/targets.test.ts` holds a complete in-memory writer as a worked
example.

## Status of the format

The row data files in a `.bacpac` have no public specification, so the decoder is
confirmed against real exports type by type. `VERIFIED_TYPES` lists what has been
confirmed; the manifest's `unverifiedTypes` names anything a conversion touched
that has not.

- **Confirmed against real exports:** `int`, `bigint`, `bit`, `uniqueidentifier`,
  `datetime`, `datetime2`, `decimal`/`numeric` (positive values), `nvarchar(n)`,
  `nvarchar(max)`, `ntext`, `varbinary(max)`
- **Implemented from documentation, not yet confirmed:** everything else in the
  table above, including `varchar`, `date`, `time`, `datetimeoffset`, `float` and
  `money`
- **Not supported:** `sql_variant`, spatial types, `hierarchyid` — a table using
  one fails with an error naming the column

Not built yet: a Postgres writer over a live connection, Node support for the
SQLite writer beyond a first attempt at `node:sqlite`, and translation of default
expressions beyond the simple cases.

## Development

```bash
bun run check              # format, lint, types
bun run test               # unit tests: synthetic .bacpac files built in memory
bun run test:integration   # the committed demo store, plus any export in fixtures/local/
```

The committed fixture is the Umbraco Commerce demo store, an Umbraco 17 database
of demonstration data (`fixtures/umbraco-commerce-demo-store/`, MIT licensed).

Real exports hold personal data. `fixtures/local/` and every other `*.bacpac` are
ignored by git; put one in `fixtures/local/` to run the structural tests against
it, and do not commit it.

The Postgres integration tests run when `BACPAC_TEST_POSTGRES` is a connection URL
and `psql` is installed:

```bash
docker run -d --rm -p 5439:5432 -e POSTGRES_PASSWORD=test postgres:18-alpine
BACPAC_TEST_POSTGRES=postgres://postgres:test@localhost:5439/postgres bun run test:integration
```

## Releasing

Every push to `main` runs the format, lint and type checks and both test suites
(`.github/workflows/ci.yml`).

Pushing a `v*` tag runs the same build and then publishes to npm
(`.github/workflows/release.yml`), so treat a tag push as a release, not a
bookmark:

```bash
# set "version" in package.json, commit, then
git tag v0.1.0 && git push origin v0.1.0
```

The tag must match the version in `package.json` or the release stops before
publishing. It needs an `NPM_TOKEN` repository secret with publish rights.

The package ships its TypeScript source and runs on Bun.
