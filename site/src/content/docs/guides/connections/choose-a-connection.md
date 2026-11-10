---
title: Choose a connection
description: Name connections, and choose which one an agent, a flow or one of its tools uses when there are several of one app, such as the company's mailboxes or a person's own accounts.
sidebar:
  order: 35
  label: Choose a connection
---

The company can connect several accounts of one app, such as
`support@acme.example` and `sales@acme.example` at Google. So can a person,
such as a work account and a home account. Each is a connection of its own,
with its own name. This page names them, and chooses which one an agent, a
flow or one of its tools uses. A tool that only reads can be given several,
and each of its calls says which one it reads
([Read several accounts with one tool](#read-several-accounts-with-one-tool)).

## Which connection a call uses

A project's **candidates** for an app are the company's live connections of
it, working or needing a reconnect, on a registration that allows the
project, in the runtime's environment. A project uses one registration of
an app, so a person's candidates are their own live connections of the app
through it. For each connection a call needs, it takes, in this order:

1. **The mailbox the run's mail came to,** for a run a mail trigger
   started, when the call is at the mailbox's app: the company's mailbox
   for a call that needs the company's connection, and a person's mailbox
   for a call that needs that person's. A reply leaves from the mailbox the
   mail came to, and so does any other call at that app in the run, such
   as a read of the mailbox's calendar
   ([The company's mailboxes](../../runs/start-runs-from-new-mail/#the-companys-mailboxes)).
2. **Else the account the call names,** when the tool's choice holds
   several and the tool only reads
   ([Read several accounts with one tool](#read-several-accounts-with-one-tool)).
3. **Else the choice for the tool**
   ([Choose one for a tool](#choose-one-for-a-tool)).
4. **Else the agent's or flow's choice** for that app in the project
   ([Choose one for an agent or a flow](#choose-one-for-an-agent-or-a-flow)).
5. **Else, for the company, the only candidate. For a person, their main
   connection of the app, else their only one**
   ([A person's accounts](#a-persons-accounts)).

A call that needs the company's connection reads the company's choices. A
call that needs a person's reads that person's own choices, and never
anyone else's ([Your own choices](#your-own-choices)).

With no candidate, the call fails with `connection-missing`. With several
and nothing chosen, the run fails with `connection-not-chosen`
([When none is chosen](#when-none-is-chosen)). A candidate counts even when
it lacks the call's permission or needs reconnecting.

A mailbox's, a choice's or a named account's connection that can't serve
the call fails it with `connection-missing`, naming the connection and why:
it was disconnected, it's in another environment, its registration no
longer allows the project, it lacks a permission, or it needs
reconnecting. For a person's connection, it names the tool's name for the
connection and the app, never the connection. The call never falls back to another connection, so a call
meant for the sales mailbox is never sent from the support one.

## A person's accounts

A person can connect several accounts of one app, such as a work account
and a home account at Google, each as a connection of their own. The first
is the one their agents use. When they connect a second, the first becomes
their **main**, and their agents go on using it:

```sh
pnpm exec kindgi connections connect google --label=home --permissions=calendar.events.owned.readonly
```

```text
Connected home (ana@example.com at google) (connection 3c7e1f90-…).
work is your main connection at google, the one your agents use when no choice names another: `kindgi connections update 3c7e1f90-… --main` makes this one your main.
```

Their first connect, a reconnect and a company connection say nothing
about a main.

- **Their other connections** reach an agent only through a choice they
  make themselves ([Your own choices](#your-own-choices)).
- **Make another one main** with `kindgi connections update`, on the
  console's **Connections** page with **Make main**, or over HTTP with
  `PATCH /v1/connections/{connectionId}` and `{ "main": true }`:

  ```sh
  pnpm exec kindgi connections update home --main
  ```

  ```text
  Made home your main connection at google (connection 3c7e1f90-…).
  ```

  The one that was main no longer is. Making the main one main changes
  nothing, and says so. Over HTTP, `main` and `label` are one change at a
  time, and in the clients, it's `connections.update` with
  `{ main: true }`.

  Only the person whose connection it is can make it main, not a tenant
  admin (`400 bad-input`, "Only the person whose connection it is makes it
  their main."). `{ "main": false }` is refused too ("A main moves only by
  making another connection main."), and so is a company connection ("The
  company has no main connection: its agents use the company's through
  their choices.").
- **Making one main never moves a mail trigger.** A trigger stores the
  mailbox it reads
  ([Which mailbox a trigger reads](../../runs/start-runs-from-new-mail/#which-mailbox-a-trigger-reads)).
- **Disconnecting the main leaves them none.** Nothing becomes main on its
  own. With one connection left, their agents use it. With several, a call
  that needs their connection, with no choice for it, fails the run with
  `connection-not-chosen` until they make one main
  ([When none is chosen](#when-none-is-chosen)). Their next connect makes
  the one left their main when there's one. With several and no main, it
  makes none main, and says so:

  ```text
  You have 3 connections at google and none is your main, so a call of your agents that needs one stops with connection-not-chosen until you make one your main, or a choice names one: `kindgi connections update <connection> --main`.
  ```

`main` is on the connection's record (`GET /v1/connections`), on a person's
connection only, and `kindgi connections list` marks it `(main)` after its
name.

## Name a connection

A connection's name is the one given at the connect, or else its account's,
such as `sales@acme.example`. Name a connection when you connect it, with
`--label`. With `--for-company`, it's the company's:

```sh
pnpm exec kindgi connections connect google --for-company --label=support --permissions=gmail.readonly,gmail.send
```

It prints the link to open. For the company's, sign in as the mailbox
itself, not as yourself. Once you have, it prints which connection it made:

```text
Connected support (support@acme.example at google, company) (connection 0b6f3a52-…).
```

Connect `sales@acme.example` the same way, with `--label=sales`, and the
company has two Google connections.

- **Each owner keeps one connection per account,** registration and
  environment: the company, and each person. A connect that signs in to an
  account its owner already has there reconnects that connection when the
  grant keeps every permission it holds: it keeps its name, whatever
  `--label` asked, and gains what was allowed. Otherwise the connection
  stays as it was: the connect answers connected if the connection is
  working and already holds what was asked, and is declined with what's
  `missing` if not. To add a permission, name the connection with
  `--reconnect`, or use **Ask Google for more** on its page in the
  console. Declined at the app, such a connect says
  `Declined at <app> (not <permissions>): nothing from this sign-in was kept.`
  (CLI 0.6.0 or later): a connection its owner already had of that account
  stays as it was.
- **`--reconnect=<connection>`** reconnects one by name or id, and needs
  the same account. It doesn't take `--label`: a reconnect keeps its name.
  It asks for the permissions you list and those the connection holds. A
  grant short of what it holds leaves it as it was: the connect answers
  connected if the connection is working and already holds what was asked,
  and is declined with what's `missing` if not.
- **Rename one** with `kindgi connections update`. Its owner or a
  tenant admin can rename it, and only a tenant admin the company's:

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

A **choice** says which connection an agent or a flow uses at an app, in
one project and the runtime's environment. The company's choices name the
company's connections, and only a project admin sets or removes one:
without [authorization](../../../deploy/authorization/), that's a
tenant admin
([Without authorization](../../../deploy/people-and-keys/#without-authorization)).
A person's own choices name theirs ([Your own choices](#your-own-choices)).

The connections a company choice can name are the project's candidates.
List them over HTTP with
`GET /v1/connection-choices/candidates?projectId=<project-id>&app=google`,
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
  workspace's default project.
- **`--app=<app>`** narrows the name to one app's candidates. The choice is
  for the connection's own app.
- **Choosing another** replaces the choice, and says which one it was in
  place of:
  `Chose sales at google for agent acme.mail-helper (choice 8e2a4b13-…), in place of support (choice 5d1c9e07-…).`
  A choice is never edited: the old one is removed, and the next one has
  the next `version`. Choosing the one it already uses changes nothing.
- **A run keeps the connection it got through a choice.** Within a run
  and the runs it starts, an agent or a flow keeps the connection its
  first call got through its choice. So replacing or removing that
  choice applies to every run that hasn't used it yet.
  `@kindgi/connections-inmemory`, for development and tests, keeps no
  run's choice: it answers each call from the current choice. It takes
  mains, choices for a tool, sets and a person's own choices, and picks in
  the order above.
- **It's refused** for a person's connection in a company choice,
  `400 bad-input` ("This is a person's connection: a person chooses their
  own (person, or --mine)."), for any other connection that isn't a
  candidate, `404 connection-not-found`, for an agent or a flow that isn't
  the project's, `404 agent-not-found` or `404 flow-not-found`, and for
  anyone but a project admin, `403 permission-denied` ("Choosing a
  connection takes a project admin.").
- **A choice the agent or flow would never read is refused,** with
  `400 bad-input` and `details.field` `person`: a company choice at an app
  it uses only as each person's own connection ("The agent uses Google
  only as each person's own connection: a person chooses their own
  (person, or --mine)."). It's judged on the version the agent or flow
  resolves to now. One that doesn't use the app now still takes a choice,
  ahead of a version that does, and one that uses the app both ways takes
  either kind. Once the version it resolves to moves to one that reads
  the choice, you can make it again.

Over HTTP, a choice is `PUT /v1/connection-choices` with
`{ "projectId", "agentId" or "flowId", "connectionId" }`, and
`connectionChoices.set` in the clients. For one tool, it also takes
`toolId` and `need`; for several connections, `connectionIds`; and for your
own choice, `person`.

List a project's choices:

```sh
pnpm exec kindgi connection-choices list --table
```

It shows each choice's agent or flow, its tool and need when it's a
tool's, its app, its connections by name, and its choice id. A set's
connections are listed with its default marked, such as
`work (default), home`, and a connection that's no longer a candidate
shows by its id. It lists the company's choices and your own, with yours
marked, such as `yours: work (default), home`. A tenant admin's lists
every person's own choices too, each with the person's user id and how
many connections it has, such as `26fc414a-…: 5 connections`, not their names.
`--agent`, `--flow`, `--app` and `--tool` narrow it, `--mine` lists only
your own, and `--include-removed` lists removed and replaced choices too,
with when.

Anyone who reads the project can list the company's choices:
`GET /v1/connection-choices?projectId=<project-id>`, or
`connectionChoices.list` in the clients. It lists your own choices too, and
a tenant admin's lists every person's. `toolId` narrows it to one tool's
own choices, and `owner=me` to your own, as it does for
`GET /v1/connections`.

Remove a choice by its id:

```sh
pnpm exec kindgi connection-choices unset 8e2a4b13-…
```

It asks first, unless you give `--yes`, then prints
`Removed connection choice 8e2a4b13-….` The agent's or flow's next runs
then use the project's only candidate at the app, and stop with
`connection-not-chosen` when there are several. Over HTTP, that's
`DELETE /v1/connection-choices/{choiceId}`, and `connectionChoices.remove`
in the clients. A removed or unknown choice, one in a project you can't
read, or another person's own choice, is
`404 connection-choice-not-found`. Anyone else but a project admin is
refused a company choice with `403 permission-denied` ("Removing a
connection choice takes a project admin.").

Disconnecting a chosen connection leaves its choice in place. The agent's
calls at that app then fail with `connection-missing`, naming the
connection, until a project admin chooses another or removes the choice.
A run that already kept the connection goes on failing at that app: the
other runs go by the choice as it is then.
Before you disconnect one, list the live choices that name it, in every
project: `GET /v1/connections/{connectionId}/choices`, or
`connections.choices(connectionId)` in the clients. Its owner or a
tenant admin can list them.

## Choose one for a tool

A choice for one of the agent's or flow's tools overrides the agent's or
flow's choice for that tool. The tool's other calls at the app, and the
agent's other tools, go on using the agent's or flow's:

```sh
pnpm exec kindgi connection-choices set sales --agent=acme.mail-helper --tool=acme.mail.send
```

```text
Chose sales at google for tool acme.mail.send of agent acme.mail-helper (choice 1f4d8a62-…).
```

- **`--need=<name>`** says which of the tool's connections the choice is
  for, by the tool's name for it, when the tool needs two of the app, such
  as a tool that copies from one account to another. With one, you can
  leave it out. The answer names it after the tool, such as
  `for tool acme.mail.copy (from) of agent acme.mail-helper`.
- **It's refused** with `400 bad-input` for a tool the agent or flow
  doesn't have, or that doesn't use the app ("The agent has no tool
  acme.mail.send that uses Google."), for a tool with two needs of the app
  and no `--need` ("acme.mail.copy uses Google twice: name the need (from,
  to)."), and for a need the tool doesn't have ("acme.mail.copy has no need
  cc of Google.").
- **A choice of the other kind of connection is refused** too, with
  `400 bad-input` and `details.field` `person`: a company choice for a
  need that's each person's own ("acme.calendar.events's calendar is each
  person's own Google connection: a person chooses their own (person, or
  --mine)."), and your own choice for a need that's the company's
  ("acme.mail.send's mail is the company's Google connection: a project
  admin chooses it for the project, not each person."). As with the
  agent's or flow's choices, it's judged on the version the agent or flow
  resolves to now, and you can make it again once that version moves to
  one that reads it.

To see what a choice can be for, list the agent's needs:
`GET /v1/connection-choices/needs?projectId=<project-id>&agentId=<agent-id>`,
or `connectionChoices.needs({ projectId, agentId })` in the clients. For
each of the agent's or flow's tools' connections, at the version it
resolves now, it lists the tool (`toolId`), its name for the connection
(`need`), the app, whose it is (`as`, `company` or `person`), the
permissions it asks for (`permissions`, the keys from the tool's needs;
runtime 0.6.0 or later), and whether a choice for it can be a set
(`set.allowed`, else `set.reason`: `changes`, `sensitive-data-egress` or
`accounts-input`). A tool whose version couldn't be read is listed in
`unread`. Anyone who reads the project can list them.

## Read several accounts with one tool

A tool that only reads can have several connections in its choice, a
**set**, with one of them its default. The model then picks, call by call,
which one each call reads, so an agent can read several accounts with one
tool.

Say a person keeps a calendar in each of five Google accounts, named
`work`, `home`, `school`, `club` and `acme-board`, and their assistant
agent `acme.assistant` lists events with `acme.calendar.events` (the
ready-made `googleCalendarEventsList`) and adds them with
`acme.calendar.create` (`googleCalendarEventCreate`). To have it answer
with one view of all five:

1. **Connect each account** as yourself, and name it:

   ```sh
   pnpm exec kindgi connections connect google --label=work --permissions=calendar.events.owned.readonly,calendar.events.owned
   pnpm exec kindgi connections connect google --label=home --permissions=calendar.events.owned.readonly
   ```

   And the same for `school`, `club` and `acme-board`. Sign in as that
   account each time. `work`, the first, becomes your main when you
   connect `home`, and it alone can add events, for the create tool.
2. **Give the list tool all five,** with `work` as its default:

   ```sh
   pnpm exec kindgi connection-choices set work home school club acme-board --agent=acme.assistant --tool=acme.calendar.events --default=work --mine
   ```

   ```text
   Chose your work, home, school, club and acme-board at google for tool acme.calendar.events of agent acme.assistant, work by default (choice 6a9b2c4d-…).
   ```
3. **Ask for the week across all of them.** The agent calls
   `acme.calendar.events` once for each account, naming it, and answers
   with one view. With
   [Several calendars](../calendar/#several-calendars), it reads each
   account's calendars too.

`acme.calendar.create` keeps one account: with no choice for it, it uses
your main, here `work`.

- **What the model sees:** the tool shows one more input, `accounts`, with
  a field for each of the tool's connections that has a set, by the tool's
  name for it. Its values are the set's names. A call that names none
  reads the default. For `acme.calendar.events`, whose connection is
  `calendar`:

  ```json excerpt
  "accounts": {
    "type": "object",
    "additionalProperties": false,
    "description": "The connections this call reads, for those that have several to choose from.",
    "properties": {
      "calendar": {
        "type": "string",
        "enum": ["work", "home", "school", "club", "acme-board"],
        "description": "Which of these Google connections this call reads, by name. Leave it out to read work."
      }
    }
  }
  ```
- **The tool never sees `accounts`.** It's taken off before the tool's
  input is checked, so each call still gets one connection per need, and a
  tool written for one account works unchanged. The call's recorded input
  keeps it, so an approval and the run's journal show which account the
  model named.
- **`--default`** is needed with several. Over HTTP, `connectionId` is the
  default, and `connectionIds` lists the set, the default included.
- **A set holds 2 to 10 different connections,** each with a name of its
  own, given with `--label` at the connect or with
  `kindgi connections update`: the model picks them by name, and a
  connection that goes by its account alone is refused.
- **Only a tool that only reads takes a set.** A tool that changes things
  keeps one connection, and so does a tool that declares
  `sensitive-data-egress`, and a tool whose own input already has an
  `accounts` field. A set isn't for an agent's or flow's choice either: it's
  for one tool. `needs` (above) says which tools can take one.
- **In a run a mail started,** the mailbox the mail came to binds the
  tool's connection at that app, so `accounts` isn't offered there: the
  mail's text can't have the agent read another mailbox of the set.
- **A name the set doesn't have** fails the call with
  `connection-missing`, and so does a field for a connection the tool
  wasn't offered a set for, or for one the run's mailbox binds. So does a
  name of the set once the tool's version, as the agent or flow resolves
  it now, no longer takes a set, even in a run that kept its set: only a
  call that names none reads the default. The failure doesn't repeat the
  name. A named account that was disconnected since
  fails the call too, as above. It never reads another one.
- **A run keeps its set.** Within a run and the runs it starts, the names
  the model is offered and the connections they mean stay as they were at
  the run's first use, even if the set is changed meanwhile.

A set widens what the agent can read: whatever a call reads from any
account in it can leave through any tool of the agent that sends. Make a
set only of accounts you're fine with the agent reading together.

The CLI checks a set's flags before it sends the choice, and stops with a
usage error, which exits 2:

- several connections without `--tool`: "A set of connections is for one
  tool: give --tool=<tool-id>"
- several without `--default`: "A set takes --default=<connection>, one of
  the set, which a call that names none uses"
- `--default` with one connection: "--default is a set's: name two or more
  connections"
- a `--default` that isn't one of the set: "--default must be one of the
  set's connections"

The server's refusals, each `400 bad-input`:

- over HTTP, without `toolId`: "A set of connections is for one tool: name
  it."
- fewer than 2, more than 10, or one twice: "A set holds 2 to 10 different
  connections."
- a default outside the set: "The default must be one of the set."
- a tool that changes things: "acme.calendar.create changes things, so it
  keeps one connection."
- a tool that declares `sensitive-data-egress`: "acme.calendar.export may
  send what it reads elsewhere, so it keeps one connection."
- a tool with its own `accounts` input: "acme.calendar.merge has its own
  accounts input, so it can't take a set."
- a connection without a name of its own: "Name ana@acme.example first:
  the agent picks a set's connections by name."

## Your own choices

A person chooses for their own runs with `--mine`, from their own
connections. Over HTTP, that's `person` in the choice
(`"person": { "userId": "<your user id>" }`). It works as the company's
does, for an agent, a flow or one of its tools, one connection or a set,
and it overrides their main:

```sh
pnpm exec kindgi connection-choices set home --agent=acme.assistant --mine
```

- **Only you set and remove your own choices,** and you need only what you
  need to run the agent or flow in the project. A tenant admin reads
  them, and can't set them (`400 bad-input`, "A person makes their own
  choices.").
- **Your candidates** are your own live connections of the app through the
  project's registration:
  `GET /v1/connection-choices/candidates?projectId=<project-id>&app=google&owner=me`
  lists them, with which one is your main.
- **Only your runs read them.** Another person's runs at the same agent go
  by their own choices, or their main.
- **A choice your runs would never read is refused,** with
  `400 bad-input` and `details.field` `person`: your own choice at an app
  the agent or flow uses only as the company's connection ("The agent uses
  Google only as the company's connection: a project admin chooses it for
  the project, not each person."), and for a tool's need that's the
  company's ([Choose one for a tool](#choose-one-for-a-tool)). As with the
  company's choices, it's judged on the version the agent or flow resolves
  to now, and you can make it again once that version moves to one that
  reads it.

## Who sees what

- **Tenant admins** read every connection in full, the company's
  included: `GET /v1/connections` and `GET /v1/connections/{connectionId}`.
  They read every person's own choices too.
- **A project's admins** read its candidates in full: each one's
  `connectionId`, `name`, `app`, `accountLabel` and `state`.
- **A project's other members,** anyone who reads the project, read each
  candidate's `connectionId` and `name` only, and list its company
  choices. They can't read the connection itself:
  `GET /v1/connections/{connectionId}` answers `404 connection-not-found`,
  as for one that isn't there.
- **A person's own connections and choices** stay theirs and the
  tenant admins'. They are never a project's candidates, and a project
  admin never lists them.
- **A person's connection names stay out of what the runtime records,**
  for everyone, that person included. A run's journal keeps their
  account's id and how the call's connection was picked, a failure says the
  app and how many connections they have, and an audit row doesn't name
  them either
  ([What a run records](../reference/#what-a-run-records)). What a call
  took and returned, and what the model wrote, stay as the model and the
  tool made them, so an account the call named can show there.

Without authorization, everyone works in every project, so anyone reads the
candidates' ids and names, and only a tenant admin reads them in full.

## When none is chosen

A call fails the run with `connection-not-chosen` when all of these hold:

- it needs the company's connection of an app;
- its run didn't come from a company mailbox of that app;
- neither its tool nor its agent or flow has a choice for the app in the
  project;
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

For a person's connection, it's the same when they have several of the
app through the project's registration, none of them is their main, and
they have no choice for the tool or the agent. The failure names the app
and how many, not their connections:

```json excerpt
"failure": {
  "code": "connection-not-chosen",
  "message": "This person has 2 Google connections that could be used, and none is their main: they make one their main, or choose one for this agent."
}
```

They make one main, or choose one with `--mine`.

A call that isn't an agent's or a flow's can't have a choice, so it
needs a project with one candidate of the app.

## When the connection changes

A call's connection is decided before it waits for its yes, and asked for
again right before the tool runs. When the two differ, the call doesn't
run, and fails with `connection-changed`. So an approved call runs only on
the connection it was approved against, a person's connection too. That
happens, for example, when the connection was disconnected while the call
waited and another account connected in its place, or when a person's main
was disconnected while the call waited and they have one other left. A
call that got its connection through a choice keeps it, since its run keeps
that connection
([Choose one for an agent or a flow](#choose-one-for-an-agent-or-a-flow)),
so a choice replaced while the call waited doesn't change it. With
`@kindgi/connections-inmemory`, which answers each call from the current
choice, it does, and the call fails with `connection-changed`.

A call that named an account, or got a set's default, never moves to
another one: when that connection is disconnected while the call waits, it
fails with `connection-missing`.

The model reads why as the call's result, and the turn goes on. For the
company's connection, it names the connection before and after:

```text
The connection "mailbox" changed while this call waited (support, support@acme.example, to sales, sales@acme.example), so it didn't run.
```

`mailbox` is the tool's name for the connection. For a person's
connection, it names the tool's name for it and the app only, never the
person's connection names or accounts:

```text
The connection "mailbox" to Google changed while this call waited, so it didn't run.
```

An approval for a call that uses a connection says which one it's for: the
company's by its account, and a person's as "this person's Google account",
with the connection's id, by which the person, or a tenant admin, reads which
of their accounts it is
([An approval's fields](../../approvals/approvals-reference/#an-approvals-fields)).
The account a call named is in the call's input, which the approval shows.
