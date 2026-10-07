---
"@kindgi/api": patch
"@kindgi/cli": patch
---

`kindgi` shows the server's own code for any server-class error that carries one: `Error [gate-failed]: …`, `Error [budget-exceeded]: …`, `Error [secret-store-error]: …`, instead of `Error [server]: …`. A conflict still shows its reason, a typed family (`not-found`, `auth`, `invalid-request`) its family, and a body with no code `server`.

`capability-unsatisfiable` (no registered provider satisfies the agent's `needs`) and `tool-version-unresolvable` (a tool the agent names has no version in its range) are now `422`, as their sibling turn failures (`model-invocation-failed`, `budget-exceeded`) are. They answered `500` before.
