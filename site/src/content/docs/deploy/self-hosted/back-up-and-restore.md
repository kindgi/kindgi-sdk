---
title: Back up and restore the runtime's database
description: Back up a self-hosted Kindgi runtime's Postgres and the keys its secrets need, restore it into a fresh database, and replay erasures after a restore.
sidebar:
  order: 3.3
---

This guide backs up a self-hosted runtime's database and restores it into a
fresh one, with every erasure still in force.

## Before you start

- **A runtime running as [Self-host Kindgi](../self-host/) sets it up:** the
  `kindgi-server` and `kindgi-db` containers, on the `kindgi` network, with
  `kindgi.env`.
- **Docker**, on the machine that runs the containers.
- **`KINDGI_API_TOKEN` exported in your shell** as the runtime's API token,
  where the `kindgi` commands read it, and **`DB_PASSWORD`** set to the
  database password from `kindgi.env`.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## Back up Postgres

The runtime keeps its state in Postgres: deployments, trusted keys,
providers, runs and their journals. A backup lets you restore all of it.

Dump the database with `pg_dump`, while the runtime runs:

```sh
docker exec kindgi-db pg_dump -U kindgi -Fc kindgi > kindgi-backup.dump
```

- `-U kindgi` connects as the database's user.
- `-Fc` writes pg_dump's custom format, which `pg_restore` reads.
- The last `kindgi` is the database to dump.

It prints nothing, and writes `kindgi-backup.dump`. The dump holds your
runs' inputs and outputs, so store it like the database.

If the runtime stores model keys, as
[Models that need a key](../self-host/#8-add-a-model-and-run-a-flow)
describes, the dump holds them encrypted, but not the keys that open them.
Back up the secrets store's keys too, apart from the dump: the AAD key, and
the local key. With Google Cloud KMS, the local key stays in KMS. A restore
needs the same keys. A runtime started with another local key stops with
exit code 2:

```text
The secrets' local key changed: tenant 207f5388-1737-45c0-a02c-b5388ca12da0's secrets were stored under local:42080424744213e5, and this key is local:f6bc4a15bef0d446. Start with the key they were stored under (KINDGI_SECRETS_LOCAL_KEY_PATH or KINDGI_SECRETS_LOCAL_KEY).
```

A different AAD key isn't checked when the runtime starts, so keep the two
keys together, and check them after a restore, before the runtime serves.

## Restore into a fresh database

A restore brings the runtime back to the moment of the backup, on a database
of its own.

Start a new Postgres, and restore the backup into it once it accepts
connections:

```sh
docker run -d --name kindgi-db-restored --network kindgi \
  -e POSTGRES_USER=kindgi -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=kindgi \
  -v kindgi-db-restored:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

until docker exec kindgi-db-restored pg_isready -h 127.0.0.1 -U kindgi -d kindgi; do sleep 1; done
docker exec -i kindgi-db-restored pg_restore -U kindgi -d kindgi --no-privileges < kindgi-backup.dump
```

- `kindgi-db-restored` is the new database's container, with a volume of the
  same name for its data.
- `pgvector/pgvector:pg16` is Postgres 16 with the `vector` extension the
  runtime needs.
- The `until` loop runs `pg_isready` each second until the new Postgres
  accepts connections. `-h 127.0.0.1` asks over TCP: while the image sets up
  the new database, Postgres answers only on its local socket, then
  restarts.
- `--no-privileges` leaves out the backup's grants. The runtime grants its
  database role what it needs every time it starts, and a fresh server
  doesn't have that role yet.

`docker run -d` prints the new container's id. `pg_isready` prints
`no response` until Postgres is up. `pg_restore` then reports one error, and
exits `1`:

```text
09760d6e9bf5d2818925e52d5c0d30aae9b1b608458494784cbc738454df0e64
127.0.0.1:5432 - no response
…
127.0.0.1:5432 - accepting connections
pg_restore: error: could not execute query: ERROR:  role "…" does not exist
Command was: CREATE POLICY tenant_rows ON public.auth_sso_providers TO … USING (…) WITH CHECK (…);


pg_restore: warning: errors ignored on restore: 1
```

The error comes from the one policy in the backup that names the runtime's
database role, which the fresh server doesn't have yet. Everything else is
restored. The runtime makes the role, and that policy, when it starts on the
new database.

Point the runtime at the new database in `kindgi.env`, where `<DB_PASSWORD>`
is the database password:

```sh
KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@kindgi-db-restored:5432/kindgi
```

Before the runtime serves it, check that the secrets' keys open the secrets
the backup brought back. The check reads the database with the settings in
`kindgi.env`, and starts nothing. If the keys are in files, mount them as the
server has them:

```sh
docker run --rm --network kindgi --env-file kindgi.env \
  quay.io/kindgi/runtime:<version> check stored-secrets
```

It decrypts each live version of every stored secret, and prints ids and
counts, never a value. When each one decrypts, it exits `0`:

```text
KMS probe OK (libsodium): chacha20-poly1305-node (0ms)
stored-secrets: every stored secret decrypts, 2 versions (1 tenant checked):
  tenant f2885e16-4039-44b4-a5f9-321b39e06dbe: 2 versions decrypt
```

With another AAD key than the one the secrets were written with, it names
each version a read would fail on, and exits `1`. A KMS key that can't open
them is named the same way, with the KMS's code:

```text
KMS probe OK (libsodium): chacha20-poly1305-node (0ms)
stored-secrets: 2 of 2 stored secret versions don't decrypt (1 tenant checked):
  tenant f2885e16-4039-44b4-a5f9-321b39e06dbe: 0 of 2 versions decrypt
    secret 0491be6e-cf77-435e-9a01-74fe5407ee03 version 1 (key local:d639cc713bfa3041): its AAD doesn't match: the AAD key isn't the one it was written with, or its row changed since
    secret afe8ad9d-07c7-4b7e-b8fb-df8173f27211 version 1 (key local:d639cc713bfa3041): its AAD doesn't match: the AAD key isn't the one it was written with, or its row changed since
A read of each version named fails. Check that the KMS key, the runtime's access to it, and KINDGI_SECRETS_AAD_KEY are the ones those secrets were written with: a restore brings back the database, not the keys.
```

Set the keys the secrets were written with, and check again. Without
`KINDGI_SECRETS_BACKEND=postgres`, the runtime stores no secrets, and the
check exits `2`.

Then [restart the runtime](../restart-and-check-health/#restart-the-runtime).
A run from before the backup is there, where `<run id>` is its id:

```sh
npx --yes @kindgi/cli@0.2 runs get <run id> --url http://localhost:4000
```

```text
  "status": "completed",
  …
  "output": {
    "reply": "Hello, Ada! It's great to meet you. How can I assist you today?",
    "greeting": "Hello, Ada!"
  }
```

A backup taken before an [erasure](../../../guides/agents/erase-a-persons-data/)
brings back what it cleared. Replay the erasures next, as
[Erasures and backups](#erasures-and-backups) shows. To look at the restored
database first, without anything running on its own, start the runtime with
[`KINDGI_PASSIVE=on`](#look-at-a-restored-copy-before-it-serves-kindgi_passive).

## Erasures and backups

An erasure keeps no identifier of whom it erased, only a keyed hash in the
erasure ledger. With the ledger's key, a replay after a restore can find
them again.

Give the runtime the ledger's key, in one of two ways:

- **`KINDGI_ERASURE_LEDGER_KEY_PATH`:** the absolute path of a file holding
  32 random bytes, mode `0600`. `openssl rand 32` makes them.
- **`KINDGI_ERASURE_LEDGER_KEY`:** the same 32 bytes, base64, where secrets
  come as environment variables.

Use the same key on every replica, whatever the secrets backend, and keep it
the same across a restore: losing it means losing replay. Without it,
erasures still run, but each answers with an `erasure-unmatchable` warning,
and a replay can't find whom it erased.

Three places say whether erasures can be replayed:

- **The startup log's `Erasures` line.** With the key:

  ```text
  …
    Erasures: on; the ledger is replayable after a backup restore (key from KINDGI_ERASURE_LEDGER_KEY)
  …
  ```

  Without it:

  ```text
  …
    Erasures: on, but NOT replayable after a backup restore: no KINDGI_ERASURE_LEDGER_KEY, so the ledger can't keep a keyed hash
  …
  ```

- **`/ready`'s `erasures`:** `replayable` or `unreplayable`.
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

1. **Export the ledger off-box, regularly.** A restore rolls the ledger back
   with everything else:

   ```sh
   npx --yes @kindgi/cli@0.2 memory erasures export --out=erasures-$(date +%F).json
   ```

   `--out` is the file it writes. `$(date +%F)` names it with the date of the
   export. It prints, as JSON, the file it `wrote` and how many `erasures` it
   holds:

   ```json
   {
     "wrote": "erasures-2026-10-12.json",
     "erasures": 1
   }
   ```

2. **After a restore, replay the latest export** before the runtime serves
   anyone. It erases again whoever the restored database holds:

   ```sh
   npx --yes @kindgi/cli@0.2 memory erasures replay erasures-<date>.json
   ```

   `erasures-<date>.json` is the latest export. Its answer sorts the
   export's erasures three ways:

   - `replayed`: the database held someone they erased, and the replay
     erased them again.
   - `restored`: put back in the ledger only, with nothing to erase.
   - `unmatched`: the ones it couldn't match.

   Here, the backup held a fact about the end user `end-7` from before their
   erasure, and the replay erased it again:

   ```json
   {
     "replayed": [
       "9e1e3253-d3a1-4c25-a0d4-020696e32125"
     ],
     "restored": [],
     "unmatched": []
   }
   ```

### Copies the runtime keeps on its own

The runtime can also keep copies of the ledger itself, every tenant's at
once. That suits a runtime that serves several tenants, where no one admin
can export them all:

- **`KINDGI_ERASURE_LEDGER_EXPORT`:** where. Either `local:<absolute dir>`, or
  `gcs:<bucket>[/<prefix>]` through Application Default Credentials. Creating
  objects is all it needs (`roles/storage.objectCreator` on the bucket).
- **`KINDGI_ERASURE_LEDGER_EXPORT_INTERVAL_MS`:** how often. Default an hour.
  Under a minute, or set without `KINDGI_ERASURE_LEDGER_EXPORT`, and the
  runtime refuses to start. An erasure made after both the last copy and the
  restore point is in neither, so this is the most a restore can miss.

**What each copy is:**
- one file, `erasure-ledger-<YYYYMMDD>-<digest>.json`, holding every tenant's
  ledger: keyed hashes only, never whom an erasure names;
- every tenant marked purged, by its id and when it was created (runtime
  0.1.10 or later). A runtime that serves one tenant names only that tenant,
  even on a database others share;
- a new one is written when the ledger changes or a tenant is purged, and at
  least one a day;
- none is ever overwritten or deleted, so keep them longer than your
  backups (a bucket's lifecycle rule, say).

The startup log has an `Erasure ledger:` line naming where and how often.

**After a restore,** before the runtime serves anyone, replay the newest copy
with the runtime image's own command and the runtime's settings. Self-hosted,
with Docker:

```sh
docker run --rm --network kindgi --env-file kindgi.env \
  -v /var/lib/kindgi/erasure-ledger:/erasure-ledger:ro \
  quay.io/kindgi/runtime:<version> erasures replay --from local:/erasure-ledger
```

- **`--from`** takes a directory (`local:<dir>`, mounted into the container
  as above), a bucket (`gcs:<bucket>[/<prefix>]`), or one file by its
  absolute path.
- **From a bucket, replay reads it:** it lists and downloads, so whatever
  runs it needs read access (`roles/storage.objectViewer`), which the
  runtime's own writing identity doesn't have. In a container elsewhere, that
  means Google credentials inside it. On Google Cloud, run it as a Cloud Run
  job with the runtime image and a service account that can read the bucket.
- **Which copy:** the one whose pass started last, by what the file says,
  never by when it was written or copied. Two replicas' passes can overlap.
- **How it runs:** it starts its own passive server on 127.0.0.1 (below),
  replays each tenant's erasures, and clears what they name before it stops.
  A replayed erasure is done before anything serves. A tenant in the copy
  that the database doesn't have is skipped, and named.
- **What it prints:** per tenant, how many erasures it replayed and how many
  it only restored to the ledger (nothing of theirs was there). Then how many
  of the replayed ones it cleared. Ids and counts only, never whom an
  erasure names.
- **Exit `1`:** an erasure was hashed under a ledger key this runtime doesn't
  hold (set the key it was made with, and replay again), or one isn't done by
  `--timeout` (seconds, default 600). Exit `2` when it can't run.

**Then purge the purged tenants again** (runtime 0.1.10 or later). A backup
from before a tenant's purge brings the tenant back with its data, and replay
doesn't purge it. Before the runtime serves anyone, run
[`kindgi-runtime tenants repurge`](../serve-many-tenants/#after-a-restore-tenants-repurge)
with `--ledger` where the copies are (`KINDGI_ERASURE_LEDGER_EXPORT` by
default). The newest copy names every
tenant purged before it was written, even one whose purge record is gone.

`erasures export --out <local:<dir> | gcs:<bucket>[/<prefix>]>` writes a copy
now, before an upgrade say, and says what it holds (`already there:` in
place of `wrote` when a copy holding the same is there):

```text
erasures export: wrote erasure-ledger-<YYYYMMDD>-<digest>.json (2 tenants, 3 erasures, 1 purged tenant)
```

The server logs each copy it writes the same way, as
`erasure ledger exported: <file> to <where> (…)`.

### Look at a restored copy before it serves: `KINDGI_PASSIVE`

`KINDGI_PASSIVE=on` starts a runtime that does nothing on its own:
- none of its background work starts: schedules and event triggers, runs
  resumed or swept, webhook deliveries, sending permission changes to
  OpenFGA, the sweeps, erasures, the ledger's copies;
- it connects no MCP endpoint at startup;
- it sends no email.

So a restored database can be inspected without a schedule firing, a
webhook going out, or a run calling your tools.
- **Requests are still served,** and a run started through the API still
  runs, so keep a passive runtime where only you can reach it.
- **It says so:** the startup log has a `⚠ Passive (KINDGI_PASSIVE=on)`
  line, and `/ready` answers `"passive": true`.

Two more things keep erasures complete:

- **End users' ids are opaque:** give `participantId` an id your app uses
  for the person, never an email or a name. Ids stay on records an erasure
  keeps.
- **Postgres can keep a cleared row's old version on disk** until it's
  vacuumed. Where that matters, run `VACUUM` on the database after
  erasures, and `REINDEX` for its indexes.

## Next

- [Restart the runtime and check its health](../restart-and-check-health/)
- [Erase a person's data](../../../guides/agents/erase-a-persons-data/)
- [Retention](../../retention/)
- [Operate a self-hosted runtime](../operate/)
