/** Where the real exports the integration tests run against live. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dir, '../../fixtures')

/** The committed demo database: an Umbraco 17 site with Umbraco Commerce. */
export const DEMO_STORE = join(
  FIXTURES,
  'umbraco-commerce-demo-store/UmbracoCommerceDemoStore_v17.0.0.bacpac',
)

/** The demo store, then whatever a developer has put in `fixtures/local/`. */
export function realExports(): string[] {
  const local = join(FIXTURES, 'local')
  const extra = existsSync(local)
    ? readdirSync(local)
        .filter((name) => name.toLowerCase().endsWith('.bacpac'))
        .map((name) => join(local, name))
    : []
  return [DEMO_STORE, ...extra]
}
