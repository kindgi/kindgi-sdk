---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A failed run says why, as data: `failure: {code, message, cause?}` on the run (`GET /v1/runs/{id}`, lists, the start answer). An agent turn's failure carries its own code (`budget-exceeded`, `capability-routing-failed`, `model-invocation-failed`, …) and, when it says, what it came from (`cause`: for `capability-routing-failed`, the router's reasons by provider). Any other failure is `run-failed`, with the run's failure message. Only a `failed` run has one. `failureMessage` is unchanged; read `failure` instead.

- The TypeScript client's `Run` has `failure` (`RunFailure`), the Python models `RunFailure`.
- `@kindgi/api` exports `runFailure(row)`, the decoder the routes use.
- `kindgi runs start` prints a failed run's line from `failure` (`Error [<code>]: <message>`), and decodes `failureMessage` itself only for a runtime from before it.
