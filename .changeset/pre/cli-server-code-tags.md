---
"@kindgi/api": patch
"@kindgi/cli": patch
---

`kindgi` shows the server's own code for any server-class error that carries one: `Error [gate-failed]: …`, `Error [budget-exceeded]: …`, `Error [secret-store-error]: …`, instead of `Error [server]: …`. A conflict still shows its reason, a typed family (`not-found`, `auth`, `invalid-request`) its family, and a body with no code `server`.

`tool-version-unresolvable` (a tool the agent names has no version in its range) is now `422`, as its sibling turn failures (`model-invocation-failed`, `budget-exceeded`) are. It answered `500` before. `capability-unsatisfiable` (no registered provider satisfies the `needs`) gets a `422` entry too; a turn reports it as the cause of `capability-routing-failed`, which was already `422`.
