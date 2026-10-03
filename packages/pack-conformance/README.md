# `@kindgi/pack-conformance`

The conformance suite for pack services. A Kindgi runtime runs a pack's code
by calling a **pack service** over [pack protocol v2](../specs/schemas/pack-protocol.schema.json),
and learns the pack from its [index](../specs/schemas/pack-index.schema.json).
Any language can implement both; this suite is how an implementation proves it.

It checks, from the outside:

- **the index** the implementation's indexer writes for the [fixture pack](./FIXTURE.md):
  valid against the spec, the right ids, canonical bytes (sorted keys, two-space
  indent, trailing newline), the same bytes on a second build;
- **the process contract**: `--index` / `--module-root` / `--host`,
  `KINDGI_PACK_SERVICE_TOKEN`, `PORT=0`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`,
  `KINDGI_PACK_ENV_CHECK`;
  the `listening`, `config-invalid` and `boot-failed` lines on stderr; SIGTERM
  draining in-flight calls and exiting 0;
- **every route and status**: `/healthz`, `/readyz`, `/v1/info`, `/v1/invoke`;
  401 / 404 / 405 / 413 / 415 / 503 with `Retry-After`;
- **the declared process env**: an index's `env.required` names, unset or empty,
  keep `/readyz` and calls at 503 (`missing env`), and `/v1/info` lists them;
- **every message**: results, Ajv-shaped validation issues, `handler-throw`,
  `tool-not-in-pack`, `tool-version-mismatch`, malformed requests,
  `deadline-exceeded` from `kindgi-timeout-ms`, `cancelled` on disconnect,
  check results — each answer validated against the protocol schema.

## Targets

| Target | Indexer | Pack service | Fixture |
|---|---|---|---|
| `tests/node.test.ts` | `runIndexer` (`@kindgi/handler-runtime`) | `@kindgi/handler-runtime/pack-service-main` | `fixtures/node-pack` |
| `tests/python.test.ts` | `python -m kindgi.pack index` | `python -m kindgi.pack serve` | `fixtures/python-pack` |

The Python target uses `KINDGI_CONFORMANCE_PYTHON`, else `sdks/python/.venv`
(`uv sync` in `sdks/python`), and is skipped — saying why — when neither exists.

A target that hasn't implemented part of the contract yet lists it in
`unsupported` (`ConformanceFeature`, e.g. `'pack-env'`): those cases are skipped
until it drops the entry.

## Adding an implementation

1. Write the fixture pack in your language under `fixtures/<name>/` ([FIXTURE.md](./FIXTURE.md)).
2. Add `tests/<name>.test.ts`:

```ts
import { describePackServiceConformance, fixturePackDir } from '../src/index.js';

describePackServiceConformance({
  name: 'go',
  packDir: fixturePackDir('go-pack'),
  command: ['/path/to/pack-service'],          // the suite appends --index, --module-root, --host
  async buildIndex(outputPath, { artifactVersion, publishedAt }) {
    // run your indexer on packDir, writing outputPath with these pins
  },
});
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
