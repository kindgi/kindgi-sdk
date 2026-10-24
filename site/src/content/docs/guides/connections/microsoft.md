---
title: Microsoft
description: Register your company's own Microsoft Entra app with Kindgi, so people can connect their Outlook mail and tools can send and read mail as them.
sidebar:
  order: 15
  label: Microsoft
---

When you finish this page, people in your workspace can connect their
Microsoft work, school or personal account. A tool, such as the ready-made
[`outlookSend`](../use-a-connection/#ready-made-tools), can then send mail
as them, after they approve it, and read their mail. They connect through
an app registered in your organization's Microsoft Entra directory, which
you register with Kindgi once.

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **A Microsoft Entra directory,** and someone in it who can register apps:
  at least the Application Developer role. Allowing the app for everyone in
  the directory takes an admin role ([Admin consent](#admin-consent)).
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). Kindgi
  0.2's CLI runs from any folder as `npx --yes @kindgi/cli@0.2`
  ([Install](../../../start/install/)).

## 1. Choose who can connect

Microsoft signs people in at a directory, and your registration with Kindgi
names it. There's no default: choose it first, since the app's **Supported
account types** at Microsoft must match it.

| Who can connect | Supported account types | Directory |
| --- | --- | --- |
| People in your company's directory, the usual choice | **Single tenant only** | its **Directory (tenant) ID**, or its domain, such as `acme.onmicrosoft.com` |
| Work or school accounts in any directory | **Multiple Entra ID tenants** | `organizations` |
| Those, and personal Microsoft accounts | **Any Entra ID Tenant + Personal Microsoft accounts** | `common` |
| Personal Microsoft accounts only | **Personal accounts only** | `consumers` |

A single-tenant app signs people in only at its own directory. Given
another, such as `common`, Microsoft refuses the sign-in on its own page
(AADSTS50194), and Kindgi never hears of it.

To let people in one project connect both their work accounts and their
personal ones, register one app at Microsoft that takes both (**Any Entra
ID Tenant + Personal Microsoft accounts**), and give Kindgi the directory
`common`. It then takes work and school accounts from other directories
too.

## 2. Register the app in Microsoft Entra

In the [Microsoft Entra admin center](https://entra.microsoft.com):

1. **Entra ID → App registrations → New registration.** Give it a name
   people recognize when they connect, and pick the **Supported account
   types** from step 1
   ([Microsoft: Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)).
2. **Authentication → Redirect URI configuration → Add Redirect URI →
   Web,** with the console's connect page as the **Redirect URI**:

   ```text
   https://kindgi.acme.com/console/connect/callback
   ```

   Then choose **Configure**
   ([Microsoft: Add a redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)).
   Pick **Web**, not **Single-page application**: Kindgi finishes the
   sign-in on its server.
3. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions:** `offline_access`, `User.Read`, and the mail permissions
   your tools need, `Mail.Send` to send mail and `Mail.Read` to read it.
   Then choose **Add permissions**. Kindgi asks for `offline_access` to keep
   access between sign-ins, and for `User.Read` to learn whose account it
   is.
4. **Certificates & secrets → Client secrets → New client secret.** Pick
   when it expires, 24 months at most, and choose **Add**. Copy its
   **Value** at once: Microsoft never shows it again
   ([Renewing the client secret](#renewing-the-client-secret)).
5. **Keep the Application (client) ID** from the app's **Overview** page,
   and, for a single-tenant app, its **Directory (tenant) ID**.

### Admin consent

Whether people may allow these permissions themselves is your directory's
setting. Where it doesn't let them, Microsoft tells them to ask an admin,
and if they go back from there, the connect ends as declined. So a declined
connect can mean the directory needs an admin's consent first.

An admin can allow the app once for everyone in the directory, with the
Cloud Application Administrator or Application Administrator role:
**Entra ID → Enterprise apps → All applications**, pick the app, then
**Security → Permissions → Grant admin consent**
([Microsoft: Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).

## 3. Store the client secret

The secret goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_MICROSOFT_CONNECT_SECRET --env=production --scope=tenant
```

- `ACME_MICROSOFT_CONNECT_SECRET` is the secret's name. The registration
  keeps only this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

## 4. Register the app with Kindgi

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **Microsoft** as the **App**:

- **Client id:** the Application (client) ID.
- **Client secret: its name in Kindgi's secrets:** the environment and name
  you stored it under, `production/ACME_MICROSOFT_CONNECT_SECRET`.
- **Directory:** the one from step 1: the Directory (tenant) ID or the
  domain, or `organizations`, `common` or `consumers`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows the **Redirect URI** you entered in
step 2.

Or register it from the command line:

```sh
npx --yes @kindgi/cli@0.2 connection-apps add microsoft --client-id=<client-id> --client-secret-ref=production/ACME_MICROSOFT_CONNECT_SECRET --tenant=<directory>
```

`<directory>` is the directory from step 1. The command prints the
registration as JSON, with the Redirect URI as its `redirectUrl`.
`--projects=<project-id>,…` lets only those projects' runs use it.

The directory can't change while people have connections through the
registration, since their access belongs to that directory. Kindgi refuses
the change (`connection-app-invalid`): disconnect them first, then change
it and connect again.

## 5. Connect

Each person connects their own account. In a project, open
**Connections**, choose **Connect an app**, pick Microsoft, sign in to
Microsoft, and allow what's asked. Microsoft first asks which of your
accounts to use.

The connection shows your Microsoft account, what it allows, and when it
was last used. Reconnecting later needs the same Microsoft account.

If you turn it down on Microsoft's page, or go back from it because your
directory needs an admin's consent first ([Admin consent](#admin-consent)),
the connect is declined. If a tool's call asked you to connect, that call
fails with `connection-declined`.

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at Microsoft: your app keeps what the person allowed until it's
removed there.

- **A work or school account:** the person removes it in
  [My Apps](https://myapplications.microsoft.com): the app's **…** menu,
  **Manage your application**, then **Revoke Permissions**. What an admin
  allowed for the whole directory, only an admin takes back, at **Entra ID
  → Enterprise apps →** the app **→ Permissions**
  ([Microsoft: Review permissions granted to enterprise applications](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-application-permissions)).
- **A personal account:** the person opens their Microsoft account's
  **Privacy** settings, then **Apps and services that can access your
  data**, and removes your app's permissions.

## When Microsoft ends access

Microsoft sends Kindgi no notice, so Kindgi finds out the next time it
renews the token. The connection then needs reconnecting. A run its owner
started waits for them to connect again. In any other run, the call fails
with `connection-missing`, and the **Connections** page shows it.

- **Unused for 90 days,** by default, its access ends
  ([Microsoft: Refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)).
- **Taken back at Microsoft:** the person removes your app, or they or an
  admin end all their sessions.

If the client secret expires, Microsoft refuses Kindgi's connects and
renewals. Calls then fail with `connection-renew-failed`, and the
connections stay as they are, so storing a new secret puts them right
([Renewing the client secret](#renewing-the-client-secret)).

## Renewing the client secret

A client secret lasts 24 months at most, and Microsoft recommends less than
12
([Microsoft: Add credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)).
Before yours expires:

1. **In Entra,** on the app's **Certificates & secrets** page, add a new
   client secret and copy its **Value**.
2. **Store it as a new version** under the same name:

   ```sh
   npx --yes @kindgi/cli@0.2 secrets set ACME_MICROSOFT_CONNECT_SECRET --env=production --scope=tenant --write-mode=add-version
   ```

   Connections keep working: Kindgi uses the new secret from the next
   sign-in or renewal.
3. **Delete the old secret** in Entra.

## Limits

Kindgi paces each connection's calls to Microsoft's limits for one
mailbox:

- **30 sends a minute,** Exchange Online's message rate
  ([Microsoft: Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits)).
- **10,000 calls in 10 minutes,** Microsoft Graph's limit for one app and
  one mailbox
  ([Microsoft: Throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)).

The ready-made tools that read mail count only against the second. A call
whose `toolId` the entry doesn't list takes 1 unit of each, so your own
tool's calls to Graph through
[`appFetch`](../use-a-connection/#read-the-token) count as sends too.

Microsoft enforces its other limits itself, such as 4 calls at once to a
mailbox: a call over one is refused with a time to wait, and `appFetch`
tries again.
