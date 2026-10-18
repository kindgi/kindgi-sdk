---
title: Another OpenID Connect provider
description: Set up sign-in with any OpenID Connect identity provider your workspace owns, and what Kindgi needs from it.
sidebar:
  order: 14
  label: OpenID Connect
---

When you finish this page, your workspace's people sign in through any
identity provider that speaks OpenID Connect. The page also lists what Kindgi
needs from that provider.

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **Someone who can create a web application in your identity provider.**
- **For `kindgi` commands:** Kindgi 0.1's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.1` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## 1. Get the redirect URI

`start` gives you the redirect URI to enter in your identity provider:

```sh
npx --yes @kindgi/cli@0.1 sso providers start acme-oidc --kind=oidc
```

- `acme-oidc` is the provider's id in your workspace.
- `--kind=oidc` asks for an OpenID Connect provider's redirect URI.

```text
Sign-in with "acme-oidc" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-lkwnp5mzjrocnhdwtd4dwjqy3m
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Step by step: https://docs.kindgi.com/v0.1/guides/sso/oidc/

Then register it:
  kindgi sso providers finish acme-oidc --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## 2. Create the app in your identity provider

Kindgi needs these from the app:

- **A web application, with a client secret:** a confidential client, using
  the authorization code flow, with the redirect URI that `start` printed.
- **The scopes `openid email profile`.**
- **A discovery document** at `<issuer>/.well-known/openid-configuration`.
  Kindgi reads the provider's endpoints from it when you register.
- **The person's email.** Kindgi refuses a sign-in without an email ("No
  email came back"). It also refuses one whose email the provider marks
  unverified ("Your email isn't verified").
- **An issuer on a public HTTPS address,** unless the runtime's operator
  allows its origin with `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`
  ([An identity provider on a private network](../#an-identity-provider-on-a-private-network)).

Copy the app's issuer URL, its client ID and its client secret.

## 3. Store the client secret

Store the secret in Kindgi's secret store, by name, so it never travels by
email or chat:

```sh
npx --yes @kindgi/cli@0.1 secrets set ACME_OIDC_SECRET --env=production --scope=tenant
```

- `ACME_OIDC_SECRET` is the secret's name. The registration keeps only this
  name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.
Then it prints what it stored:

```text
Value:
Re-enter to confirm:
{
  "name": "ACME_OIDC_SECRET",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_OIDC_SECRET at tenant in production.
```

## 4. Register it

`finish` registers the app, and offers it to people at your domains:

```sh
npx --yes @kindgi/cli@0.1 sso providers finish acme-oidc --kind=oidc --issuer=<issuer> \
  --client-id=<client id> --client-secret-ref=ACME_OIDC_SECRET --domains=<your domain>
```

- `<issuer>` is the app's issuer URL.
- `<client id>` is the app's client ID.
- `--client-secret-ref` is the secret's name from step 3. `finish` refuses a
  secret given as itself instead of by name.
- `<your domain>` is your organization's email domain, such as `acme.com`.
  For more than one, separate them with commas.

`finish` prints the registration, as in
[Set up SSO](../#3-register-what-it-sent-back).

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
