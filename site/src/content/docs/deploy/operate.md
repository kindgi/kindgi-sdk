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
docker run -d --name kindgi-server --network kindgi \
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
  Pack service: http://kindgi-pack:8080 — acme-pack (artifact 20261003.1), protocol 2, 3 tools, 1 check
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

## Upgrade the runtime

1. [Back up Postgres.](#back-up-postgres)
2. Pull the new version, and [restart](#restart-the-runtime) with it, with the same `kindgi.env`:

   ```sh
   docker pull quay.io/kindgi/runtime:<version>
   docker stop --time 30 kindgi-server
   docker rm kindgi-server
   docker run -d --name kindgi-server --network kindgi \
     --add-host registry.localhost:host-gateway \
     -p 127.0.0.1:4000:4000 --env-file kindgi.env \
     quay.io/kindgi/runtime:<version>
   ```

When it starts, the runtime brings the database up to date: it applies the migrations the database doesn't have yet, then serves. On a database that has them all, it applies nothing, so a restart on the same version changes nothing. The log doesn't list them: once the `Kindgi API server listening` lines appear, they're done. If one fails, the runtime exits with code 1, and its log says `kindgi-runtime: fatal: Error: migration failed for …` and why.

Migrations only go forward, and an older runtime isn't guaranteed to work on a database a newer one migrated. To go back, [restore the backup](#restore-into-a-fresh-database) you took before the upgrade, and run the older version on it.

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
- **Two models retire.** Anthropic retires `claude-haiku-4-5` on or after 2026-10-15, and Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20; a turn routed to them fails after. The 0.1.4 presets list `claude-haiku-5-5`, and `gemini-3.8-flash` with `gemini-3.5-flash-lite`, instead ([Connect Anthropic](../../guides/models/anthropic/#if-you-registered-it-before-014), [If you registered Gemini 2.5](../../guides/models/gemini-on-vertex-ai/#if-you-registered-gemini-25)).
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
   pnpm exec kindgi build --local --push --env selfhost --artifact-version 20261003.2
   pnpm exec kindgi deploy --env selfhost --token "$KINDGI_API_TOKEN"
   ```

   ```text
     Registering deployment
       ✓ POST /v1/deployments  →  201 Created
         deploymentId:    2a4677f2-5845-4e05-8630-5f0d01972331
         artifactVersion: 20261003.2
   ```

   The artifact version defaults to today's date with `.1`; this example's second release of the day is `.2`.

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
docker run -d --name kindgi-server --network kindgi \
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
