---
title: Okta
description: Set up sign-in with Okta, as an OpenID Connect web app your workspace owns.
sidebar:
  order: 12
---

:::caution[Not yet checked live]
These steps follow Okta's documentation and the CLI's own steps. A sign-in
through Okta hasn't been checked yet.
:::

People sign in with their Okta accounts. Start with [Set up SSO](../):

```sh
kindgi sso providers start acme-okta --idp=okta
```

```text
Sign-in with "acme-okta" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-7xxjpuwfgblqnahzj3csiek3re
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

Step by step: https://docs.kindgi.com/guides/sso/okta/

Then register it:
  kindgi sso providers finish acme-okta --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## In the Okta admin console

**Applications → Create App Integration**, sign-in method **OIDC - OpenID
Connect**, application type **Web Application**:

1. **Sign-in redirect URIs:** the redirect URI `start` printed.
2. **Assignments:** the groups who may sign in.
3. Copy the **Client ID** and the **Client secret**. Store the secret in
   Kindgi by name:

   ```sh
   kindgi secrets set ACME_OKTA_SECRET --env=production --scope=tenant --from-stdin
   ```

The issuer is your Okta organization's URL, `https://<your-org>.okta.com`.
Then:

```sh
kindgi sso providers finish acme-okta --kind=oidc --issuer=https://<your-org>.okta.com \
  --client-id=<client id> --client-secret-ref=ACME_OKTA_SECRET --domains=<your domain>
```
