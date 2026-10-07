# `@kindgi/log`

Kindgi's structured logger. The runtime and `@kindgi/api` (`createApp({ logger })`) write the same records, so `kindgi dev`, Cloud Logging, Datadog or Loki read them the same way. Zero runtime dependencies.

- **Levels per subsystem:** `error`, `warn`, `info`, `debug` and `trace`, set per subsystem. A dotted name inherits its parent's level, so `kernel=debug` covers `kernel.sweeper`.
- **Two formats:**
  - **JSON:** one record per line, for collectors.
  - **Pretty:** for a person at a terminal.
- **Redaction:** applied to every record before it's written, at every level.
- **W3C Trace Context helpers:** they carry a caller's trace id through a request, a run, and the calls they make.

## Use

```ts
import { createLogger } from '@kindgi/log';

const log = createLogger({ level: 'info', format: 'json', write: (line) => process.stdout.write(`${line}\n`) });

const leases = log.child({ subsystem: 'leases' });
leases.warn('could not expire the lease of run r-1', { runId: 'r-1', err });
```

```json
{"time":"2026-10-07T21:58:03.120Z","level":"warn","severity":"WARNING","subsystem":"leases","message":"could not expire the lease of run r-1","runId":"r-1","err":{"name":"Error","message":"…"}}
```

- **Every record has five fields:** `time` (RFC 3339), `level`, `severity`, `subsystem` and `message`.
  - `severity` is Cloud Logging's name for the level (`ERROR`, `WARNING`, `INFO`, `DEBUG`), so Cloud Run and GKE show levels with no agent configuration.
  - Records without a subsystem are `root`.
- **Correlation ids come next,** when known: `traceId`, `spanId`, `requestId`, `tenantId`, `projectId`, `runId`, `agentId`, `toolId`, and others. Then the event's own fields.
- **Pass an error as `{ err: error }`:** it's written as `name`, `message` and `code`. The `stack` is added at `error` level, or when the logger is at `debug` or below.
- **`child(bindings)`** returns a logger whose records all carry the bindings. A child's `subsystem` replaces its parent's, so name it in full (`kernel.sweeper`).
- **`isLevelEnabled(level)`** says whether a record would be written, so you can skip building costly fields.
- **`{ inMessage: [...] }`, a third argument,** names the fields the message already states: `log.info('GET /v1/runs 200 12ms', { method, route, status, durationMs }, { inMessage: ['method', 'route', 'status', 'durationMs'] })`. The pretty format leaves them out; JSON keeps every field.
- **`noopLogger`** writes nothing. It's the default where a logger isn't given.
- **Logging never throws.** A sink that fails is ignored.

## Configuration: `loggerFromEnv`

```ts
import { loggerFromEnv } from '@kindgi/log';

const got = loggerFromEnv({ env: process.env, isTTY: process.stdout.isTTY === true, subsystems: ['http', 'kernel'] });
if (got.kind === 'err') {
  console.error(got.message);
  process.exit(2);
}
for (const problem of got.problems) got.logger.warn(problem);
```

| Variable | Values | Default |
|---|---|---|
| `KINDGI_LOG_LEVEL` | `error` `warn` `info` `debug` `trace` | `info` |
| `KINDGI_LOG_LEVELS` | `subsystem=level`, comma-separated: `kernel=debug,http=warn` | none |
| `KINDGI_LOG_FORMAT` | `auto` `json` `pretty` | `auto`: pretty on a terminal or with `KINDGI_DEV=true`, JSON otherwise |

- **What refuses to start:** an unknown level or format, or a malformed `KINDGI_LOG_LEVELS`.
- **What only warns:** a subsystem no code logs under. It's returned in `problems`, so a typo doesn't stop a server.
- **Colours:** used in the pretty format on a terminal, unless `NO_COLOR` is set.

## Redaction

1. **Keys.** A field whose key looks secret is written as `[redacted]`, at any depth. A key looks secret when, lowercased and without `-` or `_`, it ends with `authorization`, `cookie`, `token`, `password`, `secret(s)`, `apikey`, `privatekey`, `passphrase` or `credential(s)`; `redact` adds your own. So `accessToken` and `x-api-key` are redacted, and `promptTokens` and `secretRef` aren't.
2. **Values.** Every string (the message, the fields, an error's message and stack) is scrubbed of known shapes only:
   - a Kindgi token (`kgi_bt_…`) keeps its prefix and last four characters;
   - `Bearer <anything>` becomes `Bearer [redacted]`;
   - a URL's password (`postgres://user:pass@`) becomes `user:***@`.

   Ids are never touched: the scrubber only matches exact patterns, and doesn't guess at entropy.

Pass a secret's *name*, never its value: redaction is the safety net, not the rule.

## Trace context

```ts
import { formatTraceparent, traceFromHeader } from '@kindgi/log';

const trace = traceFromHeader(request.headers.get('traceparent'));
log.child({ traceId: trace.traceId, spanId: trace.spanId }).info('handling');
response.headers.set('traceresponse', formatTraceparent(trace));
```

- **`traceFromHeader`** continues the caller's trace when its `traceparent` is valid, with a new span whose parent is the caller's. A missing or malformed header starts a fresh trace.
- **`parseTraceparent`, `newTraceContext`, `childSpan` and `formatTraceparent`** are the pieces it's built from, as pure functions on Web Crypto.
