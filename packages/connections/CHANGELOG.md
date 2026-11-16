# @kindgi/connections

## 0.8.0

### Minor Changes

- 309b73f: **An MCP server can sign in as a connection, and HubSpot and Asana are app entries.** A person, or the company, connects once to an app whose entry lists its MCP servers, and an endpoint registered for that server sends each call with a token minted for it from that connection.
  
  - **`@kindgi/connections`: an entry lists its MCP servers.** `defineApp` takes `mcpServers`, each `{ origin, resource, issuer }` (`AppMcpServer`): the https origin a token may go to, the resource it's minted for (RFC 8707) and the authorization server that issues it. An entry that lists servers signs in with `oauth2`, and lists each origin once.
  - **Two sign-in choices for such servers.** `signIn.scopesFrom: 'registration'` asks for no scope: a connection holds all of the entry's permissions, and each permission grants itself. `account: { kind: 'none' }` reads no account: the account is the owner (the person's user id, or `company`), so an owner has one connection per app and env, and connecting again renews it. Both need an `oauth2` sign-in.
  - **The `hubspot` and `asana` entries** (`@kindgi/connections/hubspot`, `@kindgi/connections/asana`) sign in to HubSpot's and Asana's own MCP servers with PKCE, for a person or the company, with one permission, `mcp.tools`. They bring no tools of their own: the tools are the servers'.
  - **`@kindgi/api`: an MCP endpoint signs in as a connection.** Its `auth` takes `{ scheme: 'connection', app, as: 'person' | 'company', permissions? }` (`MCPConnectionAuth`): each call uses the connection of the person the run acts for, or the company's. `permissions` names the entry's permissions the tools need, 1 to 64 (`MCP_CONNECTION_PERMISSIONS_MAX`); absent, all of them. `catalogConnectionId` names the connection the endpoint lists its tools with: the registrant's own, or the company's. It's required with a `connection` auth and refused without one.
  - **`POST /v1/mcp/endpoints` checks a `connection` auth** against the entries and connections the app serves, and answers `400 invalid-mcp-endpoint` with its reason: `unknown-app`, `origin-not-listed`, `owner-not-allowed`, `unknown-permission`, `catalog-connection-required`, `invalid-catalog-connection-id`, `catalog-connection-without-connection-auth`, `catalog-connection-not-found` or `catalog-connection-not-yours`. The endpoint binding gets the entry's server as `mcpServer`, reads the server's protected resource metadata, and refuses one whose authorization servers don't name the entry's issuer: the outcome `resource-metadata-refused`, reason `resource-metadata-unreadable`, `issuer-mismatch` or `resource-mismatch` (`MCP_RESOURCE_METADATA_REFUSALS`), answered as `400 invalid-mcp-endpoint`.
  - **`@kindgi/client`** gains `McpConnectionAuth` and `catalogConnectionId`. The Python and JVM clients carry the new models.
  - **`@kindgi/cli`: `kindgi mcp add hubspot` and `kindgi mcp add asana`.** A connection preset (`"auth": "connection"`, with its `app`, `name` and `url`) registers the vendor's server at the runtime, with `--as=person` (the default: each person's own connection) or `--as=company`, and lists its tools with your own connection or the company's. It writes nothing to `.mcp.json`. `--env` picks the connection's env when there is more than one, `--server-name` names the endpoint, and `--force` replaces one registered under that id. `--as` on a preset the launcher runs, and `--secret` or `--path` on a connection preset, are refused. `kindgi mcp presets` lists both kinds.
  - **An older runtime** refuses a `connection` auth as `invalid-auth`, and `catalogConnectionId` as `unknown-field`, and registers nothing.
  
  Release-decision: a minor, in 0.8.0, the maintainers, 2026-11-15

### Patch Changes

- @kindgi/capabilities@0.8.0
  - @kindgi/tools@0.8.0
  - @kindgi/types@0.8.0

## 0.7.0

### Patch Changes

- f2baded: **Tools for Google Drive.** `googleDriveFilesList`, `googleDriveFileGet` and `googleDriveFileCreate`, from `@kindgi/connections/google/tools`, find, read and add files in the Drive of the Google account the run acts as, or the company's with `as: 'company'`.
  
  - **The list** gives the files others share with the account too, never what's in the trash: the newest first, or, with `text`, the best matches first. It narrows by words in a file's name or content, words in its name, a folder, a kind or a time. Each file comes with its `id`, `name`, `kind`, `contentType`, `size`, `modified`, `link`, `folderId`, and `owner` when that's someone else, and `next` gives the next page.
  - **The get** stores one file as a file of the run, as an attachment tool does. A Google Doc is read as Markdown, a Sheet as CSV, Slides as text and a Drawing as a PNG, or each as a PDF with `format: 'pdf'`. Other files are read as they are when they're a JPEG, PNG or WebP image, a PDF, or a text, Markdown or CSV file, within its type's size limit. Else the answer says why the file isn't shown (`notShown`). The answer also gives the file as the list does (`listed`).
  - **The create** adds a file at the top of the Drive from `text` or from a file of the run. With `convert: true`, text or Markdown becomes a Google Doc and CSV a Google Sheet. In a run no person started, it waits for a yes. It runs once per call: run again, it gives the first call's answer, and it finds a file the call added before rather than adding a second.
  - **Permissions.** The Google entry adds `drive.readonly`, with review `restricted`, for the list and the get, and `drive.file`, with review `none`, for the create: it reaches only the files the app added. A connection made before lacks them until the person allows it. Turn on the Google Drive API in your OAuth client and add them to its Data access.
  - **Pacing.** A new rate limit paces each connection's Drive calls at 325,000 of Drive's quota units a minute, at Drive's cost for each call. Drive calls don't count in Gmail's or the calendar's units, and a Gmail attachment's download no longer counts in the calendar's. Outlook's send, reply and event writes are now named in its sends limit, at the 1 they cost before.
  - **Your own calls.** `appFetch`'s `body` takes bytes as well as text, and sends them as they are.
  - **Versions.** The three tools start at 1.0.0, as person and as company.
  - **Docs.** A new Files guide shows the tools, the Google setup guide adds the Drive API and the two permissions, the connections overview and Use a connection list the tools, and the tools authoring skill names them.
- 2d81e64: **LinkedIn posts carry images and a link card, and a post can be deleted.** `linkedinPost`, from `@kindgi/connections/linkedin/tools`, takes `images`: 1 to 20 of the run's files, in order, each with its `altText`. One is the post's image, and two or more make a multi-image post. It takes `link` too: a card with its `url`, the `title` it shows (LinkedIn makes no card from a link itself) and a `description`, with one image at most as its thumbnail. `linkedinDeletePost` deletes a post the person made, by the `postId` that posting it gave.
  
  - **Images.** Each is a JPEG, GIF or PNG of fewer than 36,152,320 pixels, LinkedIn's limits. Every image is read and checked before any is uploaded, and a file the run can't read fails the call in words, before anything is posted. The tool declares `readsFiles`, and its network adds `www.linkedin.com`, LinkedIn's upload host: an upload address on any other host is refused. On a runtime that gives a tool no file reads, a post with images fails in words, and a text post works as before.
  - **Once per call.** The uploads happen in the recorded step with the post, so a step run again uploads and posts nothing more.
  - **Calls.** Each image takes two of the person's 150 LinkedIn calls a day: one to start its upload, and one for its bytes.
  - **Deleting.** A post already deleted counts as deleted, and a server error says deleting again is safe. It asks the same `posts.write` permission, and in a run no person started it waits for the person's yes, as a post does.
  - **`appFetch`** takes bytes as a `body`, for an upload.
  - **Versions.** `linkedinPost` moves to 1.1.0. `linkedinDeletePost` starts at 1.0.0.
  - **Docs.** The connections guide, the LinkedIn guide's limits, the package README and the tools authoring skill name the new fields and the delete tool.
- 7745812: **`mailTurn` sets in every line of a mail's text that would read as one of the turn's own, not only a `---` line.** A line that starts with `[the rest of this mail is cut]` or `(no text)`, or with `To:`, `Cc:`, `Reply-To:` or `Attachments:` in any case, with or without a space after the colon, after any characters that don't show, now starts with one space, as a line starting `---` already did. Before, the agent could take a new mail's first line `To: …` for its recipients when it had none, a last line `Attachments: …` for attachments, a last line `[the rest of this mail is cut]` for a cut, and a text of only `(no text)` for none.
  
  - **Each mail a mail turn's read gives, its `mail` and every mail of its `thread`, sets in a line of its `body` that starts as `[earlier mail left out]`,** the mark a Gmail quote cut leaves, on Gmail and Outlook alike, so only the cut's own mark reads as one. A flow started from new mail gets those mails as `input.mail` and `input.thread`. A read tool's text is as before.
  - Otherwise `input` and `covered` are as before.
  - The WordPress plugin reads those lines as the mail's text and shows them without the space. An earlier plugin shows them with it, and no longer takes them for the mail's own.
  - **Docs.** Start runs from new mail says which lines are set in, and that a flow's `mail` sets in the mark.
- 1dd8f20: **Tools for OneDrive and SharePoint.** `oneDriveFilesList`, `oneDriveSharedFilesList`, `sharePointLibrariesList` and `oneDriveFileCreate`, from `@kindgi/connections/microsoft/tools`, find and add files in the OneDrive of the Microsoft account the run acts as, or the company's with `as: 'company'`, and find the files others share with it and its organization's SharePoint libraries.
  
  - **The own list** reads the account's OneDrive: with `text`, the files whose name, details or content match, across the drive; with `folderId`, what's in that folder; with neither, its top level. Each file comes with the same fields as a Google Drive list's, and `next` gives the next page. A folder's `contentType` is `inode/directory`.
  - **The shared list** searches, with `text`, what the account can open, those others share with it too, or lists a drive by its `driveId`: its top level, a folder in it, or what matches in it. A file in another drive gives its `driveId`, and its `owner` when Microsoft names one.
  - **The libraries list** finds the SharePoint sites that match `text`, at most `top` (5 when it's left out, 10 at most), and gives each one's document libraries with their `driveId`, for the shared list.
  - **The create** adds a file at the top of the OneDrive or in a folder by its `folderId`, from `text` or from a file of the run. It never replaces a file: when one of that name is already there, it fails, saying so, unless that file has the same size, which it answers as the file it added. In a run no person started, it waits for a yes. It runs once per call: run again, it gives the first call's answer.
  - **Permissions.** The Microsoft entry adds `Files.Read` for the own list, `Files.ReadWrite` for the create, `Files.Read.All` for the shared list and `Sites.Read.All` for the libraries list. On Microsoft's default for new tenants, the last two need an admin's consent once. A connection made before lacks them until the person allows it.
  - **Pacing.** A new rate limit paces each connection's OneDrive and SharePoint calls at 3,000 in 5 minutes. File calls don't count in the mailbox's limits, and Outlook's calls don't count in the new one. The mailbox's 10,000 in 10 minutes now names each Outlook call, at the 1 it cost before.
  - **`FileListed`** gains `driveId`, given only by OneDrive's lists.
  - **Versions.** The four tools start at 1.0.0, as person and as company.
  - **Docs.** The Files guide adds OneDrive and SharePoint, the Microsoft setup guide adds the Files and Sites permissions and the admin-consent default, the calendar guide's consent sentence is corrected, and the connections overview, Use a connection, the README and the tools authoring skill name the new tools.
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
- Updated dependencies [dfaeea7]
- Updated dependencies [c7b560c]
- Updated dependencies [2d279a5]
- Updated dependencies [bb5bbf8]
- Updated dependencies [af5b037]
- Updated dependencies [524e626]
- Updated dependencies [f7264e7]
- Updated dependencies [439bffc]
- Updated dependencies [00afa37]
- Updated dependencies [a478edf]
- Updated dependencies [7f9d20f]
- Updated dependencies [cdf511b]
- Updated dependencies [25d902a]
- Updated dependencies [39c4e12]
  - @kindgi/types@0.7.0
  - @kindgi/tools@0.7.0
  - @kindgi/capabilities@0.7.0

## 0.6.0

### Patch Changes

- e0bfdf7: **The calendar tools read calendars others share.** `googleCalendarSharedEventsList`, from `@kindgi/connections/google/tools`, and `outlookCalendarSharedEventsList`, from `@kindgi/connections/microsoft/tools`, list the events in a window as the events lists do, with the same input and output, and also on a calendar someone else owns that the account has, such as a colleague's or a family calendar. They act as the person, or as the company with `as: 'company'`.
  
  - **Opt-in.** They ask for a wider permission than the events lists, so only a pack that includes one asks for it. The events lists, free/busy and the calendars lists are unchanged.
  - **Permissions.** The Google entry adds `calendar.events.readonly`, with review `sensitive`, and the Microsoft entry adds `calendars.read.shared` (Calendars.Read.Shared, no admin consent by default). A connection made before lacks them until the person allows it. Add the Google one to your OAuth client's Data access, and the Microsoft one to your app's API permissions.
  - **Versions.** Google's starts at 1.0.0 and Outlook's at 1.1.0, as person and as company.
  - **Docs.** The Calendars guide shows the shared lists and their permissions, and no longer says Outlook's events list reads a shared calendar with the same permission as the main one: Microsoft's pages name a wider permission for one. The Google and Microsoft setup guides add the new permissions, and the tools authoring skill names the shared lists.
- Updated dependencies [6707cb9]
- Updated dependencies [38aa185]
- Updated dependencies [7062ba5]
  - @kindgi/types@0.6.0
  - @kindgi/tools@0.6.0
  - @kindgi/capabilities@0.6.0

## 0.5.0

### Patch Changes

- c8afe3b: **The calendar tools read several calendars.** `googleCalendarCalendarsList`, from `@kindgi/connections/google/tools`, and `outlookCalendarCalendarsList`, from `@kindgi/connections/microsoft/tools`, list the calendars of the account the run acts as, or the company's with `as: 'company'`: each with its `id`, its `name`, whether it's the `main` one, the `access` the account has, and its `owner` when that's someone else. The events lists and free/busy take up to 10 of those ids in a new optional `calendarIds`.
  
  - **Without `calendarIds`,** a list or a free/busy reads the main calendar and answers as before.
  - **Over several calendars,** a list gives each event with its `calendarId`, merged by start, with `top` counted across them, and a free/busy joins their busy times. When Google or Microsoft refuses one of the calendars, the call fails and names it. Google reads only calendars the account owns. Outlook's free/busy reads at most 1000 events across the calendars.
  - **Permissions.** The Google entry adds `calendar.calendarlist.readonly`, with review `sensitive`, which only the calendars list asks for. A Google connection made before lacks it until the person allows it. Outlook's calendars list uses `calendars.readbasic`, as its events list does. Google paces `calendar.calendarList.list` with the other calendar calls, and Outlook's `outlook.calendars.list` doesn't count against sends.
  - **Versions.** The events lists and free/busy move to 1.1.0, as person and as company. The calendars lists start at 1.0.0.
  - **Docs.** The Calendars guide shows how to read several calendars, the Google setup guide adds the new permission, and the tools authoring skill names the calendars lists.
- 1ed72e3: The doc comments and READMEs call the place a workspace, as the console does, and so do the npm descriptions of `@kindgi/capabilities`, `@kindgi/memory` and `@kindgi/policy-contract` and the types package's `SPEC.md`. What you type keeps `tenant`: `tenantId`, `TenantId` and `forTenant`. So does the multi-tenant text.
- Updated dependencies [6421d6f]
- Updated dependencies [04813e4]
- Updated dependencies [215b6c1]
- Updated dependencies [fda29c0]
- Updated dependencies [1ed72e3]
- Updated dependencies [1365f49]
  - @kindgi/capabilities@0.5.0
  - @kindgi/tools@0.5.0
  - @kindgi/types@0.5.0

## 0.4.0

### Patch Changes

- 44f9726: **Calendar tools.** `@kindgi/connections/google/tools` adds `googleCalendarEventsList`, `googleCalendarFreeBusy`, `googleCalendarEventCreate` and `googleCalendarEventUpdate`, and `@kindgi/connections/microsoft/tools` adds `outlookCalendarEventsList`, `outlookCalendarFreeBusy`, `outlookCalendarEventCreate` and `outlookCalendarEventUpdate`. They list the events in a window of at most 31 days, say when the calendar is busy, and add or change an event, on the calendar of the account the run acts as. `as: 'company'` uses the company's calendar a tenant admin connected. Each asks for the least access its call takes.
  
  - **Times.** A tool takes a time with its offset, or a day for an all-day event, and gives times in UTC. An event's `start` and `end` are both times or both days.
  - **Invitations.** A create or an update tells the people it invites, so both are mutating tools that wait for a yes in a run no person started. A create runs once per call: a step that runs again gets the first create's answer.
  - **What an update changes.** One event, or one occurrence of a repeating one, by the id a list gave. It refuses a whole series.
  - **Permissions.** The Google entry adds `calendar.events.owned.readonly`, `calendar.freebusy` and `calendar.events.owned`, each with review `sensitive`; the Microsoft entry adds `calendars.readbasic` and `calendars.readwrite`. A connection made for mail only lacks the calendar permissions: in a run the person started, the call waits for them to allow them; in any other, it fails with `connection-missing`.
  - **Rate limits.** Google calendar calls are paced at 600 a minute per connection, apart from Gmail's units. Outlook calendar calls count against Graph's mailbox limit; a create or an update also counts against the 30 a minute that sends do.
  - **Docs.** A new Calendars guide, the calendar steps in the Google and Microsoft setup guides, and the calendar tools in the tools authoring skill.
- efa3cdb: **The mail tools can show an agent a mail's attachments.**
  - **The tools.** `gmailAttachmentGet` (`@kindgi/connections/google/tools`) and `outlookAttachmentGet` (`@kindgi/connections/microsoft/tools`) take a message's id and an attachment's number in its list (1 for the first). Each works on the person's own mailbox, or on the company's with `as: 'company'`. It stores the attachment as a file the call's run owns, and the agent is shown it. It takes a JPEG, PNG or WebP image (at most 5 MB), a PDF (at most 10 MB), or a text, Markdown or CSV file (at most 1 MB). The attachment's type and listed size are checked before anything is downloaded, and a download stops past the type's limit. Any other attachment, an attached message, or a link to a file kept elsewhere answers `notShown`, with its name and why: `type`, `size`, `limit`, `store` (the call has no file store), or `storage` (the tenant's storage is full). The tools read with `gmail.readonly` and `mail.read`, as the read tools do, and change nothing in the mailbox. An attachment's id at Google or Microsoft never reaches the model, in an answer or in an error.
  - **The numbers.** The attachment tools take the same list as the read tools and a mail trigger's turn, in the same order. A mail turn numbers each mail's attachments from 1, and shows their sizes in the units the limits use (1 MB is 1,000,000 bytes), rounded up. An earlier mail that lists attachments now shows its id, as the new mail does.
  - `outlookMessageGet` and the Outlook mail trigger now read each attachment's id with its name, type and size, and never show it.
- 265fffb: **A project's repo connection.** `PUT /v1/projects/{projectId}/repo-connection` with `{ connectionId }` sets the company-wide GitHub connection a project opens its block changes' pull requests through, and `DELETE` clears it. Both need `admin` on the project. A connection that isn't there, or was removed, is `404 connection-not-found`; a person's own connection, or another app's, is `400 repo-connection-not-company-github`. `GET /v1/projects/{projectId}` answers `repoConnectionId` while one is set. The project keeps the id only, so a connection removed later reads as none. A runtime whose project store keeps no repo connection answers `501 repo-connection-unsupported`.
  
  - **Platform.** `Project.repoConnectionId`, and an optional `ProjectBinding.setRepoConnection(tenantId, projectId, connectionId | null)` answering `ProjectRepoConnectionOutcome`; the in-memory binding implements it, and the project binding conformance suite checks it with `repoConnection: true`.
  - **TypeScript client.** `client.projects.setRepoConnection(projectId, connectionId)` and `client.projects.clearRepoConnection(projectId)`.
  - **GitHub permissions.** The GitHub entry adds `contents.read`, `contents.write`, `pull_requests.read` and `pull_requests.write`. A repo connection's GitHub App needs **Contents** and **Pull requests**, read and write; the GitHub connection guide says so.
- Updated dependencies [b25b82f]
- Updated dependencies [d92355b]
- Updated dependencies [d6c9279]
- Updated dependencies [f2adcc2]
- Updated dependencies [d10dcc3]
- Updated dependencies [9b015f7]
- Updated dependencies [f3bd652]
- Updated dependencies [9a8a294]
- Updated dependencies [1bd877d]
- Updated dependencies [dff9515]
- Updated dependencies [1131ec3]
- Updated dependencies [d576ff4]
  - @kindgi/types@0.4.0
  - @kindgi/capabilities@0.4.0
  - @kindgi/tools@0.4.0

## 0.3.1

### Patch Changes

- @kindgi/tools@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/tools@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- @kindgi/tools@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/tools@0.3.0
  - @kindgi/types@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
  - @kindgi/tools@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0

## 0.2.0

### Patch Changes

- 08dedca: **Tools that act with a connection, and `appFetch` to write more.**
  - **`@kindgi/connections/app-fetch`: `appFetch(ctx, call)`** calls an app's API with one of the call's connections. Its token goes as the only `Authorization`. Calls are paced by the entry's rate limits, per connection. A busy answer is tried again: a 429, a 503 to a GET, or a 403 that says a rate limit is spent, with 3 tries in all and never a wait past 30 s. A 401 throws `ConnectionRejectedError`, so the runtime renews the token once.
  - **Each tool is a factory, and a pack names its id.** A tool id is the tenant's, filed under the first project that publishes it, so a pack includes `gmailSend({ id: 'acme.gmail.send' })` under its own id. There's no default.
    - `@kindgi/connections/google/tools`: `gmailSend` sends a plain-text mail as the person whose Google connection the call has.
    - `@kindgi/connections/github/tools`, on the company's GitHub connection: `githubIssuesList`, `githubLabelsList`, and `githubIssuesAddLabels`, which adds only labels the repository has.
    - Sending and labelling are `mutating`, and wait for a person's yes in a run no person started.
- 08dedca: **Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
  - **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. An OAuth 2.0 sign-in's `refreshToken` says whether a connect needs a refresh token: `'required'` (the default) refuses one without, and `'optional'` is for an app that may give none, whose connections then work until one minute before their access token ends and then need reconnecting (a grant that gives neither a refresh token nor the token's `expires_in` is refused). `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. A permission's `grants` and each account scope is one scope, with no space or comma, since the scopes an app grants are read split on both. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
  - **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too, alone or as another error's `cause`), so the runtime renews the token once and runs the call again. `connectionRejectionOf(error)` finds it, up to three causes deep, for a runtime's dispatch and a pack service alike. When the app can't give a token just now, the call fails with `ConnectionRenewError` (`connection-renew-failed`) and the connection stays as it is; one it can't renew at all (no refresh token, or the grant withdrawn) needs reconnecting, and the call waits or is refused as for any such connection. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
  - **`@kindgi/specs`:** `tool.schema.json` 1.3.0 has `needsSpec.connections` and the `connection` authorization.
  - **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
  - **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use. A secret read for a connection names its caller `connections`, in `@kindgi/compliance` too.
- 08dedca: **LinkedIn (posts as a person):** the `linkedin` entry at `@kindgi/connections/linkedin`, for a member's own profile on a company's own LinkedIn app with the two self-serve products (no LinkedIn review), and `linkedinPost` at `@kindgi/connections/linkedin/tools`, included under the id its pack names.
  - The entry signs in with OAuth 2.0 and PKCE, asks for `w_member_social` (in plain words: post, comment and react on LinkedIn as you, and edit or delete what you posted), and learns whose profile it is from OpenID Connect's ID token (`sub`, labelled with the email). LinkedIn has no revoke for one app's tokens and gives refresh tokens only to partners it approves, so the entry takes a connect that brings none (`refreshToken: 'optional'`), and a connection asks its person to connect again just before LinkedIn's 60 days end. A refresh token LinkedIn gives anyway is used. Calls are paced at LinkedIn's 150 a day per member.
  - `linkedinPost` posts text of up to 3,000 characters to the person's own feed, seen by anyone or by their connections only, and gives the post's id and link. The text is posted as written: a `#` that starts a word is written as LinkedIn's hashtag, and the rest of LinkedIn's markup is escaped, so a post mentions no one. It's `mutating`: in a run no person started, each post waits for that person's yes, and a step run again gets the first post's answer.
- 08dedca: **Microsoft (Outlook):** the `microsoft` entry at `@kindgi/connections/microsoft`, and three tools at `@kindgi/connections/microsoft/tools`, each included under the id its pack names: `outlookSend` (plain-text mail as the person, each send in a run no person started waiting for their yes), `outlookMessagesList` (newest first, or a search, in one folder) and `outlookMessageGet` (one message, its body as plain text).
  - An `oauth2` sign-in can name the app's own directory in its URLs (`{tenant}`, once in the authorize and token URLs and at most once in the revoke URL, filled from the registration's `oauth2.tenant`, else `signIn.tenant.default`; Microsoft's entry has no default, so each registration names it), ask for `signIn.scopes` at every sign-in (Microsoft's `offline_access`), and say which resource its granted scopes may be named with (`signIn.scopeResource`, ending in `/`), so they're compared without it, in any case. Each of `signIn.scopes` is one scope, with no space or comma.
  - A new account lookup, `profile`: a GET with the new access token, its id and label read from named fields (Microsoft Graph's `/me`). Each of its `scopes` is one scope too.
  - A rate limit's cost may be 0: that call isn't counted in that limit (Exchange's limit on sends, which reads don't use).
- b6e20ca: **A Google or Microsoft connection can be the company's mailbox.** The `google` and `microsoft` entries' `owners` are now `['member', 'company']`: a tenant admin connects the company's mailbox by signing in as that mailbox (`support@acme.example`), not as themselves.
  - **Gmail's quota costs** are in the `google` entry's rate limit, in Gmail's own units: reading a message 60 (20 for its headers or its date only), a thread 120, a message list 5, the mailbox's history 2 and its profile 1, beside a send's 100.
  - **`gmailMessagesList`** (`@kindgi/connections/google/tools`) lists or searches a Gmail mailbox, newest first: each message's subject, sender, when it came, the start of its text and whether it's unread. It needs only `gmail.readonly`.
  - **`as: 'company'`** on `gmailSend`, `gmailMessagesList`, `gmailMessageGet`, `outlookSend`, `outlookMessagesList` and `outlookMessageGet` makes the tool use the company's mailbox instead of the person's own. `as` is part of what a tool declares, so an id you've published keeps its `as`: give a company mailbox its own tool id (`acme.store-mail.list`).
  - **`@kindgi/connections/mail`**: `MailMessage`, one shape for a message from Gmail or Outlook, and `MailFunctions`, the calls a runtime makes to watch a mailbox for new mail and read it for a run.
  - **A mail's text, from Gmail or Outlook,** keeps where its links go: HTML's link `your order` comes as `your order <https://…>`, unless the text shows the address already as a word of its own. Every web address loses its tracking parameters (`utm_*`, `mc_cid`, `fbclid` and the like), and keeps the rest of its query as written. A quoted line (an HTML blockquote's) starts with `> `, one per level, as a mail client quotes. An AMP or watch version of the body isn't an attachment, and an invite is listed once.
  - **`gmailMessageGet`** reads one message whole and answers a `MailMessage`: who it's from and to and its reply-to (the first 20 people of each of To, Cc and Reply-To; `toLeftOut`, `ccLeftOut` and `replyToLeftOut` count the rest; an address cut at 254 characters and a name at 200, as for `gmailMessagesList`'s senders), its subject, its text (the plain-text part, else the HTML as text: the first 50,000 characters), its first 20 attachments' names, types and sizes (one the mail shows in its body, a pasted photo say, marked `inline`; a name or type cut at 200 characters; `attachmentsLeftOut` counts the rest), and whether it's an automatic reply. It needs only `gmail.readonly`.
  - **`googleMail`** (`@kindgi/connections/google/mail`) is Gmail's `MailFunctions`. `start` gives the mailbox's latest history id; `changes` reads the new mail in a label since it; `since` lists a label's mail from a time, for a catch-up after Gmail forgets a history id, each dated by a minimal get (20 units); and `read` gives a message with its thread, oldest first: the thread's first mail and the newest, within `MAIL_TURN_BUDGET`'s `threadMails`, and how many it didn't take (`notRead`). Each mail's text comes without what it quotes from the thread's earlier mail (an `On … wrote:` line and the `>` lines under it, an Outlook reply's original-message block), marked `[earlier mail left out]`; a forward, an answer typed between quoted lines and a mail that would be left empty keep their text whole. They're called with a token and a `fetch`, and paced by the `google` entry's rate limits, as the tools are.
  - **`outlookMessageGet` is at 2.0.0, and answers a `MailMessage`.** This breaks its output: `conversationId` is now `threadId`, `to` and `cc` hold their first 20 people, and it adds `replyTo` (its first 20 too), `toLeftOut`, `ccLeftOut` and `replyToLeftOut` (how many each has past those), `attachments` (the first 20 names, types and sizes, one shown in the body marked `inline`), `attachmentsLeftOut` and `autoSubmitted`. `body` and `bodyCut` stay; a body Outlook gives only as HTML now comes as text too. It and `outlookMessagesList` cut a person's address at 254 characters (no valid one is longer) and a name at 200. The `OutlookMessage` type is gone: use `MailMessage` (`@kindgi/connections/mail`, also exported by `@kindgi/connections/microsoft/tools`). An agent that names the tool at `^1.0.0` moves to `^2.0.0`, which also sets `resultIsOutsideData`. Without `as`, `gmailSend`, `outlookSend` and `outlookMessagesList` declare what they did before, at the same versions.
  - **Every mail read sets `resultIsOutsideData`:** `gmailMessagesList` and `gmailMessageGet`, at 1.0.0, and their company variants, as Outlook's two reads do. The agent reads each mail as data, not instructions.
  - **`microsoftMail`** (`@kindgi/connections/microsoft/mail`) is Outlook's `MailFunctions`. `start` begins a delta of a folder's new mail and keeps its link as the cursor; `changes` reads it; `since` lists a folder's mail from a time; and `read` gives a message with its conversation, oldest first, within the same budget, each mail with only what it added. A message that `changes`, `start` or `since` finds without its conversation comes with it, by a call for that one field. Each call is paced by the `microsoft` entry's rate limits, and none counts against sends. A cursor is only ever a Microsoft Graph link: one changed where it's kept is refused, so the token goes nowhere else.
  - **The mail functions give mail oldest first** within each answer: `since` its newest `max` mails, Outlook's `start` and `changes` by when each came, ties by id. On Gmail, which mails `since` takes when there are more than `max` follows Gmail's list, and `changes` keeps its history's order, the order the mailbox got them.
  - **When a mail call fails:** a busy answer is tried again as the tools' calls are (a 429, Google's rate-limit 403s, a 503 to a GET: 3 tries in all). A 401 throws `ConnectionRejectedError`, so the runtime renews the token. Any other answer the result doesn't cover throws `MailCallError`, with the app's status and its reason when that is in a code's form (Gmail's `reason`, Graph's error `code`), never the app's words or the token; `isMailScopeMissing` says when the connection lacks a scope the call needs. A call stopped by its `abortSignal` rejects with the signal's reason.
  - When Outlook finds no message, the error now says it found nothing "in the mailbox", which can be the company's.
  - **A thread leaves out drafts, trash and spam:** Gmail's `DRAFT`, `TRASH` and `SPAM`, and Outlook's drafts and its Deleted Items and Junk Email. A staff member's unsent reply never reaches a run as sent mail.
  - **The agent's own replies:** `MailMessage.sent` is `true` for the mailbox's sent mail in a read's thread (Gmail's `SENT`, Outlook's Sent Items). `replyRefOf(runId)` gives a run's reply mark, which a reply carries in its `X-Reply-Ref` header (`REPLY_REF_HEADER`); `MailMessage.replyRef` gives a Gmail mail's mark when the header is in a mark's form (`isReplyRef`). Anyone can set the header, so a mark counts only on sent mail.
  - **`mailTurn`** makes a mail-started turn from a read: the agent's message (the thread as text, oldest first, the new mail last, with who each mail is from and when), a flow target's input (`mail`, `thread`, `leftOut`), and the ids the turn `covered`. Within `MAIL_TURN_BUDGET` (each mail's text 50,000 characters, the turn's 60,000 with every line counted, at most 100 mails), it takes the new mail, then the first mail, then the newest, and says how many mails it left out. The new mail lists the first 20 people of its To, Cc and Reply-To, and each mail its first 20 attachments, then how many more, and a name or subject over 200 characters is cut. Only the mailbox's sent mail shows as "(this mailbox)": other mail from its address shows as "(this mailbox's address, not its sent mail)", since anyone can send from it. On a conversation that continues the thread, it carries only what the conversation wasn't given, and drops the agent's own marked replies. In a turn, a web address still over 100 characters keeps its scheme, host and the start of its path; the read tools keep every address whole.
- b6e20ca: **`gmailReply` and `outlookReply` answer a mail in its thread,** with plain text: `{ inReplyTo, to, body }`, where `inReplyTo` is the message's id as the list tools give it. Each has `as: 'company'` for the company's mailbox, as the other mail tools do, and asks before an unattended reply, as a send does: in a mail's run, a reply waits for a yes unless the trigger lists it in `toolsAllowedUnattended`.
  - **Where a reply goes:** the tool reads the mail and works out the one address it asks for, its Reply-To, else its From, as a mail client does. The call's `to` must name that address, in any letter case. A Reply-To that names no address, such as an empty group, counts as none. A reply is refused when the Reply-To (else From) names more than one address, one that isn't an address, or the mailbox's own, or when neither names one, and so is a `to` that names another address: the refusal names the address the mail asks for, and nothing is sent. The sender of a mail chooses both headers, so an agent that replies mustn't give out an order's details on the From address alone.
  - **`gmailReply`** sends in the message's thread with `In-Reply-To` and `References`, and the subject with `Re: ` before it. A value of the mail's goes into the reply's headers only once it's safe: a line break left in it once unfolded and decoded, or a message id that isn't `<…>` or runs past 900 characters, refuses the call. `References` keeps 20 ids, the first and the newest. In a run, the reply carries an `X-Reply-Ref` header with the run's mark, so a runtime reading the thread again knows the agent's own reply. It needs `gmail.send` and `gmail.readonly`, and answers the reply's id and its thread's.
  - **`outlookReply`** posts to the message's `/reply` in Graph's JSON form, with the body as the reply's text and the one address as its recipient; Graph keeps it in Sent Items. Graph's reply takes no header of ours, so it carries no mark. It needs `Mail.Send` and `Mail.Read`, and answers `{ accepted: true }`.
- b6e20ca: **A tool can say its results are text from outside: `resultIsOutsideData`.** A tool manifest's new optional `resultIsOutsideData: true` says the tool's results are text nobody checked, such as a mail someone sent. An agent then reads each result of it as data, not instructions:
  - in an `<event>` block;
  - in that turn, and again in every later turn's history;
  - with the framework's line about outside data in the system message from the turn's start.
  
  It changes what the model is told, not what the tool may do. The pack index carries it, and `GET /v1/tools` shows it. `outlookMessagesList` sets it, so it moves to version 1.1.0: a project that has 1.0.0 gets the flag when it takes 1.1.0.
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [68e0d57]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
  - @kindgi/tools@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- b6e20ca: **A Google or Microsoft connection can be the company's mailbox.** The `google` and `microsoft` entries' `owners` are now `['member', 'company']`: a tenant admin connects the company's mailbox by signing in as that mailbox (`support@acme.example`), not as themselves.
  - **Gmail's quota costs** are in the `google` entry's rate limit, in Gmail's own units: reading a message 60 (20 for its headers or its date only), a thread 120, a message list 5, the mailbox's history 2 and its profile 1, beside a send's 100.
  - **`gmailMessagesList`** (`@kindgi/connections/google/tools`) lists or searches a Gmail mailbox, newest first: each message's subject, sender, when it came, the start of its text and whether it's unread. It needs only `gmail.readonly`.
  - **`as: 'company'`** on `gmailSend`, `gmailMessagesList`, `gmailMessageGet`, `outlookSend`, `outlookMessagesList` and `outlookMessageGet` makes the tool use the company's mailbox instead of the person's own. `as` is part of what a tool declares, so an id you've published keeps its `as`: give a company mailbox its own tool id (`acme.store-mail.list`).
  - **`@kindgi/connections/mail`**: `MailMessage`, one shape for a message from Gmail or Outlook, and `MailFunctions`, the calls a runtime makes to watch a mailbox for new mail and read it for a run.
  - **A mail's text, from Gmail or Outlook,** keeps where its links go: HTML's link `your order` comes as `your order <https://…>`, unless the text shows the address already as a word of its own. Every web address loses its tracking parameters (`utm_*`, `mc_cid`, `fbclid` and the like), and keeps the rest of its query as written. A quoted line (an HTML blockquote's) starts with `> `, one per level, as a mail client quotes. An AMP or watch version of the body isn't an attachment, and an invite is listed once.
  - **`gmailMessageGet`** reads one message whole and answers a `MailMessage`: who it's from and to and its reply-to (the first 20 people of each of To, Cc and Reply-To; `toLeftOut`, `ccLeftOut` and `replyToLeftOut` count the rest; an address cut at 254 characters and a name at 200, as for `gmailMessagesList`'s senders), its subject, its text (the plain-text part, else the HTML as text: the first 50,000 characters), its first 20 attachments' names, types and sizes (one the mail shows in its body, a pasted photo say, marked `inline`; a name or type cut at 200 characters; `attachmentsLeftOut` counts the rest), and whether it's an automatic reply. It needs only `gmail.readonly`.
  - **`googleMail`** (`@kindgi/connections/google/mail`) is Gmail's `MailFunctions`. `start` gives the mailbox's latest history id; `changes` reads the new mail in a label since it; `since` lists a label's mail from a time, for a catch-up after Gmail forgets a history id, each dated by a minimal get (20 units); and `read` gives a message with its thread, oldest first: the thread's first mail and the newest, within `MAIL_TURN_BUDGET`'s `threadMails`, and how many it didn't take (`notRead`). Each mail's text comes without what it quotes from the thread's earlier mail (an `On … wrote:` line and the `>` lines under it, an Outlook reply's original-message block), marked `[earlier mail left out]`; a forward, an answer typed between quoted lines and a mail that would be left empty keep their text whole. They're called with a token and a `fetch`, and paced by the `google` entry's rate limits, as the tools are.
  - **`outlookMessageGet` is at 2.0.0, and answers a `MailMessage`.** This breaks its output: `conversationId` is now `threadId`, `to` and `cc` hold their first 20 people, and it adds `replyTo` (its first 20 too), `toLeftOut`, `ccLeftOut` and `replyToLeftOut` (how many each has past those), `attachments` (the first 20 names, types and sizes, one shown in the body marked `inline`), `attachmentsLeftOut` and `autoSubmitted`. `body` and `bodyCut` stay; a body Outlook gives only as HTML now comes as text too. It and `outlookMessagesList` cut a person's address at 254 characters (no valid one is longer) and a name at 200. The `OutlookMessage` type is gone: use `MailMessage` (`@kindgi/connections/mail`, also exported by `@kindgi/connections/microsoft/tools`). An agent that names the tool at `^1.0.0` moves to `^2.0.0`, which also sets `resultIsOutsideData`. Without `as`, `gmailSend`, `outlookSend` and `outlookMessagesList` declare what they did before, at the same versions.
  - **Every mail read sets `resultIsOutsideData`:** `gmailMessagesList` and `gmailMessageGet`, at 1.0.0, and their company variants, as Outlook's two reads do. The agent reads each mail as data, not instructions.
  - **`microsoftMail`** (`@kindgi/connections/microsoft/mail`) is Outlook's `MailFunctions`. `start` begins a delta of a folder's new mail and keeps its link as the cursor; `changes` reads it; `since` lists a folder's mail from a time; and `read` gives a message with its conversation, oldest first, within the same budget, each mail with only what it added. A message that `changes`, `start` or `since` finds without its conversation comes with it, by a call for that one field. Each call is paced by the `microsoft` entry's rate limits, and none counts against sends. A cursor is only ever a Microsoft Graph link: one changed where it's kept is refused, so the token goes nowhere else.
  - **The mail functions give mail oldest first** within each answer: `since` its newest `max` mails, Outlook's `start` and `changes` by when each came, ties by id. On Gmail, which mails `since` takes when there are more than `max` follows Gmail's list, and `changes` keeps its history's order, the order the mailbox got them.
  - **When a mail call fails:** a busy answer is tried again as the tools' calls are (a 429, Google's rate-limit 403s, a 503 to a GET: 3 tries in all). A 401 throws `ConnectionRejectedError`, so the runtime renews the token. Any other answer the result doesn't cover throws `MailCallError`, with the app's status and its reason when that is in a code's form (Gmail's `reason`, Graph's error `code`), never the app's words or the token; `isMailScopeMissing` says when the connection lacks a scope the call needs. A call stopped by its `abortSignal` rejects with the signal's reason.
  - When Outlook finds no message, the error now says it found nothing "in the mailbox", which can be the company's.
  - **A thread leaves out drafts, trash and spam:** Gmail's `DRAFT`, `TRASH` and `SPAM`, and Outlook's drafts and its Deleted Items and Junk Email. A staff member's unsent reply never reaches a run as sent mail.
  - **The agent's own replies:** `MailMessage.sent` is `true` for the mailbox's sent mail in a read's thread (Gmail's `SENT`, Outlook's Sent Items). `replyRefOf(runId)` gives a run's reply mark, which a reply carries in its `X-Reply-Ref` header (`REPLY_REF_HEADER`); `MailMessage.replyRef` gives a Gmail mail's mark when the header is in a mark's form (`isReplyRef`). Anyone can set the header, so a mark counts only on sent mail.
  - **`mailTurn`** makes a mail-started turn from a read: the agent's message (the thread as text, oldest first, the new mail last, with who each mail is from and when), a flow target's input (`mail`, `thread`, `leftOut`), and the ids the turn `covered`. Within `MAIL_TURN_BUDGET` (each mail's text 50,000 characters, the turn's 60,000 with every line counted, at most 100 mails), it takes the new mail, then the first mail, then the newest, and says how many mails it left out. The new mail lists the first 20 people of its To, Cc and Reply-To, and each mail its first 20 attachments, then how many more, and a name or subject over 200 characters is cut. Only the mailbox's sent mail shows as "(this mailbox)": other mail from its address shows as "(this mailbox's address, not its sent mail)", since anyone can send from it. On a conversation that continues the thread, it carries only what the conversation wasn't given, and drops the agent's own marked replies. In a turn, a web address still over 100 characters keeps its scheme, host and the start of its path; the read tools keep every address whole.
- b6e20ca: **`gmailReply` and `outlookReply` answer a mail in its thread,** with plain text: `{ inReplyTo, to, body }`, where `inReplyTo` is the message's id as the list tools give it. Each has `as: 'company'` for the company's mailbox, as the other mail tools do, and asks before an unattended reply, as a send does: in a mail's run, a reply waits for a yes unless the trigger lists it in `toolsAllowedUnattended`.
  - **Where a reply goes:** the tool reads the mail and works out the one address it asks for, its Reply-To, else its From, as a mail client does. The call's `to` must name that address, in any letter case. A Reply-To that names no address, such as an empty group, counts as none. A reply is refused when the Reply-To (else From) names more than one address, one that isn't an address, or the mailbox's own, or when neither names one, and so is a `to` that names another address: the refusal names the address the mail asks for, and nothing is sent. The sender of a mail chooses both headers, so an agent that replies mustn't give out an order's details on the From address alone.
  - **`gmailReply`** sends in the message's thread with `In-Reply-To` and `References`, and the subject with `Re: ` before it. A value of the mail's goes into the reply's headers only once it's safe: a line break left in it once unfolded and decoded, or a message id that isn't `<…>` or runs past 900 characters, refuses the call. `References` keeps 20 ids, the first and the newest. In a run, the reply carries an `X-Reply-Ref` header with the run's mark, so a runtime reading the thread again knows the agent's own reply. It needs `gmail.send` and `gmail.readonly`, and answers the reply's id and its thread's.
  - **`outlookReply`** posts to the message's `/reply` in Graph's JSON form, with the body as the reply's text and the one address as its recipient; Graph keeps it in Sent Items. Graph's reply takes no header of ours, so it carries no mark. It needs `Mail.Send` and `Mail.Read`, and answers `{ accepted: true }`.
- b6e20ca: **A tool can say its results are text from outside: `resultIsOutsideData`.** A tool manifest's new optional `resultIsOutsideData: true` says the tool's results are text nobody checked, such as a mail someone sent. An agent then reads each result of it as data, not instructions:
  - in an `<event>` block;
  - in that turn, and again in every later turn's history;
  - with the framework's line about outside data in the system message from the turn's start.
  
  It changes what the model is told, not what the tool may do. The pack index carries it, and `GET /v1/tools` shows it. `outlookMessagesList` sets it, so it moves to version 1.1.0: a project that has 1.0.0 gets the flag when it takes 1.1.0.
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
  - @kindgi/tools@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **Tools that act with a connection, and `appFetch` to write more.**
  - **`@kindgi/connections/app-fetch`: `appFetch(ctx, call)`** calls an app's API with one of the call's connections. Its token goes as the only `Authorization`. Calls are paced by the entry's rate limits, per connection. A busy answer is tried again: a 429, a 503 to a GET, or a 403 that says a rate limit is spent, with 3 tries in all and never a wait past 30 s. A 401 throws `ConnectionRejectedError`, so the runtime renews the token once.
  - **Each tool is a factory, and a pack names its id.** A tool id is the tenant's, filed under the first project that publishes it, so a pack includes `gmailSend({ id: 'acme.gmail.send' })` under its own id. There's no default.
    - `@kindgi/connections/google/tools`: `gmailSend` sends a plain-text mail as the person whose Google connection the call has.
    - `@kindgi/connections/github/tools`, on the company's GitHub connection: `githubIssuesList`, `githubLabelsList`, and `githubIssuesAddLabels`, which adds only labels the repository has.
    - Sending and labelling are `mutating`, and wait for a person's yes in a run no person started.
- 08dedca: **Connections: tools can act with accounts at other apps,** a member's own Google account or the company's GitHub App. This is the contract; a runtime implements it.
  - **New package: `@kindgi/connections`.** An app entry says how a person signs in at the app (OAuth 2.0 with PKCE, or a GitHub App's installation), who may own a connection (a member, the company), what each permission allows in plain words, whose account it is, how access is withdrawn, and the app's rate limit. An OAuth 2.0 sign-in's `refreshToken` says whether a connect needs a refresh token: `'required'` (the default) refuses one without, and `'optional'` is for an app that may give none, whose connections then work until one minute before their access token ends and then need reconnecting (a grant that gives neither a refresh token nor the token's `expires_in` is refused). `defineApp(entry)` checks one and returns it frozen; a wrong field throws a `TypeError` naming it. A permission's `grants` and each account scope is one scope, with no space or comma, since the scopes an app grants are read split on both. The Google entry is `@kindgi/connections/google` and the GitHub one `@kindgi/connections/github`.
  - **`@kindgi/tools`:** a tool declares the connections it needs in `needsSpec.connections`, by its own name for each: `{ app, permissions, as: 'person' | 'company' }`. The runtime hands it each one's access token and account in `ctx.connections`. A declarative HTTP tool sends one with `authorization: { kind: 'connection', connection }`, as `Authorization: Bearer`, and a `401` answer fails the call with `ConnectionRejectedError` (a tool's own code throws it too, alone or as another error's `cause`), so the runtime renews the token once and runs the call again. `connectionRejectionOf(error)` finds it, up to three causes deep, for a runtime's dispatch and a pack service alike. When the app can't give a token just now, the call fails with `ConnectionRenewError` (`connection-renew-failed`) and the connection stays as it is; one it can't renew at all (no refresh token, or the grant withdrawn) needs reconnecting, and the call waits or is refused as for any such connection. A `connection` authorization must name a declared connection. `ConnectionResolver` is what a runtime's tool dispatch asks for a call's connections: ready, a connect to wait for, or refused.
  - **`@kindgi/specs`:** `tool.schema.json` 1.3.0 has `needsSpec.connections` and the `connection` authorization.
  - **`@kindgi/agents`:** `computeConnectWaitToken({ runId, callId, name })`, the waitpoint token of a call's wait for a connect, and `ConnectWaitResult`.
  - **`@kindgi/api`:** `ConnectionBinding`, the store behind the connections routes, with its records (app registrations, connections, connect requests) and error codes; none carries a token. An approval can carry `approver`, the one member who may decide it, and `connection`, the person's account the call would use. A secret read for a connection names its caller `connections`, in `@kindgi/compliance` too.
- 08dedca: **LinkedIn (posts as a person):** the `linkedin` entry at `@kindgi/connections/linkedin`, for a member's own profile on a company's own LinkedIn app with the two self-serve products (no LinkedIn review), and `linkedinPost` at `@kindgi/connections/linkedin/tools`, included under the id its pack names.
  - The entry signs in with OAuth 2.0 and PKCE, asks for `w_member_social` (in plain words: post, comment and react on LinkedIn as you, and edit or delete what you posted), and learns whose profile it is from OpenID Connect's ID token (`sub`, labelled with the email). LinkedIn has no revoke for one app's tokens and gives refresh tokens only to partners it approves, so the entry takes a connect that brings none (`refreshToken: 'optional'`), and a connection asks its person to connect again just before LinkedIn's 60 days end. A refresh token LinkedIn gives anyway is used. Calls are paced at LinkedIn's 150 a day per member.
  - `linkedinPost` posts text of up to 3,000 characters to the person's own feed, seen by anyone or by their connections only, and gives the post's id and link. The text is posted as written: a `#` that starts a word is written as LinkedIn's hashtag, and the rest of LinkedIn's markup is escaped, so a post mentions no one. It's `mutating`: in a run no person started, each post waits for that person's yes, and a step run again gets the first post's answer.
- 08dedca: **Microsoft (Outlook):** the `microsoft` entry at `@kindgi/connections/microsoft`, and three tools at `@kindgi/connections/microsoft/tools`, each included under the id its pack names: `outlookSend` (plain-text mail as the person, each send in a run no person started waiting for their yes), `outlookMessagesList` (newest first, or a search, in one folder) and `outlookMessageGet` (one message, its body as plain text).
  - An `oauth2` sign-in can name the app's own directory in its URLs (`{tenant}`, once in the authorize and token URLs and at most once in the revoke URL, filled from the registration's `oauth2.tenant`, else `signIn.tenant.default`; Microsoft's entry has no default, so each registration names it), ask for `signIn.scopes` at every sign-in (Microsoft's `offline_access`), and say which resource its granted scopes may be named with (`signIn.scopeResource`, ending in `/`), so they're compared without it, in any case. Each of `signIn.scopes` is one scope, with no space or comma.
  - A new account lookup, `profile`: a GET with the new access token, its id and label read from named fields (Microsoft Graph's `/me`). Each of its `scopes` is one scope too.
  - A rate limit's cost may be 0: that call isn't counted in that limit (Exchange's limit on sends, which reads don't use).
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [68e0d57]
  - @kindgi/tools@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0
