/**
 * The targets the command line offers, by name. A target is anything that
 * implements `Writer`; adding one is a class and an entry here, and nothing in
 * the reader, the decoder or `convert` knows which is in use.
 */
import type { Writer } from './writer.ts'
import { PostgresScriptWriter } from './writers/postgres-script.ts'
import { SqliteWriter } from './writers/sqlite.ts'

export interface TargetOptions {
  /** Where the output goes: a file path for the built-in targets. */
  out: string
  overwrite?: boolean
  schema?: string
  skipForeignKeys?: boolean
}

export type TargetFactory = (options: TargetOptions) => Writer

const targets = new Map<string, TargetFactory>([
  ['sqlite', ({ out, overwrite }) => new SqliteWriter(out, { overwrite })],
  [
    'postgres-script',
    ({ out, schema, skipForeignKeys }) =>
      new PostgresScriptWriter(out, { schema, skipForeignKeys }),
  ],
])

/** Makes a target available by name, to the command line and to `createWriter`. */
export function registerTarget(name: string, factory: TargetFactory): void {
  targets.set(name, factory)
}

export const targetNames = (): string[] => [...targets.keys()]

export function createWriter(name: string, options: TargetOptions): Writer {
  const factory = targets.get(name)
  if (!factory) throw new Error(`unknown target ${name}; available: ${targetNames().join(', ')}`)
  return factory(options)
}
