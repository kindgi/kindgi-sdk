---
title: Connect your apps
description: Let a tool act in Gmail, Outlook, GitHub or LinkedIn with an account someone connected, its token kept in your own secret store and handed to one call at a time.
sidebar:
  order: 0
  label: Overview
---

A connection lets a tool act in another app, such as Gmail or GitHub, with
an account someone connected to Kindgi. The app's long-lived token goes
into your own secret store, and a call that needs it gets the connection's
current short-lived token. Nobody pastes a password or a token into an
agent or its input.

## Who owns a connection

A connection has one owner, and the owner decides which runs can use it:

- **You, for yourself,** such as your own Google account. Runs that act as
  you use it: the runs you start, and the runs of the schedules and webhooks
  you own. Nobody else's runs do.
- **The company,** connected by an admin, such as your company's GitHub App
  installed on your organization. Any run in the projects it allows can use
  it, scheduled runs included.

The model never picks a connection or an account. Kindgi picks the
connection from the run, before the call.

A schedule or a webhook runs as its owner. A personal one uses its owner's
connections, and only they or a project admin can change it. A shared one
runs as a service account and uses the company's
([Shared or personal](../runs/run-on-a-schedule/#shared-or-personal)).

## How it fits together

1. **An admin registers the app once,** for the company: your own Google
   OAuth client, Microsoft Entra app, GitHub App or LinkedIn app. Its
   secrets stay in your secret store, and Kindgi keeps only their names
   ([Google](google/), [Microsoft](microsoft/), [GitHub](github/),
   [LinkedIn](linkedin/)).
2. **People connect** on the app's own sign-in page: from the console's
   **Connections** page, from a terminal with `kindgi connections connect`,
   or from a run that's waiting for them. Each connection has a name: the
   account's, such as an email address, unless the connect gives another
   ([How connections work](reference/)).
3. **A tool says which app and which permissions it needs**
   ([Use a connection in a tool](use-a-connection/)). Before each call,
   Kindgi finds the connection and hands that call its current
   short-lived token.
4. **Approvals show the account.** An approval for a call that uses a
   connection says whose account it acts as, such as "as ana@acme.com".

## When nobody has connected yet

- **Your own connection, in a run you started:** an agent's call waits,
  and the run's page asks you to connect, as in **Connect Google**, with
  a link. Once you've connected, the run goes on. A flow's tool step
  can't wait, so it fails with `connection-missing`.
- **Anything else** fails the call with `connection-missing`, naming the
  app and what's missing: a person's connection in a schedule's or a
  webhook's run, where nobody is there to connect, and the company's
  connection in any run, since only an admin connects it. The console's
  **Connections** page shows what's missing.

So connect before a schedule or a webhook needs it. From a terminal, this
prints the link to open, and waits until you've connected:

```sh
npx --yes @kindgi/cli@0.2 connections connect google --permissions=gmail.send
```

- **`--permissions`** names what to ask for, by the app's permission keys.
  Left out, it asks you about each one at the terminal.
- **`--for-company`** connects the company's account instead, which only
  a workspace admin can.
- **`kindgi connections list --mine --table`** lists your connections, with
  their state. A workspace admin sees everyone's without `--mine`.

## What you need

- **Kindgi 0.2.0 or later,** the runtime and the CLI.
- **A runtime that offers connections.** It offers them only with all
  three of:
  - its public address (`KINDGI_PUBLIC_URL`): the app sends people back
    to a console page there;
  - the environment it serves (`KINDGI_ENV`), which its connections are
    made in;
  - a secrets store (`KINDGI_SECRETS_BACKEND`), which keeps the tokens:
    Kindgi's own, in PostgreSQL
    ([Add a model, and run a flow](../../deploy/self-hosted/self-host/#8-add-a-model-and-run-a-flow)),
    or your own secret manager
    ([Keep secrets in your own secret manager](../../deploy/self-hosted/secret-manager/)).

  Without all three, the runtime logs at startup what it's missing:
  `connections to other apps are off: they need …`.

  `kindgi dev` keeps secrets in .env files, so it doesn't offer
  connections: a call to a tool that uses one fails at once with
  `connection-app-missing`. Try them on a deployed runtime that has all
  three.
- **An admin of the workspace,** to register each app. Without
  [authorization](../../deploy/authorization/), Kindgi still keeps these to
  an admin: registering and changing apps, connecting the company's account,
  and seeing other people's connections. It reads that from the key, which
  must carry `tenant-admin`: a member's key or a key limited to a project
  never does. The workspace's other settings then check only the API key.
- **To approve what's sent from your own account, a reviewer seat**
  ([The Reviewers page](../approvals/approvals-reference/#the-reviewers-page)).

## The guides

- [Google](google/): register your Google OAuth client and connect Gmail.
- [Microsoft](microsoft/): register your Microsoft Entra app and connect
  Outlook.
- [GitHub](github/): create your GitHub App, register it, and install it on
  your organization.
- [LinkedIn](linkedin/): create your LinkedIn app, register it, and connect
  a profile to post as.
- [Use a connection in a tool](use-a-connection/): declare what a tool
  needs, and read the token in its handler.
- [Add an app](add-an-app/): what an app's entry describes, for an app
  Kindgi doesn't have yet.
- [How connections work](reference/): a connection's states, renewal, what
  disconnecting withdraws and destroys, and each error.
