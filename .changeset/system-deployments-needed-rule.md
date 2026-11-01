---
"@kindgi/api": patch
---

**`GET /v1/system/deployments` says which deployments need a pack service by the rule the runtime applies.** For `endpoint=missing` it said each one is "the newest deployment with routes for some tool version or pack check". That leaves out its project, and it's the rule before Kindgi 0.4.0. Since 0.4.0, a deployment needs a service while it serves something a call can still ask for, and no newer deployment into its project serves it. That something is a tool, agent or flow version that's registered or held (a pin or an unfinished run uses it), a tool deployed without a version, or a pack check a registered guardrail runs. The `retire` list's `superseded` reason, `SystemDeploymentsBinding.listNeedingEndpoint` and the "Serve many tenants" guide now say the same.
