---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

The API reference and the clients no longer offer event triggers and inbound webhooks, which the runtime doesn't serve: it fires schedules only, and `/v1/event-triggers` and `/v1/webhooks` answer 404. The OpenAPI document leaves those operations out, with the schemas only they used. The TypeScript client drops `eventTriggers` and `webhooks` (and their types), and the Python client their resources. A run's `trigger.kind` keeps `event` and `webhook`, now described as not served yet. To react to something outside, start a run with `POST /v1/runs`. The operations stay registered in `@kindgi/api`, marked `unserved`, so they come back when a runtime serves them. Outbound webhook endpoints (`/v1/webhook-endpoints`) are unchanged.
