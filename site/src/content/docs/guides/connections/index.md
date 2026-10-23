---
title: Connect your apps
description: Let a tool act in Gmail or GitHub with an account someone connected, its token kept in your own secret store and handed to one call at a time.
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

A schedule or a webhook runs as whoever created it, or last changed what it
runs. So when someone else changes what it runs (its flow or agent and
version, its input, the tools it may use unattended, or a webhook's signing
secret), its runs act as them from then on, with their connections
([Who owns it after a change](../runs/run-on-a-schedule/#who-owns-it-after-a-change)).

## How it fits together

1. **An admin registers the app once,** for the company: your own Google
   OAuth client or your own GitHub App. Its secrets stay in your secret
   store, and Kindgi keeps only their names ([Google](google/),
   [GitHub](github/)).
2. **People connect** on the app's own sign-in page: from the console's
   **Connections** page, or from a run that's waiting for them.
3. **A tool says which app and which permissions it needs**
   ([Use a connection in a tool](use-a-connection/)). Before each call,
   Kindgi finds the connection and hands that call its current
   short-lived token.
4. **Approvals show the account.** An approval for a call that uses a
   connection says whose account it acts as, such as "as ana@acme.com".

## When nobody has connected yet

- **Your own connection, in a run you started:** the run waits, and its
  page shows a **Connect** button. Once you've connected, the run goes on.
- **Anything else** fails the call with `connection-missing`, naming the
  app and what's missing: a person's connection in a schedule's or a
  webhook's run, where nobody is there to connect, and the company's
  connection in any run, since only an admin connects it. The console's
  **Connections** page shows what's missing.

## What you need

- **Kindgi 0.1.12 or later,** the runtime and the CLI.
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
- [GitHub](github/): create your GitHub App, register it, and install it on
  your organization.
- [Use a connection in a tool](use-a-connection/): declare what a tool
  needs, and read the token in its handler.
- [Add an app](add-an-app/): what an app's entry describes, for an app
  Kindgi doesn't have yet.
- [How connections work](reference/): a connection's states, renewal, what
  disconnecting withdraws and destroys, and each error.
