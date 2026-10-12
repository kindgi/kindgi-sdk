---
"@kindgi/api": patch
"@kindgi/bounds": patch
"@kindgi/cli": patch
---

Request bodies have a size limit and a depth limit, from the tenant input bounds.

- A request body over `requestMaxBytes` (2 MiB on hosted, 10 MiB on a self-hosted server) is refused with `413 request-too-large`, with `details.maxBytes`, before more of it is read. Every operation with a body declares that answer. Two routes keep a limit of their own: an artifact upload (`413 artifact-too-large`, checked once the caller is known) and the webhook receiver.
- A JSON body nested more than `requestJsonMaxDepth` levels (128) is refused with `400 bad-input`, with `details.maxDepth`.
- `HOSTED_BOUNDS.requestJsonMaxDepth` is 128 (it was 64), the same as self-hosted, so a schema as deep as `schemaMaxDepth` fits inside the body that carries it.
- `kindgi deploy` says what to make smaller when a deployment is over the server's limit.
