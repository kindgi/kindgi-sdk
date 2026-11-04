---
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/connections": patch
"@kindgi/connections-inmemory": patch
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
- No sign-in: the server checks the provider's own signature over the URL it called and the body's exact bytes, before anything is written. A bearer token, a cookie or a `Proxy-Authorization` header, if sent, is never read nor passed on.
- A request that doesn't prove its sender is `401 texts-inbound-refused`, the same answer whatever the reason, a body over the cap included, at any size, and a client past its refusals this minute gets `429`. The server's own trouble is `503 texts-inbound-unavailable`, and the provider sends the texts again.
- `ConnectionBinding` gains an optional `receiveTexts`, and the route is mounted only where a binding has it.

**The texts connection: a business number, connected without a browser.** `@kindgi/connections` gains the `texts` entry (`@kindgi/connections/texts`), for the company: a number at a texting provider (Telnyx for now), with the permissions `texts.reply` and `texts.send`.
- `SignIn` gains `token`, an account's credential kept on the registration by reference, with the providers it serves. `AccountLookup` gains `number`, and `AppRemoval.revoke` gains `restore-inbound`. `defineApp` checks that the three go together.
- A texts registration takes `token`: the provider, its API key by reference (`apiKey`) and the account's Ed25519 public key (`publicKey`, base64 of 32 bytes), on `POST` and `PATCH /v1/connection-apps`. The key reaches the whole provider account, so a secret a tool, MCP endpoint, webhook endpoint or webhook trigger uses is refused with `409 connection-key-in-use`, and nothing is stored.
- `POST /v1/connections` takes `number` (E.164) and `replaceInbound`. A texts connect comes back `connected` at once, with its `connectionId`; it keeps `connectUrl`, whose page only shows it connected, and `expiresAt`, which ends only a `pending` request. A number whose texts go somewhere else today is refused with `409 inbound-in-use`, naming the webhook's host or the messaging profile, until the connect says `replaceInbound: true`. A number live in another environment, or under another texts registration, is `409 number-in-use`. A reconnect names the same number, and is how a connection whose key the provider refused (`credential-refused`) works again once the registration's secret is updated.
- A disconnect puts the number's old inbound back first. When that fails, the connection stays `removing` and the answer is `502 inbound-restore-failed`; disconnecting again retries, and `DELETE /v1/connections/{connectionId}?skipInboundRestore=true` drops what was kept without putting it back. The flag is ignored for a connection of any other app. Removing a registration with its connections does the same for each number, and keeps the registration while one fails.
- A connection gains `lastProvenInboundAt` and `textsThisMonth` (`received`, `sent`, `unanswered`), for a number only.
- The CLI: `kindgi connection-apps add texts --provider=telnyx --api-key-ref=<env>/<name> --public-key=<base64>`, `kindgi connections connect texts --for-company --number=<E.164> [--replace-inbound]`, which prints the connection, and `kindgi connections disconnect <connection> --skip-inbound-restore`. The TypeScript client's `connections.disconnect` takes `skipInboundRestore`.
- `@kindgi/connections-inmemory` serves the entry with a fake provider: connect, reconnect and removal work, with hooks for the lookup and the restore, and `seed.inbound` and `seed.credentialRefused` set up a number's state. Texts come in only on a Kindgi server.
