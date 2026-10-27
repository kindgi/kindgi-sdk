---
title: Google
description: Register your company's own Google OAuth client with Kindgi, so people can connect their Gmail, or the company's mailbox, and tools can send and read mail.
sidebar:
  order: 10
  label: Google
---

When you finish this page, people in your workspace can connect their Google
account, and a tool, such as the ready-made
[`gmailSend`](../use-a-connection/#ready-made-tools), can send mail as
them, after they approve it, or read their mail. A tenant admin can
connect the company's mailbox too, such as a shop's support address, for
the tools and
[mail triggers](../../runs/start-runs-from-new-mail/) that use it. They
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
     Your Workspace admin may have to trust the app first.
   - **For a gmail.com mailbox, Audience: External, In production.**
     Without Google's review, the app is unverified: Google shows its
     "unverified app" screen when someone connects, and lets at most 100
     accounts connect. A shop's one support mailbox is one account. Don't
     leave it in **Testing**: a test user's grant ends seven days after they
     allow it, and a mail trigger then stops reading.
   - **Data access:** `openid`, `email`, and the Gmail permissions your
     tools need, such as `https://www.googleapis.com/auth/gmail.send` to
     send mail, and `https://www.googleapis.com/auth/gmail.readonly` to
     read it, which a mail trigger needs too. A reply needs both. Google
     counts every permission that reads mail as restricted.
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
- **Client secret: its name in Kindgi's secrets:** the environment and name
  you stored it under, `production/ACME_GOOGLE_CONNECT_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows what to give Google: the
**Redirect URI** you entered in step 1, and a **RISC receiver (optional)**
([When Google ends access](#when-google-ends-access)).

Or register it from the command line:

```sh
npx --yes @kindgi/cli@0.2 connection-apps add google --client-id=<client-id> --client-secret-ref=production/ACME_GOOGLE_CONNECT_SECRET
```

The command prints the registration as JSON: its `redirectUrl` is the
Redirect URI, and its `noticesUrl` the RISC receiver.
`--projects=<project-id>,…` lets only those projects' runs use it.

## 4. Connect

Each person connects their own account. In a project, open
**Connections**, choose **Connect an app**, pick Google, sign in to
Google, and allow what's asked. Google lists it in plain words, such as "Send email on your behalf".

The connection shows your Google account, what it allows, and when it was
last used. Reconnecting later needs the same Google account.

**The company's mailbox** is a tenant admin's to connect. In a project,
open **Connections**, choose **Connect an app**, pick Google, and under
**For** choose **The company**. Then sign in to Google as the mailbox
itself, such as `support@acme.example`, not as yourself. Tools with
`as: 'company'` use it, in every project the registration allows
([The company's mailbox](../../runs/start-runs-from-new-mail/#the-companys-mailbox)).

If you untick a permission on Google's page, Kindgi keeps what you allowed.
If a tool's call asked you to connect, that call fails with
`connection-declined`, naming what you didn't allow. After that, a tool
that needs the rest makes a run you started wait for you to allow it. In
any other run, its call fails with `connection-missing`.

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
  finds out the next time it renews the token, and the connection needs
  reconnecting.

To hear about it at once, Google can send a notice to Kindgi
([Cross-Account Protection](https://developers.google.com/identity/protocols/risc)).
Then a removal, or a disabled account, removes the person's connections
as soon as the notice comes, since their access is already gone at
Google.
It needs the runtime's public address to be reachable from the internet
over HTTPS. Register the **RISC receiver** address the **App
registrations** page shows for the client as your receiver
([Notices from the app](../reference/#notices-from-the-app)).

## Limits

Kindgi paces each connection's calls to Gmail at 6,000 of Gmail's quota
units a minute
([Google: Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)):

- **A send** costs 100.
- **Reading a message** costs 60, or 20 for its headers or its date only,
  and **a thread** 120.
- **A list of messages** costs 5, **the mailbox's history** 2 and **its
  profile** 1.

A mail trigger's looks for new mail count too, against the connection
it reads with.
