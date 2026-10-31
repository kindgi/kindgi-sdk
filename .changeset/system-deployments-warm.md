---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Which pack services to keep warm, and the ready ones to list.** `GET /v1/system/deployments` takes `endpoint=ready`: deployments whose endpoint is `ready` and whose pack service stays (no `retire` reason applies), across tenants, oldest first, with the same paging as `missing` and `retire` (`client.systemDeployments.list('ready')`). Entries in the `missing` and `ready` lists carry `warm`:

- `true`: keep an instance of the deployment's pack service running. In its project, calls route to it for something always on: a tool version reached from a version a pin holds (an agent's, a flow's or a tool's) or from the Latest of each agent no pin covers there, or a pack check a registered guardrail runs there.
- `false`: its service can scale to zero.
- Absent, from a runtime that doesn't say: not warm. `retire` entries never carry it.

`SystemDeploymentsBinding.listReady` is new and required. `listNeedingEndpoint` and `listReady` answer `SystemDeploymentToServe`, which is `SystemDeploymentEntry` with an optional `warm`.
