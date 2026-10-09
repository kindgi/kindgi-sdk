---
title: Run with authorization
description: What turning on authorization gives a self-hosted runtime today, what it doesn't do yet, and how to run OpenFGA next to it.
sidebar:
  order: 5
---

A self-hosted runtime checks one thing on each request by default: the API
token. Whoever holds it can do anything in its tenant. **Authorization** adds a
second check, per resource, kept in [OpenFGA](https://openfga.dev): who may
read, write or administer each project and what's in it.

## What it gives today, and what it doesn't

Authorization is built for several people and teams sharing one deployment,
and that part isn't finished. Today:

- **One person signs in: the operator,** with the runtime's API token, as its
  seed user (`KINDGI_SEED_USER_ID`), who administers the tenant. A runtime
  can't yet issue other API keys or sign other people in (`POST /v1/tokens`
  and sign-in aren't served).
- **Every decision is recorded,** allowed or denied, with who asked, what for
  and why: the access audit, below.
- **Project memberships are kept in step with OpenFGA:** adding, removing a
  member or changing their role changes what they may do, ready for when more
  people can sign in.
- **Registering an approval reviewer takes a tenant admin.**
- **Not every route is checked yet,** and a team can't be given access to a
  project.

Giving several people their own access is planned, with no date yet.

**Turn it on now** to have an access audit, or to set up projects and
memberships ahead of multi-user access. **Leave it off** if one operator is all
you need: you'd run OpenFGA for little else. `kindgi dev` runs without it.

## Run OpenFGA next to the runtime

Run OpenFGA v1.22.0. The runtime also works with v1.9.0, but published
OpenFGA security advisories affect that version
([OpenFGA: security advisories](https://github.com/openfga/openfga/security/advisories)).
OpenFGA keeps its data in Postgres:
give it its own database on the runtime's server. These commands continue
[Self-host Kindgi](../self-host/) (the `kindgi` network and the `kindgi-db`
container):

```sh
docker exec kindgi-db psql -U kindgi -c 'CREATE DATABASE openfga'

docker run --rm --network kindgi openfga/openfga:v1.22.0 migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable"

docker run -d --name kindgi-openfga --network kindgi --restart unless-stopped \
  openfga/openfga:v1.22.0 run \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable"
```

```text
migration done
```

Keep OpenFGA on the private network, with no published port: the runtime
calls it without credentials. Back up its `openfga` database with the
runtime's ([Back up Postgres](../operate/#back-up-postgres)).

### An OpenFGA you already run

To move an OpenFGA from v1.9.0 to v1.22.0, run the new version's `migrate`
against its database, then restart OpenFGA on the new version:

```sh
docker run --rm --network kindgi openfga/openfga:v1.22.0 migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable"
docker stop kindgi-openfga && docker rm kindgi-openfga
```

and start it with the `run` command above. On Postgres it's one migration,
which builds an index without locking the table. In our upgrade, the model,
every tuple and every permission answer came through unchanged, and v1.9.0
still ran on the migrated database, so going back needs no schema step.

If you set `OPENFGA_DATASTORE_MAX_IDLE_CONNS`: from v1.11, Postgres's idle
connections are set with `OPENFGA_DATASTORE_MIN_IDLE_CONNS` instead
([OpenFGA: configuration](https://openfga.dev/docs/getting-started/setup-openfga/configuration)).

### Point the runtime at it

Set its address in `kindgi.env`, and
[restart](../operate/#restart-the-runtime):

```sh
KINDGI_OPENFGA_API_URL=http://kindgi-openfga:8080
```

Run runtime 0.1.4.1 or later with authorization on: 0.1.4 can leave
permission changes unapplied after a redeploy
([Runtime 0.1.4.1](../operate/#runtime-0141)).

At its first start with it, the runtime creates an OpenFGA store for the
tenant (`tenant-<tenant id>`) and makes the seed user its admin. The startup
log says so:

```text
  User:    315d1376-7fbf-4310-83ba-11f204831423 (admin@tenant via FGA bootstrap)
```

After an upgrade, a start that brings the store up to the new version's model
logs one line for it ([From 0.1.3 to 0.1.4](../operate/#from-013-to-014)).

:::caution[Keep the seed user]
With authorization on, keep the seed user the same: set `KINDGI_SEED_USER_ID`,
or keep `KINDGI_API_TOKEN` unchanged (the runtime then keeps the token's user
across restarts). Each boot makes its seed user a tenant admin, but what was
granted to an earlier one (a project role, the keys minted for them) stays with
that user. A runtime started with a new token and no `KINDGI_SEED_USER_ID` says
so when it starts: `⚠ KINDGI_API_TOKEN changed, so it acts as a new user`.
:::

**When OpenFGA is unreachable,** requests that need a check answer `500`
(`FGA Error: connect ECONNREFUSED …`); they work again once it's back.

## A denied request

A request the check refuses gets `403`, with what was asked, on what, and why
in `details`:

```json
{"error":{"code":"permission-denied","message":"Permission denied: actor user:3fc3b945-8957-485b-902d-2950ffbe3139 does not have can_admin on tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff","details":{"action":"admin","resource":"tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff","reason":"actor user:3fc3b945-8957-485b-902d-2950ffbe3139 does not have can_admin on tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff"},"requestId":"req-58c6f372-8da1-45bf-ac11-8159c21fa973"}}
```

The TypeScript client gives `{ code: 'auth', reason: 'forbidden' }` with that
message; Python raises `AuthError`, with `server_code` `permission-denied`.

## Project memberships

A project's members have a role: `owner`, `admin`, `editor` or `viewer`. Each
includes the next ones: an owner is also an admin, an editor and a viewer.
Adding, changing or removing a membership changes OpenFGA too:

```sh
curl -X POST "$KINDGI_API_URL/v1/projects/<project-id>/memberships" \
  -H "Authorization: Bearer $KINDGI_API_TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"<user-id>","role":"editor"}'
```

`PATCH …/memberships/<user-id>` with `{"role":"viewer"}` changes the role, and
`DELETE …/memberships/<user-id>` removes the member. In the clients:
`projects.memberships.add`, `updateRole` and `remove` (`update_role` in
Python). Changing members takes `admin` on the project.

## The access audit

Each decision, allowed or denied, is kept: `GET /v1/audit/authz` lists them,
oldest first, for a tenant admin; `order=desc` lists the newest first, and its
cursor goes on in that order (`order: 'desc'` in TypeScript, `order="desc"`
in Python). They're kept for good, unless the runtime
purges audit events: with `KINDGI_COMPLIANCE_CLASSIFIER=shipped`, allowed ones
after 90 days and denied ones after 365 (see
[Audit events](../retention/#audit-events)).

```json
{
  "timestamp": "2026-10-06T13:25:01.475Z",
  "actorSubject": "user:315d1376-7fbf-4310-83ba-11f204831423",
  "action": "admin",
  "resource": "project:2358e0ee-b8ba-42fb-9704-781f14b2351f",
  "outcome": "allowed",
  "reason": "actor user:315d1376-7fbf-4310-83ba-11f204831423 has can_admin on project:2358e0ee-b8ba-42fb-9704-781f14b2351f",
  …
}
```

`actorSubject`, `action`, `resource`, `outcome` (`allowed` or `denied`), `from`, `to` and `runId` narrow the list.

### In the console

**Access audit** lists the same decisions, 50 at a time, newest first:
**Next page** leads to the older ones. A denied one has a ✗ and a red row. Narrow
the list by who, on what, action, result (allowed or denied), and time with
From and To, which are in UTC like the times in the list. The filters are in
the page's address, so you can copy it to share what you see. Clicking a row
shows the decision: allowed or denied, the part that failed (such as
`actor`), how long the check took, the reason, the request's correlation id,
and the check it asked OpenFGA (the evidence).
