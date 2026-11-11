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

Kindgi picks the connection from the run, before the call. The company can
have several of one app, such as `support@acme.example` and
`sales@acme.example`, and so can a person, such as a work account and a
home account. A call takes, in this order:

1. **The mailbox the run's mail came to,** for a run a mail trigger
   started, when the call is at the mailbox's app.
2. **Else the account the call names,** when its tool only reads and its
   choice holds several: the model picks one of them by name. That's the
   only time the model picks a connection.
3. **Else the tool's choice, else the agent's or flow's,** for that app:
   the company's, which a project admin makes, or a person's own.
4. **Else, for the company, the only connection of that app** the project
   can use. For a person, their main one, else their only one.

With none, the call fails with `connection-missing`. With several and
nothing chosen, the run fails with `connection-not-chosen`, naming the
company's and counting a person's. A mailbox's, a named or a chosen
connection that's gone, or can't serve the call, is refused: Kindgi never
falls back to another one
([Choose a connection](choose-a-connection/)).

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
4. **Approvals say whose account.** An approval for a call that uses a
   connection says whose it acts with: the company's by its account, such
   as `support@acme.example`, and a person's as "this person's Google
   account".

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
  a tenant admin can.
- **`kindgi connections list --mine --table`** lists your connections, with
  their state. A tenant admin sees everyone's without `--mine`.

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

  `kindgi dev` offers them too, with nothing to set
  ([Under `kindgi dev`](#under-kindgi-dev)).
- **An admin of the workspace,** to register each app. Without
  [authorization](../../deploy/authorization/), Kindgi still keeps these to
  an admin: registering and changing apps, connecting the company's account,
  and seeing other people's connections. It reads that from the key, which
  must carry `tenant-admin`: a member's key or a key limited to a project
  never does. The workspace's other settings then check only the API key.
- **To approve what's sent from your own account, a reviewer seat**
  ([The Reviewers page](../approvals/approvals-reference/#the-reviewers-page)).

## Under `kindgi dev`

`kindgi dev` offers connections too. It keeps their tokens in its own
database, encrypted under keys it makes for that database, and its start
names the address your apps send people back to:

```text
  Connections  on · redirect URI http://127.0.0.1:4000/console/connect/callback · register your app in the console (Connection apps)
```

To connect an app there:

1. **Make your own client at the app's provider,** with that redirect URI:
   - Google: a web application OAuth client. The URI goes under
     Authorized redirect URIs.
   - GitHub: a GitHub App. The URI is one of its callback URLs, which it
     takes up to 10 of.
   - Microsoft: an Entra app. The portal's Redirect URIs box refuses an
     `http` address, so add it in the app's Manifest, to
     `replyUrlsWithType`, with the type `Web`.
2. **Put its secrets in the pack's `.kindgi/secrets.env`,** or another
   `.env` file `kindgi dev` reads. A Google or Microsoft client has one,
   its client secret. A GitHub App has three: its client secret, its
   private key and its webhook secret. A private key goes in as one value
   in double quotes, over several lines.
3. **Register the app** on the console's Connection apps page, naming those
   secrets. Sign in to the console as the seeded user, who is the
   workspace's admin.
4. **Connect** from a run's page, or from the project's Connections page,
   as on any runtime.

What's different from a deployed runtime:
- **Every pack that serves the app needs its secrets.** Under `kindgi dev`
  a project's packs share one database, with its registrations and
  connections, but each pack reads secrets from its own `.env` files.
  Registering from a pack without them fails there and then. A pack
  without them fails when it first renews a token, and the error names
  the files it looked in.
- **A new port needs its own redirect URI.** When port 4000 is busy,
  `kindgi dev` takes the next free one, and the URI changes with it. The
  first start on a port the database hasn't used says so, once: add that
  URI to each of your apps, or their sign-in fails with
  `redirect_uri_mismatch`.
- **Mail triggers come on with connections,** so a mail trigger fires
  under `kindgi dev` as it does on a deployed runtime.
- **The keys** are in `~/.kindgi/dev/connections/`, one folder for each
  database, readable only by you. They're in your home folder, which the
  [dev sandbox](../secrets/dev-sandbox/) closes to the pack's code.
  `kindgi dev --reset` drops the bundled database and its keys with it, so
  connect again after it. A database you named keeps its keys. If a
  database's keys change, the runtime won't start, and `kindgi dev` names
  the key file and the ways out.
- **An older runtime image** doesn't say whether it offers connections.
  `kindgi dev` then shows `Connections  off, this runtime image doesn't say`.

## The guides

- [Google](google/): register your Google OAuth client and connect Gmail.
- [Microsoft](microsoft/): register your Microsoft Entra app and connect
  Outlook.
- [Calendars](calendar/): find events, see when someone is free, and add
  or change events on their Google or Outlook calendar.
- [GitHub](github/): create your GitHub App, register it, and install it on
  your organization.
- [LinkedIn](linkedin/): create your LinkedIn app, register it, and connect
  a profile to post as.
- [Use a connection in a tool](use-a-connection/): declare what a tool
  needs, and read the token in its handler.
- [Choose a connection](choose-a-connection/): name connections, and say
  which one an agent, a flow or one of its tools uses, the company's or a
  person's own.
- [Add an app](add-an-app/): what an app's entry describes, for an app
  Kindgi doesn't have yet.
- [How connections work](reference/): a connection's states, renewal, what
  disconnecting withdraws and destroys, and each error.
