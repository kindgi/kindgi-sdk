---
title: Operate a self-hosted runtime
description: Restart, check, back up, restore and upgrade a self-hosted Kindgi runtime, and rotate its tokens and keys.
sidebar:
  order: 3
---

This page leads to everything you do to keep a self-hosted runtime running,
and says what to check at each upgrade.

These pages continue [Self-host Kindgi](../self-host/): the same containers
(`kindgi-server`, `kindgi-db`, `kindgi-pack`), the same `kindgi.env` and
`pack.env`, and the same pack. Commands that take your API token read it from
`$KINDGI_API_TOKEN`.

- [Restart the runtime and check its health](../restart-and-check-health/):
  a restart that loses no runs, the health routes, the startup log, and where
  errors show.
- [Back up and restore the runtime's database](../back-up-and-restore/):
  `pg_dump`, the keys a restore needs, a restore into a fresh database, and
  replaying erasures after it.
- [Rotate the runtime's tokens and keys](../rotate-keys/): the API token, the
  pack service token, the license key, a signing key and the public run
  token key.
- [Renew the license key](../renew-the-license-key/): by hand or on a
  schedule.
- [Logs](../logs/): the log formats, the levels, and how to follow one
  request.

## Upgrade the runtime

**Upgrade at least every 90 days.** A preview release stops starting 90
days after it was released, and the runtime warns from 30 days before
([Licensing](../../../concepts/licensing/#preview-releases-stop-starting-after-90-days)).
A restart after that day doesn't come back up.

**Before you start, read the upgrade steps of each release you're
upgrading across:** [0.1.10's](../../../releases/0.1.10/#upgrade-steps),
[0.1.9's](../../../releases/0.1.9/#upgrade-steps) and
[0.1.8's](../../../releases/0.1.8/#upgrade-steps) are in their release
notes, and earlier releases' are below.

1. [Back up Postgres.](../back-up-and-restore/#back-up-postgres)
2. Pull the new version, with Docker logged in to `registry.kindgi.com` with your license key ([Pull the runtime image](../pull-the-runtime-image/)), and [restart](../restart-and-check-health/#restart-the-runtime) with it, with the same `kindgi.env`:

   ```sh
   docker pull registry.kindgi.com/kindgi/runtime:<version>
   docker stop -t 30 kindgi-server
   docker rm kindgi-server
   docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
     --add-host registry.localhost:host-gateway \
     -p 127.0.0.1:4000:4000 --env-file kindgi.env \
     registry.kindgi.com/kindgi/runtime:<version>
   ```

When it starts, the runtime brings the database up to date: it applies the migrations the database doesn't have yet, then serves. On a database that has them all, it applies nothing, so a restart on the same version changes nothing. The log doesn't list them: once the `Kindgi API server listening` lines appear, they're done. If one fails, the runtime exits with code 1, and its log says `kindgi-runtime: fatal: Error: migration failed for …` and why.

Migrations only go forward, and an older runtime isn't guaranteed to work on a database a newer one migrated. To go back, [restore the backup](../back-up-and-restore/#restore-into-a-fresh-database) you took before the upgrade, and run the older version on it.

### Checks you can run before upgrading

From 0.1.6, the runtime image runs read-only checks against a database. They read only what the previous release has, so run the new version's image against the database you're about to upgrade, with the same `kindgi.env`:

```sh
docker run --rm --network kindgi --env-file kindgi.env \
  registry.kindgi.com/kindgi/runtime:<version> check provider-keys
```

`registry.kindgi.com` has 0.2.0 and later. For an earlier version, use the
image your server already runs.

Nothing starts and nothing is written, and they print names and ids, never a value. Each exits `0` when it finds nothing, `1` when it lists what it found, and `2` when it can't run. `--tenant <uuid>` checks one tenant; by default they check every tenant in the database.

| Check | What it lists |
| --- | --- |
| `provider-keys` | Each tool version, MCP endpoint and webhook endpoint that names a model provider's key. A model provider's key is used by its provider only, so from 0.1.6 they're refused: a tool's calls fail with `provider-key-refused`, and so do an MCP endpoint's connections and a webhook endpoint's deliveries. For each, store the key it needs under its own name (the same value is fine), name that instead, and deploy or register it again. See [Give a tool a secret](../../../guides/tools/give-a-tool-a-secret/#a-model-providers-key-isnt-a-tools). |
| `secret-scopes` | Each tool version, MCP endpoint and webhook trigger in a project or an org that reads a secret at the tenant, registered by an earlier runtime that didn't record where its secrets are read. They keep reading at the tenant. One a tenant admin registered can stay. Register each other one again so where its secrets are read is recorded: a tool, publish a new version; an MCP endpoint, unregister it and register it again; a webhook trigger, `kindgi webhooks update <trigger-id> --secret=<name>`. The check ends with what to do about each, and also lists an unregistered tool version a flow or agent version still pins. |
| `mcp-header-credentials` | Each MCP endpoint that keeps a credential in plaintext `config.headers` (`X-Api-Key`, `Authorization`, …), registered by an earlier runtime that allowed it. They keep working, and their requests never follow a redirect. For each, store each header's value as a secret, and register the endpoint again with `auth` in place of the header. See [Not in `config.headers`](../../../guides/tools/mcp-servers/#not-in-configheaders). |
| `stored-secrets` | Each live version of a stored secret that doesn't decrypt with the secrets' keys: the KMS key, the runtime's access to it, and the AAD key. Run it after a restore, before the runtime serves, since a restore brings back the database, not the keys. It needs `KINDGI_SECRETS_BACKEND=postgres`. See [Back up and restore](../back-up-and-restore/#restore-into-a-fresh-database). |
| `purged-tenants` | Each tenant marked purged that still holds rows, with each table and its count: rows written after its mark, by work in flight then. Rows only, not the bytes under its prefix. Run it a day after a purge. For each tenant it lists, `kindgi-runtime tenants purge <tenant id> --confirm <its slug>`, with the server's `KINDGI_ARTIFACTS` and `KINDGI_OPENFGA_API_URL`, deletes them and leaves its mark and its record as they were. See [Close and purge a tenant](../serve-many-tenants/#close-and-purge-a-tenant). |

Here `check provider-keys` runs on a 0.1.5 database where a tool and an MCP endpoint name Anthropic's key (exit `1`):

```text
provider-keys: 2 name a model provider's key (1 tenant checked):
  tenant=… mcp-endpoint=acme.docs secret=ANTHROPIC_API_KEY provider=anthropic
  tenant=… tool=acme.summarize@1.0.0 secret=ANTHROPIC_API_KEY provider=anthropic
A model provider's key is used by its provider only: these are refused. For each, store the key it needs under its own name (the same value is fine), name that instead, and deploy or register it again.
```

After each got a key of its own, the same run finds nothing (exit `0`):

```text
provider-keys: nothing names a model provider's key (1 tenant checked).
```

The runtime logs the same at every start, one `WARN` per tool version or endpoint (`docker logs kindgi-server`). Here it's for another tool registered on 0.1.5 with Anthropic's key, `acme.translate`:

```json
{"time":"2026-10-10T10:15:40.130Z","level":"warn","severity":"WARNING","subsystem":"providers.keys","message":"provider-key-declared tenant=… tool=acme.translate@1.0.0 secret=ANTHROPIC_API_KEY provider=anthropic: a model provider's key is used by its provider only, so this tool's calls are refused. Store the key it needs under its own name and use that name","tenantId":"…","kind":"tool","id":"acme.translate","version":"1.0.0","secretName":"ANTHROPIC_API_KEY","providerId":"anthropic"}
```

Here `check mcp-header-credentials` runs on a database with two endpoints registered by an earlier runtime with a key and a secret in `config.headers` (exit `1`). Each line ends with the `auth` that replaces the headers:

```text
mcp-header-credentials: 2 MCP endpoints keep a credential in plaintext config.headers (1 tenant checked):
  tenant=… mcp-endpoint=inventory-legacy headers=X-Api-Key,X-Api-Secret → auth: { scheme: "header", headers: [{ name: "X-Api-Key", secretRef: { envName, name } }, { name: "X-Api-Secret", secretRef: { envName, name } }] }
  tenant=… mcp-endpoint=inventory-moved headers=X-Api-Key,X-Api-Secret → auth: { scheme: "header", headers: [{ name: "X-Api-Key", secretRef: { envName, name } }, { name: "X-Api-Secret", secretRef: { envName, name } }] }
They still work, and their requests never follow a redirect, but each value is stored as given. For each, store the header's value as a secret (kindgi secrets set <NAME> --env=<env> --scope=tenant), then unregister the endpoint and register it again with that auth in place of the header.
```

At every start, the runtime logs one `WARN` per such endpoint:

```json
{"time":"2026-10-10T23:54:31.368Z","level":"warn","severity":"WARNING","subsystem":"mcp.headers","message":"mcp-header-credential tenant=… mcp-endpoint=inventory-legacy headers=X-Api-Key,X-Api-Secret: this endpoint keeps a credential in plaintext config.headers, from before that was refused. It still works, and its requests never follow a redirect. Store each value as a secret, then unregister the endpoint and register it again with auth: { scheme: \"header\", headers: [{ name: \"X-Api-Key\", secretRef: { envName, name } }, { name: \"X-Api-Secret\", secretRef: { envName, name } }] } in place of the header","tenantId":"…","endpointId":"inventory-legacy","headerNames":["X-Api-Key","X-Api-Secret"]}
```

### From 0.1.6 to 0.1.7

The database migrates when 0.1.7 starts. One step adds a check to the table
of trigger fires: Postgres reads the table under a lock while it adds it,
and since fires are kept 30 days, that's short.

#### Security fixes in 0.1.7

- **The server's environment reached model providers' calls.** The model
  SDKs fill options a call leaves out from environment variables. On a
  runtime whose environment set them:
  - `ANTHROPIC_AUTH_TOKEN` was sent as a bearer beside each Anthropic
    provider's own key;
  - `ANTHROPIC_BASE_URL` sent every Anthropic provider's calls, with that
    provider's key, to that address instead of Anthropic's API;
  - `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` went as headers to each
    OpenAI-compatible provider's base URL;
  - `GOOGLE_GENAI_USE_VERTEXAI` (or `GOOGLE_GENAI_USE_ENTERPRISE`) moved a
    Gemini Developer API provider to Vertex AI, in the project the
    environment named.

  0.1.7's adapters set these options themselves, so nothing of the server's
  environment goes out with a provider's call. If your runtime's environment
  set `ANTHROPIC_BASE_URL` to an address you don't fully trust, rotate the
  Anthropic keys of the providers it ran, and `ANTHROPIC_AUTH_TOKEN` too if
  it was set.
- **A tenant's identity provider skipped the egress guard.** The requests to
  a tenant's SSO identity provider (OIDC discovery when the provider is
  registered; the token, JWKS and userinfo requests at sign-in) didn't go
  through `KINDGI_TENANT_HOST_ACCESS`'s checks, as the other hosts tenant
  configuration names do. In 0.1.7 they do, checked at each connection; a
  discovery the guard refuses answers `422 identity-provider-invalid`.
  Origins listed in `KINDGI_AUTH_PRIVATE_IDP_ORIGINS` connect as before
  ([What a tenant can't make the server do](../../../concepts/security/#what-a-tenant-cant-make-the-server-do)).
- **A key could mint a key that outlived it.** A key that expires, even one
  limited to a project, could make a key that never expires, which kept
  working after the first one expired or was revoked. In 0.1.7, from a key
  that expires, a new key needs an `expiresAt` (`--expires` in the CLI) no
  later than it (`403 token-expiry-exceeds-minter`). A console signed in
  with a key mints as that key. The deployment's token, keys without an
  expiry and other sign-ins are unchanged
  ([API keys](../../people-and-keys/#api-keys)).

#### What to check, and what's different

What to check before you upgrade, and what's different after:

- **Rebuild your packs with the 0.1.7 CLI:**
  - **A parameter named `input` is refused** when an agent's instructions
    are defined, as `today`, `now`, `agent`, `conversation` and `settings`
    were. Before, it was accepted, and a turn's structured input silently
    replaced its value. Rename it.
  - **A pack's `providers` declarations are checked against their
    preset:** a preset's own settings are required, and another preset's
    are refused, by the types and by `kindgi dev`, which names whose setting
    it is. In TypeScript, `preset` is one of the preset names
    (`KindgiPresetName`, from `@kindgi/handler-runtime`), so a name computed
    at run time needs `as KindgiPresetName`
    ([Declare them in your pack's config](../../../guides/models/#declare-them-in-your-packs-config)).
- **The runtime image carries the `kindgi` CLI,** which runs the license
  renewal jobs. On linux/amd64 it downloads 290 MB, up from 276 MB.
- **Embedding `@kindgi/agents`:** `AGENTS_MIGRATIONS_DIR` is only on the
  runtime-only subpath `@kindgi/agents/migrations` now, with no alias.
- **The API:**
  - A page cursor a list didn't issue answers `400 bad-input` on the
    agents, flows, policies and eval-suites `/versions` lists and on an
    agent's go-live history, as it does on blocks' and tools' `/versions`.
  - When an admin ends someone's sessions, it shows on that person's
    sign-in history (`GET /v1/audit/sign-ins?userId=`), with `byUserId`
    saying who, and no longer on the admin's.
  - Adding a team member who isn't a person of the tenant, was removed, or
    is named by a malformed id is refused with `404 identity-user-not-found`,
    as adding a project member is. Before, an unknown id was added.
  - A judging rule's results count the runs their corrections come from
    (`runsWithJudgments`).
- **Models:**
  - Claude Haiku 4.5 asks for up to 16,000 output tokens by default in the
    `anthropic` and `bedrock` presets (it was 8,192). A model's
    `maxOutputTokens` is the default cap a call gets when its agent sets
    none, not the model's own limit. A provider you registered from the
    preset by hand keeps 8,192 until you register the preset again
    (`kindgi providers unregister <id>`, then `register --preset=…`); one
    your pack declares updates at the next `kindgi dev` start. An agent with
    its own `maxOutputTokens` isn't affected.
  - A typed agent is told its output's name and JSON Schema from the first
    model call, so most typed turns no longer pay for a repair call.
- **The console:**
  - Its data pages are one kind of table: headers that sort, a search box on
    the lists, a **Columns** menu, and each view kept in the page's address.
    **Show more** reads **Load more** on the answers waiting for a
    correction, and a flow run's row on the Runs page opens to its agent
    turns.
  - On a run's Overview, a step that ended with its run reads **Cancelled**
    ("Stopped: the run failed" in a failed run), and the Journal marks each
    such start
    ([After a cancel](../../../guides/runs/cancel-a-run/#after-a-cancel)).
  - Signing in with an emailed link, or with Google, Microsoft or GitHub,
    returns you to the console page you were opening, and a console link
    without its workspace (`/console/projects/…`) opens in yours.
  - A tenant admin sees a line on every console page from 30 days before
    the license key expires, with how to renew.
- **`kindgi dev`:**
  - **There's one per pack.** A second `kindgi dev` in the same pack exits
    with code 3 ("kindgi dev is already running for this pack") and says
    where the running one is: its process id, the console and the API
    (with `--json`, as `{ "running": {…} }`). Before, it took over the
    first one's runtime. `--reset` and
    `--recreate-services` are refused the same way while one runs
    ([Your coding agent](../../../start/coding-agents/#what-it-runs)).
  - The console works at `localhost`, `127.0.0.1` or `[::1]` on the
    runtime's port. A request from anywhere else is refused, and the refusal
    now names the address to use
    ([Requests from other sites](../../../guides/sso/sessions/#requests-from-other-sites)).
  - It says what it's doing while it starts: pulling the image (with its
    size and progress), starting the container, migrating the database, and
    waiting for it to serve, each with its time.
- **The CLI:**
  - In an app Kindgi was added to, `kindgi init` sets up the tests
    `kindgi test` runs (vitest and vite, and a `vitest.config.mts` that maps
    your tsconfig paths); an app that runs vitest already keeps its own
    setup and is told what to add. It pins zod, vitest and vite exactly when
    your app pins exactly, else as a range.
  - `kindgi doctor` names the config file it found.
  - `kindgi guardrails list --table` prints a table.
  - Printed npm commands read `npx --no -- kindgi …`, so a flag such as
    `--help` reaches Kindgi rather than npx.
  - An app that imports an agent file (for its output schema) builds with
    Next.js or webpack, with no `serverExternalPackages`.
- **Fixed:**
  - **A runtime starting while another serves the same database no longer
    fails** with `enable-rls … deadlock detected`, and the serving one no
    longer answers `500` "Tenant-scoped query failed: deadlock detected". A
    start on an up-to-date database now takes no lock a serving instance's
    writes wait for, so a deploy, restart or scale-up no longer stalls
    writes.
  - **An MCP tool whose name contains `__` can be called.** Two tools that
    would go to the model under one name (`acme.a__b` and `acme.a.b`) are
    refused before the call, naming both: rename one of them.
- **New in 0.1.7:**
  - **Webhook triggers:** a signed request from WooCommerce, Drupal's
    Webhooks module, GitHub, Shopify or any Standard Webhooks sender starts
    a run of a flow, acting as whoever registered the trigger
    (`kindgi webhooks`, and
    `webhooks` in the TypeScript, Python and Java clients;
    [Start runs from WooCommerce, Drupal or any signed webhook](../../../guides/webhooks/start-runs-from-webhooks/)).
  - **A webhook's event, typed:** `parseEvent` in `@kindgi/sdk/webhooks`
    reads the event in a verified request's body, as Python's
    `webhooks.parse_event` does
    ([Verify a webhook](../../../guides/webhooks/verify-a-webhook/#a-receiver)).
  - **An MCP endpoint can sign in** with a user name and password, or with
    OAuth client credentials
    ([Send a credential](../../../guides/tools/mcp-servers/#send-a-credential)).
  - **Azure OpenAI and Amazon Bedrock as model providers,** with the
    `azure-openai` and `bedrock` presets
    ([Presets](../../../guides/models/#presets)).
  - **AWS Secrets Manager** for the secrets set through Kindgi's API
    ([Keep secrets in your own secret manager](../secret-manager/#aws-secrets-manager)).
  - **Azure Container Apps,** from Kindgi's Terraform module
    ([Deploy on Azure Container Apps](../azure-container-apps/)).
  - **A deployment can renew its own license key:** `kindgi license enroll`
    once, then `kindgi license renew` by hand or on a schedule, which the
    Azure module can run for you. It works once access.kindgi.com has it on
    ([Renew the license key](../renew-the-license-key/)).
  - **Where the license stands:** `GET /v1/license` answers its `standing`
    (`valid`, `expiring`, `grace` or `expired`), `daysLeft` and its dates.
    The deployment's token reads all of it. Where the deployment is set up
    to serve one tenant (without `KINDGI_TENANCY=multi`) and its database
    holds only that one, that tenant's admins read the countdown only.
    Anyone else gets `403 license-operator-only`.
  - **A tool's env values in a unit test:** `invokeToolForTest` and
    `toolContextForTest` in `@kindgi/sdk/define` decide them as a run does
    ([Give a tool per-project values](../../../guides/tools/give-a-tool-env-values/#test-it)).
  - **Two templates:** `kindgi init --template=woocommerce`, agents for a
    WooCommerce store, where a larger refund, a price change and publishing
    a product each wait for a person; and `--template=drupal`, agents for a
    Drupal site through its MCP Server, with a review flow a Drupal webhook
    starts.
  - **Coding agents:** a `kindgi-using` skill, with which your coding
    agent guides you in using what was built: the CLI's answer and the
    console page beside it
    ([Your coding agent](../../../start/coding-agents/#skills-loaded-for-the-task)).

#### Known limitations in 0.1.7

- **In a tenant with several projects, flows and agents can use tools,
  agents and other items defined in another project of the same tenant.** Checks inside a
  run (`ctx.authorize`, `can`, `check`) aren't enforced yet; route-level
  permissions are. Until 0.1.8, give project admin roles only to people
  trusted across all of a tenant's projects, or use a separate tenant per
  customer.
- **A project's tools and MCP endpoints use the tenant's secrets.** A secret
  one of them names is looked up at the tenant, whoever registered it. Give
  project admin roles only to people you'd trust with every secret in the
  tenant. 0.1.8 fixes it.
- **A webhook trigger's signing secret is read at the tenant,** in the env
  the runtime serves (`KINDGI_ENV`). Give each trigger's secret a name of its
  own, since triggers that name the same secret share its value, and
  rotating it changes them all. Store it at the tenant in that env, as
  0.1.7's `--generate-secret` does: a secret set only for a project or an
  org isn't read, and every delivery is refused. 0.1.8 fixes it.
- **With authorization on, a runtime whose database user has no `BYPASSRLS`
  (and isn't a superuser) doesn't start.** That's the usual case on a managed
  Postgres. To check, run this as the runtime's database user:

  ```sql
  SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

  If both are `f`, use 0.1.8 or later for production with authorization on:
  0.1.8 fixes it. Without authorization, the runtime starts as before.
- **A tenant SSO sign-in whose identity provider's userinfo request fails**
  (the provider is down, or `KINDGI_TENANT_HOST_ACCESS` refuses its address)
  **ends at an empty 500 page** instead of the sign-in page with an error. No
  session is created. Token and JWKS failures go back to the sign-in page as
  expected.
- **A guardrail whose `scope` lists `flows` never checks a turn,** in those
  flows' steps or anywhere else. A turn doesn't say which flow it runs in,
  so the guardrail skips it without a word: it never blocks, and its outcome
  counts stay at zero. Leave `flows` out of the scope, and run a flow's steps
  with an agent of their own that lists the guardrail. 0.1.8 fixes it
  ([Which agents it covers](../../../guides/guardrails/halt-or-record/#which-agents-it-covers)).
- **Run one runtime instance.** 0.1.6 and 0.1.7 fix the known reasons
  several instances couldn't share a database: boot migrations wait their
  turn, the sign-in limit is shared, guardrail, tool and provider changes
  reach every instance, page cursors work across instances with one
  `KINDGI_PAGINATION_KEY`, and from 0.1.7 a start takes no lock a serving
  instance's writes wait for. Several instances together aren't verified on a
  platform yet, so the Cloud Run module still runs one.

### From 0.1.5 to 0.1.6

The database migrates when 0.1.6 starts.

#### Security fixes in 0.1.6

- **A guardrail could run another tenant's check.** On a runtime serving
  several tenants, a guardrail naming a pack check its own tenant had never
  deployed could run another tenant's check of that id, if that tenant had
  deployed one. 0.1.6 looks a pack check up in the guardrail's own tenant
  only: such a guardrail fails with `unknown-check` every time, and under
  `halt` its turn fails.
- **A model provider's key could reach a tool.** Anyone who could register a
  tool, an MCP endpoint or a webhook endpoint could name a model provider's
  key as its secret, and so hand the key to a pack's code or to another
  server. 0.1.6 refuses that (run `check provider-keys` first, below).
- **Who may correct as a class was shown to every reader.** Anyone who
  could read a judge class, a project viewer included, got the ids of the
  people and service accounts allowed to correct as it. 0.1.6 sends those ids only to
  an admin of the class's scope; everyone else gets their number
  (`assertableBy.principalCount`).
- **A malformed MCP credential could appear in the runtime's log.** An MCP
  endpoint's credential, or a value in its `config.headers`, with a line
  break or a NUL inside it could show up in the sync log, in the error the
  HTTP library raised when it refused the header. 0.1.6 refuses such a value before sending, and its log names
  only the header. A log written before keeps what it wrote: rotate an MCP
  credential that was ever stored with a line break inside it.
- **A secret with a line break could appear in a run's failure message.**
  An HTTP tool's secret, or a model provider's key, containing a line break
  could show up in the error the HTTP library raised when it refused the
  header: for a tool, in the run's failure message and journal, which anyone
  who can read the run sees; for a provider's key, in errors and the logs.
  0.1.6 refuses such a value before sending, and names only the header or the
  provider. A failure message or log line recorded before keeps what it
  recorded: rotate a secret or key that was ever stored with a line break
  anywhere but at its very end (a bearer secret that started with one
  counts). One with only a trailing line break was never affected.
- **The Python SDK held your app on old releases of cryptography.** Its
  `verify` extra (`pip install 'kindgi[verify]'`) capped `cryptography` below
  47. So an app that installed it couldn't take the fix for the OpenSSL
  inside cryptography's wheels
  ([GHSA-537c-gmf6-5ccf](https://github.com/advisories/GHSA-537c-gmf6-5ccf),
  fixed in 48.0.1), nor those for
  [CVE-2026-69247](https://github.com/advisories/GHSA-g6cj-pr64-35w5),
  [CVE-2026-69248](https://github.com/advisories/GHSA-m2h6-j472-rp4c) and
  [CVE-2026-69249](https://github.com/advisories/GHSA-jwv3-5hgf-82ww)
  (fixed in 49.0.0 and 50.0.0). The extra in 0.1.6 requires cryptography
  50.0.0 or later and sets no upper limit, so your app can upgrade it freely.
  The SDK's verifier only checks signatures with a public key. It doesn't
  call the PKCS#7 decryption or X.509 certificate verification those three
  CVEs are in, but the rest of your app shares the cryptography you install.

#### What to check, and what's different

What to check before you upgrade, and what's different after:

- **Run `check provider-keys` before you upgrade** (see
  [Checks you can run before upgrading](#checks-you-can-run-before-upgrading)).
  A model provider's key is now its provider's alone: a tool, an MCP
  endpoint or a webhook endpoint that names one is refused, and so are its
  calls, connections and deliveries
  ([A model provider's key isn't a tool's](../../../guides/tools/give-a-tool-a-secret/#a-model-providers-key-isnt-a-tools)).
- **Expect a slower first start on a large database.** A new index on the
  runs table is built at the first start after the upgrade, without blocking
  writes; the more runs, the longer that start takes.
- **Set `KINDGI_PAGINATION_KEY`.** List cursors are sealed, so they no longer
  show which row they point after. Without a key, a cursor handed out before
  a restart answers `400` after it, and a client starts the list again. More
  than one instance needs the key.
  When you rotate it, keep the old one as `KINDGI_PAGINATION_PREVIOUS_KEY`
  for at least a day.
- **Rebuild your packs with the 0.1.6 CLI:**
  - **Variables your pack doesn't declare no longer reach it.** Before your
    pack's code loads, its service drops every variable the pack doesn't
    declare (`env` in `kindgi.config`, `[tool.kindgi.env]` in
    `pyproject.toml`, `env` in `kindgi.config.json`), except Kindgi's own
    (`KINDGI_*`) and the platform's. A key left in `pack.env` for something
    else no longer reaches your tools. After the upgrade, look in the pack
    service's log for a `WARN` line with `"event":"env-dropped"`. It names each
    variable the service dropped, never its value:

    ```json
    {"time":"2026-10-10T07:01:47.789Z","level":"warn","severity":"WARNING","subsystem":"pack","message":"Dropped 2 variables the pack doesn't declare: ACME_UNDECLARED_KEY, AWS_SECRET_ACCESS_KEY (declare them in the pack's env, or set KINDGI_PACK_ENV_FILTER=off)","event":"env-dropped","kind":"env-dropped","names":["ACME_UNDECLARED_KEY","AWS_SECRET_ACCESS_KEY"]}
    ```

    If your code reads one of them, declare it
    ([Declare the environment your code reads](../../../guides/secrets/pack-env/)).
    To keep the old behaviour meanwhile, set `KINDGI_PACK_ENV_FILTER=off` on
    the pack service. A Python pack's image always names `GPG_KEY`: its base
    image sets it, and nothing reads it.
  - **A tool call has an idempotency key,** `ctx.idempotencyKey`, the same
    every time the same call runs. Pass it to the system a tool writes to, so
    a step that runs again doesn't refund or email twice
    ([Make a side effect happen once](../../../guides/tools/write-a-tool/#make-a-side-effect-happen-once)).
    A pack built before 0.1.6 doesn't get it.
  - **A guardrail that names a built-in check is marked** in the pack's
    index. One from an older CLI gets a warning in the runtime's log each
    time it loads; the built-in still runs. The CLI also warns when a pack's
    check id doesn't start with the pack's id.
  - **A tool whose `needsSpec` schema doesn't compile is refused** when it's
    defined, registered or deployed, instead of being left out at load
    ([Give a tool env values](../../../guides/tools/give-a-tool-env-values/)).
    A union of types (`type: ['string', 'null']`) now compiles everywhere.
- **The API's own OAuth sign-in flow is removed.** Sign-in runs in the
  runtime's browser flow, which is unchanged. `POST /v1/auth/login/…` and
  `POST /v1/auth/callback/…` answer `404`; registering an `oauth2` identity
  provider answers `422` (one stored before still lists); and OIDC
  `allowedRedirectUris` is refused (one stored before still works). The
  TypeScript and Python clients drop `auth.login` and `auth.callback`.
  Sessions no longer hold identity-provider tokens: 0.1.6 clears the ones
  stored.
- **Times are strict.** Every time the API reads, list cursors included, is
  an RFC 3339 time with its zone (`2026-10-09T12:00:00Z`), or Postgres
  `timestamptz` text; anything else, a date alone included, answers
  `400 bad-input`. The CLI's time flags still take a date and send it as
  that day's start in UTC.
- **`member` isn't a project role you can give:** use `viewer`, which it
  always meant. A role given as `member` before still reads back as
  `member`.
- **Approvals and their runs end together**
  ([Decide an approval](../../../guides/approvals/decide-an-approval/)):
  - A reviewer's **withdraw** ends the run waiting on it: its turn fails with
    `hitl-withdrawn`, at once.
  - A run's end withdraws the approvals it **waits on** (a tool call's or a
    turn's), with `withdrawnBecause: run-cancelled` or `run-ended`. An
    approval a run asked for without waiting on it, such as a memory fact's
    review, stays pending.
  - Deciding one whose run has ended answers `409 run-already-terminal`.
  - **After the upgrade,** gate approvals still open (pending, assigned or in
    review) from runs that had already ended or been purged are withdrawn the
    same way, by a pass about once a minute
    per tenant, up to 500 runs each time (in a test, 40 seconds after the
    first start). They leave the reviewer queues with a system actor in the
    audit (`hitl-decision`, `via: run-end`). Deciding one then answers
    `409 approval-terminal`, for a cancelled run and for one that ended
    otherwise:

    ```text
    Approval … was withdrawn: its run was cancelled
    Approval … was withdrawn: its run ended
    ```

    A memory fact's review left open from before stays pending, and can
    still be decided.
- **Who sees whom:**
  - listing a project's members or team grants takes `write` on the
    project, so a viewer no longer sees who else works there;
  - the reviewer roster is for tenant admins and reviewers;
  - re-adding a member with another role answers `409 membership-exists`
    and keeps the role they hold;
  - `409 block-project-mismatch` no longer names the other project.
- **The access audit keeps every refusal of a caller the API knows,** not
  only the authorization model's decisions, except four that don't refuse
  the caller ([The access audit](../../authorization/#the-access-audit)).
  Every secret and env write through the API is in the audit log too,
  never with a value.
- **A turn stops when its run is stopped:** a model or tool call in flight
  is aborted at once on a cancel or a shutdown. A step that writes nothing
  for a while, such as a long model call, stops within
  `KINDGI_RUN_ENDED_CHECK_MS` of a cancel (5 s by default).
- **Cancelling a flow while it runs a loop stops the loop:** no more of its
  steps start after the cancel.
- **Two runtime instances starting at once no longer deadlock or race each
  other on migrations:** one waits until the other's migrations finish. One
  starting beside an instance that's serving writes can still fail (see
  [Known limitations in 0.1.6](#known-limitations-in-016)).
- **Guardrail, tool and provider changes reach every runtime instance** on
  one database at its next turn, with no restart, whichever instance (or a
  plain SQL change) made them.
- **Paging no longer skips or repeats rows recorded in the same millisecond**
  as a page's last row, on the lists that page by time: organizations,
  projects, teams and their members, memory erasures, an agent's go-live history,
  a schedule's fires, cost records, observations, and the versions of agents,
  flows, policies, test cases, blocks and tools.
- **The sign-in options lookup limit holds across instances:** 30 lookups a
  minute per client (`GET /v1/auth/sign-in-options`), counted in Postgres
  rather than by each instance.
- **Safari signs in to `kindgi dev`'s console.** Under `kindgi dev` on
  `http://localhost` or `127.0.0.1`, the session cookie is a plain one,
  since Safari keeps a `Secure` cookie only over `https`. A deployment's
  console still needs `https`.
- **The console's sign-in returns you only to a console page;** a sign-in
  link that pointed elsewhere lands on the console's home.
- **The console has a new look,** light or dark: it follows your system, or
  the one you choose (also in ⌘K). Its links no longer point at an address
  without the tenant while a page loads.
- **Every `/v1` answer says `Cache-Control: no-store`,** errors included, so
  no proxy or browser keeps one tenant's data or shows a kept answer again: a
  `410` for a flow since reinstated no longer outlives a reload
  ([Behind a load balancer or ingress](../self-host/#behind-a-load-balancer-or-ingress)).
- **⌘K and the breadcrumbs reach every project section;** choosing Cost or
  Schedules there used to do nothing.
- **A record opened under another project's address moves to its own
  project** (a run, an approval, an agent and the pages under it, a tool, and
  the like), keeping its tab, instead of showing under the wrong project with
  actions that project then refused. One in a project you can't open says so:
  "This agent belongs to another project, which you can't open. Ask an admin
  of it for access."
- **`kindgi dev` runs your pack's code sandboxed** (macOS Seatbelt; Linux
  bubblewrap, which you may need to install): it can't read your keys or
  files outside the app, write outside it, or reach Docker, and keeps the
  network and the app's own files. On Linux, the UNIX sockets it closes are
  those under the home folder, `/tmp`, `/var/tmp` and `/run`. A tool that
  reads a path or a socket outside the app (`~/.aws`, a local Postgres
  socket) needs it opened in the pack's `dev.sandbox` config. Where it can't run (Windows outside WSL, a
  container, inside another sandbox such as a coding agent's), `kindgi dev`
  warns and runs without it; `KINDGI_DEV_SANDBOX=required` refuses instead
  ([Keep your tools' code away from your keys](../../../guides/secrets/dev-sandbox/)).
- **Under `kindgi dev`, Kindgi keeps the secrets you store in its own
  file,** `.kindgi/secrets.env`, not your app's `.env.local`, and neither
  they nor a model provider's key reach the pack service's environment
  (`kindgi secrets copy` copies keys over;
  [Keep local values in env files](../../../guides/secrets/env-files/)).
- **The CLI:** `kindgi tools versions --include-tombstoned` is now
  `--include-unregistered`, as `blocks` and `flows` say.
- **The clients:** the TypeScript client drops `eventTriggers` and
  `webhooks` and the Python client their resources, which the runtime never
  served (it fires schedules; start a run with `POST /v1/runs`). Python's
  `secrets.rotate` returns its sync or async answer, and `Kindgi()` finds
  its settings when it's first used.
- **Embedding `@kindgi/api`:** `createApp`'s `signingKey` is gone (pass
  `exportSigning`), and so are `refreshToken`, `exchangeCode` and
  `oauthStateStore`. `SignInOptionsRateLimit.store` takes a `RateLimitStore`
  (in memory by default) to share the sign-in lookup limit across instances;
  a store that fails doesn't block sign-in.
- **New in 0.1.6:**
  - **Corrections:** a project's judging rules queue the runs that need a
    person's verdict, results per agent version, and runs on the test cases
    and suggested changes rescored after people correct the new answers
    ([Correct a run's output](../../../guides/evals/judge-a-runs-output/),
    [Improve an agent](../../../guides/evals/improve-an-agent/)).
  - **What failed and why:** a project's failed runs grouped by cause and
    version (`GET /v1/runs/failures`) and a failure's `reason`
    ([See why runs failed](../../../guides/runs/see-why-runs-failed/)), and
    what a suspended run waits for (`waitingFor`). The runs list filters by
    status, time and version ([List runs](../../../guides/runs/list-runs/)).
  - **Guardrail outcomes:** how often each guardrail passed, found
    something, blocked a turn or couldn't run, by agent version
    (`GET /v1/guardrails/{id}/outcomes`).
  - **Approvals:** an `approval.requested` webhook event, email to
    reviewers (`KINDGI_REVIEWER_EMAIL`), and an inbox in one read
    (`--assigned-to=me --order=asc`)
    ([Receive webhooks](../../../guides/webhooks/receive-run-finished/)).
  - **The console:** a reviewer's **Inbox** across projects, where you can
    decide several approvals in one go or by keyboard
    ([Decide an approval](../../../guides/approvals/approvals-reference/#the-inbox)).
    A project gets pages for its failed runs
    ([What failed](../../../guides/runs/list-runs/#what-failed)),
    [schedules](../../../guides/runs/run-on-a-schedule/#in-the-console),
    [flows](../../../guides/flows/write-a-flow/#in-the-console),
    [guardrails](../../../guides/guardrails/write-a-guardrail/#in-the-console) and
    [members](../../authorization/#in-the-console-members), each with a page of
    its own, plus
    [Quality](../../../guides/evals/judging-reference/#in-the-console) for
    correcting runs, and [costs](../../../guides/observability/cost-per-run/#cost-in-the-console)
    for the project and each run. The tenant gets
    [Teams](../../authorization/#in-the-console-teams),
    [Outgoing webhooks](../../../guides/webhooks/webhook-events/#in-the-console),
    [Sign-in](../../../guides/sso/#from-the-console), **My access** and its own
    costs. A page or action shows only to the roles that can use it
    ([The console, by role](../../authorization/#the-console-by-role)).
  - **Access:** who has access to a project and how
    (`GET /v1/projects/{id}/access`), a team's role on a project, what the
    caller may do (`GET /v1/identity/me/permissions`), the people list with
    their grants, and the tenant's sign-in history (`GET /v1/audit/sign-ins`)
    ([Authorization](../../authorization/)).
  - **Sign-in an operator manages alone:** with
    `KINDGI_AUTH_TENANT_PROVIDERS=off`, a tenant can't add, change or
    remove identity providers.
  - **Your own secret manager:** Google Secret Manager, Azure Key Vault or
    HashiCorp Vault (`KINDGI_SECRETS_BACKEND=secret-manager`;
    [Keep secrets in your own secret manager](../secret-manager/)), and on Azure
    a Key Vault key for the database's secrets, Azure Container Registry
    with the server's managed identity, and export signing with a Key Vault
    key ([Export signed evidence](../../../guides/observability/export-signed-evidence/)).
    Retired export keys can stay listed, so older exports still verify.
  - **A tool's secret can be optional**
    ([An optional secret](../../../guides/tools/give-a-tool-a-secret/#an-optional-secret)).
  - **A retired agent, flow, tool or set of test cases can be found and brought back**
    ([Agent and tool versions](../../../guides/agents/agent-and-tool-versions/)).
  - **Schedules** list by project and name their owners.
  - **Coding agents:** `kindgi init` keeps one out of the files that hold
    keys ([Your coding agent](../../../start/coding-agents/)).

#### Known limitations in 0.1.6

- **In a tenant with several projects, flows and agents can use tools,
  agents and other items defined in another project of the same tenant.** Checks inside a
  run (`ctx.authorize`, `can`, `check`) aren't enforced in 0.1.6;
  route-level permissions are. Until 0.1.8, give project admin roles only
  to people trusted across all of a tenant's projects, or use a separate
  tenant per customer.
- **A project's tools and MCP endpoints use the tenant's secrets.** A secret
  one of them names is looked up at the tenant, whoever registered it. Give
  project admin roles only to people you'd trust with every secret in the
  tenant. 0.1.8 fixes it.
- **With authorization on, a runtime whose database user has no `BYPASSRLS`
  (and isn't a superuser) doesn't start.** That's the usual case on a managed
  Postgres. To check, run this as the runtime's database user:

  ```sql
  SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

  If both are `f`, use 0.1.8 or later for production with authorization on:
  0.1.8 fixes it. Without authorization, the runtime starts as before.
- **Run one runtime instance.** 0.1.6 fixes the known reasons several
  instances couldn't share a database: boot migrations wait their turn, the
  sign-in limit is shared, guardrail, tool and provider changes reach every
  instance, and page cursors work across instances with one
  `KINDGI_PAGINATION_KEY`. Several instances together aren't verified yet, so
  the Cloud Run module still runs one.
- **AWS Secrets Manager comes in 0.1.7.** With
  `KINDGI_SECRETS_MANAGER=aws`, a 0.1.6 runtime doesn't start (exit code 2):

  ```text
  KINDGI_SECRETS_MANAGER=aws is reserved: this runtime doesn't support it yet. Currently supported: azure, gcp, vault.
  ```
- **An MCP server's tool whose name contains `__` can't be called.** Kindgi
  names it `<endpoint id>.<tool name>`, and every model adapter turns each
  `.` into `__` for the model and back again on the way in. So a name with a
  `__` of its own comes back wrong: the model is told the agent has no such
  tool (`unresolved-tool`), and the turn fails if it calls it again, or the
  model answers without it.
  Drupal's MCP Server Tool Bridge names its tools this way (`tool_api__…`).
  There's no workaround for a server whose tool names you don't choose:
  0.1.7 fixes it ([From 0.1.6 to 0.1.7](#from-016-to-017)).
- **A runtime starting while another serves the same database can fail to
  start.** Each start applies row-level security to every tenant table
  again, under locks that a write in flight can deadlock with. So a new
  revision starting while the old one still serves, or a second instance,
  can stop at start (exit code 1):

  ```text
  kindgi-runtime: fatal: Error: migration failed for … (…/migrations/): Migration step "enable-rls" failed: deadlock detected
  ```

  Starting it again serves. While it happens, the runtime that's serving can
  answer some writes with `500 internal-server-error`, "Tenant-scoped query
  failed: deadlock detected", and keeps serving (in our test, some project
  creations). This isn't new in 0.1.6: 0.1.7 fixes it
  ([From 0.1.6 to 0.1.7](#from-016-to-017)).

### Runtime 0.1.5.1

Runtime 0.1.5.1 fixes one security bug in 0.1.5 and earlier, for deployments
with authorization on (`KINDGI_OPENFGA_API_URL` set): someone re-added to a
project or a team with a different role silently got that role as well, and
kept it after they were removed. The members list never showed it. Without
authorization, and under `kindgi dev`, nothing is affected. Only the runtime
changes: the 0.1.5 CLI and SDKs (npm, PyPI, Maven Central) stay as they are.

On 0.1.5.1:

- **Removing someone from a project or a team removes the roles they held
  there.**
- **Re-adding someone who's already a member keeps their current role.** To
  give them another, change their role
  ([Project memberships](../../authorization/#project-memberships)). The answer
  to the re-add still echoes the role you asked for (`201`), as the API is
  unchanged in this patch; the members list shows the role they hold.
- **Removing a team's creator ends their team admin,** which they hold
  without a membership row. This matches what the team's members list shows.

Run 0.1.5.1, pulled by its digest, with the same `kindgi.env`. It has no
migration:

```sh
docker pull quay.io/kindgi/runtime:0.1.5.1@sha256:7c1b111ff22091d137f45d9770f6ff9f2521575bf28130957a5db1ce80a2e56e
```

On Cloud Run, copy it into your repository the same way as 0.1.5 (see
[The images into Artifact Registry](../cloud-run/#2-the-images-into-artifact-registry))
and set `server_image` to its digest.

**If you removed someone from a project or a team on an earlier version,
after re-adding them with another role,** they may still hold that role.
Remove them again on 0.1.5.1: the removal now clears it. For a leftover
`owner` on a project, add the person as `owner`, then remove them. 0.1.6
adds a check that finds who needs it.

### From 0.1.4 to 0.1.5

The database migrates when 0.1.5 starts. What to check before you upgrade,
and what's different after:

- **Signing in to the console with an API token is now off by default,
  except in `kindgi dev`.** If people sign in to your console by pasting an
  API token, set `KINDGI_CONSOLE_TOKEN_SIGN_IN=on` on the runtime when you
  upgrade (on Cloud Run, in the module's `server_env`:
  [Turn on sign-in](../cloud-run/#7-turn-on-sign-in)), or set up sign-in
  with your organization's identity provider
  ([Turn on sign-in](../sign-in/)). Otherwise the console's sign-in page
  offers no way in, and the runtime's startup output says so too. API tokens
  keep working for the API, the CLI and the SDKs either way.
- **Reach the console over `https`.** Every way of signing in now ends in a
  session cookie marked `Secure`, which browsers keep only over `https`
  ([MDN: Set-Cookie, `Secure`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#secure)).
  On the machine running Kindgi, Chrome also keeps it at `http://localhost`
  (or `127.0.0.1`); Safari doesn't. At any other plain-`http` address, no
  way of signing in works. Without `KINDGI_PUBLIC_URL`, the runtime also
  accepts the console's changes only from `https`, or `http` on `localhost`
  ([Requests from other sites](../../../guides/sso/sessions/#requests-from-other-sites)).
- **Behind a load balancer or ingress, set `KINDGI_TRUSTED_PROXIES`:** how
  many proxies are in front of the runtime (`1` for one), or their addresses.
  Rate limits and audit records then see each client's own address. Unset,
  the runtime uses the connection's address and ignores `X-Forwarded-For`
  ([Behind a load balancer or ingress](../self-host/#behind-a-load-balancer-or-ingress)).
- **The API token keeps its user across restarts.** Without
  `KINDGI_SEED_USER_ID`, 0.1.4 made a new user at every start; 0.1.5 keeps the
  token's user while `KINDGI_API_TOKEN` stays the same. A changed token acts
  as a new user, and the startup output warns. With authorization on, set
  `KINDGI_SEED_USER_ID` to keep one user across token changes
  ([Point the runtime at it](../../authorization/#point-the-runtime-at-it)).
  Changing `KINDGI_API_TOKEN` also signs out the console sessions the old
  token opened ([Rotate the API token](../rotate-keys/#rotate-the-api-token)).
- **Signing a person out everywhere works.** In 0.1.4,
  `POST /v1/identity/users/<id>/revoke-sessions` answered as if it had, and
  ended nothing. Revoking an API key now ends the console sessions it opened,
  and removing an identity provider ends the sessions opened through it
  ([Signing out](../../../guides/sso/sessions/#signing-out)). The audit trail
  gains `signed-out`, `sessions-revoked` and `sign-in-refused`.
- **Only tenant admins list the tenant's people.** `GET /v1/identity/users`
  answers anyone else `403`; a person still reads their own record and
  sessions. A project admin adds a member by email
  (`POST /v1/projects/<id>/memberships` with `email`), and a project admin's
  member key can manage that project's members.
- **A project editor can start an eval run** (try a version on the test
  cases); it took a project admin. Unregistering or reinstating a version
  of the test cases still does.
- **The cost aggregate counts only what you may read.** Across projects (no
  scope, the tenant, or an org), it counts the projects the caller may read,
  and records with no project; a tenant admin's counts every project. `read`
  on the tenant used to show every project's spend.
- **With authorization on, every route checks what it touches.** Reading
  tenant-wide settings (providers, policies, adapters, capabilities, signing
  keys, deployments, sign-in providers) needs `read` on the tenant, and
  changing them `admin`. Webhook endpoints and compliance evidence need
  `admin`. Starting a run needs `execute` on what it runs, and `write` on a
  project it names. Lists hold only what the caller may read. A single admin
  sees no change ([Authorization](../../authorization/)). Unregistering a
  conversation takes `write` on its project.
- **With authorization on, a permission change that fails no longer holds up
  the others.** In 0.1.4, one could leave a new project unreadable by its
  creator (`403`) until an operator replayed the outbox. 0.1.5 also carries
  the fixes in runtime 0.1.4.1 and 0.1.4.2 (below).
- **An agent, flow, tool or set of test cases stays in the project it was
  first published into.** Publishing a version of one under another project is
  refused with a `409` (`agent-project-mismatch`, `flow-…`, `tool-…`,
  `eval-suite-project-mismatch`), even for an admin of both, and nothing is
  written; 0.1.4 accepted it. A deploy that includes one is refused whole,
  even when it's unchanged. The refusal carries the id, not the other project
  ([Organize work by org and project](../../../guides/projects/organize-by-org-and-project/)).
- **If your Postgres `DateStyle` is `SQL, DMY` or `German`, check the times
  earlier releases saved.** Run `SHOW DateStyle;`
  ([DateStyle](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-DATESTYLE)).
  With either style, earlier releases read a date on the 1st to the 12th of a
  month with day and month swapped, and saved some that way: session expiries,
  approval deadlines and decision times, wait timeouts, schedule fire times,
  memory facts' validity times and stored webhook bodies. A date after the
  12th failed outright. With any other style, a time was read correctly or
  failed outright, so nothing was saved wrong. 0.1.5 reads and writes times
  correctly on any `DateStyle`, but it can't repair a swapped time, which
  looks like a real one.
- **Run OpenFGA v1.22.0.** Published OpenFGA advisories affect v1.9.0
  ([An OpenFGA you already run](../../authorization/#an-openfga-you-already-run)).
- **Expired rows are deleted every hour:** idempotency answers, sessions and
  sign-in state, which 0.1.4 kept for good ([Retention](../../retention/)).
- **Idempotency keys are per caller.** The same key from someone else is
  their own request. A repeat sent while the first request still runs is
  refused (`409 idempotency-key-in-flight`) instead of running again, and the
  answer of a request that made a secret (a new API key, say) isn't kept, so
  its repeat is refused with `idempotency-key-replay-withheld`. Keys 0.1.4
  stored aren't found again; they'd have expired within 24 hours
  ([Retry a start safely](../../../guides/runs/retry-a-start-safely/#how-it-works)).
- **A provider registration the runtime can't build is refused** when it's
  registered (`422 provider-config-invalid`, each problem in
  `details.issues`). `kindgi doctor` names any registered before 0.1.5; to
  fix one, unregister it and register it again
  ([Check a registration](../../../guides/models/#check-a-registration)).
- **A guardrail whose config its pack check would refuse is refused** when
  it's registered (`422 guardrail-config-invalid`), for a pack deployed by
  0.1.5: redeploy your pack once. A guardrail already registered with such a
  config fails every turn it checks; unregister it, and register it again
  with a config that fits
  ([Configure a guardrail](../../../guides/guardrails/configure-a-guardrail/)).
- **A halting guardrail whose check can't run now stops the turn; it used to
  let it through.** That's a check that can't run, for any reason: no check
  by that name is registered, its configuration is invalid, an `llm-judge`
  guardrail's judge can't be routed to a model, or the check throws
  (`check-failed`: pack code that crashed, a pack service that couldn't be
  reached, a judge call that failed). With `halt`, the turn fails with
  `guardrail-violation`, and `evaluationErrors` says which guardrail and why.
  With any other action, the turn goes on; in 0.1.4 a check that threw failed
  the turn whatever the action. Either way, the error is in the run's
  provenance and journal
  ([When the check can't run](../../../guides/guardrails/halt-or-record/#when-the-check-cant-run)).
- **The built-in guardrail checks run.** A guardrail that names one
  (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`,
  `tool-order`, `required-substring`, `forbidden-substring`) runs it, from a
  pack file or `POST /v1/guardrails`. In 0.1.4 it never ran
  ([Use a built-in check](../../../guides/guardrails/use-a-built-in-check/)).
- **A pack can't ship its own guardrail check under a built-in check's id:**
  the runtime runs the built-in for a guardrail naming one, so a pack's
  implementation under that id would be silently replaced. Building the pack
  refuses it with `reserved-check-id` (Python: `DefinitionError`), saying to
  rename the check. Rebuild your packs with the 0.1.5 CLI: a pack built with
  an earlier one that ships such a check runs the built-in instead.
- **Before you upgrade, check every guardrail that names a built-in check.**
  In 0.1.4 such a guardrail never ran. In 0.1.5 the built-ins run and check
  their config, but a guardrail registered before the upgrade isn't checked
  again: if its config doesn't fit the built-in's settings, its check can't
  run at any turn, and with `halt` it blocks every turn of the agents that
  list it. The runtime warns about each one when it loads it:

  ```text
  20:40:17.669 WARN  [guardrails] guardrail config invalid traceId=… tenantId=… guardrailId=acme.tool-budget check=max-tool-calls problems="config must NOT have additional properties" fix="unregister it (kindgi guardrails unregister <id>), then register it again or redeploy, with a config that fits; with several runtime instances, restart the others"
  ```

  List your guardrails (`kindgi guardrails list`), and check each one
  whose `check` is a built-in against
  [its settings](../../../guides/guardrails/use-a-built-in-check/#the-built-in-checks).
  To fix one, unregister it (`kindgi guardrails unregister <id>`), then deploy
  your pack, or register it again, with a config that fits: a deploy doesn't
  change a registered guardrail's config. If you run several runtime
  instances, restart them afterwards (below).
- **The built-in guardrail checks check their config.** A guardrail naming one
  with a config the check doesn't take is refused when it's registered
  (`422 guardrail-config-invalid`, each problem in `details.issues`) or
  deployed (`deployment-validation-failed`); one that still reaches a turn is a
  check that can't run, so a `halt` guardrail stops the turn.
- **A deploy keeps a registered guardrail only if it's the deploy's own:** in
  the project the deploy registers into, with the same definition. A pack
  whose guardrail changed is refused (`409 guardrail-already-registered`):
  unregister the guardrail, and deploy again. A guardrail with that id in
  another project is refused too (`409 guardrail-project-mismatch`, without
  naming the project). Either way nothing is deployed. Both used to pass
  silently, and the old definition stayed in force. An unchanged pack still
  redeploys, from a new image and across releases.
- **The runtime signs exports** (audit bundles, provenance, compliance
  evidence) with the deployment's export key: set
  `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` or
  `KINDGI_EXPORT_SIGNING_KMS_KEY`. 0.1.4's runtime didn't sign them. Without a
  key, outside development, the exports answer `404 signing-not-configured`.
  `kindgi exports verify` also checks audit bundles made with `@kindgi/api`
  0.1.4
  ([Export signed evidence](../../../guides/observability/export-signed-evidence/#give-the-deployment-its-key)).
- **The runtime's own address, `/`, leads to the console,** or lists what it
  serves; it answered `404`. Health checks stay on `/ready`
  ([Check health and logs](../restart-and-check-health/#check-health-and-logs)).
- **The console:** a run whose answer a guardrail blocked shows that answer
  as not sent, with the guardrail; it used to look sent
  ([A halted turn](../../../guides/guardrails/halt-or-record/#a-halted-turn)).
  The dashboard's API keys, Service accounts and People cards open their own
  pages (they opened Deleted data), and ⌘K and the breadcrumbs reach them.
  **Access audit** shows to tenant admins only, the people its API answers.
- **Anthropic retires Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`) on
  2026-11-30. A provider registration that names it should move to
  `claude-sonnet-5-5`, the `anthropic` preset's default. No preset lists it,
  so only a registration made with a spec is affected
  ([Anthropic: model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)).
- **Claude agents use Anthropic's prompt cache:** a turn's later calls read
  the prompt they repeat at a fraction of the input price, and the first
  write costs a little more. Register the `anthropic` preset again for the
  5.5 models' cache-read rate
  ([Prompt caching](../../../guides/models/anthropic/#prompt-caching)).
- **Retrieved memory reaches the model as data,** in a `<memory>` block in a
  user message instead of a second system message, so what models see
  changes. A retrieval that searches by meaning (`semantic`) on a runtime
  without embeddings fails the turn with `semantic-unavailable`; 0.1.4
  skipped that search without a word.
- **`same-user` memory is the run's end user's, never the key's user.** A run
  that names no `participantId` reads no `same-user` memory, isn't offered
  `kindgi_remember`, and its result warns `memory-needs-participant`. Such a
  run used to read and keep that memory as the user its key acts for, so an
  app's service account serving many customers mixed their memory; facts kept
  that way are no longer read as anyone's. Pass the person's `participantId`
  on each run
  ([Give an agent memory](../../../guides/agents/give-an-agent-memory/)).
- **The replays of a run on the test cases run for the past turn's end
  user,** with the same
  tools, `kindgi_remember` included (a replayed one stores nothing). A
  replay's conversation is never recalled as an earlier conversation.
- **Your pack's service writes log records** on stderr, as the runtime does:
  one per tool call, at the levels `KINDGI_LOG_LEVEL` and `KINDGI_LOG_LEVELS`
  set ([Logs](../logs/)). Printing a tool's context (`console.log(ctx)`,
  `print(ctx)`) no longer shows its secrets.
- **A turn's warnings are logged,** at `WARN` under `[runs]`, once per tenant,
  agent and warning while the runtime runs, as well as in the run's result
  ([Logs](../logs/#records-from-a-run)).
- **The clients read every `409` as a conflict** (TypeScript
  `code: 'conflict'`, Python `ConflictError`). Twenty codes used to come back
  as a server error, among them `run-lease-lost`, `agent-version-mismatch` and
  `secret-write-conflict`. Code that matched one of them by its class should
  match its code alone: `err.serverCode` (Python `e.server_code`).
- **TypeScript's `runs.follow` and `runs.followProgress`** follow a run to its
  end, as in Python, which gains `runs.follow` too. `runs.stream` and
  `runs.streamProgress` are deprecated
  ([Follow a run](../../../guides/runs/follow-a-run/)).
- **Paging conversations, approvals and runs no longer skips rows.** A row
  created in the same millisecond as a page's last row (for approvals, at the
  same instant) could be left out of the next page. Cursors you hold keep
  working. A cursor whose time isn't a time is now `400 bad-input` on
  conversations and runs, as it already was on approvals.
- **The CLI:**
  - a usage error (a missing argument, a bad flag value) exits `2`; `1` is
    for a call that failed;
  - `kindgi build` versions each build by its time (`YYYYMMDD.HHMMSS`, UTC),
    so a build without `--artifact-version` and `--published-at` is no
    longer reproducible;
  - `KEY=${KEY}` in a pack's `.env` takes the shell's value, as docker
    compose does; it used to come out empty;
  - `kindgi dev` gives the runtime your Google credentials only when
    `KINDGI_DEV_GOOGLE_CREDENTIALS` names them: a pack that uses Vertex AI
    adds `KINDGI_DEV_GOOGLE_CREDENTIALS=adc` to its `.env`
    ([Gemini on Vertex AI](../../../guides/models/gemini-on-vertex-ai/));
  - `kindgi console` opens the console, and so does `kindgi dev --open`;
  - under `kindgi dev`, **Sign in as seeded user** shows only when the console
    is at a loopback address (`localhost`, `127.0.0.1` or `[::1]`); from
    another address, sign in with the dev token. A deployed console no longer
    asks for it.
- **New in 0.1.5:**
  - **Sign-in** with your organization's identity provider
    ([Set up SSO](../../../guides/sso/)), and with Google, Microsoft or GitHub
    accounts or an emailed link through the deployment's own apps
    ([Turn on sign-in](../sign-in/)).
  - **People, API keys and service accounts:** each person and pipeline acts
    with its own key and grants
    ([People, API keys and service accounts](../../people-and-keys/)).
  - **Schedules:** an agent or a flow at set times, as you, with a history
    of each time it ran ([Run on a schedule](../../../guides/runs/run-on-a-schedule/)).
  - **Memory:** an agent remembers what its declaration allows
    (`kindgi_remember`), with the scope and how long chosen by you, not the
    model, and can recall earlier conversations. Retrieval can search by
    meaning through an embeddings endpoint (`KINDGI_MEMORY_EMBEDDINGS`). A
    tenant admin can erase an end user's words, their conversations and the
    runs that served them (`kindgi memory erasures`).
  - **Improve:** suggest new settings or a new prompt for an agent
    version, try the candidate on the test cases, and make it live through
    the release gate policy where it goes live, after review
    (`kindgi proposals`). Improve can look for better settings on its own,
    and a schedule can start an Improve run.
  - **Files kept with a run** (artifacts) and the capability catalog
    ([Keep files with a run](../../../guides/runs/keep-files-with-a-run/)).
  - **A tool's env values per project** (`ctx.env`)
    ([Give a tool env values](../../../guides/tools/give-a-tool-env-values/)).
  - **A failed run says why, as data:** `failure`, with its `code` and
    `message`, on the run.
  - **Logs:** a pack's service writes log records, `kindgi dev` shows them,
    and records from a run carry its ids; providers and MCP endpoints can opt
    in to the run's trace ([Logs](../logs/)).
  - **Java and Scala, as a preview** (a Java or Scala pack needs Jackson
    2.18 or later in your app, which is Spring Boot 3.4 or later):
    [Quickstart: Java](../../../start/quickstart-java/),
    [Quickstart: Scala](../../../start/quickstart-scala/) and
    [Call Kindgi from a Java app](../../../start/java-app/).
  - **The Cloud Run module:** an image repository you already have, no KMS
    key, calling your app's Cloud Run services from a tool, client
    addresses, and the runtime's own settings for sign-in
    ([Deploy on Google Cloud Run](../cloud-run/)).

#### Known limitations in 0.1.5

- **Safari can't sign in to `kindgi dev`'s console.** The console's sign-in
  is a `Secure` cookie, and Safari doesn't keep one over plain `http`, even at
  `http://localhost`, where Chrome and Firefox do. Open the local console in
  Chrome or Firefox. A fix is planned. A deployment's console needs `https`
  in every browser (above).
- **Run one runtime instance.** Several aren't supported yet (the Cloud Run
  module runs one). For one thing, a guardrail change reaches other instances
  only when they restart: registering, unregistering or deploying a guardrail
  takes effect at once on the instance that took the request, and other
  instances keep the guardrails they had. If you run several anyway, restart
  the others after changing a guardrail. A fix is planned.
- **Cancelling a flow while it runs a loop can let a few more of the loop's
  steps start** before it stops: in our tests up to a few dozen, within
  seconds. The run still ends `cancelled`. A later release fixes it.

### Runtime 0.1.4.2

Runtime 0.1.4.2 fixes one bug in 0.1.4 and 0.1.4.1, for every deployment:
when the database drops its connections (a restart, a failover, a network
blip), the runtime could exit instead of reconnecting. Its log then ends like
this:

```text
file:///app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255
    const x = socket.write(chunk, fn)
                     ^

TypeError: Cannot read properties of null (reading 'write')
    at Immediate.nextWrite (file:///app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255:22)
```

On 0.1.4.2, requests that need the database fail while it's down, and the
runtime keeps running and answers again once it's back. Only the runtime
changes: the 0.1.4 CLI and SDKs (npm, PyPI) stay as they are. `kindgi dev`
keeps its pinned 0.1.4 runtime, so if your local database restarts under it,
restart `kindgi dev`.

Run 0.1.4.2, pulled by its digest, with the same `kindgi.env`. It has no
migration, and it carries 0.1.4.1's fix ([Runtime 0.1.4.1](#runtime-0141)).
Keep `--restart unless-stopped` on the runtime's container either way
([Restart the runtime](../restart-and-check-health/#restart-the-runtime)):

```sh
docker pull quay.io/kindgi/runtime:0.1.4.2@sha256:420826ad9bac0c2fdb021c49517aabebeac1ff7ec236e02af47e90a31f5b825e
```

On Cloud Run, copy it into your repository the same way as 0.1.4 (see
[The images into Artifact Registry](../cloud-run/#2-the-images-into-artifact-registry))
and set `server_image` to its digest.

### Runtime 0.1.4.1

Runtime 0.1.4.1 fixes one bug in 0.1.4, for deployments with authorization on
(`KINDGI_OPENFGA_API_URL` set): a redeploy that published a new version of an
existing agent could leave other permission changes made in the same few
seconds unapplied. A newly published agent or project could then answer `403`
to the person who made it. Without authorization, and under `kindgi dev`, 0.1.4
is unaffected. Only the runtime changes: the 0.1.4 CLI and SDKs (npm, PyPI)
stay as they are.

With authorization on, run 0.1.4.1, pulled by its digest, with the same
`kindgi.env`. It has no migration, so going back to 0.1.4 works, but the bug
comes back with it:

```sh
docker pull quay.io/kindgi/runtime:0.1.4.1@sha256:3f14fcf7336c846b276c6119bc8dc96eaf44faee6dacfd45ba40b2e7c08d555f
```

On Cloud Run, copy it into your repository the same way as 0.1.4 (see
[The images into Artifact Registry](../cloud-run/#2-the-images-into-artifact-registry))
and set `server_image` to its digest.

0.1.4.1 and later don't retry a change 0.1.4 already lost. What comes
back, and when:

- **A project or agent that answered `403`** reads again from the
  upgrade on, since the upgrade restarts the runtime. At every start, the
  runtime writes again the permissions that place each project, agent,
  flow, tool, guardrail and set of test cases of its tenant
  (`KINDGI_TENANT_ID`).
- **The creator's own rights on an agent** come back when a new version of
  it is published on 0.1.4.1 or later.
- **A project membership added while the bug hit** stays missing, through
  restarts and publishes, though the project's member list still shows the
  person. Add them again on 0.1.4.1 or later with the same call
  (`POST /v1/projects/<project-id>/memberships`, see
  [Project memberships](../../authorization/#project-memberships)), and their
  access applies within seconds.

On 0.1.4.1, re-publishing an agent can log a warning like this one:

```text
WARN  [authz.outbox] drain: FGA refused a batch; trying its tuples one by one tenantId=<tenant> rowCount=2 error="cannot write a tuple which already exists: user: 'project:<id>', relation: 'parent', object: 'agent:acme.alpha': tuple to be written already existed or the tuple to be deleted did not exist"
```

It's expected: the runtime then applies the batch's changes one at a time,
and a change that's already there counts as applied. From 0.1.5, with
OpenFGA v1.22.0, the warning doesn't appear: the runtime asks OpenFGA to
ignore changes already in place, and v1.22.0 does, so it takes the batch
whole. With an older OpenFGA that doesn't, the runtime still applies them
one at a time, and logs it at `info`.

### From 0.1.3 to 0.1.4

`kindgi.env` needs no change: the database migrates when 0.1.4 starts. What's different after:

- **Agent versions are pinned.** A version published from 0.1.4 on resolves its tool ranges once, when it's published, and keeps those versions ([Agent and tool versions](../../../guides/agents/agent-and-tool-versions/)). Versions published before have no pins and keep resolving each run. The first `kindgi deploy` after the upgrade registers a pinned next version of each agent, and says so:

  ```text
  agent acme.matcher: registered new version 1.4.1 (1.4.0 was published before pins; 1.4.1 pins its tools); set version: '1.4.1' in acme.matcher to match
  ```

  Set that version in the agent's code. An app that runs an exact version (`agentVersion: '1.4.0'`) keeps running the unpinned one until you change it; an app that runs the latest gets the pinned one.
- **With authorization on** (`KINDGI_OPENFGA_API_URL`), the first start brings each tenant's authorization store up to 0.1.4's model, with a line per store before the banner:

  ```text
  <time> INFO  [authz] tenant 8c3b6779-c02b-47e1-a9e1-4d0cd7f0c5a7: store 01M48C11G6C00WQXYMAJEWH7DW now has the current model (01M48C11V76E0C6APGAKKPRXXK → 01M48C24EGSZQHYJMEE2ZD88S2)
  ```

  Later starts print nothing. A store it can't reach gets a warning instead (`could not bring store … up to the current model`), the runtime starts anyway, and the next start tries again.
- **Deleting an org keeps its record** until a retention policy on `org` purges it. It still answers `404 org-not-found`, its projects and teams stay without an org, and its slug is free at once ([Delete an org](../../../guides/projects/organize-by-org-and-project/#delete-an-org)). 0.1.3 removed the record at once.
- **Unregistering a provider keeps its record** until a retention policy on `provider` purges it; its id is free to register again at once ([List, change and remove](../../../guides/models/#list-change-and-remove)). 0.1.3 removed the record at once.
- **`KINDGI_PUBLIC_URL`** is new: the address clients use when it isn't the one the runtime binds, behind a proxy or a load balancer ([Check it](../self-host/#6-check-it)).
- **The runtime's logs are structured.** Each line is a record with a level and a subsystem: JSON when the output isn't a terminal (as on a server), readable lines on one. `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` choose what's written, and a request's `traceparent` is joined ([Logs](../logs/)).
- **A conversation's turns run the agent version it was opened with.** A turn that names another version is refused (`agent-version-mismatch`); one whose version is no longer registered answers `404` ([A conversation keeps its agent version](../../../guides/agents/conversations/#a-conversation-keeps-its-agent-version)). 0.1.3 ran the current version and refused the turn when it differed.
- **`kindgi runs start` exits `1` for a failed run,** with `Error [<code>]: <message>` naming the error's own code, such as `budget-exceeded` or `model-invocation-failed`. 0.1.3 printed `Error [server]` and exited `0` for a run that failed. A script that checks the exit code now sees the failure; the run itself is still printed on stdout.
- **`dev-echo` says it isn't a real model.** Its answers start with `⚠ dev-echo isn't a real model`, and a turn it answers carries a `dev-echo-not-a-model` warning.
- **On Cloud Run,** the Terraform module pins the version of the secrets' AAD key it reads: add `secrets_aad_key_version` (normally `"1"`) to your `.tfvars` before you apply ([Deploy on Google Cloud Run](../cloud-run/#operate-it)).
- **Gemini 2.5 retires on Vertex AI.** Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20; a turn routed to them fails after. The 0.1.4 `gemini` preset lists `gemini-3.8-flash` with `gemini-3.5-flash-lite` instead ([If you registered Gemini 2.5](../../../guides/models/gemini-on-vertex-ai/#if-you-registered-gemini-25)). The `anthropic` preset adds `claude-haiku-5-5` beside `claude-haiku-4-5`; Anthropic lists each model's status on its [model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) page.
- **Register presets again.** A provider registered from a preset before 0.1.4 keeps what it had: no default model, so an agent that names none gets the first model by name (`claude-haiku-4-5` for `anthropic`); none of the models' temperature and thinking marks; and only the two base prices. Unregister it and register the preset again with the 0.1.4 CLI, or restart `kindgi dev` for one the pack's config declares. `kindgi doctor` warns (`!`) about one that's stale.
- **Each provider can name a default model** (`metadata.defaultModel`): when nothing else decides, an agent gets it rather than the first model by name. Each preset names a mid-priced one, such as `claude-sonnet-5-5` ([How Kindgi picks](../../../guides/agents/choose-a-model/#how-kindgi-picks)).
- **Models that take no temperature get none.** A model registered with `"sampling": false` (the Claude 5.5 and GPT-6 models) is called without one, and the turn carries a `sampling-unsupported` warning instead of failing. A model's `thinking` says how it thinks; thinking counts against its output limit and bills as output ([Temperature and thinking](../../../guides/models/#temperature-and-thinking)).
- **Costs follow what providers bill.** A registration keeps its model's extra rates: cached prompts, cache writes, long prompts and data residency. A long prompt prices the whole call at the long rates (Claude Haiku 5.5 past 100,000 tokens, Gemini 3.1 Pro past 200,000, GPT-6 past 272,000). A rate that isn't a non-negative number is refused when you register. Kindgi's costs stay estimates from published prices; your provider's invoice is what you pay.
- **OpenAI calls use OpenAI's Responses API,** which GPT-6 models need to call tools: agents with tools now work on them. Every call sends `store: false`. An existing OpenAI registration moves over when you upgrade, with nothing to register again; `"api": "chat-completions"` in its `adapter_config` keeps the older API ([OpenAI's own API](../../../guides/models/openai-compatible/#openais-own-api)).
- **Gemini calls retry a temporary failure** (a rate limit `429`, an overloaded model `503`, and the like), three attempts in all, as the Anthropic and OpenAI-compatible adapters already did.
- **A waited start that outlasts the client's timeout** (30 seconds in TypeScript, now settable with `timeoutMs`; 60 seconds in Python) fails on the client without the run's id, and says to start the run in the background and follow it ([Wait for the result](../../../guides/runs/start-a-run/#wait-for-the-result)).
- **In 0.1.2 and 0.1.3, the Python client could start a waited run up to three times** when it outlasted the client's timeout. 0.1.4's client never sends a call again once it may be running: upgrade the client. A start you repeat yourself with the same idempotency key still returns the first run only once the first request has answered ([Retry a start safely](../../../guides/runs/retry-a-start-safely/)).
