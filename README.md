# bacpac-importer

Convert a SQL Server `.bacpac` to SQLite, Postgres or MySQL.

The export is read directly — no SQL Server to restore it into, no SqlPackage and
no .NET. Point it at the file and get a database out.

```bash
bunx @kineco-au/bacpac-importer convert site.bacpac --to sqlite --out site.sqlite
```

Requires [Bun](https://bun.sh) 1.3 or later.

## Install

```bash
bun add @kineco-au/bacpac-importer
```

## Command line

```bash
# What is in the file: tables, row count, server version, anything not convertible
bacpac-importer inspect site.bacpac
bacpac-importer inspect site.bacpac --columns

# To a SQLite database file
bacpac-importer convert site.bacpac --to sqlite --out site.sqlite

# To a SQL script for Postgres, then load it
bacpac-importer convert site.bacpac --to postgres-script --out site.sql
psql "$DATABASE_URL" -f site.sql

# To a SQL script for MySQL, then load it
bacpac-importer convert site.bacpac --to mysql-script --out site.sql
mysql -D mydb < site.sql

# Or have the script create the database and select it itself
bacpac-importer convert site.bacpac --to mysql-script --out site.sql --schema mydb
mysql < site.sql
```

| Option | |
| --- | --- |
| `--to <target>` | `sqlite`, `postgres-script` or `mysql-script` |
| `--out <path>` | the file to write |
| `--include <table>` | convert only this table; repeatable. `table` or `schema.table` |
| `--exclude <table>` | leave this table out; repeatable |
| `--overwrite` | replace an existing SQLite file |
| `--schema <name>` | Postgres: put every table in this schema. MySQL: create this database and `USE` it |
| `--skip-foreign-keys` | Postgres and MySQL: leave foreign keys out, for data that does not satisfy them |
| `--collation <name>` | MySQL: the collation for tables and text; default matches the source's case sensitivity |
| `--encoding <name>` | the encoding of `char`/`varchar`/`text` values; default `windows-1252` |
| `--manifest <path>` | where to write the manifest; default `<out>.manifest.json` |

## What gets converted

Tables and their data, with primary keys, unique constraints, indexes, foreign
keys, identity columns, and default values where they translate directly
(literals, the current time, a new GUID).

Views, stored procedures, functions, triggers and computed columns are **not**
converted: they are T-SQL and have no mechanical translation. They are listed in
the manifest so you know what was left behind.

### The manifest

Every conversion writes a JSON manifest beside its output:

- each table, its name in the target, and its row count
- each column's original SQL Server type and the type it became
- the row total the export itself declares, to compare against what was written
- anything skipped, and any warnings — a default that did not translate, a
  foreign key pointing at an excluded table

## Library

```ts
import { convert, SqliteWriter } from '@kineco-au/bacpac-importer'

const manifest = await convert('site.bacpac', new SqliteWriter('site.sqlite'), {
  exclude: ['AuditLog'],
  onProgress: ({ table, rows, done }) => done && console.log(table, rows),
})

console.log(`${manifest.rows} rows in ${manifest.tables.length} tables`)
```

For Postgres, use `new PostgresScriptWriter('site.sql', { schema: 'public' })`; for
MySQL, `new MysqlScriptWriter('site.sql', { database: 'mydb' })`.

### Reading without converting

```ts
import { openBacpac } from '@kineco-au/bacpac-importer'

const bacpac = await openBacpac('site.bacpac')

for (const table of bacpac.tables) {
  console.log(table.schema, table.name, table.columns.map((c) => c.name))
  for await (const batch of bacpac.rows(table)) {
    for (const row of batch) {
      // a row is an array of values, in column order
    }
  }
}

await bacpac.close()
```

Rows are streamed in batches, so a large table is never held in memory.

### How types map

| SQL Server | In JavaScript | SQLite | Postgres | MySQL |
| --- | --- | --- | --- | --- |
| `tinyint` | `number` | `INTEGER` | `smallint` | `tinyint unsigned` |
| `smallint`, `int` | `number` | `INTEGER` | `smallint`, `integer` | `smallint`, `int` |
| `bigint` | `bigint` | `INTEGER` | `bigint` | `bigint` |
| `bit` | `boolean` | `INTEGER` 0/1 | `boolean` | `tinyint(1)` 0/1 |
| `decimal`, `numeric`, `money` | `string`, exact | `TEXT` | `numeric(p,s)` | `decimal(p,s)` |
| `float`, `real` | `number` | `REAL` | `double precision`, `real` | `double`, `float` |
| `uniqueidentifier` | `string`, lower case | `TEXT` | `uuid` | `char(36)` |
| `datetime`, `datetime2`, `smalldatetime` | ISO 8601 `string`, no zone | `TEXT` | `timestamp` | `datetime(n)` |
| `date`, `time` | ISO 8601 `string` | `TEXT` | `date`, `time` | `date`, `time(n)` |
| `datetimeoffset` | ISO 8601 `string` | `TEXT` | `timestamptz` | `datetime(n)`, offset dropped |
| `char`, `varchar`, `text`, their Unicode forms, `xml` | `string` | `TEXT` | `varchar(n)`, `char(n)`, `text` | `varchar(n)`, `char(n)`, `longtext` |
| `binary`, `varbinary`, `image`, `rowversion` | `Uint8Array` | `BLOB` | `bytea` | `varbinary(n)`, `longblob` |

Decimals are strings so that no precision is lost; `bigint` is a JavaScript
`bigint` for the same reason.

**Case sensitivity.** When the source database is case-insensitive, as most SQL
Server databases are, SQLite text columns get `COLLATE NOCASE` so lookups and
unique indexes behave as they did. MySQL gets `utf8mb4_0900_as_ci`, which is
case-insensitive and accent-sensitive like SQL Server's usual collation — pass
`--collation` for MariaDB or MySQL 5.7, which do not have it. Postgres has no
direct equivalent, so text comparisons there are case-sensitive; the manifest
carries a warning.

**Fractional seconds and zones.** MySQL keeps six fractional digits where SQL
Server keeps seven, so a `datetime2(7)` value is trimmed rather than rounded.
MySQL has no zoned timestamp at all: a `datetimeoffset` keeps the wall-clock time
it was written with and loses the offset, and the manifest names the column.

**Index key limits.** MySQL indexes at most 3072 bytes of a key, which four-byte
`utf8mb4` text reaches sooner than SQL Server's 900. A key over the limit is cut
to a prefix of its widest columns — narrow columns keep the whole of themselves —
and every prefix is reported in the manifest. A unique key enforced on a prefix is
stricter than the source, which is reported too.

### Writing to another database

A target is any class that implements `Writer`. Nothing else in the library knows
which one is in use:

```ts
import { convert, registerTarget, type Writer } from '@kineco-au/bacpac-importer'

class DuckDbWriter implements Writer {
  readonly target = 'duckdb'
  readonly warnings: string[] = []
  tableName(table) { /* the table's name in the target */ }
  columnType(column) { /* the column's type in the target */ }
  async begin(database, tables) { /* create the tables */ }
  async beginTable(table) {}
  async writeRows(table, rows) { /* one batch of rows */ }
  async endTable(table) {}
  async end() { /* indexes, foreign keys, sequences */ }
  async abort() { /* release the target after a failure */ }
}

await convert('site.bacpac', new DuckDbWriter('site.duckdb'))

// Optional: offer it on the command line as `--to duckdb`
registerTarget('duckdb', ({ out }) => new DuckDbWriter(out))
```

`parseDefault` reads a column's default into a database-neutral value for your
writer to render, `sourceType` gives a column's type as SQL Server declares it,
and `fitIdentifier` cuts a name to your target's identifier limit without two
long names colliding.

## Supported types

The row data in a `.bacpac` has no public specification, so each type's decoding
is confirmed against real exports. If a conversion touches a type that has not
been confirmed, the manifest names it under `unverifiedTypes` — check those
columns before relying on them.

| | Types |
| --- | --- |
| **Confirmed** | `int`, `bigint`, `bit`, `uniqueidentifier`, `datetime`, `datetime2`, `decimal` and `numeric` (positive values), `nvarchar(n)`, `nvarchar(max)`, `ntext`, `varbinary(max)` |
| **Implemented, not yet confirmed** | `tinyint`, `smallint`, `float`, `real`, `money`, `date`, `time`, `datetimeoffset`, `smalldatetime`, `char`, `varchar`, `nchar`, `text`, `binary`, `image`, `xml`, `rowversion` |
| **Not supported** | `sql_variant`, `geography`, `geometry`, `hierarchyid` — a table using one fails with an error naming the column |

## Limitations

- Bun only. The package ships TypeScript source and has not been tested on Node.
- Postgres and MySQL output is a script for `psql` or `mysql`; there is no writer
  over a live connection yet.
- Default values beyond literals, the current time and a new GUID are not
  translated, and are reported instead.
- The MySQL script uses expression defaults, so it needs MySQL 8.0.13 or later,
  or MariaDB 10.2 or later with `--collation`.
- MySQL dates start at year 1000, so an earlier one will not load.

## Contributing

Issues and pull requests are welcome at
[github.com/kineco-au/bacpac-importer](https://github.com/kineco-au/bacpac-importer).
`CONTRIBUTING.md` in the repository covers building, testing and releasing.

## Licence

MIT
