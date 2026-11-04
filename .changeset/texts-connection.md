---
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A run can start from a text message.** `RunStartedBy` gains `text`, for a run a text trigger fired. Such a run is one no person is watching, with the rules a mail-started run has:
- The text is read as outside data, in an `<event>` block, never as the person's own message.
- Every tool that changes something (any tool that isn't `mutating: false`) waits for a person's yes, with the new reason `text-change` (`UnattendedWaitReason`), unless the trigger lists it in `toolsAllowedUnattended`. A read-only tool runs.
- A tool that declares `needsApprovalWhenUnattended`, or uses a person's connection, waits as in any run no person started, unless the trigger lists it.
- A run's `startedBy` in the API can be `text`, and such a run acts for the trigger's owner.

**Text triggers.** A text trigger starts a run of an agent or a flow for each text (SMS or WhatsApp) to a business number, with the text as the run's input. `TRIGGER_KINDS` gains `text`.
- The API has `/v1/text-triggers`: register, list, get, update, pause, resume, unregister, its fires, its versions, and take ownership. The CLI has `kindgi text-triggers`, and the TypeScript client has `textTriggers`.
- Its `config` names the number, `connectionId`: one of the project's company connections of app `texts`. `runsPerHour` (1-600, default 60) and `perSenderPerHour` (1-60, default 10) limit how many runs it starts.
- One live text trigger answers a number. Registering another on it, or moving one onto it, is refused with `409 trigger-connection-taken`, whose `heldBy` names the trigger that answers it, which can be in another project of the workspace. A paused trigger keeps its number; unregistering it frees the number.
- The number is the company's, so registering a text trigger and every change to one take a project admin. Pausing, resuming and unregistering follow the rules other triggers have.
- `toolsAllowedUnattended` never lists `texts.send`.

**Texts come in at `/v1/texts-inbound/{tenantId}/{appId}`.** It's where a texting provider delivers to a texts registration: `POST` for texts and delivery statuses, `GET` for a provider's handshake.
- No sign-in: the server checks the provider's own signature over the URL it called and the body's exact bytes, before anything is written. A bearer token, if sent, is never read.
- A request that doesn't prove its sender is `401 texts-inbound-refused`, the same answer whatever the reason, and a client past its refusals this minute gets `429`. The server's own trouble is `503 texts-inbound-unavailable`, and the provider sends the texts again.
- `ConnectionBinding` gains an optional `receiveTexts`, and the route is mounted only where a binding has it.
