# Contributing

## Building and testing

```bash
bun install
bun run check              # format, lint, types
bun run test               # unit tests: synthetic .bacpac files built in memory
bun run test:integration   # the committed demo store, plus any export in fixtures/local/
bun src/cli.ts inspect fixtures/umbraco-commerce-demo-store/*.bacpac
```

The committed fixture is the Umbraco Commerce demo store, an Umbraco 17 database
of demonstration data (`fixtures/umbraco-commerce-demo-store/`, MIT licensed).

Real exports hold personal data. `fixtures/local/` and every other `*.bacpac` are
ignored by git; put one in `fixtures/local/` to run the structural tests against
it, and do not commit it.

The Postgres and MySQL integration tests run when `BACPAC_TEST_POSTGRES` or
`BACPAC_TEST_MYSQL` is a connection URL and the matching client is installed, and
skip themselves otherwise:

```bash
docker run -d --rm -p 5439:5432 -e POSTGRES_PASSWORD=test postgres:18-alpine
docker run -d --rm -p 3399:3306 -e MYSQL_ROOT_PASSWORD=test mysql:8.4

BACPAC_TEST_POSTGRES=postgres://postgres:test@localhost:5439/postgres \
BACPAC_TEST_MYSQL=mysql://root:test@localhost:3399 \
  bun run test:integration
```

## Confirming a type

`VERIFIED_TYPES` in `src/bcp.ts` lists the column types whose decoding has been
checked against a real export. To add one, find or make an export that uses it,
pin real decoded values in an integration test, and only then add it to the set
and to the README's table.

## Adding a target

A target implements `Writer` (`src/writer.ts`) and is registered in
`src/targets.ts`. `tests/unit/targets.test.ts` holds a complete in-memory writer
as a worked example.

## Releasing

Every push to `main` runs the format, lint and type checks and both test suites
(`.github/workflows/ci.yml`).

Pushing a `v*` tag runs the same build and then publishes to npm
(`.github/workflows/release.yml`), so treat a tag push as a release, not a
bookmark:

```bash
# set "version" in package.json, commit, then
git tag v1.0.0 && git push origin v1.0.0
```

The tag must match the version in `package.json` or the release stops before
publishing. It needs an `NPM_TOKEN` repository secret with publish rights to the
`@kineco-au` scope.
