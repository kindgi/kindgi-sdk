---
"@kindgi/client": patch
---

`flows.versions.get` (and the deprecated `flows.getVersion`) returns a `FlowVersionRow`: `GET /v1/flows/{flowId}/versions/{version}` already answers an unregistered version with its `unregisteredAt`, and the type now carries it. An active version has none. A caller that treats the answer as a `Flow` is unaffected.
