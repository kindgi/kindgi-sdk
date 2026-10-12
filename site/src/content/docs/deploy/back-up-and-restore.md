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
- **`KINDGI_API_TOKEN` set in your shell** to the runtime's API token, and
  **`DB_PASSWORD`** to the database password from `kindgi.env`.
- **For `kindgi` commands:** your pack's directory, with Kindgi 0.1's CLI.

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
keys together.

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

The error is the one policy in the backup that names the runtime's database
role, which the fresh server doesn't have yet. Everything else is restored.
The runtime makes the role, and that policy, when it starts on the new
database.

Point the runtime at the new database in `kindgi.env`, where `<DB_PASSWORD>`
is the database password:

```sh
KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@kindgi-db-restored:5432/kindgi
```

Then [restart the runtime](../restart-and-check-health/#restart-the-runtime).
A run from before the backup is there, where `<run id>` is its id:

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
brings back what it cleared. Replay the erasures next, as
[Erasures and backups](#erasures-and-backups) shows.

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
   kindgi memory erasures export --out=erasures-$(date +%F).json
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
   kindgi memory erasures replay erasures-<date>.json
   ```

   `erasures-<date>.json` is the latest export. Its answer lists the
   erasures it `replayed`, the ones it `restored` to the ledger, and any it
   couldn't match, as `unmatched`. Here, the backup held a fact about the end
   user `end-7` from before their erasure, and the replay erased it again:

   ```json
   {
     "replayed": [
       "9e1e3253-d3a1-4c25-a0d4-020696e32125"
     ],
     "restored": [],
     "unmatched": []
   }
   ```

Two more things keep erasures complete:

- **End users' ids are opaque:** give `participantId` an id your app uses
  for the person, never an email or a name. Ids stay on records an erasure
  keeps.
- **Postgres can keep a cleared row's old version on disk** until it's
  vacuumed. Where that matters, run `VACUUM` on the database after
  erasures, and `REINDEX` for its indexes.

## Next

- [Restart the runtime and check its health](../restart-and-check-health/)
- [Erase a person's data](../../guides/agents/erase-a-persons-data/)
- [Retention](../retention/)
- [Operate a self-hosted runtime](../operate/)
