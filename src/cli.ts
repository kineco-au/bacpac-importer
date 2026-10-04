#!/usr/bin/env bun
/** The command line: inspect a .bacpac, or convert one. */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { convert } from './convert.ts'
import { openBacpac } from './reader.ts'
import { createWriter, targetNames } from './targets.ts'
import { sourceType } from './writer.ts'

const USAGE = `Usage:
  bacpac-importer inspect <file.bacpac> [--columns]
  bacpac-importer convert <file.bacpac> --to sqlite|postgres-script|mysql-script --out <path>
                          [--include <table>]... [--exclude <table>]...
                          [--overwrite] [--schema <name>] [--skip-foreign-keys]
                          [--collation <name>] [--encoding <name>] [--manifest <path>]

The manifest is written beside the output as <out>.manifest.json unless --manifest says otherwise.`

async function inspect(file: string, columns: boolean): Promise<void> {
  const bacpac = await openBacpac(file)
  try {
    const { origin, database } = bacpac
    console.log(`exported   ${origin.exportedAt ?? 'unknown'}`)
    console.log(`server     ${origin.serverVersion ?? 'unknown'}`)
    console.log(`collation  ${database.collation ?? 'unknown'}`)
    console.log(`rows       ${origin.rowCount ?? 'unknown'}`)
    console.log(`tables     ${database.tables.length}`)
    for (const table of database.tables) {
      console.log(`  ${table.schema}.${table.name}  (${bacpac.dataFiles(table).length} data files)`)
      if (columns)
        for (const column of table.columns)
          console.log(
            `      ${column.name}  ${sourceType(column)}${column.nullable ? '' : ' not null'}${column.identity ? ' identity' : ''}`,
          )
    }
    if (database.skipped.length > 0) {
      console.log(`not converted  ${database.skipped.length}`)
      for (const object of database.skipped) console.log(`  ${object.kind}  ${object.name}`)
    }
  } finally {
    await bacpac.close()
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      out: { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      overwrite: { type: 'boolean' },
      schema: { type: 'string' },
      'skip-foreign-keys': { type: 'boolean' },
      collation: { type: 'string' },
      encoding: { type: 'string' },
      manifest: { type: 'string' },
      columns: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, file] = positionals
  if (values.help || !command || !file) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }

  if (command === 'inspect') {
    await inspect(file, values.columns ?? false)
    return 0
  }
  if (command !== 'convert' || !values.out) {
    console.error(USAGE)
    return 2
  }

  if (!values.to) {
    console.error(`--to is required: ${targetNames().join(', ')}\n\n${USAGE}`)
    return 2
  }
  const writer = createWriter(values.to, {
    out: values.out,
    overwrite: values.overwrite,
    schema: values.schema,
    skipForeignKeys: values['skip-foreign-keys'],
    collation: values.collation,
  })

  const manifest = await convert(file, writer, {
    include: values.include,
    exclude: values.exclude,
    encoding: values.encoding,
    onProgress: ({ table, rows, done }) => {
      if (done) console.log(`${String(rows).padStart(10)}  ${table}`)
    },
  })
  const manifestPath = values.manifest ?? `${values.out}.manifest.json`
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`\n${manifest.rows} rows in ${manifest.tables.length} tables → ${values.out}`)
  if (manifest.source.declaredRows !== undefined && manifest.excluded.length === 0)
    console.log(
      manifest.source.declaredRows === manifest.rows
        ? 'row count matches the export'
        : `WARNING: the export declares ${manifest.source.declaredRows} rows`,
    )
  for (const warning of manifest.warnings) console.log(`warning: ${warning}`)
  if (manifest.unverifiedTypes.length > 0)
    console.log(
      `types not yet verified against real exports: ${manifest.unverifiedTypes.join(', ')}`,
    )
  console.log(`manifest → ${manifestPath}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
