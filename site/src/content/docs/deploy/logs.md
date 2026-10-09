---
title: Logs
description: What the runtime logs, at which level, in which format, and how to follow one request or run through them.
sidebar:
  order: 3.5
---

The runtime writes its log to standard output, one record per line. Where it
goes from there is your platform's: `kindgi dev` shows it in its terminal,
`docker logs` shows a container's, and Cloud Run sends it to Cloud Logging.

## Choose the level and the format

Three settings, all optional:

| Setting | Values | Default |
| --- | --- | --- |
| `KINDGI_LOG_LEVEL` | `error`, `warn`, `info`, `debug`, `trace` | `info` |
| `KINDGI_LOG_LEVELS` | a level per subsystem, e.g. `kernel=debug,http=warn` | none |
| `KINDGI_LOG_FORMAT` | `auto`, `json`, `pretty` | `auto` |

- **`KINDGI_LOG_LEVELS`** overrides the level for the subsystems it names. A
  dotted subsystem takes its parent's level unless it's named itself:
  `kernel=debug` covers `kernel.sweeper` too.
- **`auto`** is `pretty` on a terminal or with `KINDGI_DEV=true`, and `json`
  otherwise: a container started with `docker run -d` logs JSON, which suits a
  log pipeline. To read a container's log by eye, set
  `KINDGI_LOG_FORMAT=pretty`, or start it with `docker run -it` (a terminal).

A value the runtime can't use stops it at boot, with exit code 2:

```text
KINDGI_LOG_LEVEL must be one of error, warn, info, debug, trace, got "loud".
```

A subsystem no part of the runtime logs under only warns:

```text
17:36:56.534 WARN  [boot] KINDGI_LOG_LEVELS names "nope", which no subsystem logs under; it has no effect.
```

## The subsystems

`boot`, `http`, `auth`, `authz`, `runs`, `kernel`, `leases`, `approvals`,
`retention`, `audit`, `compliance`, `webhooks`, `mcp`, `providers`,
`promotions`, `tools`, `guardrails`, `pack`, `db`, `ready`, `shutdown` and
`schedules`, with these nested ones: `kernel.waitpoints`, `kernel.sweeper`,
`webhooks.worker`, `authz.outbox`, `providers.prune` and `audit.retention`.

## The two formats

**Pretty**, one line per record: the time, the level, the subsystem, the
message, then the ids and fields the message doesn't already say:

```text
17:36:39.645 INFO  [http] POST /v1/agents 400 18ms traceId=3130a5e3041da97008e45a5c76496675 spanId=e32239d4cb84621f requestId=req-128deaa3-bb5c-49bc-b765-9bcce460c58e tenantId=5c0a7e11-0000-4000-8000-00000000c0de
```

**JSON**, one object per line, for a log platform to index: `time`, `level`,
`severity` (Cloud Logging's), `subsystem` and `message`, then the ids, then
the fields:

```json
{"time":"2026-10-07T17:36:47.001Z","level":"info","severity":"INFO","subsystem":"http","message":"POST /v1/runs 404 57ms","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"e61f14baa539a680","requestId":"req-474e92d9-7a0a-4bc0-9307-664ed1cf3184","tenantId":"5c0a7e11-0000-4000-8000-00000000c0de","method":"POST","route":"/v1/runs",…}
```

A record whose message states some of its fields lists them in `inMessage`:
fields the message already states; renderers may omit them. The request line
above ends with `"inMessage":["method","route","status","durationMs"]`, which
is how the pretty format and `kindgi dev` know to leave them out.

At boot, the pretty format prints the startup block (see
[The startup log](../operate/#the-startup-log)). The JSON format prints one
`boot` record instead, with the same lines in `lines`:

```json
{"time":"2026-10-07T17:36:46.080Z","level":"info","severity":"INFO","subsystem":"boot","message":"Kindgi runtime ready","tenantId":"5c0a7e11-0000-4000-8000-00000000c0de","url":"http://127.0.0.1:56664","lines":["Kindgi API server listening on http://127.0.0.1:56664","  Tenant:  5c0a7e11-0000-4000-8000-00000000c0de","  Token:   …939b (provided)",…]}
```

Secrets stay out: values under secret-looking keys, `kgi_bt_` tokens, `Bearer`
values and the passwords in URLs are redacted.

## Requests

Every API request gets one line under `http`: its method, its route (with its
ids as `:runId`, not their values), its status and how long it took.

| The request | Level |
| --- | --- |
| A write (`POST`, `PUT`, `PATCH`, `DELETE`), or any answer from 400 to 499 | `info` |
| An answer of 500 or more | `error`, with the error |
| A read, a health probe (`/health`, `/ready`) or a stream | `debug` |

So at the default level, a run's start shows and its polling doesn't:

```text
17:36:39.684 DEBUG [http] GET /v1/runs 200 20ms traceId=… requestId=… tenantId=…
17:36:39.720 INFO  [http] GET /v1/runs/:runId 404 20ms traceId=… requestId=… tenantId=…
```

(`KINDGI_LOG_LEVELS=http=debug` showed the first.)

## Follow a request or a run

Each request has a W3C trace context. Send a `traceparent` header and the
runtime joins your trace: its records carry your `traceId`, and its answer
has a `traceresponse` header with your trace id and its own span:

```sh
curl -X POST "$KINDGI_API_URL/v1/runs" -H "Authorization: Bearer $KINDGI_API_TOKEN" \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -H 'content-type: application/json' -d '{"agent":"acme.desk","input":{"userMessage":"hi"}}'
```

```text
traceresponse: 00-4bf92f3577b34da6a3ce929d0e0e4736-e61f14baa539a680-01
```

Without a `traceparent`, the runtime starts a trace of its own. A run keeps the
trace it started in as `traceId`, so its later records can be found from it:

```sh
kindgi runs get <run-id>   # "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
```

The runtime's calls to your pack's service don't carry the run's trace yet;
that comes in 0.1.5.

Model providers and MCP servers are outside your deployment, so they get the
run's trace only when their registration opts in: `send_traceparent: true` on
a [provider](../../guides/models/#a-provider-spec), `sendTraceparent: true` on
an [MCP endpoint](../../guides/tools/mcp-servers/#send-the-runs-trace). Then
each call to them carries a `traceparent` header: ids only, never content.
