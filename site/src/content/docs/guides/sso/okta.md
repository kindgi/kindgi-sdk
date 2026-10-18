---
title: Okta
description: Set up sign-in with Okta, as an OpenID Connect web app your workspace owns.
sidebar:
  order: 12
---

When you finish this page, your workspace's people sign in with their Okta
accounts, through an OpenID Connect app in your Okta organization.

:::caution[Not checked live]
These steps follow Okta's documentation and the CLI's own steps. No sign-in
through Okta has been checked.
:::

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **Someone who can create app integrations in your Okta organization,** and
  assign groups to them.
- **For `kindgi` commands:** Kindgi 0.1's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.1` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## 1. Get the redirect URI

`start` gives you the redirect URI to enter in Okta, and the steps to send
whoever runs your Okta organization:

```sh
npx --yes @kindgi/cli@0.1 sso providers start acme-okta --idp=okta
```

- `acme-okta` is the provider's id in your workspace.
- `--idp=okta` adds Okta's own steps to the message.

```text
Sign-in with "acme-okta" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-2c7kusqdhjluthweveerubty5q
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Okta admin console → Applications → Create App Integration → OIDC - OpenID Connect →
Web Application:
  1. Sign-in redirect URIs: the URI above.
  2. Assignments: the groups who may sign in.
  3. Copy the client ID and the client secret.
Issuer: https://<your-org>.okta.com

Step by step: https://docs.kindgi.com/v0.1/guides/sso/okta/

Then register it:
  kindgi sso providers finish acme-okta --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## 2. Create the app in the Okta admin console

Open **Applications → Create App Integration**. Choose the sign-in method
**OIDC - OpenID Connect**, and the application type **Web Application**:

1. **Sign-in redirect URIs:** enter the redirect URI that `start` printed.
2. **Assignments:** choose the groups who may sign in.
3. Copy the **Client ID** and the **Client secret**.

## 3. Store the client secret

Store the secret in Kindgi's secret store, by name, so it never travels by
email or chat:

```sh
npx --yes @kindgi/cli@0.1 secrets set ACME_OKTA_SECRET --env=production --scope=tenant
```

- `ACME_OKTA_SECRET` is the secret's name. The registration keeps only this
  name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.
Then it prints what it stored:

```text
Value:
Re-enter to confirm:
{
  "name": "ACME_OKTA_SECRET",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_OKTA_SECRET at tenant in production.
```

## 4. Register it

`finish` registers the app, and offers it to people at your domains:

```sh
npx --yes @kindgi/cli@0.1 sso providers finish acme-okta --kind=oidc --issuer=https://<your-org>.okta.com \
  --client-id=<client id> --client-secret-ref=ACME_OKTA_SECRET --domains=<your domain>
```

- `--issuer` is your Okta organization's URL. `<your-org>` is its name in
  that URL.
- `<client id>` is the **Client ID** from step 2.
- `--client-secret-ref` is the secret's name from step 3.
- `<your domain>` is your organization's email domain, such as `acme.com`.
  For more than one, separate them with commas.

`finish` prints the registration, as in
[Set up SSO](../#3-register-what-it-sent-back).

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
