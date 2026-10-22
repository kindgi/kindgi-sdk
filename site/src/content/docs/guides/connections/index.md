---
title: Connect your apps
description: Let a tool act in Gmail or GitHub with an account someone connected, its token kept in your own secret store and handed to one call at a time.
sidebar:
  order: 0
  label: Overview
---

A connection lets a tool act in another app, such as Gmail or GitHub, with
an account someone connected to Kindgi. The app's token goes into your own
secret store, and each call that needs it gets a short-lived token of its
own. Nobody pastes a password or a token into an agent or its input.

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
runs. So when someone else changes its agent, its input or the tools it may
use unattended, its runs act as them from then on, with their connections.

## How it fits together

1. **An admin registers the app once,** for the company: your own Google
   OAuth client or your own GitHub App. Its secrets stay in your secret
   store, and Kindgi keeps only their names ([Google](google/),
   [GitHub](github/)).
2. **People connect** on the app's own sign-in page: from the console's
   **Connections** page, or from a run that's waiting for them.
3. **A tool says which app and which permissions it needs**
   ([Use a connection in a tool](use-a-connection/)). Before each call,
   Kindgi finds the connection, gets a token, and hands it to that call
   only.
4. **Approvals show the account.** An approval for a call that uses a
   connection says whose account it acts as, such as "as ana@acme.com".

## When nobody has connected yet

- **In a run you started,** the run waits, and its page shows a **Connect**
  button. Once you've connected, the run goes on.
- **In a schedule's or a webhook's run,** nobody is there to connect, so
  the call fails with `connection-missing`, naming the person and the app.
  The console's **Connections** page shows what's missing.

## What you need

- **A runtime whose public address is set** (`KINDGI_PUBLIC_URL`). The app
  sends people back to a console page at that address. Without it, the
  runtime doesn't offer connections, and its log says why.
- **An admin of the workspace,** to register each app.
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
