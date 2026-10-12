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

1. [Back up Postgres.](../back-up-and-restore/#back-up-postgres)
2. Pull the new version, and [restart](../restart-and-check-health/#restart-the-runtime) with it, with the same `kindgi.env`:

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

Migrations only go forward, and an older runtime isn't guaranteed to work on a database a newer one migrated. To go back, [restore the backup](../back-up-and-restore/#restore-into-a-fresh-database) you took before the upgrade, and run the older version on it.

Each release's changes, and the steps to upgrade to it, are in the [release notes](../../releases/).

### Checks you can run before upgrading

The runtime image runs read-only checks against a database. They read only what the previous release has, so run the new version's image against the database you're about to upgrade, with the same `kindgi.env`:

```sh
docker run --rm --network kindgi --env-file kindgi.env \
  quay.io/kindgi/runtime:<version> check provider-keys
```

Nothing starts and nothing is written, and they print names and ids, never a value. Each exits `0` when it finds nothing, `1` when it lists what it found, and `2` when it can't run. `--tenant <uuid>` checks one tenant; by default they check every tenant in the database.

| Check | What it lists |
| --- | --- |
| `provider-keys` | Each tool version, MCP endpoint and webhook endpoint that names a model provider's key. A model provider's key is used by its provider only, so they're refused: a tool's calls fail with `provider-key-refused`, and so do an MCP endpoint's connections and a webhook endpoint's deliveries. For each, store the key it needs under its own name (the same value is fine), name that instead, and deploy or register it again. See [Give a tool a secret](../../guides/tools/give-a-tool-a-secret/#a-model-providers-key-isnt-a-tools). |

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

The runtime logs the same at every start, one `WARN` per tool version or endpoint (`docker logs kindgi-server`). Here it's for another tool that was registered with Anthropic's key, `acme.translate`:

```json
{"time":"2026-10-10T10:15:40.130Z","level":"warn","severity":"WARNING","subsystem":"providers.keys","message":"provider-key-declared tenant=… tool=acme.translate@1.0.0 secret=ANTHROPIC_API_KEY provider=anthropic: a model provider's key is used by its provider only, so this tool's calls are refused. Store the key it needs under its own name and use that name","tenantId":"…","kind":"tool","id":"acme.translate","version":"1.0.0","secretName":"ANTHROPIC_API_KEY","providerId":"anthropic"}
```
