---
title: People, API keys and service accounts
description: Add the people who work in a deployment, give them roles and their own API keys, give pipelines service accounts with only what they need, and remove someone in one step.
sidebar:
  order: 5.2
---

With [authorization](../authorization/) on, a tenant has **people**, each
with their own sign-in and API keys, and **service accounts**, which act for
a pipeline or an app. What each may do is kept in OpenFGA, so turn
authorization on first. A **tenant admin** adds them. The first one is the
runtime's seed user (`KINDGI_SEED_USER_ID`, or the API token's user), whom
the runtime makes a tenant admin at every start.

## Who can do what

- **A tenant admin** does everything in the tenant: adds and removes people,
  makes keys for anyone, and changes tenant-wide settings (providers,
  policies, signing keys, deployments, identity providers).
- **A tenant member** reads the tenant's settings (providers, policies,
  adapters, signing keys, deployments), not its projects. Everyone you add
  is one.
- **A role on a project** (`owner`, `admin`, `editor` or `viewer`) gives the
  work in it: its agents, runs and conversations
  ([Project memberships](../authorization/#project-memberships)).
- **A service account** has only what it's granted. It isn't a tenant member
  unless you make it one.

Lists hold only what the caller may read.

:::caution[One company per tenant]
Everyone in a tenant reads its settings. Give people from different
companies different tenants, not different projects of one tenant.
:::

## Add a person

```sh
kindgi people add --name="Sam Rivera" --email=sam@acme.example
```

It prints the new person, with their `id`, and says on stderr what being
added gives them: they read the tenant's settings, and need a project role to
work on its agents and runs. An email another person already has is refused
(`409 identity-user-email-taken`).

Then give them a role on a project. A tenant admin, or an admin of that
project, adds them by email or by id:

```sh
curl -X POST "$KINDGI_API_URL/v1/projects/<project-id>/memberships" \
  -H "Authorization: Bearer $KINDGI_API_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"sam@acme.example","role":"editor"}'
```

The email matches whatever its case, and the answer names the person. Here a
project admin added a viewer as `GUS@acme.test`:

```json
{"projectId":"ea6e0f95-301e-4017-b2d4-82590cc6ec64","userId":"74e4beb8-6aa4-47ef-9f2a-e0245ee62343","role":"viewer"}
```

Someone who isn't one of the tenant's people (or was removed) isn't added:

```json
{"error":{"code":"identity-user-not-found","message":"No one with email \"outsider@example.com\" is a member of this tenant","requestId":"req-304865e8-9499-48cd-afca-2f8c87e8f05d"}}
```

In the clients: `projects.memberships.add(projectId, { email, role })`
(TypeScript). Now they can [sign in to the console](../sign-in/), or use a
key you make them.

## Make someone a tenant admin

```sh
kindgi people grant <user-id> --tenant-admin
kindgi people ungrant <user-id> --tenant-admin
```

The grant holds from their next request. `kindgi people grants <user-id>
--table` lists what someone holds: tenant admin, tenant member, project and
team roles, and a reviewer role, as granted directly (what a team or an org
gives isn't expanded). Taking it away is refused in two cases:

- `409 last-tenant-admin`: they're the only one. Make someone else a tenant
  admin first.
- `409 seed-user-admin`: they're the seed user, whom the runtime makes a
  tenant admin again at every start. Unset `KINDGI_SEED_USER_ID` and restart
  the runtime first.

## API keys

Everyone can make their own keys:

```sh
kindgi tokens create --label=laptop --expires=30d
```

The secret is printed once, there: store it, because nothing shows it again.
`--expires` takes `30d`, `12h`, `90m` or a date; a key without it doesn't
expire.

- **For someone else** (a tenant admin only): `--for=user:<user-id>` or
  `--for=sa:<service-account-id>`.
- **`--role=member`** (the default) takes no admin action on the tenant, even
  for a tenant admin. A project admin's member key still manages that
  project's members. **`--role=admin`** is made only by a tenant admin, and
  only for a tenant admin (`403 role-exceeds-principal` for anyone else).
- **`--project=<project-id>`** limits the key to one project. A request that
  names another project is refused (`403 key-project-mismatch`).

`kindgi tokens list` lists your keys; a tenant admin sees everyone's
(`--for=user:<id>` for one person's). Someone else's key reads as `404`.
`kindgi tokens revoke <token-id>` refuses the key from its next request on,
with `401`.

## Service accounts

A service account is for a pipeline or an app: it has no sign-in, only keys,
and only the grants you give it.

```sh
kindgi service-accounts create acme-ci --description="Deploys from CI" --project=<project-id>:editor
kindgi tokens create --for=sa:<service-account-id> --label=ci --expires=90d
```

Its grants are written before `create` answers, so its first key works at
once. `--tenant-admin`, `--tenant-member` and `--project=<id>:<role>`
(repeatable) are what you can grant, now or later with
`kindgi service-accounts grant` and `ungrant`.

Give `--tenant-member` only to an account whose job reads the tenant's
settings. Without it, such a read is refused, and the refusal says how to
grant it.

`kindgi service-accounts unregister <service-account-id>` takes its grants
away, and its keys stop working.

## Who sees the tenant's people

Only a tenant admin lists them. Anyone else gets:

```json
{"error":{"code":"permission-denied","message":"Only a tenant admin lists the tenant's people","requestId":"req-6f9ecda9-4a1d-4ef4-83a8-c91d5c78e47f"}}
```

A person's record and sessions are for a tenant admin, or that person.

## Remove a person

```sh
kindgi people remove <user-id>
```

In one step, before it answers, their API keys are revoked (the next request
with one gets `401`), their sessions end, and every grant and membership is
taken away. Their record stays, so runs, approvals and the audit trail still
say who they were. Adding their email again makes a new person, with nothing
granted.

It's refused for yourself and for the seed user
(`identity-user-unregister-refused`), and for the only tenant admin
(`last-tenant-admin`). Removed people are left out of lists;
`kindgi people list --include-removed` shows them too.

## In the console

- **API keys** lists your keys (a tenant admin's, everyone's). **Create a
  key** makes one for you, or, for a tenant admin, for a person or a service
  account, with its role, project and expiry. The secret shows once, with a
  Copy button.
- **People** (tenant admins): **Add a person**, each person's roles in words,
  making or unmaking a tenant admin, a key for them, and removing them.
- **Service accounts** (tenant admins): create one with its grants, change
  them, make it a key, unregister it.

A project you have no role on shows **No access**, with the projects you can
open.

## Recorded

Each change is kept as evidence: `person-added`, `person-granted`,
`person-ungranted`, `person-unregistered`, `api-key-minted`,
`api-key-revoked`, `service-account-created`, `service-account-granted`,
`service-account-ungranted` and `service-account-unregistered`. A key's
secret is never in one.
