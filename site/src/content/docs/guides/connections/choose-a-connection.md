---
title: Choose a connection
description: Name the company's connections, and choose which one an agent or a flow uses when the company has several of one app, such as two mailboxes.
sidebar:
  order: 35
  label: Choose a connection
---

The company can connect several accounts of one app, such as
`support@acme.example` and `sales@acme.example` at Google. Each is a
connection of its own, with its own name. This page names them, and
chooses which one an agent or a flow uses. A person's own connection needs
neither: a run that acts as them uses their one connection of the app.

## Which connection a call uses

A project's **candidates** for an app are the company's live connections of
it, working or needing a reconnect, on a registration that allows the
project, in the runtime's environment. A call that needs the company's
connection takes, in this order:

1. **The mailbox the run's mail came to,** for a run a company mail trigger
   started, when the call is at the mailbox's app. A reply leaves from the
   mailbox the mail came to, and so does any other company call at that app
   in the run, such as a read of the mailbox's calendar
   ([The company's mailboxes](../../runs/start-runs-from-new-mail/#the-companys-mailboxes)).
2. **Else the agent's or flow's choice** for that app in the project
   ([Choose one for an agent or a flow](#choose-one-for-an-agent-or-a-flow)).
3. **Else the only candidate.**

With no candidate, the call fails with `connection-missing`. With several
and no choice, the run fails with `connection-not-chosen`
([When none is chosen](#when-none-is-chosen)). A candidate counts even when
it lacks the call's permission or needs reconnecting.

A mailbox's or a choice's connection that can't serve the call fails it with
`connection-missing`, naming the connection and why: it was disconnected,
it's in another environment, its registration no longer allows the
project, it lacks a permission, or it needs reconnecting. The call never
falls back to another connection, so a call meant for the sales mailbox is
never sent from the support one.

## Name a connection

A connection's name is the one given at the connect, or else its account's,
such as `sales@acme.example`. Name the company's when you connect them,
with `--label`:

```sh
pnpm exec kindgi connections connect google --for-company --label=support --permissions=gmail.readonly,gmail.send
```

It prints the link to open. Sign in as the mailbox itself, not as
yourself. Once you have, it prints which connection it made:

```text
Connected support (support@acme.example at google, company) (connection 0b6f3a52-…).
```

Connect `sales@acme.example` the same way, with `--label=sales`, and the
company has two Google connections.

- **The company keeps one connection per account,** registration and
  environment. A connect that signs in to an account the company already
  has there reconnects that connection: it keeps its name, whatever
  `--label` asked, and gains what was allowed.
- **`--reconnect=<connection>`** reconnects one by name or id, and needs
  the same account. It doesn't take `--label`: a reconnect keeps its name.
- **Rename one** with `kindgi connections update`. Its owner or a
  workspace admin can rename it, and only a workspace admin the company's:

  ```sh
  pnpm exec kindgi connections update support --label=helpdesk
  ```

  It prints `Renamed support to helpdesk (connection 0b6f3a52-…).` Over
  HTTP, that's `PATCH /v1/connections/{connectionId}` with
  `{ "label": "helpdesk" }`, and in the clients, `connections.update`. The
  rules for a name are in [How connections work](../reference/).
- **A command takes a connection by id or by name,** in any letter case.
  `--app=<app>` narrows a name to one app's connections. A name two
  connections share is refused, listing each one, so name it by id.

**Everything binds by id.** A mail trigger and a choice store the
connection's id, never its name. So a rename, or another connection given
an old name, never moves a trigger or a choice. A reconnect keeps the
connection and its id. A disconnect ends it: a connect after that makes
another connection, with another id, and triggers and choices that named
the old one fail, naming it, until you point them at the other.

## Choose one for an agent or a flow

A **choice** says which company connection an agent or a flow uses at an
app, in one project and the runtime's environment. Only a project admin
sets or removes one: without
[authorization](../../../deploy/authorization/), that's a workspace admin
([Without authorization](../../../deploy/people-and-keys/#without-authorization)).

The connections a choice can name are the project's candidates. List them
over HTTP with `GET /v1/connection-choices/candidates?projectId=<project-id>&app=google`,
or `connectionChoices.candidates({ projectId, app })` in the clients
(`connection_choices.candidates` in Python).

Choose `support` for the agent `acme.mail-helper`:

```sh
pnpm exec kindgi connection-choices set support --agent=acme.mail-helper
```

```text
Chose support at google for agent acme.mail-helper (choice 5d1c9e07-…).
```

- **`--flow=<id>`** makes the choice for a flow instead of `--agent`. It's
  for the tool steps the flow runs itself. An agent the flow runs uses
  the agent's own choice.
- **`--project=<project-id>`** is the project. Without it, it's the
  tenant's Default project.
- **`--app=<app>`** narrows the name to one app's candidates. The choice is
  for the connection's own app.
- **Choosing another** replaces the choice, and says which one it was in
  place of:
  `Chose sales at google for agent acme.mail-helper (choice 8e2a4b13-…), in place of support (choice 5d1c9e07-…).`
  A choice is never edited: the old one is removed, and the next one has
  the next `version`. Choosing the one it already uses changes nothing.
- **It's refused** for a person's own live connection in the
  environment, `400 bad-input` ("A person's own connection is used for
  them; choices are for the company's."), for any other connection that
  isn't a candidate,
  `404 connection-not-found`, for an agent or a flow that isn't the
  project's, `404 agent-not-found` or `404 flow-not-found`, and for anyone
  but a project admin, `403 permission-denied` ("Choosing a connection
  takes a project admin.").

Over HTTP, a choice is `PUT /v1/connection-choices` with
`{ "projectId", "agentId" or "flowId", "connectionId" }`, and
`connectionChoices.set` in the clients.

List a project's choices:

```sh
pnpm exec kindgi connection-choices list --table
```

It shows each choice's agent or flow, app, connection by name, and choice
id. `--agent`, `--flow` and `--app` narrow it, and `--include-removed`
lists removed and replaced choices too, with when. Anyone who reads the
project can list them: `GET /v1/connection-choices?projectId=<project-id>`,
or `connectionChoices.list` in the clients.

Remove a choice by its id:

```sh
pnpm exec kindgi connection-choices unset 8e2a4b13-…
```

It asks first, unless you give `--yes`, then prints
`Removed connection choice 8e2a4b13-….` The agent or flow then uses the
project's only candidate at the app, and stops with
`connection-not-chosen` when there are several. Over HTTP, that's
`DELETE /v1/connection-choices/{choiceId}`, and `connectionChoices.remove`
in the clients. A removed or unknown choice, or one in a project you
can't read, is `404 connection-choice-not-found`. Anyone else but a
project admin is refused with `403 permission-denied` ("Removing a
connection choice takes a project admin.").

Disconnecting a chosen connection leaves its choice in place. The agent's
calls at that app then fail with `connection-missing`, naming the
connection, until a project admin chooses another or removes the choice.

## Who sees what

- **Workspace admins** read every connection in full, the company's
  included: `GET /v1/connections` and `GET /v1/connections/{connectionId}`.
- **A project's admins** read its candidates in full: each one's
  `connectionId`, `name`, `app`, `accountLabel` and `state`.
- **A project's other members,** anyone who reads the project, read each
  candidate's `connectionId` and `name` only, and list its choices. They
  can't read the connection itself: `GET /v1/connections/{connectionId}`
  answers `404 connection-not-found`, as for one that isn't there.
- **A person's own connections** stay theirs and the workspace admins'. They
  are never a project's candidates, and nobody else lists them.

Without authorization, everyone works in every project, so anyone reads the
candidates' ids and names, and only a workspace admin reads them in full.

## When none is chosen

A call fails the run with `connection-not-chosen` when all of these hold:

- it needs the company's connection of an app;
- its run didn't come from a company mailbox of that app;
- its agent or flow has no choice for the app in the project;
- the project has more than one candidate there.

No model can fix that, so the model never sees it: the agent's turn fails,
and its run with it. The run's `failure` names the connections to choose
from
([Why one run failed](../../runs/see-why-runs-failed/#why-one-run-failed)):

```json excerpt
"failure": {
  "code": "connection-not-chosen",
  "message": "This project has 2 company Google connections (sales, support), and agent acme.mail-helper has no choice of one. …"
}
```

A project admin chooses one of them, and the agent's runs use it from
then on:

```sh
pnpm exec kindgi connection-choices set support --agent=acme.mail-helper
```

A call that isn't an agent's or a flow's can't have a choice, so it
needs a project with one candidate of the app.

## When the connection changes

A call's connection is decided before it waits for its yes, and asked for
again right before the tool runs. When the two differ, the call doesn't
run, and fails with `connection-changed`. So an approved call runs only on
the connection it was approved against. That happens when, while the call
waited, a project admin chose another connection for the agent, or a
connection was disconnected and another account connected in its place.
It holds for a person's connection too.

The model reads why as the call's result, naming the connection before and
after, and the turn goes on:

```text
The connection "mailbox" changed while this call waited (support, support@acme.example, to sales, sales@acme.example), so it didn't run.
```

`mailbox` is the tool's name for the connection. An approval for a call
that uses a connection names the connection it's for, the company's
included
([An approval's fields](../../approvals/approvals-reference/#an-approvals-fields)).
