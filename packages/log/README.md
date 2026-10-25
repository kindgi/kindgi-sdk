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
3. **The full mask,** `scrubText(text, { fullMask: true })`, is for an error a run shows: on its record, in the console and in the model's view, which have more readers than a log. A log line is never written with it.
   - A Kindgi token becomes `[redacted]` whole, with no prefix and no last four.
   - A URL's query or fragment value whose name looks secret becomes `[redacted]`, and its name stays. The name looks secret when it ends as a secret key does (rule 1), or with `signature` or `sig`, or is exactly `key`. So `?token=`, `#access_token=`, `X-Amz-Signature=`, a SAS `sig=` and `?key=` are masked, and `?sort_key=` and `?page=` aren't.
   - `Bearer` and a URL's password read as in rule 2.

Pass a secret's *name*, never its value: redaction is the safety net, not the rule.

## An error's causes: `describeCauses`

`describeCauses(err)` is what an error's causes add to its message: `''` when it has none, else `; caused by <Name> [<code>]: <message>` for each. So a failed `fetch` says why:

```ts
import { describeCauses } from '@kindgi/log';

try {
  await fetch('https://shop.acme.example/orders');
} catch (err) {
  throw new Error(`Listing orders failed: ${(err as Error).message}${describeCauses(err)}`);
  // Listing orders failed: fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)
}
```

- **Three causes at most** are said. One whose message the message above it already holds (its code too, when it has one) is passed over.
- **An `AggregateError` with an empty message** says its errors: `AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:4000, connect ECONNREFUSED 127.0.0.1:4000`.
- **A plain object** with a `message` or a `code` is said like an error, but its own `cause` isn't looked at, since a storage error's can carry a query's values.
- **Each cause is masked with the full mask, made one line, and cut at 500 characters.** The cut never lands inside a word.
- **A value that isn't an error has no causes.** It never throws.

A tool's error already says its causes: the handler runtime and `invokeTool` use it.

## Trace context

```ts
import { formatTraceparent, traceFromHeader } from '@kindgi/log';

const trace = traceFromHeader(request.headers.get('traceparent'));
log.child({ traceId: trace.traceId, spanId: trace.spanId }).info('handling');
response.headers.set('traceresponse', formatTraceparent(trace));
```

- **`traceFromHeader`** continues the caller's trace when its `traceparent` is valid, with a new span whose parent is the caller's. A missing or malformed header starts a fresh trace.
- **`parseTraceparent`, `newTraceContext`, `childSpan` and `formatTraceparent`** are the pieces it's built from, as pure functions on Web Crypto.
