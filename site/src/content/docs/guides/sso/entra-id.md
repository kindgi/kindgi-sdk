---
title: Microsoft Entra ID
description: Set up sign-in with Microsoft Entra ID, as a single-tenant OpenID Connect app your workspace owns.
sidebar:
  order: 11
---

People sign in with their accounts in your Microsoft Entra ID directory.
Start with [Set up SSO](../):

```sh
kindgi sso providers start acme-entra --idp=entra
```

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

## In the Microsoft Entra admin center

**Applications → App registrations → New registration:**

1. **Supported account types:** accounts in this organizational directory
   only (single tenant).
2. **Redirect URI:** platform **Web**, the redirect URI `start` printed.
3. From **Overview**, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret:** copy its **Value**, not
   "Secret ID"; it's shown once. Store it in Kindgi by name:

   ```sh
   kindgi secrets set ACME_ENTRA_SECRET --env=production --scope=tenant --from-stdin
   ```

   The secret expires on the date you chose. Before then, add a new one and
   set it again under the same name.
5. **Enterprise applications →** the app **→ Properties → Assignment
   required:** Yes. Then, under **Users and groups**, add who may sign in.

Steps 1 to 4 and the issuer below were checked with a sign-in through such an
app. Step 5 is from Microsoft's documentation. The app needs no optional
claims: Kindgi reads the person's email from Microsoft's userinfo endpoint.

The issuer is your directory's own:
`https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0`. Then:

```sh
kindgi sso providers finish acme-entra --kind=oidc \
  --issuer=https://login.microsoftonline.com/<directory tenant id>/v2.0 \
  --client-id=<application client id> --client-secret-ref=ACME_ENTRA_SECRET --domains=<your domain>
```

`common` is refused, because it would let in people from any Entra
directory:

```text
Error [identity-provider-invalid]: https://login.microsoftonline.com/common/v2.0 lets people from any Microsoft Entra directory sign in. Use your directory's own issuer, https://login.microsoftonline.com/<directory-tenant-id>/v2.0 (the app registration's Directory (tenant) ID), and register the app for a single tenant
```

## Not the same as "Continue with Microsoft"

This is your workspace's own identity provider: a single-directory app, and
only your directory's people. **Continue with Microsoft**, which accounts
from any directory can use, is a different app, registered for any
organizational directory, that whoever runs the runtime sets up for the whole
deployment ([Turn on sign-in](../../../deploy/sign-in/#microsoft)).
