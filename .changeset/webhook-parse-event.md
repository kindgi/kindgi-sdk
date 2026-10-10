---
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**A webhook's event, typed.** `parseEvent(body)` in `@kindgi/sdk/webhooks` reads the event in a verified request's body, as Python's `webhooks.parse_event` does. It answers `{ kind: 'ok', event }`, or `{ kind: 'err', reason, message }` with `reason`:
- `not-json`;
- `unknown-type`: an event a newer runtime sends that this version doesn't know (answer it with a 2xx and leave it);
- `invalid-event`: a field missing or of the wrong type, named in `message`.

A field it doesn't know is kept, so a newer runtime's additions don't break a receiver. It needs no other package.
- `WebhookEvent` covers every event the API sends: `run.finished`, `improvement-pass.finished`, `approval.requested` and `webhook.test`. New in `@kindgi/client`, and in `@kindgi/sdk/webhooks` with the others: `FinishedRun`, `ImprovementPassFinishedEvent`, `RequestedApproval` and `ApprovalRequestedEvent`.
- `data.run.id` is a `RunId` and `data.approval.approvalId` an `ApprovalId`, so `client.runs.get(…)` and `client.approvals.get(…)` take them as they are. Code that builds one of these events from plain strings casts those ids, as it does for a `Run`.
