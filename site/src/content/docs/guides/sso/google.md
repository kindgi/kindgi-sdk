---
title: Google Workspace
description: Set up sign-in with your Google Workspace accounts, as an OpenID Connect provider your workspace owns.
sidebar:
  order: 10
  label: Google
---

When you finish this page, your workspace's people sign in with their Google
Workspace accounts. They go through an OAuth client in your organization's
Google Cloud project.

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **A Google Cloud project in your organization,** and someone who can
  create OAuth clients in it.
- **For `kindgi` commands:** Kindgi 0.1's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.1` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## 1. Get the redirect URI

`start` gives you the redirect URI to enter in Google, and the steps to send
whoever runs your Google Cloud project:

```sh
npx --yes @kindgi/cli@0.1 sso providers start acme-google --idp=google
```

- `acme-google` is the provider's id in your workspace.
- `--idp=google` adds Google's own steps to the message.

```text
Sign-in with "acme-google" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-tetkkt72cvmszkfsa2qamru4i4
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

Step by step: https://docs.kindgi.com/v0.1/guides/sso/google/

Then register it:
  kindgi sso providers finish acme-google --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## 2. Create the client in the Google Cloud console

In your organization's project, open **Google Auth Platform**:

1. **Branding:** enter the app's name and a support email.
2. **Audience: Internal.** Only accounts in your Google Workspace or Cloud
   Identity organization can then sign in, with no test users and no app
   review ([Google: Manage App Audience](https://support.google.com/cloud/answer/15549945)).
   Google offers Internal only for a project in your organization.
3. **Data access:** add the scopes `openid`, `email` and `profile`.
4. **Clients → Create client → Web application → Authorized redirect URIs:**
   enter the redirect URI that `start` printed.
5. **Copy the client ID and the client secret.** Google shows the secret
   once.

To change the redirect URI later, open the same client under **APIs &
Services → Credentials**. There, **Authorized redirect URIs → Add URI**, then
**Save**, changes it. A change can take a few minutes to apply.

These steps were checked with a Google account signing in through such a
client, its redirect URI added under **APIs & Services → Credentials**. The
Internal audience needs a Workspace organization, which that check didn't
have: step 2 comes from Google's documentation.

## 3. Store the client secret

Store the secret in Kindgi's secret store, by name, so it never travels by
email or chat:

```sh
npx --yes @kindgi/cli@0.1 secrets set ACME_GOOGLE_SECRET --env=production --scope=tenant
```

- `ACME_GOOGLE_SECRET` is the secret's name. The registration keeps only
  this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.
Then it prints what it stored:

```text
Value:
Re-enter to confirm:
{
  "name": "ACME_GOOGLE_SECRET",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_GOOGLE_SECRET at tenant in production.
```

## 4. Register it

`finish` registers the client, and offers it to people at your domains:

```sh
npx --yes @kindgi/cli@0.1 sso providers finish acme-google --kind=oidc --issuer=https://accounts.google.com \
  --client-id=<client id> --client-secret-ref=ACME_GOOGLE_SECRET --domains=<your domain>
```

- `--issuer` is Google's, `https://accounts.google.com`.
- `<client id>` is the client ID from step 2.
- `--client-secret-ref` is the secret's name from step 3.
- `<your domain>` is your Google Workspace domain, such as `acme.com`. For
  more than one, separate them with commas.

`finish` prints the registration, as in
[Set up SSO](../#3-register-what-it-sent-back).

## Not the same as "Continue with Google"

This is your workspace's own identity provider: only your domains, and only
your organization's accounts. **Continue with Google**, which any Google
account can use, is a different app. Whoever runs the runtime sets it up for
the whole deployment ([Turn on sign-in](../../../deploy/self-hosted/sign-in/#google)).

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
