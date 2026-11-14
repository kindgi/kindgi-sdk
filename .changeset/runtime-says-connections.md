---
"@kindgi/api": patch
"@kindgi/client": patch
---

**`GET /v1/runtime` can say whether the runtime serves connections to other apps.** `RuntimeInfo` gains an optional `connections` (`RuntimeConnections`): `{ on: true }`, or `{ on: false }` with a `reason` in the runtime's own words. The route gives `reason` only when the runtime runs in development mode, since any caller of a tenant reads it. A host passes it in `CreateAppInput.runtime`, and the route copies it field by field; without it, the answer leaves the field out.

The TypeScript client's types and the Python client's models gain the same field.
