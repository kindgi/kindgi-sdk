---
title: Google Workspace
description: Set up sign-in with your Google Workspace accounts, as an OpenID Connect provider your workspace owns.
sidebar:
  order: 10
  label: Google
---

People sign in with their Google Workspace accounts, through an OAuth client
in your organization's Google Cloud project. Start with
[Set up SSO](../):

```sh
kindgi sso providers start acme-google --idp=google
```

```text
Sign-in with "acme-google" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-uiyrzsxrefmitdo6oxmizvyerq
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Google Cloud console → Google Auth Platform:
  1. Branding: the app name and a support email.
  2. Audience: Internal (only your Google Workspace accounts; no test users, no review).
  3. Data access: openid, email, profile.
  4. Clients → Create client → Web application → Authorized redirect URIs: the URI above.
  5. Download the client ID and secret (Google shows the secret once).
Issuer: https://accounts.google.com

Step by step: https://docs.kindgi.com/guides/sso/google/

Then register it:
  kindgi sso providers finish acme-google --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## In the Google Cloud console

In your organization's project, **Google Auth Platform**:

1. **Branding:** the app's name and a support email.
2. **Audience: Internal.** Only accounts in your Google Workspace (or Cloud
   Identity) organization can then sign in, with no test users and no app
   review ([Google: Manage App Audience](https://support.google.com/cloud/answer/15549945)).
   Internal is only offered for a project in your organization.
3. **Data access:** the scopes `openid`, `email` and `profile`.
4. **Clients → Create client → Web application → Authorized redirect URIs:**
   the redirect URI `start` printed. The same client is under **APIs &
   Services → Credentials**, where **Authorized redirect URIs → Add URI**,
   then **Save**, changes it later. A change can take a few minutes to apply.
5. **Copy the client ID and the client secret.** Google shows the secret
   once. Store it in Kindgi by name:

   ```sh
   kindgi secrets set ACME_GOOGLE_SECRET --env=production --scope=tenant --from-stdin
   ```

The issuer is `https://accounts.google.com`. Then:

```sh
kindgi sso providers finish acme-google --kind=oidc --issuer=https://accounts.google.com \
  --client-id=<client id> --client-secret-ref=ACME_GOOGLE_SECRET --domains=<your domain>
```

These steps were checked with a Google account signing in through such a
client, its redirect URI added under **APIs & Services → Credentials**. The
Internal audience needs a Workspace organization, which that check didn't
have: step 2 is from Google's documentation.

## Not the same as "Continue with Google"

This is your workspace's own identity provider: only your domains, and only
your organization's accounts. **Continue with Google**, which any Google
account can use, is a different app that whoever runs the runtime sets up
for the whole deployment ([Turn on sign-in](../../../deploy/sign-in/#google)).
