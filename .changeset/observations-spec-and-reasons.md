---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

`GET /v1/observations`'s `agentVersion`, `conversationId`, `since` and `until` filters, which the route already read, are in the OpenAPI spec, so the Python client's `observations.list` takes them. `kindgi observations` and `kindgi proposals` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't record supervisor observations or draft fix proposals yet. A reason given for a group covers each of its commands.
