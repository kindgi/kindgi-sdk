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

Authorization is for several people and teams sharing one deployment:

- **People and service accounts, each with their own keys.** A tenant admin
  adds people, who [sign in to the console](../sign-in/) and make their own
  API keys, and service accounts for pipelines and apps
  ([People, API keys and service accounts](../people-and-keys/)). The
  runtime's seed user (`KINDGI_SEED_USER_ID`) is the first tenant admin.
- **Every request is checked** against what its caller may do: tenant admin,
  tenant member, a role on a project, or a reviewer role. Lists hold only
  what the caller may read.
- **Every decision is recorded,** allowed or denied, with who asked, what for
  and why: the access audit, below.
- **Registering an approval reviewer takes a tenant admin.**
- **A team can't be given access to a project yet.**

**Turn it on** when more than one person or system uses a deployment.
**Leave it off** if one operator is all you need: you'd run OpenFGA for
little else. `kindgi dev` runs without it.

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

Give the person by `email` instead of `userId` if you like: it matches one
of the tenant's people, whatever its case
([Add a person](../people-and-keys/#add-a-person)).
`PATCH …/memberships/<user-id>` with `{"role":"viewer"}` changes the role, and
`DELETE …/memberships/<user-id>` removes the member. In the clients:
`projects.memberships.add`, `updateRole` and `remove` (`update_role` in
Python). Changing members takes `admin` on the project: a tenant admin, or
the project's own admins.

Adding someone who's a member already keeps their role. The same role answers
`201` with the existing membership; another one is `409 membership-exists`,
with the role they hold in `details.role`. Use `PATCH` to change it.

Listing a project's members takes `write` on it: its editors and admins. A
viewer sees the project, not who else works in it, and reads their own roles
through [their grants](../people-and-keys/#make-someone-a-tenant-admin)
(`GET /v1/identity/users/<user-id>/grants`).

## Team grants

A team can have a role on a project: `viewer`, `editor` or `admin`. Every
member of the team then holds that role there, the team's admins included. A
team never owns a project; `owner` is a person's role.

```sh
curl -X POST "$KINDGI_API_URL/v1/projects/<project-id>/team-grants" \
  -H "Authorization: Bearer $KINDGI_API_TOKEN" -H 'content-type: application/json' \
  -d '{"teamId":"<team-id>","role":"editor"}'
```

Giving a team a role takes `admin` on the project and `read` on the team:
you give your project only to a team you can see. Giving a team `admin`
hands "who works here" to the team's admins, since anyone they add to the
team gets it. Adding a role the team already holds answers `201` with the
existing grant; another role is `409 team-grant-exists`. `PATCH …/team-grants/<team-id>` with
`{"role":"viewer"}` changes it, and `DELETE …/team-grants/<team-id>` takes it
away.

In the clients: `projects.teamGrants.list`, `add`, `updateRole` and `remove`
(`projects.team_grants` in Python), and `teams.projectGrants.list`
(`teams.project_grants.list`) for the projects a team works in.

Who sees the grants:

- **A project's team grants** (`GET …/team-grants`): its editors and admins
  (`write`).
- **A team's project grants** (`GET /v1/teams/<team-id>/project-grants`) and
  **its members** (`GET /v1/teams/<team-id>/memberships`): the team's admins
  and tenant admins. A plain member sees the team, not who else is in it.

Deleting a team removes the access it gave: its members' roles and its
project grants. Nobody keeps access through a team that's gone.

## Who has access to a project

`GET /v1/projects/<project-id>/access` lists everyone OpenFGA lets into the
project, people and service accounts, with their role and every way in:

```json
{
  "data": [
    {
      "principal": { "kind": "user", "id": "6b1f…" },
      "displayName": "Ada Lovelace",
      "primaryEmail": "ada@acme.example",
      "role": "admin",
      "via": [
        { "kind": "tenant-admin" },
        { "kind": "direct", "role": "editor", "joinedAt": "2026-10-01T09:12:44.103Z" }
      ]
    },
    {
      "principal": { "kind": "user", "id": "9c2e…" },
      "displayName": "Ben Okafor",
      "role": "editor",
      "via": [{ "kind": "team", "teamId": "…", "teamName": "Support crew", "role": "editor" }]
    }
  ],
  "hasMore": false
}
```

- **`role`** is the highest any way in gives. An admin of the project's org
  (`org-admin`) and a tenant admin (`tenant-admin`) are admins of the project.
- **A direct role with `joinedAt`** is a membership: change or remove it with
  `…/memberships/<user-id>`. One without `joinedAt` has no membership behind
  it, such as the owner who created the project.
- **A team's role** is changed on its grant (`…/team-grants/<team-id>`).

Reading it takes `write` on the project (its editors and admins); emails show
to its admins only. It's ordered by role, owner first, then by name, and pages
like other lists. In the clients: `projects.access.list` (the same in Python).
A runtime without OpenFGA answers `501 project-access-unsupported`.

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

**Access audit**, for tenant admins (the only people its API answers), lists
the same decisions, 50 at a time, newest first:
**Next page** leads to the older ones. A denied one has a ✗ and a red row. Narrow
the list by who, on what, action, result (allowed or denied), and time with
From and To, which are in UTC like the times in the list. The filters are in
the page's address, so you can copy it to share what you see. Clicking a row
shows the decision: allowed or denied, the part that failed (such as
`actor`), how long the check took, the reason, the request's correlation id,
and the check it asked OpenFGA (the evidence).
