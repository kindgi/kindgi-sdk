---
title: Serve many tenants
description: Run one Kindgi runtime for many tenants who don't trust one another. Covers the settings it starts only with, the operator's system keys, creating tenants, a pack service for each deployment, and suspending, closing and purging a tenant.
sidebar:
  order: 3.9
---

A runtime serves one tenant by default, `KINDGI_TENANT_ID`'s. With
`KINDGI_TENANCY=multi` it serves many. Each tenant is created through the
system API, and each request's tenant comes from its key or session. This page
is for the operator: whoever runs the runtime, its database and the services
around it, for tenants who don't trust one another. The runtime's license
applies as on any deployment ([Licensing](../../../concepts/licensing/)).

Commands that take the operator's token read it from `$KINDGI_API_TOKEN`, and
the runtime's address from `$KINDGI_URL`.

## What changes

- **No tenant is set on the server.** `KINDGI_TENANT_ID` is refused: "KINDGI_TENANT_ID (or --tenant, or the config file's `tenant`) is refused with KINDGI_TENANCY=multi: a runtime serving many tenants takes each request's tenant from its key or session. Unset it."
- **Nothing else that names one tenant is taken either:**
  `KINDGI_SEED_USER_ID`, `KINDGI_PACK_DIR`, `KINDGI_DEV_CONSOLE_LOGIN`, the
  dev echo provider and the config file's `mcp.endpoints` are each refused,
  by name: "KINDGI_TENANCY=multi serves many tenants, so it refuses what names
  one: seedUserId (KINDGI_SEED_USER_ID)."
- **The deployment's own token is the operator's.** `KINDGI_API_TOKEN` has
  the full system capability, `kindgi:system`. It acts in no tenant and
  reaches `/v1/system/*` only.
- **A tenant's own identity provider is offered only on the domains you
  list** in `KINDGI_AUTH_VERIFIED_DOMAINS`
  ([Which domains find a workspace's identity provider](../sign-in/#which-domains-find-a-workspaces-identity-provider)).
  A runtime serving one tenant routes that tenant's domains with nothing to
  set. On a domain not listed, its people reach the provider only through
  its own link, and GitHub and the emailed link aren't refused to them
  ([Who gets in](../sign-in/#who-gets-in)).
- **The emailed sign-in link needs a captcha.** Without the Turnstile keys
  ([Sign-in links by email](../sign-in/#sign-in-links-by-email)), the start
  stops: "The emailed sign-in link on a runtime that serves several tenants
  needs a captcha: set KINDGI_AUTH_TURNSTILE_SECRET (or
  KINDGI_AUTH_TURNSTILE_SECRET_PATH) and KINDGI_AUTH_TURNSTILE_SITE_KEY."
- **Each tenant is created through `POST /v1/system/tenants`**, with its
  setup: its Default project and its authorization store.
- **The start sets nothing up per tenant.** After an upgrade that adds a
  step for each tenant, run [`tenants repair`](#after-each-upgrade-tenants-repair).
- **Background work** keeps up every tenant that's set up, and starts new
  work (schedules, deliveries, notices) only in the active ones.

The banner says so:

```text
  Tenants: many (KINDGI_TENANCY=multi), each created through POST /v1/system/tenants
  Token:   kgi_bt_… (provided), the operator's: kindgi:system, in no tenant, /v1/system/* only
  …
  Background work: upkeep in every tenant set up; new work (schedules, deliveries, notices) in the active ones
  …
  Tenant host access: isolated (stdio MCP endpoints refused; tenant-chosen hosts can't reach the metadata server, this host or private networks; providers can't sign in with this server's own credentials; KINDGI_TENANT_HOST_ACCESS)
  OpenFGA calls carry its preshared key (KINDGI_OPENFGA_PRESHARED_KEY)
  Pack services: one per deployment, at the endpoints recorded through the system API (1 allowed host pattern)
```

## The settings it starts only with

A runtime serving many tenants starts only with every setting that keeps them
apart, and the two that let you allow and count them:

| Setting | What it does |
|---|---|
| `KINDGI_TENANT_HOST_ACCESS=isolated` | What a tenant registers reaches public hosts only: not the metadata server, this host or private networks, and never with the server's own cloud credentials. The server then refuses `KINDGI_DEV`, `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow` and `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`. |
| `KINDGI_PACK_ROUTING=per-deployment` | Each call goes to the pack service of the newest deployment in the run's project that shipped the tool or check, never to one pack service every tenant shares. A run with no project uses the Default project, whose deployments include each one that named no project. It needs `KINDGI_SECRETS_BACKEND=postgres`, because each endpoint's token is sealed under the secrets' key. `KINDGI_PACK_SERVICE_URL`, `KINDGI_PACK_SERVICE_TOKEN` and `KINDGI_PACK_SERVICE_AUTH` are refused. |
| `KINDGI_PACK_ENDPOINT_HOSTS` | The hosts a deployment's pack service may be on, comma-separated: a host name, `*.` and a domain, or `*-`, a tail and a domain. |
| `KINDGI_OPENFGA_API_URL` and `KINDGI_OPENFGA_PRESHARED_KEY` | The authorization store, and the key it requires of its callers, so only the server reads and writes tenants' grants ([Require a key for OpenFGA](../../authorization/#require-a-key-for-openfga)). |
| `KINDGI_PRODUCTION_GATE=on` | A tenant puts a project in production only once you allow it ([Limits and production](#limits-and-production)). |
| `KINDGI_USAGE_METERING=on` | Each run is counted when it's created and when it ends, so tenants' limits read what each one did. |

A start that lacks any of them is refused, naming each, and exits 2:

```text
KINDGI_TENANCY=multi serves tenants who don't trust one another, so it starts only with the hosted profile's settings: KINDGI_PACK_ENDPOINT_HOSTS must name the hosts a deployment's endpoint may be on (it's empty, so every endpoint would be refused).
```

[Environment variables](../../../reference/env-vars/) has each setting in
full.

At every start, the server checks that OpenFGA takes its key. If OpenFGA
refuses the server's call, the start stops, exits 1 and names the settings to
fix. If OpenFGA doesn't answer, the start goes on and logs a warning: "OpenFGA at
<url> isn't answering (…). The server is up; requests that need authorization
fail until it answers."

## The operator's keys

Keep the deployment's own token for yourself. Give each service that acts for
you, such as sign-up, the service that runs pack services, or billing, its
own **system key** (`kgi_sy_…`), with the least scope it needs:

| Scope | What it reaches |
|---|---|
| `system:tenants` | Creating, listing, reading, renaming and closing tenants |
| `system:tenants:create` | Creating tenants only: each with a first admin, production blocked, no image repository, not a test tenant |
| `system:tenants:image-prefix` | Setting a tenant's image repository |
| `system:tenants:production` | A tenant's production switch |
| `system:tenants:limits` | A tenant's limits |
| `system:tenants:contacts` | A tenant's admins' contact addresses, for service notices |
| `system:tenants:purge` | [Purging a closed tenant](#close-and-purge-a-tenant), once its window has passed (runtime 0.1.10 or later). No other scope includes it |
| `system:suspend` | Suspending and restoring a tenant, a project or a pack |
| `system:deployments` | The deployments and their pack services' endpoints |
| `system:pack-env` | The values each deployment's pack declares, for its pack service, and the revision it runs (runtime 0.1.9 or later). On a key of its own: the deployments key reads no value, and only a key holding this scope itself, not `kindgi:system`, reads a secret's |
| `system:license` | Reading the deployment's license, for its renewal |
| `kindgi:system` | All of them: a full key |

```sh
curl -sS -X POST "$KINDGI_URL/v1/system/keys" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"scopes": ["system:deployments"], "label": "pack services", "expiresAt": "2027-10-01T00:00:00Z"}'
```

- **The token comes back once,** in the answer's `token`.
- **A system key acts in no tenant.** Every tenant route refuses it
  (`system-key-on-tenant-route`). `GET /v1/system/whoami` tells a service
  which key it holds.
- **Only the full capability mints, lists and revokes keys.** A key can't
  outlive the key minting it. A full key minted by another system key needs
  an `expiresAt`, so only the deployment's own token mints one that never
  expires.
- **Revoking a key revokes every key minted from it,** however deep:
  `POST /v1/system/keys/{keyId}/revoke`.
- **Every request a system key makes is recorded,** and a request to the
  system routes that changes something is recorded before it acts. When
  that record can't be written, nothing is done
  (`access-record-unavailable`).

## Create a tenant

```sh
curl -sS -X POST "$KINDGI_URL/v1/system/tenants" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "name": "Acme Store",
    "slug": "acme-store",
    "imagePrefix": "registry.acme.com/tenants/acme-store",
    "firstAdmin": { "email": "pat@acme-store.example", "name": "Pat" }
  }'
```

- **With `firstAdmin`,** that person becomes the tenant's admin and member by
  email, and signs in with the runtime's own sign-in
  ([Turn on sign-in](../sign-in/)). No key comes back: once signed in, they
  make the tenant's keys ([API keys](../../people-and-keys/#api-keys)).
- **Without `firstAdmin`,** the answer carries the tenant's first admin key,
  once. Store it, because nothing shows it again. Only the full capability
  creates a tenant that way.
- **A tenant whose admins can't sign in any more** (runtime 0.1.9 or later):
  `kindgi-runtime tenants make-admin` makes one of its people its admin, or a
  new person by email, with what a first admin holds: every capability but
  `secrets:reveal`, which no person is given. They then sign in and make the
  tenant's keys, so it needs sign-in turned on ([Turn on sign-in](../sign-in/)).
  Like [`tenants repair`](#after-each-upgrade-tenants-repair), it runs
  against the runtime's database and authorization store. Run it with
  `--dry-run` first, which says what would change and changes nothing:

  ```sh
  kindgi-runtime tenants make-admin <tenant id> \
    --email pat@acme-store.example --name Pat \
    --reason "Pat can't sign in; checked with Acme Store" --dry-run
  ```

  `--person <user id>` names one of its people instead, who must be a
  tenant member. Nothing is taken from anyone. If it stops partway, run it
  again with the same arguments to finish it. What it does is in the
  tenant's audit log, by `system`, which the tenant's admins can read:
  making them admin and what that gives them carry your `--reason`.
- **A tenant created without `firstAdmin` whose admin key is lost** (runtime
  0.2.0 or later): `kindgi-runtime tenants admin-key` mints it again. The
  live keys of the tenant's "First admin" service account are revoked, and
  the console sessions they opened end. Then one key is minted for it,
  carrying what the first one did: tenant admin, and the tenant's root
  capabilities, `secrets:reveal` among them. It runs against the runtime's
  database. Run it with `--dry-run` first:

  ```sh
  kindgi-runtime tenants admin-key <tenant id> \
    --reason "Acme Store's admin key was lost; checked with Acme Store" --dry-run
  ```

  The key is printed once, alone, on stdout, so it can go straight into a
  secret store; the rest is said on stderr. With `--dry-run`, nothing is
  minted, and what would change is said on stdout. It's refused when one of
  those keys has a use recorded, unless `--revoke-used`: a key that was used
  was received, and someone may be holding it. A use is recorded at most once
  a minute, so a key used just now may not show it yet. A suspended tenant
  gets the key too, as does a closing one inside its 30-day export window; a
  closing tenant past that window is refused. Each key revoked, and the key
  minted, is in the tenant's audit log, by `system`, with your `--reason`. It
  exits `0` when the key is minted, `1` when it's minted but an audit entry
  couldn't be written or a revoked key's sessions couldn't be ended, and `2`
  when it's refused and nothing changed. A tenant created with `firstAdmin`
  has no such account: `tenants make-admin` makes a person its admin.
- **Production starts blocked.** `"productionAllowed": true` allows it from
  the start, and takes `system:tenants:production`.
- **`imagePrefix`** is the repository every image the tenant deploys must
  sit in, `<host>/<path>`. Without one, the tenant can't register a
  deployment. You can set it later, with `PUT /v1/system/tenants/{tenantId}/image-prefix`:

  ```json
  {
    "error": {
      "code": "image-prefix-unset",
      "message": "This tenant has no image repository set, so it can't register a deployment yet: its operator sets one.",
      "requestId": "req-f5000e71-d1ec-4ae8-984b-1778ece7b597"
    }
  }
  ```

- **Send an `Idempotency-Key` with every create.** If the setup didn't
  finish, the tenant waits, frozen, and the same request finishes it. A repeat
  with the first request's key gets the first answer again, except an admin
  key, which is never sent twice. Without the key, a lost answer can't be told
  apart from another tenant's slug (`tenant-slug-taken`).
- **A setup left pending shows at every start:** the log names each tenant
  (the first 10; it counts the rest, and `tenants repair --all` names them
  all) and says to retry the same create, or to run
  `kindgi-runtime tenants repair --tenant <id>` if its create named a first
  admin.

**Rename a tenant** (runtime 0.1.10 or later) with
`PATCH /v1/system/tenants/<tenant id>` and `{ "name": …, "slug": … }`,
either or both, under `system:tenants`. It answers `204`, and its id stays. Its own admins can do the same with
`PATCH /v1/tenant`. The slug follows the create's rules, and a taken one is
refused with `tenant-slug-taken`. A closing tenant, or one whose setup is
pending, can't be renamed (`409 tenant-closing`, `409 tenant-setup-pending`).
Neither can a slug that `KINDGI_AUTH_VERIFIED_DOMAINS` names
(`409 tenant-slug-in-config`): see [Turn on sign-in](../sign-in/).

## A pack service for each deployment

Each deployment runs in its own pack service, which you run: an orchestrator,
or a script, with a `system:deployments` key. The runtime records where each
service is, and checks it. It never creates or deletes one.

1. **List the deployments that need a service:**
   `GET /v1/system/deployments?endpoint=missing`, oldest first across tenants.
   A deployment needs one while it's routed: it's the newest in its project
   with routes for some tool version or pack check, it has no endpoint or a
   cleared one, and nothing about it is closing or suspended. Each entry has
   the tenant's id, the deployment's id, its pack and project (the one it
   named, else the tenant's Default), and its image: the digest-pinned
   `imageRef`, its digest, the artifact version and when it went live. It
   has nothing else of the tenant.
2. **Run the image as a service** whose host begins with the deployment's own
   service name, `packServiceName(tenantId, deploymentId)` from `@kindgi/api`
   (`kp-` and 20 characters), then `-` or `.`. Give it a token of its own,
   its `KINDGI_PACK_SERVICE_TOKEN`: 16 to 512 printable characters, no
   spaces.

   If its pack declares an environment (runtime 0.1.9 or later), read it
   first, with a key of its own holding `system:pack-env`:
   `GET …/deployments/{deploymentId}/pack-env` gives each declared name's
   plain value (`env`) and the `revision` they make. Ask with
   `?secrets=values`, and a name set only as a secret is given too, in
   `secrets`, read at the version the revision names. Give the service those.
   If it names a `problem` instead, it gives no value: start nothing, and say
   why (step 4).
3. **Record its endpoint:**

   ```sh
   curl -sS -X PUT "$KINDGI_URL/v1/system/tenants/$TENANT_ID/deployments/$DEPLOYMENT_ID/endpoint" \
     -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_SYSTEM_KEY") \
     -H 'Content-Type: application/json' \
     -d @<(printf '{"url": "https://%s", "auth": "token", "token": "%s"}' "$SERVICE_HOST" "$PACK_TOKEN")
   ```

   `auth` is `token`, or `google-id-token` to add an ID token for the URL
   (Cloud Run's invoker check). The runtime records the endpoint only once
   every check passes:
   - the URL is `https://<host>` (`endpoint-url-invalid`);
   - its host is in `KINDGI_PACK_ENDPOINT_HOSTS` (`endpoint-host-not-allowed`);
   - its host names the deployment's service (`endpoint-name-mismatch`);
   - the image is in the tenant's repository (`image-not-allowed`);
   - the service answers `/v1/info` as this deployment, with the
     `kindgi-tenant-id` header (`endpoint-unreachable`, `endpoint-info-mismatch`).

   The deployment is then `ready`. A refusal is also recorded as the
   deployment's problem, and the tenant sees its code. For a pack that
   declares an environment, also send the `revision` you gave the service, as
   `packEnvRevision`.
4. **While you can't make a service, say why:**
   `PUT …/deployments/{deploymentId}/endpoint/problem` with a `code`:
   `tenant-not-provisioned`, `capacity-unavailable`, `service-start-failed` or
   `image-not-allowed`. For its environment (runtime 0.1.9 or later):
   `pack-env-missing` (a required name is set nowhere), `pack-env-ambiguous`
   (set both as a secret and as a plain value) or `pack-env-secret-not-yet`
   (set only as a secret, read without `secrets=values`). With
   `secrets=values`, every secret value the route gives is audited, one row
   per secret, before the answer. When those rows can't be written, or the
   secret store is out, it gives none (`503 pack-env-unavailable`): try
   again. A secret that can't be read for a reason the platform fixes is
   `pack-env-secret-unreadable`, a runtime with nowhere to audit one refuses
   with `501 pack-env-secrets-unaudited`, and a secret over 32768 bytes is
   more than a pack service can be given (`pack-env-secret-too-large`):
   record the code. Record `pack-env-secret-capacity` when there's no room
   just now for a service that can be given a secret, kept apart from other
   projects': try again. The tenant sees the code and when, so a deploy that
   waits for its pack service says why at once.
5. **Give a running service its changed environment** (runtime 0.1.9 or
   later): `GET /v1/system/pack-env` lists the deployments with a `ready`
   service whose values changed since the revision it runs: ids, the image
   and the revision each runs, never a value. Read each one's values, start
   its service again with them, and record it: `PUT …/pack-env` with the new
   `revision` and the `appliedRevision` it was listed with. Another revision
   recorded since is `pack-env-conflict`. If the values can't be given, or
   the new revision didn't start, send `held` with the code instead
   (`pack-env-update-failed` for one that didn't start): the service keeps
   what it runs, and the tenant sees the code. One held as
   `pack-env-update-failed` stays listed for an hour after it was first
   held, so you try it again. After that it's listed again only when its
   values change. One held as `pack-env-secret-unreadable` or
   `pack-env-secrets-unaudited` is listed every time, with its `held`, since
   the platform fixes those and its revision doesn't move: read it again on
   your own back-off. If a running service can't be given a secret where you
   run it, and a name is now set only as one, hold it as
   `pack-env-secret-redeploy`: a new deployment's service can be given it,
   from a new build of the pack.
6. **Retire what should go:** `GET /v1/system/deployments?endpoint=retire`
   lists deployments with an endpoint whose service should go, each with its
   `reason`. Clear the endpoint first, with `DELETE …/endpoint`, then delete
   the service. A `superseded` deployment is one whose every tool version and
   check newer deployments in its project ship.

A call to a deployment's tool never goes anywhere else. With no endpoint yet
it fails with `pack-endpoint-pending`, and after a clear with
`pack-endpoint-cleared`. A tenant sees its deployment's `endpoint`: `pending`
(with the problem, if one is recorded), `ready` or `cleared`.

A call never goes to a deployment in another project, either. When no
deployment in the run's project ships what it names, it fails with
`pack-route-missing`:

```text
No deployment in project "<project name>" ships tool acme.lookup@1.0.0.
```

A call run again stays on the deployment it first ran on. If that
deployment isn't in the run's project, or doesn't ship what the call names:

```text
Deployment <deployment-id> isn't in project "<project name>", or doesn't ship tool acme.lookup@1.0.0. This call first ran on deployment <deployment-id>, and a re-run doesn't move to another.
```

## Limits and production

- **Limits:** `GET` and `PUT /v1/system/tenants/{tenantId}/limits`
  (`system:tenants:limits`). `PUT` replaces them all: a limit left out isn't
  set, and isn't enforced. Read them, change one, and put them all back. The
  tenant reads its own on `GET /v1/tenant`.
- **Production:** `PUT /v1/system/tenants/{tenantId}/production-allowed` with
  `{"allowed": true}` (`system:tenants:production`). Until then, putting a
  project in production is refused with `403 production-not-allowed`, and
  projects already in production stay so.
  `KINDGI_PRODUCTION_NEXT_URL` names where a refused tenant goes to be
  allowed
  ([Put a project in production](../../../guides/projects/organize-by-org-and-project/#put-a-project-in-production)).
  The `projectsInProduction` limit caps how many of its projects are in
  production at once.

## Suspend and restore

Suspending takes `system:suspend`, which no other scope includes, and can
record a `reason`. A second suspend keeps the first one's time and reason, and
restoring clears both. A closing tenant can't be suspended (`409 tenant-closing`).

- **A tenant:** `PUT /v1/system/tenants/{tenantId}/suspended` with
  `{"suspended": true, "reason": "…"}`. It takes hold within 5 seconds. Its
  own keys and sessions still read and export it. Nothing runs (its
  unfinished runs are cancelled, waiting ones included), and any other
  write is refused (`409 tenant-suspended`), but for deletes, signing in
  and out, revoking, and erasing or searching memory. Its schedules and
  triggers are skipped, not changed, and a webhook whose signature checks
  is answered `202` and skipped. At the restore, nothing that came due
  meanwhile runs late: a schedule fires next at its first time after the
  restore.
- **A project:** `PUT /v1/system/tenants/{tenantId}/projects/{projectId}/suspended`.
  Nothing new runs in it (`409 project-suspended`), and no pack service's
  endpoint is recorded for it. Its unfinished runs are cancelled, waiting
  ones included. Its schedules and webhooks are skipped, and its
  deployments list to retire. The rest of the tenant is untouched. While
  the Default project is suspended, a pack call that names no project is
  refused too.
- **A pack:** `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/suspended`.
  Its calls fail with `pack-suspended`, never going to an older deployment,
  and it lists to retire. Restored, it serves again from the endpoint
  recorded for it. If its endpoint is pending, or was cleared meanwhile, it
  lists as needing a pack service.

## Close and purge a tenant

`POST /v1/system/tenants/{tenantId}/close` starts the end of the tenant's
contract, and there's no way back. The tenant is `closing`. For its 30-day
export window, its own keys and sessions still read and export it, and its
people can still sign in. Nothing runs (its unfinished runs are cancelled,
waiting ones included), and writes are refused as for a suspended tenant,
with `409 tenant-closing`. Its deployments list to retire.

Once the window has passed, purge it. Its keys and sessions go with its
rows. Until then, nothing of the tenant runs, and it writes only deletes,
revokes, erasures, exports and sign-ins. One of those during the purge can
leave a row: the purge names it, and running it again finishes it.

When nothing of the tenant is left, the purge writes its record and marks it
purged. Each server keeps a tenant's state for about 5 seconds, so within
about 5 seconds of the mark nothing of it signs in or is served. The purge
waits three times that, then deletes again: work of the tenant under way at
the mark, such as a request that started before it, can still write a row.

Purge it through the system API, or with `kindgi-runtime tenants purge`
where the runtime's database is reachable. Both run the same purge.

### Through the system API

`POST /v1/system/tenants/{tenantId}/purge` (runtime 0.1.10 or later) takes a
system key holding `system:tenants:purge`, or `kindgi:system`. No other scope
includes it: give it to the tooling that ends accounts, and to nothing else.

```sh
curl -sS -X POST "$KINDGI_URL/v1/system/tenants/$TENANT_ID/purge" \
  -H "Authorization: Bearer $KINDGI_SYSTEM_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"confirm": "acme-shop"}'
```

- **`confirm` is the tenant's slug,** a second check on the id. Another
  value is `400 tenant-slug-mismatch`, and nothing is changed.
- **The servers need `KINDGI_TENANT_PURGE_RECORD`:** where purge records
  are kept, `local:<absolute dir>` or `gcs:<bucket>[/<prefix>]`, the same
  place as the command's `--record`. Unset, every purge is refused with
  `409 purge-record-unset`: without a record, restoring a backup taken
  before the purge would bring the tenant back, with nothing to purge it
  again ([`kindgi-runtime tenants repurge`](#after-a-restore-tenants-repurge)
  reads the records after a restore).
- **It answers when it's done,** after its wait. The answer names each
  table's rows it deleted (`deleted`), the objects deleted from the
  artifacts' store (`objectsDeleted`), and whether its authorization store
  went (`authzStoreDeleted`).
- **One purge of a tenant runs at a time,** through this route or with
  `kindgi-runtime tenants purge`: a second waits for the first to finish,
  then runs. Every 30 seconds of waiting, the server logs
  `tenant purge: waiting for another purge of the tenant to finish`, with
  `tenantId` and `waitedSeconds`, under the
  [subsystem](../logs/#the-subsystems) `tenants.purge`.
- **`complete: true`:** nothing of it is left, its record is written, and
  it's marked purged at `purgedAt`. **`complete: false`:** `left` and
  `objectsLeft` say what is, and `leftBecause` why, when it's a setting the
  runtime lacks. Run it again. A call that ended before its answer is
  finished the same way. Each run again is a new request: a new
  `Idempotency-Key`, or none.
- **Refused, with nothing changed:** a tenant that isn't closing
  (`409 tenant-not-closing`), or whose window is still open
  (`409 tenant-export-window-open`, with `windowEndsAt`), and one with
  artifacts or an authorization store when the server has no
  `KINDGI_ARTIFACTS` or `KINDGI_OPENFGA_API_URL` (`409 purge-setting-missing`).
- **A failed delete of its OpenFGA store** is `502 authz-store-delete-failed`,
  and its message says what that left. A tenant's rows go only after its
  store, so by then its artifacts' bytes may be deleted, but none of its
  rows. Run it again once OpenFGA answers.
- **A day later,** run it again. On a tenant already purged, it deletes
  anything of it written since its mark (`alreadyPurged: true`), and its
  mark and its record stay as they were. Nothing should write to a tenant
  a day after its mark, so report any tables it names.
- **Every call is on the operator's access record,** with its key, the
  tenant and its outcome, a refusal too.

### With kindgi-runtime

```sh
kindgi-runtime tenants purge <tenant id> --confirm <tenant slug> --record <where>
```

```text
tenants purge: tenant 1ccae8e9-3dc8-4db9-b393-ba3d44e7f86e (acme-shop)
  artifacts: 1 row deleted
  audit_events: 4 rows deleted
  authz_store_registry: 1 row deleted
  identity_users: 1 row deleted
  adapter_registry: 6 rows deleted
  memory_erasures: 1 row deleted
  memory_facts: 2 rows deleted
  projects: 1 row deleted
  artifacts' bytes: 1 deleted
  OpenFGA store: 01M4WPFNJJ7YY6RXSJK1KB9W7D deleted
  No table holds a row of it now, and no bytes are under its prefix; its tenants row stays, marked purged.
  record: purged/1ccae8e9-3dc8-4db9-b393-ba3d44e7f86e.json written
```

- **It deletes the tenant for good:** every row of it, its artifacts' bytes and
  its OpenFGA store. Its tenants row stays, marked purged, with nothing left
  that signs in.
- **`--dry-run`** says what would be deleted, and changes nothing.
- **Refused (exit 2)** for a tenant that isn't closing or is still in its
  window, or one with artifacts or an OpenFGA store when `KINDGI_ARTIFACTS`
  or `KINDGI_OPENFGA_API_URL` isn't set as the server has it. **Exit 1** when rows or bytes of it are left, named: run it again.
- **With a key for OpenFGA**
  ([Require a key for OpenFGA](../../authorization/#require-a-key-for-openfga)),
  purging a tenant with an OpenFGA store needs runtime 0.1.9 or later. An
  earlier one doesn't send the key, or the ID token behind Cloud Run IAM, so
  the store's delete is refused, and the purge exits `2` with
  `OpenFGA answered <status> to deleting store <id>`.
  By then the tenant's artifacts' bytes are deleted, but none of its rows.
- **Exit 1, too, when work in flight at the mark wrote rows of it:** each
  is named (`written after its mark: …`) and deleted. One that needs a
  setting the run doesn't have is left, with why (`written after its mark,
  not deleted: …`): run it again with that setting, or report it.
- **A day later,** run it again with `--dry-run`, and without it if it
  lists anything. On a tenant already purged, the purge deletes what's of
  it, and its mark and its record stay as they were. Nothing should write
  to a tenant a day after its mark, so report the tables it names.
  `kindgi-runtime check purged-tenants` lists every tenant marked purged
  that still holds rows, by table and count: rows only, not the bytes under
  its prefix.
- **`--record`** (`local:<dir>` or `gcs:<bucket>[/<prefix>]`) keeps a record
  of each purge, `purged/<tenant id>.json` under it. After a restore,
  [`tenants repurge`](#after-a-restore-tenants-repurge) reads them.
- **One purge of a tenant runs at a time** (runtime 0.1.10 or later): a
  second, here or through the system API, waits for the first to finish.
  Every 30 seconds of waiting it says
  `tenants purge: waiting for another purge of tenant <id> to finish (30 s so far)`
  on stderr. `tenants repurge` waits the same way, tenant by tenant:
  `tenant <id>: waiting for another purge of it to finish (30 s so far)`.

### After a restore: tenants repurge

A backup taken before a tenant's purge brings the tenant back with its data,
and [replaying the erasure ledger](../back-up-and-restore/) doesn't purge it.
After a restore, before the runtime serves anyone, purge every purged tenant
again:

```sh
kindgi-runtime tenants repurge --from <where> --ledger <where>
```

- **Two sources name the tenants:** the purge records under `--from`
  (`local:<dir>` or `gcs:<bucket>[/<prefix>]`, where `--record` and
  `KINDGI_TENANT_PURGE_RECORD` write them), and the newest copy of the
  erasure ledger under `--ledger` (runtime 0.1.10 or later), which names
  every tenant purged before it was written, however long ago. A record can
  be gone, deleted by a bucket's retention rule, say; the copy still names
  its tenant. A tenant both name is purged once.
- **`--ledger`** takes what `erasures replay --from` takes: a directory, a
  bucket, or one file by its absolute path. Left out, it's
  `KINDGI_ERASURE_LEDGER_EXPORT`, where the server writes its copies. With
  neither, it goes by the records alone, and says so:
  `No --ledger or KINDGI_ERASURE_LEDGER_EXPORT: the records alone, so a tenant whose record is gone isn't found.`
  With no copy where it looks, it stops:
  `tenants repurge: no copy of the erasure ledger in <where>.`
- **One bucket can hold both,** for example the records under `purged/`
  (`--from gcs:<bucket>`) and the server's copies under `runtime/`
  (`--ledger gcs:<bucket>/runtime`). Reading a bucket, it lists and
  downloads, so whatever runs it needs read access to it, as
  [replay](../back-up-and-restore/) does.
- **Run it with `--dry-run` first,** and nothing changes. Its first line
  says what it read:
  `tenants repurge --dry-run: <n> purge records, and the ledger's copy <file> (written <when>; <n> purged tenants). Nothing will be changed.`
  A copy names purged tenants when runtime 0.1.10 or later wrote it. An
  earlier one says `version 1, which names no purged tenant`, and only the
  records name tenants then. A line for each tenant follows, by id and
  slug, with what named it (`its record`, `the ledger's copy`, or both) and
  what a run would do: `would be purged again`, with its state and what it
  holds;
  `already purged; what was written of it after its mark would be deleted`;
  or `already purged, and nothing of it is left`.
- **Each tenant is purged again,** whatever its restored row says: a restore
  can bring it back active, or closing. On one still marked purged, it
  deletes what's of it, and leaves its mark and its record as they were.
- **Skipped or refused:** a tenant the database doesn't have is skipped
  (`not in this database, skipped`). One whose record or entry in the copy
  isn't its own is refused, and named. That's checked by when the tenant was
  created, which a rename doesn't change
  (`refused: its record's createdAt isn't this tenant's.`), and, for a
  record without a creation time, by the tenant's slug.
- **Exit `0`:** done. **`1`:** rows of a tenant are left, named
  (`tenant <id>: left: <table>: <n> rows`): run it again. **`2`:** a tenant
  was refused, as above or for a setting the run lacks (artifacts or an
  OpenFGA store, and no `KINDGI_ARTIFACTS` or `KINDGI_OPENFGA_API_URL`), or
  it couldn't run.

## After each upgrade: tenants repair

A runtime serving many tenants sets nothing up for each tenant when it starts.
After every upgrade that adds a step for each tenant, run this once:

```sh
kindgi-runtime tenants repair --all
```

```text
tenant 5b52fd42-bd2b-4597-b324-84ec1a7033a4 (tenant-1792242381807-ed3afb): Default project kept; authorization store kept; 0 tuples added; 0 memberships and 0 service account grants put back; adapters: 6 kept up to date, 0 removed; sign-in providers reconciled
1 tenant repaired.
```

It adds only what's missing: the Default project, the authorization store's
tuples and current model, the access each active person and service account
has on record (a person's tenant membership, a service account's grants), the
shipped adapters, and the sign-in providers. It
finishes a create whose setup didn't finish, if the create named a first
admin. Run it again at will. `--tenant <id>` repairs one tenant.
`--providers` redoes only sign-in's providers, after `KINDGI_PUBLIC_URL`
changes. It exits 0 when every tenant is set up, and 1 when something is left
for you, named:

```text
tenant f309aaca-024a-4fb9-aff8-ef76c4c40e16 (tenant-a): Default project created; no authorization store, and none can be made without naming its first admin: left for the operator; 0 tuples added; adapters: 6 kept up to date, 0 removed; sign-in providers reconciled
1 tenant gone through; 1 left for the operator (named above).
```

## Switch a one-tenant runtime to many

The first start with many tenants keeps the tenant it served, with its data,
keys and people, as the first of many.

1. **Run OpenFGA with a preshared key,** and point the runtime at it
   ([Require a key for OpenFGA](../../authorization/#require-a-key-for-openfga)).
2. **[Upgrade](../operate/#upgrade-the-runtime) and start it still as one
   tenant,** `KINDGI_TENANT_ID` kept. If the tenant has no authorization
   store yet, because it ran without OpenFGA, that start sets one up. Going
   straight to many tenants would leave it without one, and `tenants repair`
   can't make one.
3. **Start it with many tenants:** `KINDGI_TENANCY=multi` and the
   [settings above](#the-settings-it-starts-only-with), with
   `KINDGI_TENANT_ID`, `KINDGI_SEED_USER_ID` and the rest that name one
   tenant removed ([What changes](#what-changes)). If the tenant has its own
   identity provider, list its domains in `KINDGI_AUTH_VERIFIED_DOMAINS`. If
   the emailed sign-in link is on, set the Turnstile keys: the start stops
   without them. `KINDGI_API_TOKEN` is now the operator's and acts in no
   tenant, so whoever used it as the tenant's admin needs another way in
   first. A tenant key minted before the switch keeps working, and so does
   the tenant's sign-in.
4. **Run `kindgi-runtime tenants repair --all`** once. Until it runs, the
   people and service accounts added while the tenant ran without OpenFGA
   are refused: the start in step 2 makes only the seed user an admin. The
   repair gives them back the access their records show.
5. **Set the tenant's image repository:**
   `PUT /v1/system/tenants/{tenantId}/image-prefix` with `{"prefix": "<host>/<path>"}`.
6. **Deploy each pack again.** Its deployments from before have no routes,
   and the banner says how many:

   ```text
     ⚠ Per-deployment routing: 1 deployment registered before it has no routes; deploy it again. The same image is enough.
   ```

   Its `endpoint` is then `pending` until you record its pack service.

## Next

- The system routes in full:
  [system tenants](../../../reference/api/operations/tags/system-tenants/),
  [system keys](../../../reference/api/operations/tags/system-keys/) and
  [system deployments](../../../reference/api/operations/tags/system-deployments/).
- [Back up and restore](../back-up-and-restore/), then `tenants repurge`.
