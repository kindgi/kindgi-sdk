---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/env-inmemory": patch
---

**An audit record that can't be written, and a check the authorization model can't answer, are logged through your logger instead of the console.**
- `emitResolveEvent` and `emitLifecycleEvent` (`@kindgi/compliance`) take an optional `log`, a `@kindgi/log` `Logger`. An append that fails or throws still never fails the caller's operation. It's logged there at `warn`, with the record's `kind` and the error's `code`, or the error it threw. Without a `log` it isn't logged anywhere; before, it went to `console.warn`.
- `createApp` passes the request's logger, under the subsystem `audit`, for a secret or env write's record and for a secret read refused for its scope. `resolveAtScope` takes that `log` as an optional fourth argument. An app without a `logger` won't see that a record was dropped, and the `logger` option's docs say so.
- A check the authorization model has no relation for, which is a bug in a route, is logged at `error` through the request's logger, under the subsystem `authz`, with its `action` and `resource`. Before, it went to `console.error`.
- `createInMemoryEnvBinding` takes an optional `log` and passes it on with every audit record it writes.
