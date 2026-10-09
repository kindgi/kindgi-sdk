---
title: Operate a self-hosted runtime
description: Check, back up, restore and upgrade a self-hosted Kindgi runtime, and rotate its tokens and keys.
sidebar:
  order: 3
---

This page continues [Self-host Kindgi](../self-host/): the same containers (`kindgi-server`, `kindgi-db`, `kindgi-pack`), the same `kindgi.env` and `pack.env`, and the same pack. Commands that take your API token read it from `$KINDGI_API_TOKEN`.

## Restart the runtime

The runtime reads its settings when it starts, so most changes on this page take a restart:

```sh
docker stop --time 30 kindgi-server
docker rm kindgi-server
docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
  --add-host registry.localhost:host-gateway \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  quay.io/kindgi/runtime:0.1.4
```

On a stop, the runtime stops taking requests and gives the runs it's executing up to 7 seconds to finish, then exits with code 0. `--time 30` gives it that time before Docker kills it.

:::caution[Runs in flight]
A run that was executing when the runtime stopped, and didn't finish in time, can be left `running`: nothing resumes it. Cancel it, and start it again:

```sh
pnpm exec kindgi runs cancel <run id> --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
```

To avoid it, restart when no runs are executing.
:::

## Check health and logs

The log lines on this page are in the pretty format. A runtime in a container
logs JSON unless `KINDGI_LOG_FORMAT=pretty` is set; [Logs](../logs/) has both
formats, the levels, and how to follow one request.

```sh
curl -s http://localhost:4000/health
```

```text
{"ok":true}
```

Point a load balancer's health check at `/ready` (or `/health`), not `/`:
`/` leads to the console (a `302`), and without the console it answers `200`
even while the database is down, so a check on `/` would pass a broken
runtime.

`/health` says the process is up. `/ready` says its database answers too, within two seconds. Neither needs a token:

```sh
curl -s http://localhost:4000/ready
```

```text
{"ok":true,"database":"ok"}
```

While Postgres is unreachable, `/ready` answers `503` with `{"ok":false,"database":"unreachable"}`, and `/health` still answers `{"ok":true}`. Use `/ready` for a load balancer's or platform's readiness check. The image's own health check uses it, so `docker ps` shows the runtime's state:

```sh
docker ps --filter name=kindgi-server --format 'table {{.Names}}\t{{.Status}}'
```

```text
NAMES           STATUS
kindgi-server   Up 34 seconds (healthy)
```

`docker ps` shows `(unhealthy)` while the database is down, and the runtime's log says why:

```text
17:37:34.151 WARN  [ready] the database doesn't answer: no answer within 2000 ms
```

A route that reads the database answers `500` and names the cause. With Postgres unreachable, `GET /v1/deployments` answers:

```sh
curl -s http://localhost:4000/v1/deployments -H "authorization: Bearer $KINDGI_API_TOKEN"
```

```text
{"error":{"code":"internal-server-error","message":"Deployment list failed: deployments: Tenant-scoped query failed: host not found (getaddrinfo ENOTFOUND kindgi-db)","requestId":"req-…"}}
```

### The startup log

The runtime prints what it's running with when it starts (`docker logs kindgi-server`; in the JSON format they're the `lines` of its `boot` record). The lines to check after a change:

```text
  Token:   kgi_bt_…65bb (provided)
  …
  Public run tokens: off (no signing key)
  License: Docs example · non-production · until 2026-11-02
  ⚠ The license key expires in 29 days (2026-11-02). Renew it: contact@kindgi.com.
  Env: production (tool secrets resolve in it)
  Tenant host access: deployed (stdio MCP endpoints refused; KINDGI_TENANT_HOST_ACCESS)
  Pack service: http://kindgi-pack:8080 — acme-pack (artifact …), protocol 2, 3 tools, 1 check
```

- **`Token`:** the last four characters of the API token it accepts.
- **`License`:** who the key is for, its kind and its end date. A warning follows within 30 days of the end.
- **`Pack service`:** the pack it reached, with its artifact version. When it can't reach it, a warning takes this line's place, with the reason.

### After a crash

When the runtime comes back after stopping without a shutdown, its sweep
repairs the runs the stop left mid-way
([If the runtime stops](../../concepts/runs/#if-the-runtime-stops)). Each
repair is a line in its log:

```text
<time> INFO  [leases] resuming run <run id> (tenant <tenant id>): its wait resolved and nothing resumed it
<time> INFO  [leases] woke the flow run waiting on child run <run id> …: the child had moved on
<time> INFO  [leases] ended run <run id> …: its parent run had ended
```

### Where errors show

- **A setting the runtime refuses** (a missing license key, or a log setting it can't use): it exits with code 2, and its log says what to fix.
- **A database it can't reach while starting:** it exits with code 1, and its log says which database and why, never the password. Here Postgres wasn't running:

  ```sh
  docker inspect --format '{{.State.ExitCode}}' kindgi-server
  docker logs kindgi-server
  ```

  ```text
  1
  Can't connect to the database at kindgi-db:5432/kindgi: host not found (getaddrinfo ENOTFOUND kindgi-db). Check KINDGI_DATABASE_URL, and that Postgres is up and reachable from here.
  ```

- **Another failure while starting:** it exits with code 1, and the log's first line starts with `kindgi-runtime: fatal:` and ends with the cause.

- **A run that fails:** its `failureMessage`, in `pnpm exec kindgi runs get <run id>`.

## Back up Postgres

The runtime keeps its state in Postgres: deployments, trusted keys, providers, runs and their journals. Back it up with `pg_dump`, while the runtime runs:

```sh
docker exec kindgi-db pg_dump -U kindgi -Fc kindgi > kindgi-backup.dump
```

`-Fc` is pg_dump's custom format, which `pg_restore` reads. The dump holds your runs' inputs and outputs: store it like the database.

If the runtime stores model keys ([Models that need a key](../self-host/#8-add-a-model-and-run-a-flow)), the dump holds them encrypted, but not the keys that open them. Back up the secrets store's keys too, apart from the dump: the AAD key, and the local key (with Google Cloud KMS, that key stays in KMS). A restore needs the same ones. A runtime started with another local key stops with exit code 2:

```text
The secrets' local key changed: tenant 207f5388-1737-45c0-a02c-b5388ca12da0's secrets were stored under local:42080424744213e5, and this key is local:f6bc4a15bef0d446. Start with the key they were stored under (KINDGI_SECRETS_LOCAL_KEY_PATH or KINDGI_SECRETS_LOCAL_KEY).
```

A different AAD key isn't checked when the runtime starts, so keep the two keys together.

## Restore into a fresh database

Start a new Postgres, and restore the backup into it once it accepts connections:

```sh
docker run -d --name kindgi-db-restored --network kindgi \
  -e POSTGRES_USER=kindgi -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=kindgi \
  -v kindgi-db-restored:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

docker exec kindgi-db-restored pg_isready -U kindgi -d kindgi
docker exec -i kindgi-db-restored pg_restore -U kindgi -d kindgi --no-privileges < kindgi-backup.dump
```

`--no-privileges` leaves out the backup's grants. The runtime grants its database role what it needs every time it starts, and a fresh server doesn't have that role yet.

Point the runtime at the new database in `kindgi.env`:

```sh
KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@kindgi-db-restored:5432/kindgi
```

Then [restart the runtime](#restart-the-runtime). A run from before the backup is there:

```sh
pnpm exec kindgi runs get <run id> --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
```

```text
  "status": "completed",
  …
  "output": {
    "reply": "Hello, Ada! It's great to meet you. How can I assist you today?",
    "greeting": "Hello, Ada!"
  }
```

A backup taken before an [erasure](../../guides/agents/erase-a-persons-data/)
brings back what it cleared: replay the erasures next
([Erasures and backups](#erasures-and-backups)).

## Erasures and backups

An erasure keeps no identifier of whom it erased, only a keyed hash in the
erasure ledger, so a replay after a restore can find them again. Give the
runtime the ledger's key:

- **`KINDGI_ERASURE_LEDGER_KEY_PATH`:** the absolute path of a file holding
  32 random bytes (`openssl rand 32`), mode `0600`;
- **or `KINDGI_ERASURE_LEDGER_KEY`:** the same 32 bytes, base64, where secrets
  come as environment variables.

Use the same key on every replica, whatever the secrets backend, and keep it
the same across a restore: losing it means losing replay. Without it,
erasures still run, but each answers with an `erasure-unmatchable` warning,
and a replay can't find whom it erased.

Three places say whether erasures can be replayed:
- **the startup log's `Erasures` line**, with the key:

  ```text
  …
    Erasures: on; the ledger is replayable after a backup restore (key from KINDGI_ERASURE_LEDGER_KEY)
  …
  ```

  and without it:

  ```text
  …
    Erasures: on, but NOT replayable after a backup restore: no KINDGI_ERASURE_LEDGER_KEY, so the ledger can't keep a keyed hash
  …
  ```

- **`/ready`'s `erasures`:** `replayable` or `unreplayable`;
- **`kindgi doctor`'s `erasures` check.** It never fails, since a runtime
  without the key is fine for development. With the key, then without it:

  ```text
  …
    ✓ Erasures: Erasures can be replayed after a backup restore: the runtime has the erasure ledger key.
  …
  ```

  ```text
  …
    – Erasures: Erasures run, but a replay after a backup restore can't find whom they erased: the runtime has no KINDGI_ERASURE_LEDGER_KEY. Fine for development; set it where you run in production.
  …
  ```

Then:

1. **Export the ledger off-box, regularly:** a restore rolls it back with
   everything else.

   ```sh
   kindgi memory erasures export --out=erasures-$(date +%F).json
   ```

2. **After a restore, replay the latest export** before the runtime serves
   anyone. It erases again whoever the restored database holds:

   ```sh
   kindgi memory erasures replay erasures-<date>.json
   ```

   Its answer lists the erasures it `replayed`, the ones it `restored` to the
   ledger, and any it couldn't match (`unmatched`).

Two more things keep erasures complete:

- **End users' ids are opaque:** give `participantId` an id your app uses
  for the person, never an email or a name. Ids stay on records an erasure
  keeps.
- **Postgres can keep a cleared row's old version on disk** until it's
  vacuumed. Where that matters, run `VACUUM` (and `REINDEX` for indexes) on
  the database after erasures.

## Upgrade the runtime

1. [Back up Postgres.](#back-up-postgres)
2. Pull the new version, and [restart](#restart-the-runtime) with it, with the same `kindgi.env`:

   ```sh
   docker pull quay.io/kindgi/runtime:<version>
   docker stop --time 30 kindgi-server
   docker rm kindgi-server
   docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
     --add-host registry.localhost:host-gateway \
     -p 127.0.0.1:4000:4000 --env-file kindgi.env \
     quay.io/kindgi/runtime:<version>
   ```

When it starts, the runtime brings the database up to date: it applies the migrations the database doesn't have yet, then serves. On a database that has them all, it applies nothing, so a restart on the same version changes nothing. The log doesn't list them: once the `Kindgi API server listening` lines appear, they're done. If one fails, the runtime exits with code 1, and its log says `kindgi-runtime: fatal: Error: migration failed for …` and why.

Migrations only go forward, and an older runtime isn't guaranteed to work on a database a newer one migrated. To go back, [restore the backup](#restore-into-a-fresh-database) you took before the upgrade, and run the older version on it.

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
  ([Requests from other sites](../../guides/sso/sessions/#requests-from-other-sites)).
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
  ([Point the runtime at it](../authorization/#point-the-runtime-at-it)).
  Changing `KINDGI_API_TOKEN` also signs out the console sessions the old
  token opened ([Rotate the API token](#rotate-the-api-token)).
- **Signing a person out everywhere works.** In 0.1.4,
  `POST /v1/identity/users/<id>/revoke-sessions` answered as if it had, and
  ended nothing. Revoking an API key now ends the console sessions it opened,
  and removing an identity provider ends the sessions opened through it
  ([Signing out](../../guides/sso/sessions/#signing-out)). The audit trail
  gains `signed-out`, `sessions-revoked` and `sign-in-refused`.
- **Only tenant admins list the tenant's people.** `GET /v1/identity/users`
  answers anyone else `403`; a person still reads their own record and
  sessions. A project admin adds a member by email
  (`POST /v1/projects/<id>/memberships` with `email`), and a project admin's
  member key can manage that project's members.
- **With authorization on, every route checks what it touches.** Reading
  tenant-wide settings (providers, policies, adapters, capabilities, signing
  keys, deployments, sign-in providers) needs `read` on the tenant, and
  changing them `admin`. Webhook endpoints and compliance evidence need
  `admin`. Starting a run needs `execute` on what it runs, and `write` on a
  project it names. Lists hold only what the caller may read. A single admin
  sees no change ([Authorization](../authorization/)).
- **With authorization on, a permission change that fails no longer holds up
  the others.** In 0.1.4, one could leave a new project unreadable by its
  creator (`403`) until an operator replayed the outbox. 0.1.5 also carries
  the fixes in runtime 0.1.4.1 and 0.1.4.2 (below).
- **Run OpenFGA v1.22.0.** Published OpenFGA advisories affect v1.9.0
  ([An OpenFGA you already run](../authorization/#an-openfga-you-already-run)).
- **Expired rows are deleted every hour:** idempotency answers, sessions and
  sign-in state, which 0.1.4 kept for good ([Retention](../retention/)).
- **Idempotency keys are per caller.** The same key from someone else is
  their own request. A repeat sent while the first request still runs is
  refused (`409 idempotency-key-in-flight`) instead of running again, and the
  answer of a request that made a secret (a new API key, say) isn't kept, so
  its repeat is refused with `idempotency-key-replay-withheld`. Keys 0.1.4
  stored aren't found again; they'd have expired within 24 hours
  ([Retry a start safely](../../guides/runs/retry-a-start-safely/#how-it-works)).
- **A provider registration the runtime can't build is refused** when it's
  registered (`422 provider-config-invalid`, each problem in
  `details.issues`). `kindgi doctor` names any registered before 0.1.5; to
  fix one, unregister it and register it again
  ([Check a registration](../../guides/models/#check-a-registration)).
- **A guardrail whose config its pack check would refuse is refused** when
  it's registered (`422 guardrail-config-invalid`), for a pack deployed by
  0.1.5: redeploy your pack once. A guardrail already registered with such a
  config fails every turn it checks; unregister it, and register it again
  with a config that fits
  ([Configure a guardrail](../../guides/guardrails/configure-a-guardrail/)).
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
  ([When the check can't run](../../guides/guardrails/halt-or-record/#when-the-check-cant-run)).
- **The built-in guardrail checks run.** A guardrail that names one
  (`must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`,
  `tool-order`, `required-substring`, `forbidden-substring`) runs it, from a
  pack file or `POST /v1/guardrails`. In 0.1.4 it never ran
  ([Use a built-in check](../../guides/guardrails/use-a-built-in-check/)).
- **A pack can't ship its own guardrail check under a built-in check's id:**
  the runtime runs the built-in for a guardrail naming one, so a pack's
  implementation under that id would be silently replaced. Building the pack
  refuses it with `reserved-check-id` (Python: `DefinitionError`), saying to
  rename the check. Rebuild your packs with the 0.1.5 CLI: a pack built with
  an earlier one that ships such a check runs the built-in instead.
- **The runtime signs exports** (audit bundles, provenance, compliance
  evidence) with the deployment's export key: set
  `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` or
  `KINDGI_EXPORT_SIGNING_KMS_KEY`. 0.1.4's runtime didn't sign them. Without a
  key, outside development, the exports answer `404 signing-not-configured`.
  `kindgi exports verify` also checks audit bundles made with `@kindgi/api`
  0.1.4
  ([Export signed evidence](../../guides/observability/export-signed-evidence/#give-the-deployment-its-key)).
- **The runtime's own address, `/`, leads to the console,** or lists what it
  serves; it answered `404`. Health checks stay on `/ready`
  ([Check health and logs](#check-health-and-logs)).
- **Anthropic retires Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`) on
  2026-11-30. A provider registration that names it should move to
  `claude-sonnet-5-5`, the `anthropic` preset's default. No preset lists it,
  so only a registration made with a spec is affected
  ([Anthropic: model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)).
- **Claude agents use Anthropic's prompt cache:** a turn's later calls read
  the prompt they repeat at a fraction of the input price, and the first
  write costs a little more. Register the `anthropic` preset again for the
  5.5 models' cache-read rate
  ([Prompt caching](../../guides/models/anthropic/#prompt-caching)).
- **Retrieved memory reaches the model as data,** in a `<memory>` block in a
  user message instead of a second system message, so what models see
  changes. A retrieval that searches by meaning (`semantic`) on a runtime
  without embeddings fails the turn with `semantic-unavailable`; 0.1.4
  skipped that search without a word.
- **Your pack's service writes log records** on stderr, as the runtime does:
  one per tool call, at the levels `KINDGI_LOG_LEVEL` and `KINDGI_LOG_LEVELS`
  set ([Logs](../logs/)). Printing a tool's context (`console.log(ctx)`,
  `print(ctx)`) no longer shows its secrets.
- **The clients read every `409` as a conflict** (TypeScript
  `code: 'conflict'`, Python `ConflictError`). Twenty codes used to come back
  as a server error, among them `run-lease-lost`, `agent-version-mismatch` and
  `secret-write-conflict`. Code that matched one of them by its class should
  match its code alone: `err.serverCode` (Python `e.server_code`).
- **TypeScript's `runs.follow` and `runs.followProgress`** follow a run to its
  end, as in Python, which gains `runs.follow` too. `runs.stream` and
  `runs.streamProgress` are deprecated
  ([Follow a run](../../guides/runs/follow-a-run/)).
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
    ([Gemini on Vertex AI](../../guides/models/gemini-on-vertex-ai/));
  - `kindgi console` opens the console, and so does `kindgi dev --open`.
- **New in 0.1.5:**
  - **Sign-in** with your organization's identity provider
    ([Set up SSO](../../guides/sso/)), and with Google, Microsoft or GitHub
    accounts or an emailed link through the deployment's own apps
    ([Turn on sign-in](../sign-in/)).
  - **People, API keys and service accounts:** each person and pipeline acts
    with its own key and grants
    ([People, API keys and service accounts](../people-and-keys/)).
  - **Schedules:** an agent or a flow at set times, as you, with a history
    of each time it ran ([Run on a schedule](../../guides/runs/run-on-a-schedule/)).
  - **Memory:** an agent remembers what its declaration allows
    (`kindgi_remember`), with the scope and how long chosen by you, not the
    model, and can recall earlier conversations. Retrieval can search by
    meaning through an embeddings endpoint (`KINDGI_MEMORY_EMBEDDINGS`). A
    tenant admin can erase an end user's words, their conversations and the
    runs that served them (`kindgi memory erasures`).
  - **Improvement passes:** propose new settings or a new prompt for an
    agent version, compare the candidate on a test set, and promote it
    through the scope's gate after review (`kindgi proposals`). A pass can
    look for better settings on its own, and a schedule can start one.
  - **Files kept with a run** (artifacts) and the capability catalog
    ([Keep files with a run](../../guides/runs/keep-files-with-a-run/)).
  - **A tool's env values per project** (`ctx.env`)
    ([Give a tool env values](../../guides/tools/give-a-tool-env-values/)).
  - **A failed run says why, as data:** `failure`, with its `code` and
    `message`, on the run.
  - **Logs:** a pack's service writes log records, `kindgi dev` shows them,
    and records from a run carry its ids; providers and MCP endpoints can opt
    in to the run's trace ([Logs](../logs/)).
  - **Java and Scala, as a preview:**
    [Quickstart: Java](../../start/quickstart-java/),
    [Quickstart: Scala](../../start/quickstart-scala/) and
    [Call Kindgi from a Java app](../../start/java-app/).
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

- **The built-in guardrail checks don't check their config yet.** A setting
  of the wrong type is ignored: `never-call-tool` with
  `tools: 'my-pack.issue-refund'` (a string, not a list) forbids nothing and
  passes every turn. Copy the shapes in
  [Use a built-in check](../../guides/guardrails/use-a-built-in-check/#the-built-in-checks)
  exactly. A fix is planned.

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
([Restart the runtime](#restart-the-runtime)):

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
  flow, tool, guardrail and test set of its tenant (`KINDGI_TENANT_ID`).
- **The creator's own rights on an agent** come back when a new version of
  it is published on 0.1.4.1 or later.
- **A project membership added while the bug hit** stays missing, through
  restarts and publishes, though the project's member list still shows the
  person. Add them again on 0.1.4.1 or later with the same call
  (`POST /v1/projects/<project-id>/memberships`, see
  [Project memberships](../authorization/#project-memberships)), and their
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

- **Agent versions are pinned.** A version published from 0.1.4 on resolves its tool ranges once, when it's published, and keeps those versions ([Agent and tool versions](../../guides/agents/agent-and-tool-versions/)). Versions published before have no pins and keep resolving each run. The first `kindgi deploy` after the upgrade registers a pinned next version of each agent, and says so:

  ```text
  agent acme.matcher: registered new version 1.4.1 (1.4.0 was published before pins; 1.4.1 pins its tools); set version: '1.4.1' in acme.matcher to match
  ```

  Set that version in the agent's code. An app that runs an exact version (`agentVersion: '1.4.0'`) keeps running the unpinned one until you change it; an app that runs the latest gets the pinned one.
- **With authorization on** (`KINDGI_OPENFGA_API_URL`), the first start brings each tenant's authorization store up to 0.1.4's model, with a line per store before the banner:

  ```text
  <time> INFO  [authz] tenant 8c3b6779-c02b-47e1-a9e1-4d0cd7f0c5a7: store 01M48C11G6C00WQXYMAJEWH7DW now has the current model (01M48C11V76E0C6APGAKKPRXXK → 01M48C24EGSZQHYJMEE2ZD88S2)
  ```

  Later starts print nothing. A store it can't reach gets a warning instead (`could not bring store … up to the current model`), the runtime starts anyway, and the next start tries again.
- **Deleting an org keeps its record** until a retention policy on `org` purges it. It still answers `404 org-not-found`, its projects and teams stay without an org, and its slug is free at once ([Delete an org](../../guides/projects/organize-by-org-and-project/#delete-an-org)). 0.1.3 removed the record at once.
- **Unregistering a provider keeps its record** until a retention policy on `provider` purges it; its id is free to register again at once ([List, change and remove](../../guides/models/#list-change-and-remove)). 0.1.3 removed the record at once.
- **`KINDGI_PUBLIC_URL`** is new: the address clients use when it isn't the one the runtime binds, behind a proxy or a load balancer ([Check it](../self-host/#6-check-it)).
- **The runtime's logs are structured.** Each line is a record with a level and a subsystem: JSON when the output isn't a terminal (as on a server), readable lines on one. `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` choose what's written, and a request's `traceparent` is joined ([Logs](../logs/)).
- **A conversation's turns run the agent version it was opened with.** A turn that names another version is refused (`agent-version-mismatch`); one whose version is no longer registered answers `404` ([A conversation keeps its agent version](../../guides/agents/conversations/#a-conversation-keeps-its-agent-version)). 0.1.3 ran the current version and refused the turn when it differed.
- **`kindgi runs start` exits `1` for a failed run,** with `Error [<code>]: <message>` naming the error's own code, such as `budget-exceeded` or `model-invocation-failed`. 0.1.3 printed `Error [server]` and exited `0` for a run that failed. A script that checks the exit code now sees the failure; the run itself is still printed on stdout.
- **`dev-echo` says it isn't a real model.** Its answers start with `⚠ dev-echo isn't a real model`, and a turn it answers carries a `dev-echo-not-a-model` warning.
- **On Cloud Run,** the Terraform module pins the version of the secrets' AAD key it reads: add `secrets_aad_key_version` (normally `"1"`) to your `.tfvars` before you apply ([Deploy on Google Cloud Run](../cloud-run/#operate-it)).
- **Gemini 2.5 retires on Vertex AI.** Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20; a turn routed to them fails after. The 0.1.4 `gemini` preset lists `gemini-3.8-flash` with `gemini-3.5-flash-lite` instead ([If you registered Gemini 2.5](../../guides/models/gemini-on-vertex-ai/#if-you-registered-gemini-25)). The `anthropic` preset adds `claude-haiku-5-5` beside `claude-haiku-4-5`; Anthropic lists each model's status on its [model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) page.
- **Register presets again.** A provider registered from a preset before 0.1.4 keeps what it had: no default model, so an agent that names none gets the first model by name (`claude-haiku-4-5` for `anthropic`); none of the models' temperature and thinking marks; and only the two base prices. Unregister it and register the preset again with the 0.1.4 CLI, or restart `kindgi dev` for one the pack's config declares. `kindgi doctor` warns (`!`) about one that's stale.
- **Each provider can name a default model** (`metadata.defaultModel`): when nothing else decides, an agent gets it rather than the first model by name. Each preset names a mid-priced one, such as `claude-sonnet-5-5` ([How Kindgi picks](../../guides/agents/choose-a-model/#how-kindgi-picks)).
- **Models that take no temperature get none.** A model registered with `"sampling": false` (the Claude 5.5 and GPT-6 models) is called without one, and the turn carries a `sampling-unsupported` warning instead of failing. A model's `thinking` says how it thinks; thinking counts against its output limit and bills as output ([Temperature and thinking](../../guides/models/#temperature-and-thinking)).
- **Costs follow what providers bill.** A registration keeps its model's extra rates: cached prompts, cache writes, long prompts and data residency. A long prompt prices the whole call at the long rates (Claude Haiku 5.5 past 100,000 tokens, Gemini 3.1 Pro past 200,000, GPT-6 past 272,000). A rate that isn't a non-negative number is refused when you register. Kindgi's costs stay estimates from published prices; your provider's invoice is what you pay.
- **OpenAI calls use OpenAI's Responses API,** which GPT-6 models need to call tools: agents with tools now work on them. Every call sends `store: false`. An existing OpenAI registration moves over when you upgrade, with nothing to register again; `"api": "chat-completions"` in its `adapter_config` keeps the older API ([OpenAI's own API](../../guides/models/openai-compatible/#openais-own-api)).
- **Gemini calls retry a temporary failure** (a rate limit `429`, an overloaded model `503`, and the like), three attempts in all, as the Anthropic and OpenAI-compatible adapters already did.
- **A waited start that outlasts the client's timeout** (30 seconds in TypeScript, now settable with `timeoutMs`; 60 seconds in Python) fails on the client without the run's id, and says to start the run in the background and follow it ([Wait for the result](../../guides/runs/start-a-run/#wait-for-the-result)).
- **In 0.1.2 and 0.1.3, the Python client could start a waited run up to three times** when it outlasted the client's timeout. 0.1.4's client never sends a call again once it may be running: upgrade the client. A start you repeat yourself with the same idempotency key still returns the first run only once the first request has answered ([Retry a start safely](../../guides/runs/retry-a-start-safely/)).

## Rotate the API token

Make a new token, replace `KINDGI_API_TOKEN` in `kindgi.env` with it, and [restart](#restart-the-runtime):

```sh
printf 'kgi_bt_%s\n' "$(openssl rand -hex 32)"
```

The `Token` line in the log now shows the new token's last four characters, and the old token is refused:

```text
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-…"}}
```

`KINDGI_API_TOKEN` is one token: switch your CLI and apps to the new one when you restart.

Console sessions signed in with the old token end at the restart, and people
sign in again. The startup log counts them:

```text
  Signed out: 1 console session an earlier token opened
```

A request with such a session afterwards answers `401`.

## Rotate the pack service token

The runtime and your pack's service share this token. Make a new one:

```sh
openssl rand -base64 32
```

Put it in both files, `KINDGI_PACK_SERVICE_TOKEN` in `pack.env` and in `kindgi.env`. Then restart the pack's service with the same image:

```sh
docker stop --time 30 kindgi-pack
docker rm kindgi-pack
docker run -d --name kindgi-pack --network kindgi --env-file pack.env \
  registry.localhost:5050/acme-pack@sha256:<your pack's digest>
```

And [restart the runtime](#restart-the-runtime). While the two tokens differ, the pack's service refuses the runtime's calls, and your tools fail. The runtime's log says so:

```text
  ⚠ Pack service at http://kindgi-pack:8080 isn't answering (pack-service-unauthorized: The pack service rejected the pack token). The server is up; pack tools and checks fail until it answers.
```

Once both sides have the same token, the runtime's calls go through again, with no further restart.

## Rotate the license key

Replace `KINDGI_LICENSE_KEY` in `kindgi.env` with the new key, [restart](#restart-the-runtime), and check the `License` line in the log:

```text
  License: Docs example · non-production · until 2026-11-02
```

## Rotate a signing key

Rotate under a new key id. A key id stays bound to its public key, and a revoked id can't be trusted again.

1. Create a key, and trust it:

   ```sh
   pnpm exec kindgi key create acme-selfhost-2 --env selfhost
   pnpm exec kindgi key trust acme-selfhost-2 --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
   ```

2. Sign your next release with it. In the `selfhost` block of `kindgi.config.ts`:

   ```ts
   signingKey: '~/.kindgi/keys/acme-selfhost-2.pem',
   signerKeyId: 'acme-selfhost-2',
   ```

   Then build and deploy as usual, and run the new image as your pack's service ([step 4](../self-host/#4-run-your-packs-service)). The first line keeps the old key's envelope, to check the revocation below:

   ```sh
   cp .kindgi/build/deploy-envelope.json old-envelope.json
   pnpm exec kindgi build --local --push --env selfhost
   pnpm exec kindgi deploy --env selfhost --token "$KINDGI_API_TOKEN"
   ```

   ```text
     Registering deployment
       ✓ POST /v1/deployments  →  201 Created
         deploymentId:    3c4f4d76-f4a4-4d5f-8339-f05b0497b462
         artifactVersion: 20261008.193855
   ```

   The artifact version defaults to the build time, `YYYYMMDD.HHMMSS` in UTC, so a second build the same day gets its own tag.

3. Revoke the old key:

   ```sh
   pnpm exec kindgi key revoke acme-selfhost --reason "rotated to acme-selfhost-2" \
     --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
   ```

   ```text
     ✓ Revoked acme-selfhost
   ```

   A revoked id can't be trusted again: `kindgi key trust` says so, and how to
   trust another key.

From then on, the runtime refuses a deploy signed by the old key. Here, an envelope it signed earlier:

```sh
pnpm exec kindgi deploy --env selfhost --from-envelope old-envelope.json \
  --idempotency-key redeploy-old --token "$KINDGI_API_TOKEN"
```

```text
  Registering deployment
    ✗ POST /v1/deployments  →  HTTP 403
      code:    signer-not-trusted
      message: Signer key "acme-selfhost" is not on this tenant's trust list
```

Without `--idempotency-key`, the CLI's key is a hash of the envelope. Sending an envelope you already deployed then returns the first answer again (for 24 hours), and deploys nothing.

The runtime checks signatures when you deploy. A deployment the revoked key signed keeps running, through restarts too. The revoked key stays listed for audit:

```sh
curl -s "http://localhost:4000/v1/signing-keys?includeRevoked=true" -H "authorization: Bearer $KINDGI_API_TOKEN"
```

Each key in the list has its `revokedAt` and `revokedReason`, if it was revoked.

## Rotate the public run token key

If browsers [follow runs](../../guides/runs/follow-from-the-browser/), the runtime signs their public run tokens with a key of its own. Make one:

```sh
openssl genpkey -algorithm ed25519 -out public-token-signing.pem
chmod 600 public-token-signing.pem
```

Give it to the runtime as a file: add this line to `kindgi.env`, and [restart](#restart-the-runtime) with the file mounted:

```sh
KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH=/etc/kindgi/public-token-signing.pem
```

```sh
docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
  --add-host registry.localhost:host-gateway \
  -v "$PWD/public-token-signing.pem:/etc/kindgi/public-token-signing.pem:ro" \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  quay.io/kindgi/runtime:0.1.4
```

The file must have mode 0600, and the runtime's user in the container (uid 10001) must be able to read it. The log says:

```text
  Public run tokens: on (browsers follow runs; no CORS origins)
```

To rotate it, replace the file with a new key (the same two commands), and restart with the same mount. Tokens signed with the old key are refused from then on:

```text
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-…"}}
```

Tokens minted after the restart work as before.
