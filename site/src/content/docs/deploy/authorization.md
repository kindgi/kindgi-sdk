---
title: Run with authorization
description: What turning on authorization gives a self-hosted runtime, what it doesn't do, and how to run OpenFGA next to it.
sidebar:
  order: 5
---

When you finish this page, your runtime checks every request against who
may read, write or administer each project, with OpenFGA running next to
it.

By default, a self-hosted runtime lets in whoever holds a key or a sign-in,
and each may work in every project. Tenant settings are the tenant admin's
([Without authorization](../people-and-keys/#without-authorization)).
**Authorization** adds a check per resource, kept in
[OpenFGA](https://openfga.dev): who may read, write or administer each
project and what's in it.

:::note[On Kindgi Cloud]
Authorization is always on, and Kindgi runs OpenFGA. Skip
[Before you start](#before-you-start) and
[Run OpenFGA next to the runtime](#run-openfga-next-to-the-runtime), and the
runtime's `KINDGI_*` settings: they're Kindgi's.
:::

## What it gives, and what it doesn't

Authorization is for people and teams who share one deployment but need
different access:

- **Roles for people and service accounts.** People
  [sign in to the console](../self-hosted/sign-in/) and make their own API
  keys either way, and service accounts act for pipelines and apps
  ([People, API keys and service accounts](../people-and-keys/)). With
  authorization, a tenant admin gives each a role, and can make others
  tenant admins. The runtime's seed user (`KINDGI_SEED_USER_ID`) is the
  first.
- **Every request is checked** against what its caller may do: tenant admin,
  tenant member, a role on a project, or a reviewer role. Lists hold only
  what the caller may read.
- **Every decision on what a request may do or read is recorded,** allowed
  or denied, with who asked, what for and why
  ([The access audit](#the-access-audit)). What the console reads to show
  you your own access isn't (runtime 0.3.0 or later).
- **Registering an approval reviewer takes a tenant admin.** A tenant admin
  reads approvals at every tier without registering, through a session or an
  `admin` key not limited to a project, in the projects they may read.
  Deciding takes the roster.
- **A team can have a role on a project** through the API
  ([Team grants](#team-grants)). The console doesn't offer it.

**Turn it on** when people need different access, such as a viewer or a
project of their own, or when more than one person needs to be a tenant
admin. A runtime serving many tenants needs it. **Leave it off** when
everyone who signs in may work in every project, such as one operator or a
small team that trusts each other. `kindgi dev` runs without it.

## Before you start

- **A runtime set up as in [Self-host Kindgi](../self-hosted/self-host/),** with its
  `kindgi` Docker network and its `kindgi-db` Postgres container.
  `DB_PASSWORD` is that Postgres's password.
- **Runtime 0.1.4.1 or later.** On a managed Postgres whose database user
  has neither `BYPASSRLS` nor superuser, 0.1.6 and 0.1.7 don't start with
  authorization on: use 0.1.8 or later there.
- **Docker,** to run OpenFGA.

## Run OpenFGA next to the runtime

Run OpenFGA v1.22.0. The runtime also works with v1.9.0, but published
OpenFGA security advisories affect that version
([OpenFGA: security advisories](https://github.com/openfga/openfga/security/advisories)).
OpenFGA keeps its data in Postgres:
give it its own database on the runtime's server. These commands continue
[Self-host Kindgi](../self-hosted/self-host/) (the `kindgi` network and the `kindgi-db`
container):

```sh
docker exec kindgi-db psql -U kindgi -c 'CREATE DATABASE openfga'

docker run --rm --network kindgi openfga/openfga:v1.22.0 migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable"

docker run -d --name kindgi-openfga --network kindgi --restart unless-stopped \
  openfga/openfga:v1.22.0 run \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable" \
  --playground-enabled=false
```

```text
migration done
```

- `CREATE DATABASE openfga` gives OpenFGA a database of its own in the
  runtime's Postgres.
- `migrate` makes OpenFGA's tables there, and prints `migration done`.
  `--datastore-engine postgres` and `--datastore-uri` say where its data
  goes.
- `run` starts OpenFGA on the `kindgi` network, as `kindgi-openfga`. `-d`
  runs it in the background, and `--restart unless-stopped` has Docker
  start it again after a restart.

These commands reach Postgres over the `kindgi` network, which doesn't
leave the machine, so the URI turns TLS off (`sslmode=disable`). When
OpenFGA reaches its database over another network, have it check the
server's certificate
([OpenFGA's connection to the database](../self-hosted/database-tls/#openfgas-connection-to-the-database)).

Keep OpenFGA on the private network, with no published port: the runtime
calls it without credentials unless OpenFGA requires a key
([Require a key for OpenFGA](#require-a-key-for-openfga), which needs runtime
0.1.8 or later).
The playground is off: it's for trying OpenFGA on your own machine. Back up its `openfga` database with the
runtime's ([Back up Postgres](../self-hosted/back-up-and-restore/#back-up-postgres)).

### An OpenFGA you already run

To move an OpenFGA from v1.9.0 to v1.22.0, run the new version's `migrate`
against its database, then restart OpenFGA on the new version:

```sh
docker run --rm --network kindgi openfga/openfga:v1.22.0 migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable"
docker stop kindgi-openfga && docker rm kindgi-openfga
```

Then start it with the `run` command from
[Run OpenFGA next to the runtime](#run-openfga-next-to-the-runtime). On
Postgres it's one migration,
which builds an index without locking the table. In our upgrade, the model,
every tuple and every permission answer came through unchanged, and v1.9.0
still ran on the migrated database, so going back needs no schema step.

If you set `OPENFGA_DATASTORE_MAX_IDLE_CONNS`: from v1.11, Postgres's idle
connections are set with `OPENFGA_DATASTORE_MIN_IDLE_CONNS` instead
([OpenFGA: configuration](https://openfga.dev/docs/getting-started/setup-openfga/configuration)).

### Point the runtime at it

Set OpenFGA's address in `kindgi.env`, and
[restart](../self-hosted/restart-and-check-health/#restart-the-runtime) the runtime:

```sh
KINDGI_OPENFGA_API_URL=http://kindgi-openfga:8080
```

At its first start with it, the runtime creates an OpenFGA store for the
tenant, `tenant-<tenant id>`, and makes the seed user its admin. The startup
log says so:

```text
  User:    315d1376-7fbf-4310-83ba-11f204831423 (admin@tenant via FGA bootstrap)
```

After an upgrade, a start that brings the store up to the new version's model
logs one line for it ([Operate](../self-hosted/operate/#from-013-to-014) has the line).

:::caution[Keep the seed user]
With authorization on, keep the seed user the same. Set `KINDGI_SEED_USER_ID`,
or keep `KINDGI_API_TOKEN` unchanged: the runtime then keeps the token's user
across restarts. Each boot makes its seed user a tenant admin. But what was
granted to an earlier one stays with that user, such as a project role and
the keys minted for them. A runtime started with a new token and no
`KINDGI_SEED_USER_ID` says so when it starts:
`⚠ KINDGI_API_TOKEN changed, so it acts as a new user`.
:::

**When OpenFGA is unreachable,** requests that need a check answer `500
internal-server-error` with `Unhandled server error` and the request id
(runtime 0.1.9 or later; earlier ones answer with the cause itself). The
runtime's `unhandled error` log line for that request id has the cause,
`FGA Error: connect ECONNREFUSED …` ([Logs](../self-hosted/logs/)). They work again
once it's back.

**When the database fails one tenant's permission changes:** the runtime
sends permission changes to OpenFGA from a queue in Postgres, about twice a
second: a grant, a revoke, a new project or a new agent. When it can't read
or update one tenant's part of that queue, it logs an error
([Logs](../self-hosted/logs/)). Here, with the database out of reach:

```json
{"time":"2026-10-12T06:21:01.457Z","level":"error","severity":"ERROR","subsystem":"authz.outbox","message":"drain: a tenant failed","tenantId":"0b6a3f2e-6c1d-4a8e-9f4b-2d7c5e1a9b30","error":"Tenant-scoped query failed: connection refused (connect ECONNREFUSED …)"}
```

That tenant's changes stay queued and go on a later pass: none is lost, and
other tenants' changes still go. Until then, checks answer from what OpenFGA
already has.

- **A single line** needs nothing: it was a passing database error.
- **The same tenant on every pass** means its permission changes aren't
  reaching OpenFGA. Fix what `error` names on the database side: the
  connection, a timeout, or the database user's permissions. The changes
  apply on the next pass, with no restart.

### Require a key for OpenFGA

OpenFGA answers whoever reaches it, so anything else on its network could read
and write your permissions. OpenFGA can require a key, and the runtime sends
it with every call (`Authorization: Bearer <key>`). This needs runtime 0.1.8 or
later: an earlier runtime ignores the setting, and OpenFGA then refuses its
calls.

Use OpenFGA 1.14.0 or later with a key, with its playground off: before 1.14.0,
the playground page shows the key to anyone who opens it
([OpenFGA: Playground Preshared Key Exposure](https://github.com/openfga/openfga/security/advisories/GHSA-68m9-983m-f3v5),
CVE-2026-40293). Make a key, run
OpenFGA with it, and give the runtime the same key:

```sh
OPENFGA_KEY=$(openssl rand -hex 32)

docker run -d --name kindgi-openfga --network kindgi --restart unless-stopped \
  openfga/openfga:v1.22.0 run \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@kindgi-db:5432/openfga?sslmode=disable" \
  --authn-method preshared --authn-preshared-keys "$OPENFGA_KEY" \
  --playground-enabled=false
```

In `kindgi.env`, beside the address:

```sh
KINDGI_OPENFGA_PRESHARED_KEY=<the same key>
```

The key is printable ASCII, without spaces or commas: it travels in a header,
and OpenFGA's list of keys is comma-separated. After a
[restart](../self-hosted/restart-and-check-health/#restart-the-runtime), the startup lines say what the
runtime's calls carry, never the key:

```text
  OpenFGA calls carry its preshared key (KINDGI_OPENFGA_PRESHARED_KEY)
```

A runtime whose key OpenFGA doesn't hold, or that has none, doesn't start:

```text
kindgi-runtime: fatal: Error: OpenFGA at http://127.0.0.1:63551 refused the server's call (401): set KINDGI_OPENFGA_PRESHARED_KEY to one of the keys OpenFGA runs with (its OPENFGA_AUTHN_PRESHARED_KEYS) and, for an OpenFGA behind Cloud Run IAM, KINDGI_OPENFGA_AUTH=google-id-token.
```

**To change the key** with no call refused, use OpenFGA's list of keys, and
restart each in turn:

1. Add the new key to OpenFGA's: `--authn-preshared-keys "$OLD_KEY,$NEW_KEY"`.
   Restart OpenFGA.
2. Set the runtime's `KINDGI_OPENFGA_PRESHARED_KEY` to the new key. Restart the
   runtime.
3. Drop the old key from OpenFGA's list. Restart OpenFGA.

On Cloud Run, OpenFGA's IAM adds a second check:
[OpenFGA behind Cloud Run IAM](../self-hosted/cloud-run/#openfga-behind-cloud-run-iam).

## A denied request

A request the check refuses gets `403`, with what was asked, on what, and why
in `details`:

```json
{"error":{"code":"permission-denied","message":"Permission denied: actor user:3fc3b945-8957-485b-902d-2950ffbe3139 does not have can_admin on tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff","details":{"action":"admin","resource":"tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff","reason":"actor user:3fc3b945-8957-485b-902d-2950ffbe3139 does not have can_admin on tenant:af0be8c3-f8c2-430a-ba2f-06d3edd574ff"},"requestId":"req-58c6f372-8da1-45bf-ac11-8159c21fa973"}}
```

The TypeScript client gives `{ code: 'auth', reason: 'forbidden' }` with that
message. Python raises `AuthError`, with `server_code` `permission-denied`.

## The console, by role

The console offers only what your role lets you do. It reads that from
`GET /v1/identity/me/permissions`
([What you may do](../people-and-keys/#what-you-may-do)). The server still
checks every call.

- **A project's viewer** reads its pages and takes no action in them. A
  line under the console's header says so on each of the project's pages:
  "You can view this project; changes need an editor." When a tenant admin
  set the tenant's own line, `console.readOnlyNotice`, it shows instead,
  such as "Ask Ana Ruiz for edit access."
- **An editor** may also "run agents and flows, work on agent versions,
  publish prompts and settings, correct runs, try versions on the test
  cases", in the console's words. An agent's page offers them **Register new
  version** and **Start run**, which a viewer's doesn't.
- **A project admin** may also "make versions live, register agents and
  tools, build test cases, rescore runs on the test cases, set judge
  classes", and
  changes who works in the project ([Members](#in-the-console-members)).
- **The tenant's sections** show to those they're for:
  - People, Service accounts, Policies, Webhooks, Sign-in, Access audit and
    the like, to tenant admins;
  - the Inbox and Approvals, to reviewers;
  - Teams, to tenant admins and anyone in a team.

![A project's Agents page as Gus Moreno, a viewer of Support: under the header, "You can view this project; changes need an editor."; the agents list (Support agent, acme.support, version 1.0.0) with no buttons.](../../../assets/access/viewer-project.png)

**My access**, in the tenant's sections, is what you may do and how you
have it. It starts with a sentence, such as "You're an editor in 1
project." Then it has your tenant role ("Tenant: member. Its people, keys
and settings are its admins'."), and your reviewer role if you have one.
Last is a table of your projects: your role, how you have it, and what it
lets you do and doesn't. You can have a role directly, through a team, as an
admin of the org, or as a tenant admin. **The detail** holds your ids and
what each role allows on each kind of object.

![My access as Eda Brooks: "You're an editor in 1 project." and "Tenant: member. Its people, keys and settings are its admins'."; a table with Support, Editor, directly, and what it lets her do: "run agents and flows, work on agent versions, publish prompts and settings, correct runs, try versions on the test cases; not make versions live, register agents and tools, build test cases, rescore runs on the test cases, set judge classes"; and The detail, closed.](../../../assets/access/my-access.png)

## Project memberships

A project's members have a role: `owner`, `admin`, `editor` or `viewer`. Each
includes the next ones: an owner is also an admin, an editor and a viewer.
A role given as `member` before it was retired still reads back as `member`
and grants what `viewer` does. Giving it is a `400` that says to use
`viewer`. An API key's `member` role is a different one, and stays
([People, API keys and service accounts](../people-and-keys/)).
Adding, changing or removing a membership changes OpenFGA too:

```sh
curl -X POST "$KINDGI_API_URL/v1/projects/<project-id>/memberships" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") -H 'content-type: application/json' \
  -d '{"userId":"<user-id>","role":"editor"}'
```

- `<project-id>` is the project's id, and `<user-id>` the person's.
- `role` is their role on the project: `owner`, `admin`, `editor` or
  `viewer`.
- `KINDGI_API_URL` is the runtime's address, and `KINDGI_API_TOKEN` your
  API key.

You can name the person by `email` instead of `userId`. It matches one of
the tenant's people, whatever its case
([Add a person](../people-and-keys/#add-a-person)).
`PATCH …/memberships/<user-id>` with `{"role":"viewer"}` changes the role, and
`DELETE …/memberships/<user-id>` removes the member. In the clients, the
calls are `projects.memberships.add`, `updateRole` and `remove`, with
`update_role` in Python. Changing members takes `admin` on the project: a
tenant admin, or the project's own admins.

Adding someone who's a member already keeps their role. The same role answers
`201` with the existing membership; another one is `409 membership-exists`,
with the role they hold in `details.role`. Use `PATCH` to change it.

Listing a project's members takes `write` on it: its editors and admins. A
viewer sees the project, not who else works in it, and reads their own roles
through [their grants](../people-and-keys/#make-someone-a-tenant-admin)
(`GET /v1/identity/users/<user-id>/grants`).

In the console, a project's admins do this on its **Members** page: see
[In the console: Members](#in-the-console-members).

## Teams

A team is a group of the tenant's people, each in it as a `member` or an
`admin`. A tenant admin makes one with `POST /v1/teams`, giving a `name`, a
`slug` and an optional `description`, and holds its `admin` role. Its
admins, and tenant admins, add and take out its people
(`…/teams/<team-id>/memberships`), change their roles, and rename it
(`PATCH /v1/teams/<team-id>`). A team's role on a project reaches everyone
in it ([Team grants](#team-grants)).

### In the console: Teams

**Teams**, in the tenant's sections, shows to tenant admins and anyone in a
team, with the teams each may see. A tenant admin makes one with **New
team**: "A group of people, run by its admins: they decide who is in it.
You add the first people on its page." It takes a name, a slug ("Lowercase
letters, digits and hyphens; unique in the tenant.") and what the team is.

![The Teams page as a tenant admin: "1 team.", Support crew (support-crew, "First-line support"), a New team button, and under the list "The console doesn't give a team a role on a project yet: the API does (team grants)."](../../../assets/teams/teams.png)

A team's page, for its admins and tenant admins, says how many are in it
and how many run it, such as "4 people, 2 run it.", and lists them with
their role and since when. There they rename it, and the slug stays. They
change someone's role, take someone out, which asks first, and add someone
from the tenant's people. Finding a person reads the tenant's people, so
adding someone takes a tenant admin.

![Support crew's page as a tenant admin: "4 people, 2 run it." and "The console doesn't give a team a role on a project yet: the API does (team grants)."; Add someone to Support crew (a person, a role, Add); and the list: the seed user and Ana Ruiz (admins), Ben Okafor and Ada Lovelace (members), each with a role to change and Take out; a Rename button.](../../../assets/teams/team.png)

Anyone else in the team sees it, but not who else is in it: "You're in it.
Who is in Support crew is shown to its admins."

The console doesn't delete a team, or give one a role on a project: both
are the API's. Both Teams pages say so: "The console doesn't give a team a
role on a project yet: the API does (team grants)."

## Team grants

A team can have a role on a project: `viewer`, `editor` or `admin`. Every
member of the team then holds that role there, the team's admins included. A
team never owns a project: `owner` is a person's role.

```sh
curl -X POST "$KINDGI_API_URL/v1/projects/<project-id>/team-grants" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") -H 'content-type: application/json' \
  -d '{"teamId":"<team-id>","role":"editor"}'
```

- `<team-id>` is the team's id.
- `role` is the team's role on the project: `viewer`, `editor` or `admin`.

Giving a team a role takes `admin` on the project and `read` on the team:
you give your project only to a team you can see. Giving a team `admin`
hands "who works here" to the team's admins, since anyone they add to the
team gets it. Adding a role the team already holds answers `201` with the
existing grant. Another role is `409 team-grant-exists`.
`PATCH …/team-grants/<team-id>` with `{"role":"viewer"}` changes it, and
`DELETE …/team-grants/<team-id>` takes it away.

In the clients, the calls are `projects.teamGrants.list`, `add`,
`updateRole` and `remove`, or `projects.team_grants` in Python.
`teams.projectGrants.list`, `teams.project_grants.list` in Python, lists the
projects a team works in.

Who sees the grants:

- **A project's team grants** (`GET …/team-grants`): its editors and admins,
  who have `write`.
- **A team's project grants** (`GET /v1/teams/<team-id>/project-grants`) and
  **its members** (`GET /v1/teams/<team-id>/memberships`): the team's admins
  and tenant admins. A plain member sees the team, not who else is in it.

Deleting a team removes the access it gave: its members' roles and its
project grants. Nobody keeps access through a team that's gone.

## Who has access to a project

`GET /v1/projects/<project-id>/access` lists everyone OpenFGA lets into the
project, people and service accounts, with their role and every way in. Here
it lists the project's creator, Ana Ruiz and Ben Okafor. Ana is a tenant
admin who's also a direct editor. Ben is in the team Support crew, an editor
of the project:

```json
{
  "data": [
    {
      "principal": { "kind": "user", "id": "7e8e9ff9-…" },
      "displayName": "seed-user",
      "role": "owner",
      "via": [
        { "kind": "direct", "role": "owner", "joinedAt": "2026-10-10T06:52:18.102Z" },
        { "kind": "tenant-admin" },
        { "kind": "team", "teamId": "8a88aabe-…", "teamName": "Support crew", "role": "editor" }
      ]
    },
    {
      "principal": { "kind": "user", "id": "54293391-…" },
      "displayName": "Ana Ruiz",
      "primaryEmail": "ana@acme.example",
      "role": "admin",
      "via": [
        { "kind": "tenant-admin" },
        { "kind": "direct", "role": "editor", "joinedAt": "2026-10-10T06:52:18.297Z" },
        { "kind": "team", "teamId": "8a88aabe-…", "teamName": "Support crew", "role": "editor" }
      ]
    },
    {
      "principal": { "kind": "user", "id": "06a1dcc9-…" },
      "displayName": "Ben Okafor",
      "primaryEmail": "ben@acme.example",
      "role": "editor",
      "via": [
        { "kind": "team", "teamId": "8a88aabe-…", "teamName": "Support crew", "role": "editor" }
      ]
    }
  ],
  "hasMore": false
}
```

- **`role`** is the highest any way in gives. An admin of the project's org
  (`org-admin`) and a tenant admin (`tenant-admin`) are admins of the project.
- **A tenant admin is an admin of every team too,** so they're also listed
  through a team's grant, as Ana and the creator are here.
- **A direct role with `joinedAt`** is a membership: change or remove it with
  `…/memberships/<user-id>`. One without `joinedAt` has no membership behind
  it, such as the creator of a project an older runtime made.
- **A team's role** is changed on its grant (`…/team-grants/<team-id>`).

Reading it takes `write` on the project: its editors and admins. Emails show
to its admins only. It's ordered by role, owner first, then by name, and pages
like other lists. In the TypeScript and Python clients, it's
`projects.access.list`. A runtime without OpenFGA answers
`501 project-access-unsupported`.

### In the console: Members

A project's **Members** page shows everyone with access, and how, to the
project's editors and admins. It starts with a count, each one counted once
by the way their role comes from, such as "6 people and 1 service account have access
to Support: 4 through a role of their own, 2 through a team, 1 as a tenant
admin." Then each one, with their role and every way in: "Their own role
(editor)", "Team Support crew (editor)", "Admin of Acme", "Tenant admin". A
way the console can't name reads "Another way in". Emails show to the
project's admins.

![Support's Members page as a tenant admin: "6 people and 1 service account have access to Support: 4 through a role of their own, 2 through a team, 1 as a tenant admin."; an Add someone to Support form (an email, a role, Add); and the list: the seed user (owner; their own role, tenant admin, Team Support crew), Ana Ruiz (her own role editor, "admin through another way in"; tenant admin, Team Support crew), acme-ci (service account, editor), Ada Lovelace (her own role viewer, "editor through another way in"; Team Support crew (editor)), Ben Okafor (editor through Team Support crew), Eda Brooks (editor) and Gus Moreno (viewer), with Take away beside each role of someone's own.](../../../assets/access/members.png)

A project admin changes who works there:

- **Add someone** by their email in the tenant, with one of the four roles.
  An email that isn't one of the tenant's people isn't added: "No one with
  that email in this tenant: a tenant admin adds them on People first."
- **Change** a person's role of their own. When another way in gives them
  more, it says so under it, such as "editor through another way in". A
  role through a team, an org or tenant admin is changed where it comes
  from, and a service account's on its own page.
- **Take away** a person's role of their own. It asks first, and says what
  stays:

![The Take away step: "Take Ada Lovelace off Support? From their next request on, they can't work in Support through this role. Ada Lovelace keeps editor access through Team Support crew. What was done here stays.", with Cancel and Take it away.](../../../assets/access/members-take-away.png)

An editor reads the same list, with "Only an admin of Support changes who
works here." A viewer doesn't see the section. At its address, they read
"Who works in Support is shown to its editors and admins.", and nothing
more.

## The access audit

Each decision the authorization model makes on what a request may do or
read, allowed or denied, is kept. So is a refusal the API answers from its
own checks. `GET /v1/audit/authz` lists them, oldest first, for a tenant
admin. `order=desc` lists the newest first, and its cursor goes on in that
order: `order: 'desc'` in TypeScript, `order="desc"` in Python. They're kept
for good, unless the runtime purges audit events. With
`KINDGI_COMPLIANCE_CLASSIFIER=shipped`, it purges allowed ones after 90 days
and denied ones after 365 ([Audit events](../retention/#audit-events)).

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

Refusals the API decides before it asks the authorization model are kept
too, on runtime 0.1.6 or later, with a `reason` that says which check
refused:

- what the caller's API key rules out: a `member` key asking for a tenant
  admin's action, a key limited to a project acting on another project's
  resource, a key without the capability a write needs (`env:write`,
  `secrets:write`, …);
- a request that names a project other than its key's, and a key limited to
  a project minting one that isn't (`key-project-mismatch`);
- minting a key with capabilities you don't hold;
- on the approvals routes, a caller who isn't a reviewer, unless it's a
  tenant admin reading them;
- a caller who may not correct as a restricted judge class
  (`judge-class-not-allowed`);
- the operator's identity-provider lock (`identity-providers-operator-managed`);
- reading the deployment's license (`GET /v1/license`) or its use
  (`GET /v1/license/usage`) without its own token or a system key holding
  `system:license`, unless you're an admin of its one tenant reading the
  license, where it's set up to serve one tenant (without
  `KINDGI_TENANCY=multi`) and its database holds only that one
  (`license-operator-only`);
- console token sign-in's refusals (`token-sign-in-not-allowed`,
  `token-sign-in-off`);
- a stdio MCP endpoint where the deployment runs no commands
  (`host-access-denied`).

Never kept, since they don't refuse the caller: `signer-not-trusted`,
`csrf-origin-mismatch` and `role-exceeds-principal`, a limit on the key
being minted. Nor is a refusal of a request with no principal behind it: a
public run token used outside its two progress routes, or correcting a run
without a user or a service token. A `401`, for an unknown caller, never is.

On runtime 0.3.0 or later, what a caller is shown about its own access isn't
kept either, allowed or not: whoami's `tenantAdmin`
(`GET /v1/identity/whoami`), `GET /v1/identity/me/permissions`, and a
judging queue item's `can` (whether you may dismiss or reopen it). A console
reads them often, to choose which pages and buttons to show, and none of
them lets the caller do anything. Each request it then makes is checked, and
kept, as above.

### In the console

**Access audit**, for tenant admins, lists the same decisions, 50 at a
time, newest first. Tenant admins are the only people its API answers.
**Next page** leads to the older ones. A denied one has a ✗ and a red row. Narrow
the list by who, on what, action, result (allowed or denied), and time with
From and To, which are in UTC like the times in the list. The filters are in
the page's address, so you can copy it to share what you see. Clicking a row
shows the decision: allowed or denied, the part that failed, such as
`actor`, how long the check took, the reason, the request's correlation id,
and the check it asked OpenFGA, which is the evidence.

## Next

- [People, API keys and service accounts](../people-and-keys/): add the
  people and accounts that authorization checks.
- [Turn on sign-in](../self-hosted/sign-in/): how people sign in to the console.
- [Back up and restore the runtime's database](../self-hosted/back-up-and-restore/):
  back up OpenFGA's database with the runtime's.
