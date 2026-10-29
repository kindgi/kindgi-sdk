---
title: Restart the runtime and check its health
description: Restart a self-hosted Kindgi runtime without losing runs, check that it's healthy, and find where its errors show.
sidebar:
  order: 3.1
---

This guide restarts a self-hosted runtime without losing runs, and checks
that it came back healthy.

## Before you start

- **A runtime running as [Self-host Kindgi](../self-host/) sets it up:** the
  `kindgi-server`, `kindgi-db` and `kindgi-pack` containers, on the `kindgi`
  network, with `kindgi.env` and `pack.env`.
- **Docker** and **curl**, on the machine that runs the containers.
- **`KINDGI_API_TOKEN` exported in your shell** as the runtime's API token. The
  commands that take your API token read it from there.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## Restart the runtime

The runtime reads its settings when it starts, so most changes to
`kindgi.env` take a restart.

Stop the container, remove it, and start it again with the same settings:

```sh
docker stop -t 30 kindgi-server
docker rm kindgi-server
docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
  --add-host registry.localhost:host-gateway \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  registry.kindgi.com/kindgi/runtime:0.2.0
```

- `-t 30` gives the runtime 30 seconds to stop before Docker kills it.
- `--network kindgi` puts it on the network the database and the pack's
  service are on.
- `--restart unless-stopped` starts it again after a crash or a reboot.
- `--add-host registry.localhost:host-gateway` lets it reach the local
  registry that [Self-host Kindgi](../self-host/) pushes the pack to.
- `-p 127.0.0.1:4000:4000` serves the API on this machine's port 4000 only.
- `--env-file kindgi.env` gives it its settings.

Docker prints the container's name after `stop` and `rm`, and the new
container's id after `run`:

```text
kindgi-server
kindgi-server
22451a46ab6068874f5e493d44d3cb2fefc38edfcac32553194206eac95ea229
```

On a stop, the runtime stops taking requests and gives the runs it's
executing up to 7 seconds to finish. Then it exits with code 0.

A stop that comes while it's still starting, before it serves, such as
while it waits for its database, ends it within 3 seconds (runtime 0.1.10
or later). Its log says `Stopped while starting (SIGTERM).`, and it exits
with code 143, as a process that `SIGTERM` ends does. Stopped with Ctrl-C
in a terminal, it says `(SIGINT)` and exits with code 130. A second Ctrl-C
changes nothing: the first stop is already under way.

:::caution[Runs in flight]
A run that was executing when the runtime stopped, and didn't finish in
time, can be left `running`: nothing resumes it. Cancel it, and start it
again:

```sh
npx --yes @kindgi/cli@0.2 runs cancel <run id> --url http://localhost:4000
```

`<run id>` is the run's id, and `--url` is the runtime's URL. It prints the
run's id, as in [Cancel a run](../../../guides/runs/cancel-a-run/):

```json
{
  "ok": true,
  "runId": "265627c7-1ac7-4d18-a926-6da9fcc18577"
}
```

To avoid it, restart when no runs are executing.
:::

## Check health and logs

Two routes say whether the runtime is up, and its log says why when it
isn't. The log lines on this page are in the pretty format. A runtime in a
container logs JSON unless `KINDGI_LOG_FORMAT=pretty` is set.
[Logs](../logs/) has both formats, the levels, and how to follow one
request.

`/health` says the process is up. Neither it nor `/ready` needs a token:

```sh
curl -s http://localhost:4000/health
```

`-s` keeps `curl` quiet, so it prints only the answer:

```text
{"ok":true}
```

`/ready` says its database answers too, within two seconds:

```sh
curl -s http://localhost:4000/ready
```

```text
{"ok":true,"database":"ok"}
```

While Postgres is unreachable, `/ready` answers `503` with
`{"ok":false,"database":"unreachable"}`, and `/health` still answers
`{"ok":true}`.

`/v1/runtime` says which runtime answers: its release, how many tenants it
serves, and whether it runs in development mode. Any of the tenant's tokens
reads it, whatever its rights:

```sh
curl -s http://localhost:4000/v1/runtime -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")
```

```text
{"version":"0.3.0","tenancy":"single","development":false}
```

`version` is the release, or what the build gave otherwise (`dev` when it
gave none). `tenancy` is `single` for a runtime that serves one tenant and
`multi` for one that serves many, as
[`KINDGI_TENANCY`](../../../reference/env-vars/#kindgi_tenancy) sets it. The
clients read it as `client.runtime.get()`, in TypeScript and in Python.

Point a load balancer's or a platform's readiness check at `/ready`, or
`/health`, and never at `/`. `/` leads to the console with a `302`. Without
the console, it answers `200` even while the database is down, so a check on
`/` would pass a broken runtime.

The image's own health check uses `/ready`, so `docker ps` shows the
runtime's state:

```sh
docker ps --filter name=kindgi-server --format 'table {{.Names}}\t{{.Status}}'
```

`--filter` picks the runtime's container, and `--format` prints its name and
status:

```text
NAMES           STATUS
kindgi-server   Up 34 seconds (healthy)
```

`docker ps` shows `(unhealthy)` while the database is down, and the
runtime's log says why:

```text
17:37:34.151 WARN  [ready] the database doesn't answer: no answer within 2000 ms
```

A route that reads the database answers `500` and names the cause. With
Postgres unreachable, `GET /v1/deployments` answers:

```sh
curl -s http://localhost:4000/v1/deployments -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")
```

```text
{"error":{"code":"internal-server-error","message":"Deployment list failed: deployments: Tenant-scoped query failed: host not found (getaddrinfo ENOTFOUND kindgi-db)","requestId":"req-…"}}
```

### The startup log

The runtime prints what it's running with when it starts. Read it with
`docker logs kindgi-server`. In the JSON format, they're the `lines` of its
`boot` record. The lines to check after a change:

```text
  Token:   kgi_bt_…3236 (provided)
  …
  Public run tokens: off (no signing key)
  …
  License: …
  …
  Env: production (tool secrets resolve in it)
  Tenant host access: deployed (stdio MCP endpoints refused; tenant-chosen hosts can't reach the metadata server or this host; KINDGI_TENANT_HOST_ACCESS)
  Pack service: http://…:8080 — acme-pack (artifact …), protocol 2, 3 tools, 1 check
```

- **`Token`:** the last four characters of the API token it accepts.
- **`License`:** who the key is for, its kind and its end date. A warning
  follows within 30 days of the end.
- **`⚠ This preview build (…) stops starting on …`:** from 30 days before
  this preview release stops starting (90 days after it was released).
  Upgrade before then. In the JSON format it's also a
  record of its own, `"event": "kindgi.preview_expiry"`, logged at startup
  and once a day: match it in a log alert.
- **`Pack service`:** the pack it reached, with its artifact version. When it
  can't reach it, a warning takes this line's place, with the reason.

### After a crash

When the runtime comes back after stopping without a shutdown, its sweep
repairs the runs the stop left mid-way, as
[If the runtime stops](../../../concepts/runs/#if-the-runtime-stops) explains.
Each repair is a line in its log:

```text
<time> INFO  [leases] resuming run <run id> (tenant <tenant id>): its wait resolved and nothing resumed it
<time> INFO  [leases] woke the flow run waiting on child run <run id> …: the child had moved on
<time> INFO  [leases] ended run <run id> …: its parent run had ended
```

### Where errors show

- **A setting the runtime refuses,** such as a missing license key, or a log
  setting it can't use: it exits with code 2, and its log says what to fix.
- **A database it can't reach while starting:** it exits with code 1, and
  its log says which database and why, never the user or the password.
  Here Postgres wasn't running:

  ```sh
  docker inspect --format '{{.State.ExitCode}}' kindgi-server
  docker logs kindgi-server
  ```

  ```text
  1
  Can't connect to the database at kindgi-db:5432/kindgi: host not found (getaddrinfo ENOTFOUND kindgi-db). Check KINDGI_DATABASE_URL, and that Postgres is up and reachable from here.
  ```

  **A database that never answers** (runtime 0.1.10 or later), such as
  one behind a firewall that drops its packets: the runtime waits its
  connect timeout and asks again, 3 times in all. Before each new try, it
  logs a warning on the `boot` subsystem that ends
  `try 1 of 3; asking again.`, then `try 2 of 3`. After the third, it exits
  with code 1, and the reason is `no host answered within 30 s (3 tries)`,
  about 90 seconds after it started. The reason can also read
  `CONNECT_TIMEOUT`, the Postgres client's word for the same wait. The
  connect timeout is the URL's `connect_timeout`, else `PGCONNECT_TIMEOUT`,
  else 30 seconds.

  With several hosts in `KINDGI_DATABASE_URL`, such as
  `postgres://…@db1:5432,db2:5432/kindgi`, the runtime tries once, with no
  warning, and the line names each host. Hosts that refuse the connection or
  aren't found are tried in turn for the connect timeout times the number of
  hosts: `no host answered within 60 s` for two. A first host that answers
  nothing ends the try at its connect timeout, with the reason
  `CONNECT_TIMEOUT`, and the hosts after it aren't tried.

  The `kindgi-runtime check` and `kindgi-runtime tenants` commands try once.
  They say the same, without `(3 tries)` and with `(or --db)` after
  `KINDGI_DATABASE_URL`, and exit with code 2.

  **A password with a raw `/`, `?` or `#`** has to be percent-encoded in
  `KINDGI_DATABASE_URL`: `%2F`, `%3F` and `%23`. Otherwise the runtime
  misreads the URL. Most often it refuses it as not a valid `postgres://`
  URL and exits with code 2. For some passwords it can't connect instead,
  and its log names `KINDGI_DATABASE_URL` where the host would be.

- **Another failure while starting:** it exits with code 1, and the log's
  first line starts with `kindgi-runtime: fatal:` and ends with the cause.
- **A run that fails:** its `failureMessage`, in
  `npx --yes @kindgi/cli@0.2 runs get <run id>`.

## Next

- [Back up and restore the runtime's database](../back-up-and-restore/)
- [Rotate the runtime's tokens and keys](../rotate-keys/)
- [Logs](../logs/)
- [Operate a self-hosted runtime](../operate/)
