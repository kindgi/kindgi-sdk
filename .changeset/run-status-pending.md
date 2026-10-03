---
"@kindgi/api": patch
"@kindgi/client": patch
---

The OpenAPI run status says `pending` where it said `queued`. The server sends `pending` for a run that hasn't started yet, which is what `options.wait: false` answers, and a validating client (the Python client, or one generated with runtime validation) refused that response. A test now holds the document to the runtime's `RunStatus`.
