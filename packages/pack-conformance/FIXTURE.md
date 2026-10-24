# The conformance fixture pack

Every implementation ships the same pack, in its own language, under
`fixtures/<name>/`. The suite indexes it with the implementation's indexer and
runs it in the implementation's pack service. Ids, versions and behaviour are
the contract; how each language declares them is its own business.

Pack: id `conformance`, version `1.0.0`. Every tool is version `1.0.0`.

## Tools

| Id | Input | Output | Behaviour |
|---|---|---|---|
| `conformance.echo` | `{ message: string, minLength 1 }`, required, no other properties | `{ message: string }`, required | Returns `{ message }`. |
| `conformance.bad-output` | any object | `{ message: string }`, required | Returns `{ message: 42 }` — breaks its output schema. |
| `conformance.throws` | any object | any object | Throws an error whose message is `boom`. |
| `conformance.sleep` | `{ ms: integer ≥ 0 }`, required | `{ slept: integer }`, required | Waits `ms` milliseconds, then returns `{ slept: ms }`; stops early when the call is cancelled. |
| `conformance.hold` | `{ release: string, minLength 1 }`, required | `{ released: boolean }`, required | Prints `hold: <release>` on stdout, then waits until the file at `release` exists and returns `{ released: true }`; stops early when the call is cancelled. A test holds a call open with it, for exactly as long as it needs. |
| `conformance.context` | any object | any object | Returns the call context: `tenantId`, `runId`, `requestId` and `idempotencyKey` (when sent), `env`, `secrets`, `config` (`{}` when absent). |
| `conformance.pause` | `{ timeoutMs, name, answer: boolean }`, none required, no other properties | `{ tokenId: string }`, required | Declares `pauses`. Reads the call's wait token first, so a call without one fails there. With `answer: true`, returns `{ tokenId }`, the token's id; otherwise pauses with the `timeoutMs` and `name` it was given (each only when given). A target without `pause` support leaves it out. |
| `conformance.defaults` | `{ name: string, greeting: string = "Hello", options: { loud: boolean = false } = {} }`, `name` required | any object | Returns its input as the handler received it — JSON Schema `default`s filled in, nested ones included. |
| `conformance.noisy` | any object | `{ ok: boolean }`, required | Prints `noisy: a line on stdout` and a JSON-looking line to stdout, a line to stderr, then returns `{ ok: true }`. |
| `conformance.process-env` | any object | any object | Returns `{ names }`: the names of the variables in its process environment that start with `KINDGI_`, sorted. The service token is never among them. |
| `conformance.http` | `{ path: string }`, required | `{ url: string }`, required | Declarative, no author-written handler: an HTTP spec — `GET https://api.example.com/{path}`, an `Accept: application/json` header, bearer secret `local/API_TOKEN`, success `200`–`299`. The runtime makes the request; the SDK only indexes the spec, which must be the same spec in every language. Called in-process, each SDK's stand-in handler throws. |

## Guardrails

| Id | Check id | Config | Behaviour |
|---|---|---|---|
| `conformance.min-length` | `conformance.checks.min-length` | `{ minLength: integer ≥ 0, default 1 }` | Passes when the trace's `output`, trimmed, has at least `minLength` characters; otherwise `{ passed: false, reason: "too short" }`. Action `halt`, severity `error`. |
| `conformance.check-throws` | `conformance.checks.throws` | none | Throws an error whose message is `check boom`. Action `log-only`. |

## Agent and flow

- `conformance.echo-agent` (version `1.0.0`): calls `conformance.echo` (`{ id, version: "1.0.0" }`), guarded by `conformance.min-length`.
- `conformance.echo-flow` (version `1.0.0`): one tool node `echo` → `conformance.echo`; edges `$start → echo → $end`.
