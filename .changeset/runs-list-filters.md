---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
---

`GET /v1/runs` (`runs.list`) narrows by more: `status` (one, or a comma-separated list such as `failed,cancelled`), `createdAfter` and `createdBefore` (strict), `agentVersion` (with `agentId`), and `flowId` with `flowVersion` (with `flowId`). An unknown status, a bad time, an empty value, or a version without its id is a `400 bad-input`. The TypeScript client takes `status` as one status or an array; Python as a comma-separated string.
