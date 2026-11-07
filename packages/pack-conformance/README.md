# `@kindgi/pack-conformance`

The conformance suite for pack services. A Kindgi runtime runs a pack's code
by calling a **pack service** over [pack protocol v2](../specs/schemas/pack-protocol.schema.json),
and learns the pack from its [index](../specs/schemas/pack-index.schema.json).
Any language can implement both; this suite is how an implementation proves it.

It checks, from the outside:

- **the index** the implementation's indexer writes for the [fixture pack](./FIXTURE.md):
  valid against the spec, the right ids, canonical bytes (sorted keys, two-space
  indent, trailing newline), the same bytes on a second build, and every flow
  passing the graph checks every index goes through (`flowGraphProblem`, from
  `@kindgi/flow`);
- **a flow with a cycle**, in the [invalid-flow pack](./FIXTURE.md#the-invalid-flow-pack):
  refused, either by the indexer (a `manifest-validation-failed` file error
  naming its module) or by those graph checks on the index it wrote;
- **the process contract**: `--index` / `--module-root` / `--host`,
  `KINDGI_PACK_SERVICE_TOKEN`, `PORT=0`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`,
  `KINDGI_PACK_ENV_CHECK`, `KINDGI_PACK_ENV_FILTER`;
  the `listening`, `config-invalid` and `boot-failed` lines on stderr; SIGTERM
  draining in-flight calls and exiting 0;
- **every route and status**: `/healthz`, `/readyz`, `/v1/info`, `/v1/invoke`;
  401 / 404 / 405 / 413 / 415 / 503 with `Retry-After`;
- **the declared process env**: an index's `env.required` names, unset or empty,
  keep `/readyz` and calls at 503 (`missing env`), and `/v1/info` lists them;
- **the pack's environment**: a variable the index doesn't declare is absent
  in a tool, while the declared ones, `KINDGI_*` and the platform's are there;
  `env-dropped` names it, never its value; `KINDGI_PACK_ENV_FILTER=off` keeps
  it. The suite sets `KINDGI_PACK_ENV_DECLARED` from the index, as a built
  image does, for a JVM pack service's launcher;
- **every message**: results, Ajv-shaped validation issues, `handler-throw`,
  `tool-not-in-pack`, `tool-version-mismatch`, malformed requests,
  `deadline-exceeded` from `kindgi-timeout-ms`, `cancelled` on disconnect,
  check results, a check's `config` refused against its `configSchema` (the
  first issue in the message) — each answer validated against the protocol schema.

## Targets

| Target | Indexer | Pack service | Fixtures |
|---|---|---|---|
| `tests/node.test.ts` | `runIndexer` (`@kindgi/handler-runtime`) | `@kindgi/handler-runtime/pack-service-main` | `fixtures/node-pack`, `fixtures/node-invalid-flow-pack` |
| `tests/python.test.ts` | `python -m kindgi.pack index` | `python -m kindgi.pack serve` | `fixtures/python-pack`, `fixtures/python-invalid-flow-pack` |
| `tests/java.test.ts` | `com.kindgi.pack.Main index` | `kindgi-pack-java … com.kindgi.pack.Main serve` | `fixtures/java-pack`, `fixtures/java-invalid-flow-pack` |
| `tests/scala.test.ts` | `com.kindgi.pack.Main index` | `kindgi-pack-java … com.kindgi.pack.Main serve` | `fixtures/scala-pack`, `fixtures/scala-invalid-flow-pack` |

The Python target uses `KINDGI_CONFORMANCE_PYTHON`, else `sdks/python/.venv`
(`uv sync` in `sdks/python`), and is skipped — saying why — when neither exists.

The Java target uses the JDK 17+ in `KINDGI_CONFORMANCE_JAVA_HOME`, else
`JAVA_HOME`, else the `java` on PATH, and the built `sdks/java/kindgi-pack`
(`./mvnw -pl kindgi-pack -am compile` in `sdks/java`). It compiles both fixture
packs against them and starts the service through its launcher. Without a JDK or
the build it's skipped, saying why; under CI it fails instead.

The Scala target runs the same service and indexer on the fixture packs in Scala
(`kindgi-pack-scala`, `sdks/scala`). sbt builds each against the layer
from source: with kindgi-pack installed (`./mvnw -pl kindgi-pack -am install
-DskipTests`), `sbt writeClasspath` in `fixtures/scala-pack` and in
`fixtures/scala-invalid-flow-pack` writes its `target/classpath.txt` (Scala 3;
`sbt "++2.13.18!" writeClasspath` for 2.13, in both). Without them, or with the
two built on different Scala versions, the target is skipped, saying why. The Scala job sets
`KINDGI_CONFORMANCE_SCALA=1`, under which it fails instead.

A target that hasn't implemented part of the contract yet lists it in
`unsupported` (`ConformanceFeature`, e.g. `'pack-env'`): those cases are skipped
until it drops the entry. A target without `indexInvalidFlowPack` has the
invalid-flow case skipped, saying so.

## Adding an implementation

1. Write the fixture pack in your language under `fixtures/<name>-pack/`, and the
   invalid-flow pack under `fixtures/<name>-invalid-flow-pack/` ([FIXTURE.md](./FIXTURE.md)).
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
  async indexInvalidFlowPack(outputPath, { artifactVersion, publishedAt }) {
    // run it on fixturePackDir('go-invalid-flow-pack') the same way, and
    // return its file errors ({ code, message, filePath }) instead of throwing
    return [];
  },
});
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
