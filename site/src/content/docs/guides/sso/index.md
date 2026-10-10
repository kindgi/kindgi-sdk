---
title: Set up SSO
description: Let your workspace's people sign in with your organization's identity provider (Google Workspace, Microsoft Entra ID, Okta, Keycloak, or any OpenID Connect or SAML provider), set up from the CLI.
sidebar:
  order: 0
  label: Set up SSO
---

Your workspace can have its own identity provider: people then sign in with
your organization's accounts, with its rules and multi-factor sign-in. Kindgi
offers it to anyone whose email is on your domains, and lets in only the
people you've added.

Setting it up takes two people: you, an admin of the workspace, and whoever
runs your identity provider ("IT" below). You start in the CLI and get what
to send IT. IT creates the app on their side and sends back what it gave
them. You register it, and try it.

**Before you start:** sign-in must be on for this runtime, and your domain
verified for your workspace ([Turn on sign-in](../../deploy/sign-in/)).

## 1. Start: what to send IT

```sh
kindgi sso providers start acme-kc --idp=keycloak
```

```text
Sign-in with "acme-kc" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-ibhu3tdkkrjjjfllbjpu2uk3gm
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Keycloak admin console → your realm → Clients → Create client → OpenID Connect:
  1. Client authentication: On. Authentication flow: Standard flow.
  2. Valid redirect URIs: the URI above (exactly; no wildcard).
  3. Credentials tab: copy the client secret.
  4. Each person needs an email with "Email verified" on, or sign-in is refused.
Issuer: https://<keycloak-host>/realms/<realm>

Step by step: https://docs.kindgi.com/v0.1/guides/sso/keycloak/

Then register it:
  kindgi sso providers finish acme-kc --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

`acme-kc` is the provider's id in your workspace: pick one per identity
provider. `--idp` adds that provider's steps; your identity provider's page
below has them in full. A SAML provider starts with `--kind=saml` instead, and
gets the URLs a SAML app asks for. The URLs are made from the runtime's
`KINDGI_PUBLIC_URL`, and stay the same after you register, after any
`update`, and if you remove the provider and register it again under the
same id.

## 2. IT creates the app

IT follows your identity provider's page below, with exactly the redirect
URI `start` printed. Then IT stores the client secret in Kindgi's secret
store, by name, so it never travels by email or chat:

```sh
kindgi secrets set ACME_KC_SECRET --env=production --scope=tenant --from-stdin
```

`--env` is the runtime's env (`KINDGI_ENV`). Kindgi keeps only the name in
the provider's registration; the secret stays in the store.

## 3. Finish: register what IT sent back

```sh
kindgi sso providers finish acme-kc --kind=oidc --issuer=http://127.0.0.1:18091/realms/acme \
  --client-id=kindgi-live --client-secret-ref=ACME_KC_SECRET --domains=acme.test --name="Acme Keycloak"
```

- **`--domains`** are the email domains this provider is offered for. It's
  required: sign-in is email first, so people find their provider by their
  email's domain.

  ```text
  Error: --domains=<your-domain> is required: sign-in is email first, so people find this provider by their email's domain
  ```

- **`--issuer`** is your identity provider's issuer URL: here a Keycloak
  realm on the same machine.
- **`--name`** is what the sign-in page's button says: "Sign in with Acme
  Keycloak".
- **The issuer's endpoints** are read from its discovery document when you
  register. The registration shows them:

  ```json
  {
    "providerId": "acme-kc",
    "provider": {
      "providerId": "acme-kc",
      "kind": "oidc",
      "displayName": "Acme Keycloak",
      "domains": ["acme.test"],
      "signIn": { "redirectUri": "http://localhost:18096/auth/sso/callback/idp-ibhu3tdkkrjjjfllbjpu2uk3gm" },
      "issuer": "http://127.0.0.1:18091/realms/acme",
      "clientId": "kindgi-live",
      "clientSecretRef": "ACME_KC_SECRET",
      …
    }
  }
  ```

- **A secret is always a reference:** `--client-secret-ref` names it. The
  secret itself is never accepted.

## 4. Add people, and try it

Only people already added to your workspace get in, by the email the identity
provider confirms. Add each one first (People in the console, or
`POST /v1/identity/users` with their `primaryEmail`). Then get a link to try:

```sh
kindgi sso providers test acme-kc
```

```text
Open this in a browser and sign in as a person who's been added to this tenant:
  http://localhost:18096/auth/start/idp-ibhu3tdkkrjjjfllbjpu2uk3gm

Afterwards, the console shows who you are signed in as.
```

After that, people sign in from the console's sign-in page with their email
([Sign in to the console](sign-in/)). Someone who isn't added is refused,
even though the identity provider let them through.

## Change it, list it, remove it

```sh
kindgi sso providers list --table
```

```text
PROVIDER  KIND  NAME           DOMAINS
────────  ────  ─────────────  ─────────
acme-kc   oidc  Acme Keycloak  acme.test
```

- **`get <id>`** shows one, with its sign-in URLs.
- **`update <id>`** changes a field in place (`--name`, `--domains`, a new
  `--client-secret-ref` …). The URLs IT has don't change. Changing which
  identity provider is behind it (a new issuer or client, or new SAML
  metadata or certificates) signs its people out; they sign in again as
  usual. Renaming it or changing its domains doesn't.
- **`remove <id>`** takes it out of sign-in at once, and ends the sessions
  people opened through it. Its old links answer "That sign-in option is
  gone".

## Your identity provider

| Identity provider | Page | Checked live |
|---|---|---|
| Keycloak | [Keycloak](keycloak/) | yes, OpenID Connect and SAML (signed requests) |
| Google Workspace | [Google](google/) | yes, except the Workspace-only audience |
| Microsoft Entra ID | [Microsoft Entra ID](entra-id/) | yes, single-tenant OpenID Connect |
| Okta | [Okta](okta/) | no: steps from Okta's docs |
| Another OpenID Connect provider | [OpenID Connect](oidc/) | through Keycloak and Google |
| Another SAML provider | [SAML](saml/) | through Keycloak |

**An identity provider on a private network** (an internal Keycloak, say)
is refused unless the runtime's operator allows its origin with
`KINDGI_AUTH_PRIVATE_IDP_ORIGINS`:

```text
Error [identity-provider-invalid]: http://127.0.0.1:18091/realms/acme is not a public HTTPS address (loopback): the deployment's operator can allow its origin with KINDGI_AUTH_PRIVATE_IDP_ORIGINS
```

The local Keycloak in the examples above was allowed that way
(`KINDGI_AUTH_PRIVATE_IDP_ORIGINS=http://127.0.0.1:18091`).
