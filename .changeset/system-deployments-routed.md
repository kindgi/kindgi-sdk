---
"@kindgi/api": patch
---

`GET /v1/system/deployments` describes "routed" by the rule the runtime applies. With `endpoint=missing`, a deployment is routed while it's the newest with routes for some tool version or pack check. With `endpoint=retire`, it's `superseded` once newer deployments ship every tool version and check it does. The description used to say a live or promoted version resolves to it, a wider rule than the runtime's.
