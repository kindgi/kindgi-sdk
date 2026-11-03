---
title: Microsoft Entra ID
description: Set up sign-in with Microsoft Entra ID, as a single-tenant OpenID Connect app your workspace owns.
sidebar:
  order: 11
---

When you finish this page, your workspace's people sign in with their
accounts in your Microsoft Entra ID directory, through an app registered for
that directory only.

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **Someone who can register apps in your Entra ID directory,** and assign
  people to them.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## 1. Get the redirect URI

`start` gives you the redirect URI to enter in Entra ID, and the steps to
send whoever runs your directory:

```sh
npx --yes @kindgi/cli@0.2 sso providers start acme-entra --idp=entra
```

- `acme-entra` is the provider's id in your workspace.
- `--idp=entra` adds Entra ID's own steps to the message.

```text
Sign-in with "acme-entra" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-ml6sriyaafkkzfsohwylwcarja
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Microsoft Entra admin center → App registrations → New registration:
  1. Supported account types: this organizational directory only (single tenant).
  2. Redirect URI: Web, the URI above.
  3. Copy the Application (client) ID and the Directory (tenant) ID.
  4. Certificates & secrets → New client secret: copy its Value (shown once). It expires:
     note the date.
  5. Enterprise applications → the app → Properties → Assignment required: Yes; then
     Users and groups: who may sign in.
Issuer: https://login.microsoftonline.com/<directory-tenant-id>/v2.0 (never `common`).

Step by step: https://docs.kindgi.com/v0.1/guides/sso/entra-id/

Then register it:
  kindgi sso providers finish acme-entra --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## 2. Register the app in the Microsoft Entra admin center

Open **Applications → App registrations → New registration:**

1. **Supported account types:** choose accounts in this organizational
   directory only, a single tenant.
2. **Redirect URI:** choose the platform **Web**, and enter the redirect URI
   that `start` printed.
3. **Overview:** copy the **Application (client) ID** and the **Directory
   (tenant) ID**.
4. **Certificates & secrets → New client secret:** copy its **Value**, not
   its "Secret ID". Entra ID shows it once. The secret expires on the date
   you choose.
5. **Enterprise applications →** the app **→ Properties → Assignment
   required:** choose Yes. Then, under **Users and groups**, add who may sign
   in.

Steps 1 to 4 of this section, and the issuer in
[Register it](#4-register-it), were checked with a sign-in through such an
app. Step 5 of this section comes from Microsoft's documentation. The app
needs no optional claims: Kindgi reads the person's email from
Microsoft's userinfo endpoint.

## 3. Store the client secret

Store the secret's **Value** in Kindgi's secret store, by name, so it never
travels by email or chat:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_ENTRA_SECRET --env=production --scope=tenant
```

- `ACME_ENTRA_SECRET` is the secret's name. The registration keeps only
  this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.
Then it prints what it stored:

```text
Value:
Re-enter to confirm:
{
  "name": "ACME_ENTRA_SECRET",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_ENTRA_SECRET at tenant in production.
```

Before the secret expires, add a new client secret in Entra ID, and store it
under the same name as a new version:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_ENTRA_SECRET --env=production --scope=tenant --write-mode=add-version
```

`--write-mode=add-version` adds a version to a secret that exists. It
prints what the first `set` printed, with the new version in `versionId`.
Without the flag, `set` refuses a name that's already taken:

```text
Value:
Re-enter to confirm:
Version conflict: ACME_ENTRA_SECRET already exists (version 1). To store a new version, retry with --write-mode=add-version.
```

The runtime keeps a secret it has read for up to a minute, so sign-ins use
the new version within a minute. Delete the old client secret in Entra ID
only after that.

## 4. Register it

`finish` registers the app, and offers it to people at your domains:

```sh
npx --yes @kindgi/cli@0.2 sso providers finish acme-entra --kind=oidc \
  --issuer=https://login.microsoftonline.com/<directory tenant id>/v2.0 \
  --client-id=<application client id> --client-secret-ref=ACME_ENTRA_SECRET --domains=<your domain>
```

- `--issuer` is your directory's own issuer.
  `<directory tenant id>` is the **Directory (tenant) ID** from step 2.
- `<application client id>` is the **Application (client) ID** from step 2.
- `--client-secret-ref` is the secret's name from step 3.
- `<your domain>` is your directory's email domain, such as `acme.com`. For
  more than one, separate them with commas.

`finish` prints the registration, as in
[Set up SSO](../#3-register-what-it-sent-back).

`finish` refuses the `common` issuer, because it would let in people from
any Entra directory:

```text
Error [identity-provider-invalid]: https://login.microsoftonline.com/common/v2.0 lets people from any Microsoft Entra directory sign in. Use your directory's own issuer, https://login.microsoftonline.com/<directory-tenant-id>/v2.0 (the app registration's Directory (tenant) ID), and register the app for a single tenant
```

## Not the same as "Continue with Microsoft"

This is your workspace's own identity provider: a single-directory app, and
only your directory's people. **Continue with Microsoft**, which accounts
from any directory can use, is a different app. It's registered for any
organizational directory, and whoever runs the runtime sets it up for the
whole deployment ([Turn on sign-in](../../../deploy/self-hosted/sign-in/#microsoft)).

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
