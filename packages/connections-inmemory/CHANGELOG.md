# @kindgi/connections-inmemory

## 0.8.2

### Patch Changes

- Updated dependencies [b8ffc77]
  - @kindgi/api@0.8.2
  - @kindgi/agents@0.8.2
  - @kindgi/authz@0.8.2
  - @kindgi/connections@0.8.2
  - @kindgi/tools@0.8.2
  - @kindgi/types@0.8.2

## 0.8.1

### Patch Changes

- @kindgi/agents@0.8.1
  - @kindgi/api@0.8.1
  - @kindgi/authz@0.8.1
  - @kindgi/connections@0.8.1
  - @kindgi/tools@0.8.1
  - @kindgi/types@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [309b73f]
- Updated dependencies [716ae82]
  - @kindgi/connections@0.8.0
  - @kindgi/api@0.8.0
  - @kindgi/agents@0.8.0
  - @kindgi/authz@0.8.0
  - @kindgi/tools@0.8.0
  - @kindgi/types@0.8.0

## 0.7.0

### Patch Changes

- b8cb40c: **The connections API for an app that connects through Kindgi's own app.** Everything is new and optional, and a server with no such app sends none of it:
  
  - A connection entry's `signIn.kind` can be `kindgi-app`: the app connects through Kindgi's own app, by Kindgi's connect step, with no client to register.
  - A registration (`ConnectionApp`) can carry `via: 'kindgi'`: the server made it itself for such an app, and it has no `oauth2` or `githubApp`. `POST /v1/connection-apps` doesn't register such an app (`connection-app-invalid`, `app`), and `PATCH` changes only its label and projects.
  - When the business shared several accounts that fit the app and none was picked, the finish answers `kind: 'pick-account'`, and the request, still `pending`, lists them in `accounts` (`{ id, label }` each). The person picks one and starts the request again with `accountId`, which can't go with `installationId` or `newInstallation`.
  - The finish takes what Kindgi's connect step sends back: `state`, with `error` when the connect didn't happen, and never a `code`.
  
  The TypeScript client's types and the Python client's models gain the same fields. The in-memory binding (`@kindgi/connections-inmemory`) refuses `accountId` (`bad-input`, `accountId`): it holds no app that connects through Kindgi's own app.
- 768e1b3: **A run can start from a text message.** `RunStartedBy` gains `text`, for a run a text trigger fired. Such a run is one no person is watching, with the rules a mail-started run has:
  - The text is read as outside data, in an `<event>` block, never as the person's own message.
  - Every tool that changes something (any tool that isn't `mutating: false`) waits for a person's yes, with the new reason `text-change` (`UnattendedWaitReason`), unless the trigger lists it in `toolsAllowedUnattended`. A read-only tool runs.
  - A tool that declares `needsApprovalWhenUnattended`, or uses a person's connection, waits as in any run no person started, unless the trigger lists it.
  - A run's `startedBy` in the API can be `text`, and such a run acts for the trigger's owner.
  
  **Text triggers.** A text trigger starts a run of an agent or a flow for each text (SMS or WhatsApp) to a business number, with the text as the run's input. `TRIGGER_KINDS` gains `text`.
  - The API has `/v1/text-triggers`: register, list, get, update, pause, resume, unregister, its fires, its versions, and take ownership. The CLI has `kindgi text-triggers`, and the TypeScript client has `textTriggers`.
  - Its `config` names the number, `connectionId`: one of the project's company connections of app `texts`. `runsPerHour` (1-600, default 60) and `perSenderPerHour` (1-60, default 10) limit how many runs it starts.
  - One live text trigger answers a number. Registering another on it, or moving one onto it, is refused with `409 trigger-connection-taken`, whose `heldBy` names the trigger that answers it, which can be in another project of the workspace. A paused trigger keeps its number; unregistering it frees the number.
  - The number is the company's, so registering a text trigger and every change to one take a project admin. Pausing, resuming and unregistering follow the rules other triggers have.
  - `toolsAllowedUnattended` never lists `kindgi_send_text`: a text that isn't a reply always waits for a person's yes.
  
  **Texts come in at `/v1/texts-inbound/{tenantId}/{appId}`.** It's where a texting provider delivers to a texts registration: `POST` for texts and delivery statuses, `GET` for a provider's handshake.
  - No sign-in: the server checks the provider's own signature over the URL it called and the body's exact bytes, before anything is written. A bearer token, a cookie or a `Proxy-Authorization` header, if sent, is never read nor passed on.
  - A request that doesn't prove its sender is `401 texts-inbound-refused`, the same answer whatever the reason, a body over the cap included, at any size, and a client past its refusals this minute gets `429`. The server's own trouble is `503 texts-inbound-unavailable`, and the provider sends the texts again.
  - `ConnectionBinding` gains an optional `receiveTexts`, and the route is mounted only where a binding has it.
  
  **The texts connection: a business number, connected without a browser.** `@kindgi/connections` gains the `texts` entry (`@kindgi/connections/texts`), for the company: a number at a texting provider (Telnyx for now), with the permissions `texts.reply` and `texts.send`.
  - `SignIn` gains `token`, an account's credential kept on the registration by reference, with the providers it serves. `AccountLookup` gains `number`, and `AppRemoval.revoke` gains `restore-inbound`. `defineApp` checks that the three go together, and that each permission of a `token` sign-in grants its own key.
  - A texts registration takes `token`: the provider, its API key by reference (`apiKey`) and the account's Ed25519 public key (`publicKey`, base64 of 32 bytes), on `POST` and `PATCH /v1/connection-apps`. The key reaches the whole provider account, so a secret a tool, MCP endpoint, webhook endpoint, webhook trigger or destination uses is refused with `409 connection-key-in-use`, and nothing is stored.
  - Only its registration names that key. A tool, an MCP endpoint, a webhook endpoint, a webhook trigger, a destination, a model provider or another connection app registration that names it is refused with `400 connection-key-refused` (`details.secret`, `details.appId`), and nothing is stored; a texts registration whose key another registration names in any of its secrets is `409 connection-key-in-use`, with that registration in `usedBy` (kind `connection-app`). Both ask for a new API key from the provider, stored under its own name, since a copy of the account key under another name reaches the same account; the 409 also says to rotate a shared key at the provider. A removed registration frees its key, and one kept while its numbers' inbound can't be put back still holds it. `@kindgi/api` exports `connectionKeysOf` (its `ConnectionKeys` maps each key to every live registration holding it) and `connectionKeyRefusal`, and the TypeScript and Python clients read the new code as an invalid request.
  - `POST /v1/connections` takes `number` (E.164) and `replaceInbound`. A texts connect comes back `connected` at once, with its `connectionId`; it keeps `connectUrl`, whose page only shows it connected, and `expiresAt`, which ends only a `pending` request. A number whose texts go somewhere else today is refused with `409 inbound-in-use`, naming the webhook's host or the messaging profile, until the connect says `replaceInbound: true`. A number live in another environment, or under another texts registration, is `409 number-in-use`. A reconnect names the same number, and is how a connection whose key the provider refused (`credential-refused`) works again once the registration's secret is updated.
  - A disconnect puts the number's old inbound back first. When that fails, the connection stays `removing` and the answer is `502 inbound-restore-failed`; disconnecting again retries, and `DELETE /v1/connections/{connectionId}?skipInboundRestore=true` drops what was kept without putting it back. The flag is ignored for a connection of any other app. Removing a registration with its connections does the same for each number, and keeps the registration while one fails.
  - A connection gains `lastProvenInboundAt` and `textsThisMonth` (`received`, `sent`, `unanswered`), for a number only.
  - The CLI: `kindgi connection-apps add texts --provider=telnyx --api-key-ref=<env>/<name> --public-key=<base64>`, `kindgi connections connect texts --for-company --number=<E.164> [--replace-inbound]`, which prints the connection, and `kindgi connections disconnect <connection> --skip-inbound-restore`. The TypeScript client's `connections.disconnect` takes `skipInboundRestore`.
  - `@kindgi/connections-inmemory` serves the entry with a fake provider: connect, reconnect and removal work, with hooks for the lookup and the restore, and `seed.inbound` and `seed.credentialRefused` set up a number's state. Texts come in only on a Kindgi server.
- d86edd5: **A texts registration's account key is refused when it's read, and in a pack's `env`.** A name stored before a registration took it as its key is refused too, when the secret is read through the guard; a webhook trigger's signing secret and a pack's `env` are read through it here:
  - `guardSecretKeys(binding, { providerKeys, connectionKeys }, user)` wraps a `SecretsBinding` so each read refuses a model provider's key, then a texts registration's account key, to `user` (`SecretKeys` is its second argument; either set may be left out). Only the registration reads its own key: a read as `'a connection app'` whose context says `caller: 'connections'` and that registration's `appId`. `getVersion` carries no context, so it refuses the key to every user. Nothing is cached, so a key that a registration takes after a secret was written is refused at the next read. `guardProviderKeys` is `guardSecretKeys` with provider keys only.
  - `SecretError` gains `connection-key-refused` (`name`, `appId`), and `ResolveContext` gains an optional `appId`, the reader's own say, which only that guard reads.
  - `SecretUser` gains `"a pack's env"`. A pack's env never gets a held key: the name is left out as unreadable (`pack-env-secret-unreadable`, with code `connection-key-refused`) and the store isn't asked. A model provider's key in a pack's `env` is given as before.
  - `POST /v1/deployments` answers `400 connection-key-refused` (`details.secret`, `details.appId`) when a name the pack's `env` declares is a live texts registration's account key: the first such name, its required names before its optional ones and each list sorted by name, checked after the tools' own issues. Nothing is registered.
  - A webhook trigger whose signing secret is a held key answers `401` at its next delivery once the receiver's 10-second keep of its signing key runs out, and the receiver then keeps that answer as long as it keeps a missing secret's.
  - `ConnectionKeys` reads one key's holders: `holders(tenantId, name)`. `connectionKeysOf` uses the new optional `ConnectionBinding.keyHolders({ tenantId, name })`, a point read in `listApps` order, when the binding has it. Without it, every read lists all of the workspace's registrations, with no page cap, so a key held by a registration past the first pages is refused too. The deploy route and the other write routes refuse a held key from the same read.
  - `@kindgi/connections-inmemory` serves `keyHolders`. A removal kept while a number's inbound can't be put back still holds its key, and the removal frees it.
- Updated dependencies [dfaeea7]
- Updated dependencies [3621ee2]
- Updated dependencies [70a156b]
- Updated dependencies [591568a]
- Updated dependencies [95494bb]
- Updated dependencies [5903a0b]
- Updated dependencies [9d9ab0e]
- Updated dependencies [a976d95]
- Updated dependencies [4c43200]
- Updated dependencies [cf07be5]
- Updated dependencies [1a5deb5]
- Updated dependencies [478a3d3]
- Updated dependencies [f9a6250]
- Updated dependencies [1ae2843]
- Updated dependencies [821552c]
- Updated dependencies [c7b560c]
- Updated dependencies [b095fe4]
- Updated dependencies [5461b4e]
- Updated dependencies [efc220c]
- Updated dependencies [cde9433]
- Updated dependencies [5d0d0a3]
- Updated dependencies [b8cb40c]
- Updated dependencies [f418104]
- Updated dependencies [9b65483]
- Updated dependencies [f8a4191]
- Updated dependencies [abea110]
- Updated dependencies [5b85c66]
- Updated dependencies [c88d9dd]
- Updated dependencies [fc320f4]
- Updated dependencies [852eff3]
- Updated dependencies [6ac7e3d]
- Updated dependencies [1d47709]
- Updated dependencies [2d279a5]
- Updated dependencies [bb5bbf8]
- Updated dependencies [e975c6f]
- Updated dependencies [3b5216b]
- Updated dependencies [0c60659]
- Updated dependencies [f2baded]
- Updated dependencies [5ec7895]
- Updated dependencies [8c5e37a]
- Updated dependencies [7399226]
- Updated dependencies [f5b88e9]
- Updated dependencies [9b9bb22]
- Updated dependencies [1492439]
- Updated dependencies [b247ee3]
- Updated dependencies [520e54d]
- Updated dependencies [9c4b4f1]
- Updated dependencies [6a6b029]
- Updated dependencies [712383f]
- Updated dependencies [712383f]
- Updated dependencies [0ce1b0c]
- Updated dependencies [2d81e64]
- Updated dependencies [7745812]
- Updated dependencies [b4addfd]
- Updated dependencies [054e09f]
- Updated dependencies [af5b037]
- Updated dependencies [524e626]
- Updated dependencies [1dd8f20]
- Updated dependencies [090706e]
- Updated dependencies [f7264e7]
- Updated dependencies [ea7d74f]
- Updated dependencies [697cdc8]
- Updated dependencies [ea5b156]
- Updated dependencies [c003626]
- Updated dependencies [80ee9d9]
- Updated dependencies [363dd24]
- Updated dependencies [6279526]
- Updated dependencies [3905040]
- Updated dependencies [d5e05dc]
- Updated dependencies [d9c762d]
- Updated dependencies [e2cddae]
- Updated dependencies [c09130a]
- Updated dependencies [de3a30f]
- Updated dependencies [3af15cf]
- Updated dependencies [311ceaa]
- Updated dependencies [3cf1c3f]
- Updated dependencies [d4814d8]
- Updated dependencies [7b44a57]
- Updated dependencies [ced2a0f]
- Updated dependencies [1df25b1]
- Updated dependencies [439bffc]
- Updated dependencies [54faad5]
- Updated dependencies [86c2610]
- Updated dependencies [d1dbacc]
- Updated dependencies [8cac758]
- Updated dependencies [fda6124]
- Updated dependencies [f3d8f7d]
- Updated dependencies [64b51fe]
- Updated dependencies [15c2925]
- Updated dependencies [c7bef1f]
- Updated dependencies [fd2d147]
- Updated dependencies [768e1b3]
- Updated dependencies [d86edd5]
- Updated dependencies [00afa37]
- Updated dependencies [a478edf]
- Updated dependencies [7f9d20f]
- Updated dependencies [cdf511b]
- Updated dependencies [c06243b]
- Updated dependencies [d3f48a7]
- Updated dependencies [a6a4ecb]
- Updated dependencies [25d902a]
- Updated dependencies [0876939]
- Updated dependencies [026b7b5]
- Updated dependencies [85274b1]
- Updated dependencies [5491d46]
- Updated dependencies [39c4e12]
  - @kindgi/types@0.7.0
  - @kindgi/agents@0.7.0
  - @kindgi/api@0.7.0
  - @kindgi/tools@0.7.0
  - @kindgi/connections@0.7.0
  - @kindgi/authz@0.7.0

## 0.6.0

### Patch Changes

- 21501e1: **A tool's need of a connection says which permissions it asks for, and a declined connect says what it kept.** `GET /v1/connection-choices/needs` (`client.connectionChoices.needs(...)`) answers each need's `permissions`: the entry's permission keys, from the tool's `needsSpec`. A place that shows a need can then say what a connection lacks for it. The field is optional, and a binding that doesn't read them leaves it out. `ConnectionChoiceNeedRecord` has `permissions`. The `reconnects` text now says that a named reconnect asks for the permissions it lists and those the connection holds, and that a grant short of what the connection holds leaves it as it was.
  
  - `@kindgi/connections-inmemory`: its needs answer each need's permissions, so `kindgi dev` shows them too.
  - `@kindgi/cli`: a `kindgi connections connect` without `--reconnect` that's declined at the app says `Declined at <app> (not <permissions>): nothing from this sign-in was kept.` The sign-in may have been to an account the owner already has a connection of, and that connection stays as it was, so "nothing connected" could be wrong. An expired or failed connect still says "nothing connected".
- Updated dependencies [6707cb9]
- Updated dependencies [9589cfa]
- Updated dependencies [6b4249a]
- Updated dependencies [d27c97b]
- Updated dependencies [375d315]
- Updated dependencies [6769a34]
- Updated dependencies [611d0b2]
- Updated dependencies [a54e5e2]
- Updated dependencies [e0bfdf7]
- Updated dependencies [ebb6c1e]
- Updated dependencies [ecd251e]
- Updated dependencies [38aa185]
- Updated dependencies [7062ba5]
- Updated dependencies [21501e1]
- Updated dependencies [fb947de]
- Updated dependencies [fbf0357]
- Updated dependencies [8618cf7]
- Updated dependencies [b3f40b8]
- Updated dependencies [287c34c]
- Updated dependencies [81b8af0]
- Updated dependencies [7c10695]
- Updated dependencies [0334286]
- Updated dependencies [61322b4]
  - @kindgi/types@0.6.0
  - @kindgi/agents@0.6.0
  - @kindgi/api@0.6.0
  - @kindgi/connections@0.6.0
  - @kindgi/tools@0.6.0
  - @kindgi/authz@0.6.0

## 0.5.0

### Patch Changes

- 04813e4: **A call uses the company connection its run's mailbox or its agent's choice names, and runs only on the connection it was approved against.** For a company need, a resolver now takes, in order: the company connection the run's mailbox reads with, when the mailbox is the company's, of the need's app, and names one; else the connection the call's agent or flow chose for the app in the project, in this environment; else the only candidate (a live company connection of the app, working or needing a reconnect, on a registration that allows the project, in this environment). No candidate is `connection-missing`, as before. Several, and no choice of one, is the new `connection-not-chosen`, listing them by name: the turn fails, rather than pick one or ask the model to, and the API answers `409 connection-not-chosen` when the call waits for the run, with `details.connection` and `details.choices`. A connection the mailbox or a choice names that can't serve the call (disconnected, in another environment, on a registration that no longer allows the project, lacking a permission, or needing a reconnect) is `connection-missing`, naming it, and never falls back to another. An id that isn't one of the company's connections of the app answers as no connection does. Candidates are counted before permissions, so of two where only one holds what the call needs, neither is picked silently. A person's own connection is found as before.
  
  - `@kindgi/tools`: `ResolveConnectionsInput` gains `target` (the call's agent or flow, which a runtime checks against the run's own record) and `mailbox` (`ConnectionRunMailbox`, the run's mailbox as the run records it). A refusal can be `connection-not-chosen`, with `choices` (each candidate's `connectionId` and `name`). `ToolConnection` gains `name`: the connection's label, else its account's.
  - `@kindgi/runtime`: `RunMailbox` gains `connectionId`, the company connection the run's mail was read with: the one its trigger version names, fixed when the fire starts the run. A run whose trigger version names none carries none.
  - `@kindgi/connections-inmemory`: resolves a company need in that order, and gives each token its connection's `name`.
  - `@kindgi/agents`: the connection gate asks with the call's agent and the run's mailbox. `connection-not-chosen` fails the turn (`ConnectionNotChosenError`, with the tool's name for the connection and the choices' names), whether at the first ask, after a connect, or on the fresh ask right before the tool runs; the model never reads it. A call whose fresh ask comes to another connection than the gate decided on, a person's or the company's, runs nothing and fails with the new call code `connection-changed`, naming both for a company connection and the app alone for a person's, which the model reads like the other connection codes; so does the ask after the app refused a token. An approval for a call that uses a company connection and no person's now shows that connection (`HitlEnqueueInput.connection`), with no `approver`: the reviewers decide it as before. `connection` gains `name`, for a company connection only.
  - `@kindgi/api`, `@kindgi/client`: `ApprovalConnection`, on an approval and in a run's `waitingFor`, is set for a company connection too, and carries a company connection's `name`. A person's has none. The errors reference has `connection-not-chosen`.
- e96b83b: **A project's admins choose which company connection an agent or a flow uses for an app.** The company can hold several connections of one app, so a choice names one of them, for one agent or flow in a project, in this server's environment. `PUT /v1/connection-choices` (`client.connectionChoices.set({ projectId, agentId, connectionId })`, or `flowId` in place of `agentId`) makes it, for the connection's app. The connection must be a live company connection in this environment (working, or needing a reconnect), on a registration that allows the project: `GET /v1/connection-choices/candidates` (`client.connectionChoices.candidates`) lists them. A person's own connection is `400 bad-input`, since it's used for that person, and any other connection that can't be chosen is `404 connection-not-found`, the same answer as for an id that doesn't exist. An agent or a flow that isn't one of the project's is `404 agent-not-found` or `404 flow-not-found`. Choosing the connection already chosen answers that choice as it is. Choosing another replaces it in one step with a new choice at the next `version`, since a choice is never edited. `GET /v1/connection-choices?projectId=` (`client.connectionChoices.list`) lists the project's live choices, narrowed by `agentId`, `flowId` or `app`, and with `includeRemoved=true` the removed ones too, with `removedAt` and `removedBy`: a choice's history. The project's members may read them, and the candidates too: a member who isn't an admin sees each candidate's `connectionId` and `name` only. `DELETE /v1/connection-choices/{choiceId}` (`client.connectionChoices.remove`) removes one, and keeps it in that history; an unknown or removed id is `404 connection-choice-not-found`, a new code. Disconnecting a connection leaves its choices listed until someone sets or removes them. `ConnectionBinding` gains `listChoices`, `getChoice`, `setChoice`, `removeChoice` and `listCandidates`, and its errors `connection-choice-not-found`, `agent-not-found` and `flow-not-found`.
  
  - `@kindgi/connections-inmemory`: keeps choices the same way. A removed choice stays, with `removedAt` and `removedBy`, and versions count per project, environment, agent or flow, and app. Its `inProject` option says whether an agent or a flow is one of a project's; without it, none is, and every choice is refused.
- 2251f96: **A connection has a name, its `label`.** `POST /v1/connections` takes an optional `label`, the name to give the connection it makes: trimmed, 1 to 100 characters, with no control, format or invisible characters (such as bidi overrides, zero-width characters or line separators, and a variation selector only in an emoji), else `400 bad-input` with `details.field` `label`. When the connect finishes, a new connection takes that name, or else its account's, such as an email address, without those characters and cut to 100 characters. One owner's live connections to an app in an environment each have their own name, whatever the case, an emoji's variation selector or how accented letters are encoded: a name another of them has is refused at the connect (`409 connection-label-taken`), and a new connection whose name was taken in the meantime gets the first free number after it, such as `ana@acme.com 2`. A reconnect keeps the connection's name, so the one it asks for isn't checked. `PATCH /v1/connections/{connectionId}` (`client.connections.update(connectionId, { label })`) renames one: its owner or a tenant admin may, as for a disconnect, and anyone else gets `404 connection-not-found`. A taken name is `409 connection-label-taken`. A connection and a connect request carry `label` when they have one; a connection made before connections had names has none. `ConnectionBinding` gains `update`, and its errors `connection-label-taken`.
  
  - `hasHiddenCharacters` is the one rule for these names: a site's display name and a console link's label now also refuse a lone surrogate and the characters that render as nothing (Unicode's default-ignorable ones, such as the Hangul fillers), and a variation selector anywhere but in an emoji. An emoji with its variation selector, such as ✉️ or 1️⃣, still passes. A deployment whose console link label holds one of the newly refused characters (a lone surrogate, a Hangul filler, a combining grapheme joiner, or a variation selector after a letter) doesn't start after the upgrade, and the error names the link: take the character out. `comparableName` is what two connection names compare by, and `fitName` makes a name from an account's label: its hidden characters removed, trimmed, and cut between the characters a person sees, so a flag or a keycap is never split.
  - `@kindgi/connections-inmemory`: names connections the same way, and renames them with `update`. A seeded connection takes an optional `label`, and none by default.
- 215b6c1: **A run's record says how each connection a call used was picked, and through which registration.** A call's connection record in the run's journal gains `pick`: `by` is `mailbox` (the company connection the run's mail came to), `choice` (the agent's or flow's choice, with its `choiceId`), `only` (the project's only company connection of the app) or `own` (the person's own connection), and `registration` is the app's registration it came through, `{ id, name }`, named by its label, else by its app's name and its id's first 8 characters. Records from older runtimes have no `pick`. Any project reader reads a run's record, so it never names a person's connection: a person's has their account and no `name`, and so does their approval.
  
  - `@kindgi/tools`: `ConnectionPick`, and `picks` on a ready `ResolveConnectionsOutcome`, keyed like `connections`. A tool never sees them.
  - `@kindgi/connections-inmemory`: answers each ready need with its pick.
  - `@kindgi/agents`: the connection gate records each pick, and a connection's `name` for a company need only.
- c104300: **The company keeps one connection per account, and a connect can name the one it reconnects.** The company now keeps one per account: connecting support@acme.example and then sales@acme.example makes two connections, each named by its account, and connecting support@acme.example again reconnects its connection when the grant keeps every permission it holds, and the connection keeps its name and gains what was allowed. The account is known only when the connect finishes, so that's where it's found. `POST /v1/connections` (`client.connections.connect`) takes an optional `reconnects`, the id of the connection to connect again: a live one of the connect's own owner, on the same registration and environment. Any other id, whether another owner's, another registration's or environment's, a removed one or one that doesn't exist, is `404 connection-not-found` with `details.field` `reconnects`, and one that isn't a UUID is `400 bad-input`. The same account is required at the finish (`connection-account-mismatch`). When a connect finishes, `reconnected` says whether it landed on a connection that was already there, and `labelTaken`, when a new connection's name was taken in the meantime, gives the name it was to get; the connection is named the first free `<name> 2`, `<name> 3` and so on, which `connection.label` holds. `ConnectionBinding`'s `createRequest` takes `reconnects`, and its connected finish carries `reconnected` and `labelTaken`.
  
  - `@kindgi/connections-inmemory`: keeps the company's connections one per account the same way, finding the account's at the finish in the same step that would make a new one, so two finishes of one account make one connection. A company connection is seeded one per account.
- fda29c0: **One agent can use several accounts of one app: the company's, or a person's own.**
  
  A person can connect an app more than once, once per account: connecting an account they already have reconnects that connection when the grant keeps every permission it holds, as the company's does. One of their connections through a registration in an environment is their main (`Connection.main`, `ConnectionCandidate.main`): the one their agents use when no choice names another. A person's first connection has no main. Their second connection makes the first one their main, and the connect finish says which (`main`: `set`, `kept` or `missing`, with `connectionId` for the first two). `PATCH /v1/connections/{connectionId}` with `{ "main": true }` makes a connection its owner's main, in place of the one that was. Only that person can do this; the company's connections have no main, and `main: false` is refused, since a main moves only when another is made main. A mail trigger's stored connection doesn't move with it.
  
  A choice can now be for one tool's connection, not only for an agent's or a flow's app: `toolId` and `need`, the tool's name for the connection, which may be left out when the tool uses the app once. A choice can also be a person's own (`person`), for their own runs: only they make, change or remove it. A choice a version would never read is refused (`bad-input`, field `person`): the company's for a tool's need that is each person's own, a person's for the company's, and an agent's or a flow's own choice when its tools, at the versions they resolve to now, use the app only as the other owner's. One whose tools don't use the app now may be made ahead. For a tool that changes nothing, a choice can be a set (`connectionIds`): 2 to 10 candidates, each named, with `connectionId` among them as the one a call that names none uses. The agent's model then sees an `accounts` input on that tool. That input names, by connection name, which of the set's connections a call reads; the model never sees connection ids. A name outside the set fails the call with `connection-missing`, without the name, and so does any name once the tool, at the version its agent or flow resolves to now, can't take a set: only a call that names none uses the default. A tool that changes things, declares `sensitive-data-egress` or has an `accounts` input of its own can't take a set.
  
  - `GET /v1/connection-choices/needs` lists an agent's or a flow's tools' connections at the versions they resolve to now: the tool, its `need`, the app, whose connection it is (`as`), and whether a choice for it may be a set (`set.allowed`, else `set.reason`: `changes`, `sensitive-data-egress` or `accounts-input`). Tools whose version couldn't be read are in `unread`.
  - `GET /v1/connections/{connectionId}/choices` lists the live choices that name a connection, as `connectionId` or in a set, for its owner or a tenant admin.
  - `GET /v1/connection-choices` takes `toolId`. It lists the company's choices and the caller's own, and a tenant admin reads every person's too; `owner=me` lists only the caller's own. `GET /v1/connection-choices/candidates` takes `owner=me` for the caller's own connections.
  - A run's record of the connection a call used says how it was picked (`by`: `named` or `main` are new), whose it was (`as`), and for a set, how many it had (`setSize`), without naming the others. A person's connection on that record now carries only its account's id, not its label.
  - An approval's `connection` names no account when it's a person's own, and `as` says whose. `ApprovalConnection` (and `HitlEnqueueInput.connection`) gains `as`, and its `account` is now optional, so code that read `account` as always there must allow for a person's approval without one. The reviewer sees "this person's <app> account". Approvals recorded before keep what they had.
  - A mail trigger on a person's mailbox can name its owner's own connection (`config.mailbox.connectionId`). With none named it stores their main, else their only one; several and no main is `409 connection-not-chosen`, counting them and naming none. A person mailbox's `account` (its address) is read only by the trigger's owner and a tenant admin; anyone else reads the trigger without it. A take-over of a person's mailbox clears its stored connection and its `account` label until the next poll.
  
  - `@kindgi/api`: the routes above, and `ConnectionBinding` gains `choiceNeeds` and `listChoicesForConnection`, with `main`, `toolId`, `need`, `connectionIds`, `person` and `owners` on its inputs and records. New types: `ConnectFinishMain`, `ConnectionChoiceNeedRecord`, `ConnectionChoiceNeeds` and `ConnectionSetRefusal`. For tests, `@kindgi/api/testing`'s trigger registry gains `recordPoll`, which records a mail trigger's poll and the account it read.
  - `@kindgi/tools`: `ResolveConnectionsInput.accounts`, a need's connection id named by the call; `ConnectionResolver.accountChoices`, the sets a turn offers, with the types `ConnectionAccountChoices` and `ConnectionAccountChoicesInput`; and `ConnectionPick`'s new `by` values, `as` and `setSize`.
  - `@kindgi/agents`: a turn asks the resolver for its sets once, offers each as an `accounts` input, and takes it off the arguments before the tool runs. `connectionSetRefusal(tool)` is the one rule for which tools may take a set.
  - `@kindgi/runtime`: `MailTriggerRecord.account`'s label is optional, and the scheduler's docs cover a person mailbox's connection.
  - `@kindgi/connections-inmemory`: keeps mains, tool choices, person choices and sets the same way, and its resolver picks a call's connection in the same order.
  - `@kindgi/client`: `client.connectionChoices.needs(...)`, which answers a `ConnectionChoiceNeeds`, `client.connections.choices(connectionId)`, and the new fields and queries above.
  - `@kindgi/cli`: `kindgi connection-choices set` takes `--tool`, `--need`, `--default` and `--mine`, and `list` takes `--tool` and `--mine`, with TOOL, NEED and CONNECTIONS columns: your own choices marked `yours:`, and another person's counted, with their user id, not named. `kindgi connections update --main` makes a connection your main, and `kindgi connections list` marks it `(main)`. After a person's new connection, `connect` says which of theirs their agents use when they have several there: their main, or that none is, so a call that needs one stops with `connection-not-chosen` until one is. `kindgi mail-triggers` takes `--connection` with `--as=person`: your own connection that reads your mailbox. A person's mailbox's `connection-not-chosen` says how to name one, or make one main.
- 8327900: The doc comments and READMEs call the place a workspace, as the console and the API reference do, and so do the npm descriptions of `@kindgi/bounds` and `@kindgi/platform`. What you type keeps `tenant`: `tenantId`, `TenantHierarchyBinding` and `runOutsideTenant`. So does the multi-tenant text.
- Updated dependencies [6421d6f]
- Updated dependencies [64f9f38]
- Updated dependencies [c8afe3b]
- Updated dependencies [04813e4]
- Updated dependencies [e96b83b]
- Updated dependencies [2251f96]
- Updated dependencies [215b6c1]
- Updated dependencies [c104300]
- Updated dependencies [f3a6c97]
- Updated dependencies [3360533]
- Updated dependencies [6d3018f]
- Updated dependencies [fda29c0]
- Updated dependencies [1ed72e3]
- Updated dependencies [8327900]
- Updated dependencies [1365f49]
  - @kindgi/api@0.5.0
  - @kindgi/agents@0.5.0
  - @kindgi/connections@0.5.0
  - @kindgi/tools@0.5.0
  - @kindgi/types@0.5.0
  - @kindgi/authz@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [b25b82f]
- Updated dependencies [af2f8db]
- Updated dependencies [1e4dd72]
- Updated dependencies [265fffb]
- Updated dependencies [24c1f9d]
- Updated dependencies
- Updated dependencies [44f9726]
- Updated dependencies [d92355b]
- Updated dependencies [b9135f8]
- Updated dependencies [d6c9279]
- Updated dependencies [6380c49]
- Updated dependencies [d508659]
- Updated dependencies [265fffb]
- Updated dependencies [2afc071]
- Updated dependencies [f2adcc2]
- Updated dependencies [ae02280]
- Updated dependencies [e98d120]
- Updated dependencies [9106401]
- Updated dependencies [c9740c7]
- Updated dependencies [3a1502d]
- Updated dependencies [7bdd73e]
- Updated dependencies [a2f785f]
- Updated dependencies [d10dcc3]
- Updated dependencies [efa3cdb]
- Updated dependencies [9b015f7]
- Updated dependencies [334f7f9]
- Updated dependencies [038fbfb]
- Updated dependencies [9a8a294]
- Updated dependencies [5d28854]
- Updated dependencies [58ce994]
- Updated dependencies [6ab40e9]
- Updated dependencies [e9f223b]
- Updated dependencies [1bd877d]
- Updated dependencies [265fffb]
- Updated dependencies [12830e8]
- Updated dependencies [59a1243]
- Updated dependencies [bd3817f]
- Updated dependencies [d779ec5]
- Updated dependencies [156abe4]
- Updated dependencies [b4e208f]
- Updated dependencies [dff9515]
- Updated dependencies [fbb40b7]
- Updated dependencies [00c0b51]
- Updated dependencies [023f556]
- Updated dependencies [9346681]
- Updated dependencies [1131ec3]
- Updated dependencies [9faeb00]
- Updated dependencies [d576ff4]
- Updated dependencies [fdbd8cc]
  - @kindgi/types@0.4.0
  - @kindgi/agents@0.4.0
  - @kindgi/api@0.4.0
  - @kindgi/tools@0.4.0
  - @kindgi/connections@0.4.0
  - @kindgi/authz@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
  - @kindgi/api@0.3.1
  - @kindgi/agents@0.3.1
  - @kindgi/tools@0.3.1
  - @kindgi/authz@0.3.1
  - @kindgi/connections@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/agents@0.3.1-rc.1
  - @kindgi/api@0.3.1-rc.1
  - @kindgi/authz@0.3.1-rc.1
  - @kindgi/connections@0.3.1-rc.1
  - @kindgi/tools@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
  - @kindgi/api@0.3.1-rc.0
  - @kindgi/agents@0.3.1-rc.0
  - @kindgi/tools@0.3.1-rc.0
  - @kindgi/authz@0.3.1-rc.0
  - @kindgi/connections@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [77de8bd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [1a36b1f]
- Updated dependencies [06ae9b6]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [ea16d4e]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [5022734]
- Updated dependencies [29b60dd]
- Updated dependencies [e8baad5]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [03a715d]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [52d0759]
- Updated dependencies [8dd91b0]
  - @kindgi/api@0.3.0
  - @kindgi/agents@0.3.0
  - @kindgi/tools@0.3.0
  - @kindgi/authz@0.3.0
  - @kindgi/types@0.3.0
  - @kindgi/connections@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [77de8bd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [1a36b1f]
- Updated dependencies [06ae9b6]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [ea16d4e]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [5022734]
- Updated dependencies [29b60dd]
- Updated dependencies [e8baad5]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [03a715d]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [52d0759]
- Updated dependencies [8dd91b0]
  - @kindgi/api@0.3.0-rc.0
  - @kindgi/agents@0.3.0-rc.0
  - @kindgi/tools@0.3.0-rc.0
  - @kindgi/authz@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/connections@0.3.0-rc.0

## 0.2.0

### Patch Changes

- 08dedca: **A registration names its app's directory: `oauth2.tenant`.** For an app whose sign-in happens in a directory of its own (Microsoft's tenant), `POST /v1/connection-apps` and `PATCH /v1/connection-apps/{appId}` take `oauth2.tenant`: Microsoft's tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. The registration's answer shows it. The route checks that it's a string of 1 to 253 characters; the server's binding answers `connection-app-invalid` (`details.field` `oauth2.tenant`) when the app needs one and it's missing (Microsoft's always does), when the app has no directory, or when it isn't a directory's name. A `PATCH` that gives `oauth2` gives the whole of it, the tenant included. Changing the directory while the registration has live connections is refused as a client id change is (`connection-app-invalid`, `details.field` `oauth2.tenant`): their refresh tokens belong to it. It's compared as the sign-in uses it, so leaving `tenant` out of an app with a default directory counts as that default. `ConnectionOAuth2App` in the OpenAPI document, and the TypeScript and Python clients, have the optional `tenant`.
  - `@kindgi/connections-inmemory` checks it the same way, and its consent page is in the registration's directory, asking for the sign-in's and the account lookup's scopes too.
- 08dedca: **A new package: `@kindgi/connections-inmemory`.** An in-memory `ConnectionBinding` and `ConnectionResolver`, sharing one store, with a fake app in place of Google's or GitHub's servers, for development and tests. A test connects without a browser (`code: 'ok'`), and hooks make the fake app refuse a code, give no refresh token, fail a renewal, withdraw a grant, offer several GitHub installations, or send a notice. A connection without a refresh token, connected or seeded, works until its token ends, with no call to the app. It refuses `NODE_ENV=production` unless `productionSafe`.
- Updated dependencies [68e0d57]
- Updated dependencies [bf30268]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [68e0d57]
- Updated dependencies [19b0a86]
- Updated dependencies [b6e20ca]
- Updated dependencies [6fc48e9]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [68e0d57]
- Updated dependencies [354c801]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [8564e06]
- Updated dependencies [bf30268]
- Updated dependencies [a458bf4]
- Updated dependencies [af37c1a]
- Updated dependencies [af2f5db]
- Updated dependencies [68e0d57]
- Updated dependencies [98104be]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [b6e20ca]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [119ac78]
- Updated dependencies [fc7347c]
- Updated dependencies [b6e20ca]
- Updated dependencies [760acad]
- Updated dependencies [b6e20ca]
  - @kindgi/agents@0.2.0
  - @kindgi/api@0.2.0
  - @kindgi/connections@0.2.0
  - @kindgi/tools@0.2.0
  - @kindgi/authz@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
  - @kindgi/api@0.2.0-rc.1
  - @kindgi/tools@0.2.0-rc.1
  - @kindgi/connections@0.2.0-rc.1
  - @kindgi/agents@0.2.0-rc.1
  - @kindgi/authz@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **A registration names its app's directory: `oauth2.tenant`.** For an app whose sign-in happens in a directory of its own (Microsoft's tenant), `POST /v1/connection-apps` and `PATCH /v1/connection-apps/{appId}` take `oauth2.tenant`: Microsoft's tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. The registration's answer shows it. The route checks that it's a string of 1 to 253 characters; the server's binding answers `connection-app-invalid` (`details.field` `oauth2.tenant`) when the app needs one and it's missing (Microsoft's always does), when the app has no directory, or when it isn't a directory's name. A `PATCH` that gives `oauth2` gives the whole of it, the tenant included. Changing the directory while the registration has live connections is refused as a client id change is (`connection-app-invalid`, `details.field` `oauth2.tenant`): their refresh tokens belong to it. It's compared as the sign-in uses it, so leaving `tenant` out of an app with a default directory counts as that default. `ConnectionOAuth2App` in the OpenAPI document, and the TypeScript and Python clients, have the optional `tenant`.
  - `@kindgi/connections-inmemory` checks it the same way, and its consent page is in the registration's directory, asking for the sign-in's and the account lookup's scopes too.
- 08dedca: **A new package: `@kindgi/connections-inmemory`.** An in-memory `ConnectionBinding` and `ConnectionResolver`, sharing one store, with a fake app in place of Google's or GitHub's servers, for development and tests. A test connects without a browser (`code: 'ok'`), and hooks make the fake app refuse a code, give no refresh token, fail a renewal, withdraw a grant, offer several GitHub installations, or send a notice. A connection without a refresh token, connected or seeded, works until its token ends, with no call to the app. It refuses `NODE_ENV=production` unless `productionSafe`.
- Updated dependencies [68e0d57]
- Updated dependencies [bf30268]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [68e0d57]
- Updated dependencies [19b0a86]
- Updated dependencies [6fc48e9]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [68e0d57]
- Updated dependencies [354c801]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [8564e06]
- Updated dependencies [bf30268]
- Updated dependencies [a458bf4]
- Updated dependencies [af37c1a]
- Updated dependencies [af2f5db]
- Updated dependencies [68e0d57]
- Updated dependencies [98104be]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [08dedca]
- Updated dependencies [119ac78]
- Updated dependencies [fc7347c]
- Updated dependencies [760acad]
  - @kindgi/agents@0.2.0-rc.0
  - @kindgi/api@0.2.0-rc.0
  - @kindgi/connections@0.2.0-rc.0
  - @kindgi/tools@0.2.0-rc.0
  - @kindgi/authz@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0
