# Work that takes longer than a call

A tool call has a deadline: 120 s by default (`KINDGI_PACK_CALL_TIMEOUT_MS`
on a runtime the user runs). At the deadline the call fails with
`deadline-exceeded` and `ctx.abortSignal` fires; a handler that doesn't stop
runs on, and its result goes nowhere.
- In an agent, the turn fails, unless `toolErrors.retryOn` lists
  `'tool-error'`. The list replaces the default, so keep
  `'invalid-arguments'` and `'unknown-tool'` in it; the workspace's
  `tool-errors` policy can narrow it further.
- In a flow, the step fails. An edge's `retry` may run it again while the
  first handler still runs, with the same `ctx.idempotencyKey`: pass the key
  on. An edge's `timeoutMs` can only fail it sooner.
- A run whose call is still running is executing, not parked: a runtime
  deploy or restart, or a crash, fails it.

NEVER write a tool that waits for work taking minutes or hours (a report, a
batch job, a person's answer elsewhere), and don't raise the deadline for
it. Ask the user how the other system reports back, then:

- It can call a URL when done: **pause**. Declare `pauses: true`, hand
  `ctx.waitToken.url` to that system with `ctx.idempotencyKey`, and
  `return ctx.pause({ timeoutMs, name })`. Its answer is the call's result,
  checked against `output`. `name` says what the run waits for, with no
  personal data. Runtime 0.2.0 or later.
- It can post a webhook when done, and nothing in this run needs the
  answer: start the job with `ctx.idempotencyKey`, return its id at once,
  and give that system a webhook trigger that starts the next flow.
- It can't call back: return the job's id, and check it from a scheduled
  flow.

Docs: https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#work-that-takes-longer-than-a-call
and https://docs.kindgi.com/v0.3/guides/tools/wait-for-another-system/
