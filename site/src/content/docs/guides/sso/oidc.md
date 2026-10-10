---
title: Another OpenID Connect provider
description: Set up sign-in with any OpenID Connect identity provider your workspace owns, and what Kindgi needs from it.
sidebar:
  order: 14
  label: OpenID Connect
---

Any identity provider that speaks OpenID Connect works. Start with
[Set up SSO](../):

```sh
kindgi sso providers start acme-oidc --kind=oidc
```

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

## What Kindgi needs from it

- **A web application, with a client secret** (a confidential client), using
  the authorization code flow, with the redirect URI `start` printed.
- **The scopes `openid email profile`.**
- **A discovery document** at `<issuer>/.well-known/openid-configuration`.
  Kindgi reads the provider's endpoints from it when you register.
- **The person's email.** A sign-in without an email is refused ("No email
  came back"), and so is one whose email the provider marks unverified
  ("Your email isn't verified").
- **An issuer on a public HTTPS address,** unless the runtime's operator
  allows its origin with `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`.

Send back the issuer URL and the client ID. The client secret goes into
Kindgi's secret store by name:

```sh
kindgi secrets set ACME_OIDC_SECRET --env=production --scope=tenant --from-stdin
kindgi sso providers finish acme-oidc --kind=oidc --issuer=<issuer> \
  --client-id=<client id> --client-secret-ref=ACME_OIDC_SECRET --domains=<your domain>
```

A secret passed itself, instead of by reference, is refused.
