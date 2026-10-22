---
title: Google
description: Register your company's own Google OAuth client with Kindgi, so people can connect their Gmail and tools can send mail as them.
sidebar:
  order: 10
  label: Google
---

When you finish this page, people in your workspace can connect their Google
account, and a tool can send mail as them, after they approve it. They
connect through an OAuth client in your organization's Google Cloud project,
which you register with Kindgi once.

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **A Google Cloud project in your organization,** and someone who can turn
  on APIs and create OAuth clients in it.
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). Kindgi
  0.2's CLI runs from any folder as `npx --yes @kindgi/cli@0.2`
  ([Install](../../../start/install/)).

## 1. Create the client in the Google Cloud console

In your organization's project:

1. **Turn on the Gmail API:** **APIs & Services → Library → Gmail API →
   Enable**.
2. Open **Google Auth Platform**:
   - **Branding:** the app's name and a support email.
   - **Audience: Internal.** Only accounts in your Google Workspace or
     Cloud Identity organization can then connect, with no test users and
     no app review
     ([Google: Manage App Audience](https://support.google.com/cloud/answer/15549945)).
   - **Data access:** `openid`, `email`, and the Gmail permissions your
     tools need, such as `https://www.googleapis.com/auth/gmail.send` to
     send mail.
   - **Clients → Create client → Web application.** Under **Authorized
     redirect URIs**, enter the console's connect page:

     ```text
     https://kindgi.acme.com/console/connect/callback
     ```

3. **Keep the client ID and the client secret.** Google shows the secret
   once.

## 2. Store the client secret

The secret goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_GOOGLE_CONNECT_SECRET --env=production --scope=tenant
```

- `ACME_GOOGLE_CONNECT_SECRET` is the secret's name. The registration keeps
  only this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

## 3. Register the client

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **Google** as the **App**:

- **Client id:** the one Google gave you.
- **Client secret: its name in Kindgi's secrets:** the name you stored it
  under, `ACME_GOOGLE_CONNECT_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows what to give Google: the
**Redirect URI** you entered in step 1, and a **RISC receiver (optional)**
([When Google ends access](#when-google-ends-access)).

## 4. Connect

Each person connects their own account. In a project, open
**Connections**, choose **Connect an app**, pick Google, sign in to
Google, and allow what's asked. Google lists it in plain words, such as "Send email on your behalf".

The connection shows your Google account, what it allows, and when it was
last used. Reconnecting later needs the same Google account.

If you untick a permission on Google's page, Kindgi keeps what you allowed.
A tool that needs the rest makes a run you started wait for you to allow
it. In any other run, its call fails with `connection-missing`.

## Disconnecting

**Connections → Disconnect** withdraws the grant at Google, then destroys
the stored token in your secret store
([How connections work](../reference/#disconnecting)).

Google's withdrawal covers the whole grant: everything your client was
allowed for that Google account, by every connection that uses it. So while
another connection in your workspace uses the same Google account, Kindgi
doesn't withdraw at Google, and only destroys this connection's token.

## When Google ends access

- **Unused for six months,** Google ends a connection's access, and it
  needs reconnecting. A run its owner started waits for them to connect
  again. In any other run, the call fails with `connection-missing`, and
  the **Connections** page shows it.
- **Removed by the person at Google,** or their account disabled: Kindgi
  finds out at the next call, and the connection needs reconnecting.

To hear about it at once, Google can send a notice to Kindgi
([Cross-Account Protection](https://developers.google.com/identity/protocols/risc)).
It needs the runtime's public address to be reachable from the internet
over HTTPS. Register the **RISC receiver** address the **App
registrations** page shows for the client as your receiver
([Notices from the app](../reference/#notices-from-the-app)).
