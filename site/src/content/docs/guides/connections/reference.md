---
title: How connections work
description: A connection's states, where its token is kept, how it's renewed, what disconnecting withdraws and destroys on each secret store, and what each error means.
sidebar:
  order: 50
  label: How connections work
---

## A connection's states

- **Working:** calls can use it.
- **Needs reconnecting:** the app ended its access, or it was suspended.
  Its owner connects again, with the same account.
- **Removing:** a disconnect has started. No new call uses it.
- **Removed:** its token is withdrawn and destroyed. The record stays, with
  who removed it, when and why.

The company and each person keep one live connection per account,
registration and environment, which serves every project the registration
allows. So either can have several of one app, each with its own name: the
company's `support@acme.example` and `sales@acme.example` at Google, say,
or a person's work and home accounts. A connect that lands on an account
its owner already has reconnects that connection when the grant keeps
every permission it holds, and the connection keeps its name and gains
what was allowed. One of a person's connections through a
registration in an environment is their **main**, the one their agents use
when no choice names another. When there are several, the run's mail, a
choice or a person's main says which one a call uses
([Choose a connection](../choose-a-connection/)).

Each connection has a name, its `label`, that people know it by. It's the
name given at the connect, or else the account's, such as an email address.
Its owner or a tenant admin can change it
(`PATCH /v1/connections/{connectionId}`). A name is 1 to 100 characters
once spaces at either end are trimmed, with no control, format or invisible
character, such as a bidi override, a zero-width joiner or a line
separator, and no variation selector except in an emoji. So a typed name
with a joined emoji such as 👩‍💻 is refused, while ✉️ and 1️⃣ are fine. A
name taken from the account loses those characters and is cut to 100. One
owner's live connections to an app in an environment each have their own
name, whatever the case, an emoji's variation selector or how accented
letters are encoded. A new connection whose name was taken in the meantime
gets the first free number after it, such as `ana@acme.com 2`. A reconnect
keeps the name. A connection made before connections had names has none,
and shows its account.

Only a connection's owner and your workspace's admins can see, rename or
remove it. A project's members see the names of the company's connections
it can use, so they can tell them apart
([Who sees what](../choose-a-connection/#who-sees-what)). Registering an app
is for tenant admins only.

## Where the token is kept

- **The long-lived token** (a refresh token) is one secret in your
  workspace's secret store, written when the person connects, and again
  when the app hands out a new one. People's own secret commands can't
  read or change it.
- **Access tokens** are kept only in the runtime's memory, until shortly
  before they expire. When the app gives no refresh token, as LinkedIn
  does for most apps, the access token is kept as that one secret
  instead, until it ends.
- **A GitHub App connection keeps no token.** Each call's token is made from
  the app's private key, which stays in your secret store.

A token goes only into the one call that needs it: never into a run's
journal, a log, an approval or an error. The journal records which
connection and account a call used
([What a run records](#what-a-run-records)).

## What a run records

Each call that runs on a connection records it in the run's journal, as
`"kind": "ready"` with its `connections`, each under the tool's name for
the connection: its `connectionId`, `app`, `appName` and `account`, and
for the company's connection, its `name`.
The company's `account` is `{ "id", "label" }`. A person's is `{ "id" }`
only: the runtime keeps a person's account by its id, never its label. The
record also says how the connection was picked, as `pick`:

```json excerpt
"mailbox": {
  "connectionId": "0b6f3a52-…",
  "app": "google",
  "appName": "Google",
  "account": { "id": "…", "label": "support@acme.example" },
  "name": "support",
  "pick": {
    "by": "choice",
    "choiceId": "5d1c9e07-…",
    "as": "company",
    "registration": { "id": "1a2b3c4d-…", "name": "Google (1a2b3c4d)" }
  }
}
```

A person's, for a call that named one of the five accounts in its tool's
set ([Read several accounts with one tool](../choose-a-connection/#read-several-accounts-with-one-tool)):

```json excerpt
"calendar": {
  "connectionId": "3c7e1f90-…",
  "app": "google",
  "appName": "Google",
  "account": { "id": "…" },
  "pick": {
    "by": "named",
    "choiceId": "6a9b2c4d-…",
    "as": "person",
    "setSize": 5,
    "registration": { "id": "1a2b3c4d-…", "name": "Google (1a2b3c4d)" }
  }
}
```

- **`by`** is how it was picked
  ([Which connection a call uses](../choose-a-connection/#which-connection-a-call-uses)):
  - `mailbox`: the mailbox the run's mail came to, the company's or the
    person's.
  - `named`: the connection of the tool's set that the call named, with
    the set's `choiceId`.
  - `choice`: a choice, with its `choiceId`: the tool's, else the agent's
    or flow's, the company's or the person's own. With a set, it's the
    set's default, which a call that named none got.
  - `only`: the project's only company candidate.
  - `main`: the person's main connection
    ([A person's accounts](../choose-a-connection/#a-persons-accounts)).
  - `own`: the person's only connection of the app.
- **`as`** is whose connection the call needed: `company`, or `person`,
  the run's person.
- **`setSize`**, with a set, is how many connections it holds. It counts a
  person's set, and never names the others.
- **`registration`** is the registration the connection came through,
  `{ "id", "name" }`. Its name is its label, which
  `kindgi connection-apps list --table` shows, else its app's name and the
  first 8 characters of its id, as above.

`pick` names registrations only, never a person's connection names or
accounts. Records from older runtimes have no `pick`, or a `pick` without
`as` and `setSize`, and keep a person's account label as it was recorded.

A call that its connections stopped before it ran records why instead, as
`"kind": "refused"`: its [`code`](#errors-when-a-call-uses-a-connection),
the tool's name for the connection (`name`), the `app`, whose connection
the call needed (`as`), any permissions the connection lacks (`missing`),
and the `message`. The company's `connection-not-chosen` also lists the
connections to choose from (`choices`, each `{ "connectionId", "name" }`);
a person's lists none. Records from older runtimes have no `as`.

An agent's call also records when its tool is handed those connections,
as `"kind": "ran"`, right before the tool's first run on them, once for
each attempt of the call's step. Its `ready` record then has
`"recordsRan": true`, and a call with that and no `ran` record didn't
run: an approval turned it down, or the check right before its tool
stopped it (`connection-changed`, say). A call whose input then failed
the tool's input check has a `ran` record too, and its tool didn't
start: its result says the input failed (`invalid-arguments`). A flow's
tool step records `ready` right before its tool runs, so there the
`ready` record says it was handed its connections, and a step that then
failed with `input-validation-failed` didn't start either. Records from
older runtimes have neither `ran` nor `recordsRan`.

In the console, a run's page words this record under **What happened**,
below each tool call that ran, in an agent's turn or a flow's tool step:

```text
Ran on the company's Google connection "support", the mailbox the run's mail came to.
Ran on the company's Google connection "support", chosen for it.
Ran on the company's Google connection "support", the default of the set chosen for it.
Ran on the company's Google connection "support", which the call named from its set.
Ran on the company's Google connection "support", the project's only one.
Ran on their Google connection whose mailbox the run's mail came to.
Ran on their Google connection chosen for it.
Ran on their Google connection, the default of a set of 5 chosen for it.
Ran on one of 5 of their Google connections, which the call named from their set.
Ran on their main Google connection.
Ran on their only Google connection.
Ran on a connection to Google.
```

The first five are the company's, and the next six a person's, by `by`
and `setSize`. When you're the run's person, "their" reads "your". "Chosen
for it" links to the choice, when you can read it. The last line is for a
record without `pick`. A record without `as` reads as it did before: `own`
as a person's, one with a `name` as the company's, and any other as the
last line. A call that didn't run, such as one an approval turned down,
has no line. A call that ran has a line for each connection it ran on, but
in a record without `pick` the connections of one app share one line.
These lines name a person's connection by its app only, and a set's by how
many it holds, never which.

The page tells that a call ran from these records, for the attempt of its
step that it ended on: an agent's call from its `ran` record, a flow's
tool step from its `ready` one. A call whose input failed the tool's
input check has no line, since its tool never started. For an agent's
record from an older runtime, with no `recordsRan`, the page tells from
the call's result instead, so two cases come out wrong there. In a turn
that's still running, or that failed, it has no results to read, so a
call that the check right before its tool stopped still shows its line.
And in a turn that completed, a call that ran, was refused by the app and
then couldn't get its connection again shows none.

Anyone with `read` on the project can read the run's journal, and so this
record: a company connection's account label, and a person's account by
its id only. What a call took and returned, and what the model wrote, stay
as the model and the tool made them, so an account a call named can show
there.

## Renewal

- **Only when a call needs it.** Nothing renews a connection in the
  background, so a connection nobody uses isn't kept alive.
- **If the app can't give a token just now,** because it doesn't answer
  or answers with an error that doesn't end the grant, the call fails with
  `connection-renew-failed`. The connection stays as it is, and a later
  call tries again.
- **If the app has ended the grant** (it answers `invalid_grant`), the
  connection needs reconnecting, and its stored token is destroyed.
- **An idle connection lapses** when the app says so: Google ends access
  unused for six months, and Microsoft after 90 days by default. The
  connection then needs reconnecting
  ([When the connection is missing](../use-a-connection/#when-the-connection-is-missing)).
- **An app that gives no refresh token** ends a connection when its access
  token ends: LinkedIn gives them only to partners it approves, and its
  access lasts 60 days. Kindgi knows when. From seven days before, the
  connection says when it ends, and where the deployment sends mail,
  whoever can reconnect it gets one email (runtime 0.7.0 or later). Just
  before its access ends, the connection needs reconnecting, with no call
  to the app
  ([LinkedIn](../linkedin/#when-linkedin-ends-access)).
- **The connection's page shows when it was last used,** so you can
  disconnect what nobody uses.
- **The connection's page lists what it may do.** **Ask** *app*
  **for more** there (for Google, **Ask Google for more**) adds
  permissions to it while it's live: you sign in at the app as its
  account, which is asked for what you tick and what the connection holds.
  A grant short of what it holds changes nothing.
- **Each renewal is logged** at info level as
  `a connection was renewed`, with the connection's id, its app and a
  hash of its account, never a token or an address. A renewal that finds
  the grant ended logs
  `a connection renewal found it needs reconnecting`, with the reason.

## Disconnecting

The connection's owner, or a tenant admin, disconnects it from the
console's **Connections** page, or from a terminal, by its id from
`kindgi connections list`:

```sh
npx --yes @kindgi/cli@0.4 connections disconnect <connection-id>
```

It asks first, unless `--yes`, and prints what was done. Kindgi then:

1. **Stops new uses** at once, on every replica.
2. **Withdraws access at the app,** where that's safe:
   - **Google:** withdraws the grant, unless another live connection in
     your workspace uses the same Google account. Google's withdrawal
     covers the whole grant, so it would end that connection's access too.
   - **GitHub:** revokes the short-lived tokens it holds. Any other ends
     within the hour, when GitHub expires it. The app stays installed on
     your organization until you uninstall it on GitHub
     ([GitHub](../github/#disconnecting)).
   - **Microsoft:** withdraws nothing. Your app keeps what the person
     allowed until it's removed at Microsoft
     ([Microsoft](../microsoft/#disconnecting)).
   - **LinkedIn:** withdraws nothing, since LinkedIn has no way to give a
     token back. It works until its 60 days end, or until the person
     removes your app at LinkedIn ([LinkedIn](../linkedin/#disconnecting)).
   - If the app doesn't answer, Kindgi records that and goes on.
3. **Destroys the stored token** in your secret store (below).
4. **Records the removal,** with a signed audit event that names the app
   and the connection, and never the account's address.

If a disconnect stops part way, disconnecting again finishes it.

### What destroyed means on each secret store

- **Kindgi's own store, in PostgreSQL:** the token's encrypted value and its
  wrapped key are cleared, for every version. The old bytes can stay in the
  database's write-ahead log and in its backups until they're recycled, or
  age out under your backup retention. With your own KMS key, nothing in
  the KMS is destroyed: the wrapped key that the KMS key opened is cleared
  with the value.
- **Google Secret Manager:** the secret is deleted, with all its versions.
- **HashiCorp Vault:** every version is destroyed, then the secret's
  metadata.
- **Azure Key Vault:** the secret is deleted, but Key Vault's soft delete
  keeps a deleted copy for the vault's retention period, which you set
  between 7 and 90 days. Kindgi doesn't purge it.

([Keep secrets in your own secret manager](../../../deploy/self-hosted/secret-manager/))

## Notices from the app

An app can tell Kindgi when access ends on its side, at the address its
registration shows: GitHub's **Webhook URL**, or Google's **RISC
receiver**. Each notice is checked by its signature.

- **GitHub:**
  - the app uninstalled from your organization: its connections are
    removed;
  - the app suspended: its connections need reconnecting, and work again
    when the suspension is lifted;
  - any other event changes nothing.
- **Google,** if you set up Cross-Account Protection:
  - the person removing your client's access, or their Google account
    disabled: their connections are removed;
  - one token withdrawn: the connection that held it is removed;
  - the person's sessions ended at Google: their connections need
    reconnecting;
  - any other event changes nothing.

  Without Cross-Account Protection, Kindgi finds out the next time it
  renews the token: Google refuses, and the connection then needs
  reconnecting.

A notice changes only what was connected before it, so someone who has
connected again since keeps working. A connection a notice removes is
already gone at the app, so Kindgi only destroys the stored token.

## Errors when a call uses a connection

- **`connection-app-missing`:** no registration of that app allows the
  run's project, and an admin registers it. Or the runtime doesn't offer
  connections at all, as under `kindgi dev`
  ([What you need](../#what-you-need)).
- **`connection-needs-a-person`:** the tool needs a person's connection,
  and the run acts as nobody: a service account's run, or an event's.
- **`connection-missing`:** the connection isn't there, lacks a
  permission, or needs reconnecting, and the run can't wait for its owner.
  The error names the app and what's missing. A company connection that's
  there but can't serve the call is named too, a person's by the tool's
  name for it, and the call never falls back to another one. A name in
  `accounts` that the tool's set doesn't have fails the call the same way,
  and so does one of the set once the tool's version no longer takes a
  set, without repeating the name
  ([Read several accounts with one tool](../choose-a-connection/#read-several-accounts-with-one-tool)).
- **`connection-not-chosen`:** the call needs a company connection, the
  project has several of the app, and the agent or flow has no choice of
  one. The run fails, naming them. Or the call needs a person's
  connection, they have several of the app and none is their main, and
  they have no choice of one: the run fails, counting them, not naming
  them
  ([When none is chosen](../choose-a-connection/#when-none-is-chosen)).
- **`connection-changed`:** the call's connection changed while it waited,
  such as for its approval, so it didn't run. The model reads that, and
  the turn goes on
  ([When the connection changes](../choose-a-connection/#when-the-connection-changes)).
- **`connection-declined`:** the person declined, or didn't allow a
  permission the call needs.
- **`connection-timed-out`:** nobody connected before the wait ran out.
- **`connection-rejected`:** the app refused the token, after one renewal
  and one more try. The connection stays as it is: a refusal can mean the
  call lacks a permission. A connection with no refresh token isn't
  renewed: one refusal and it needs reconnecting, and the call fails with
  `connection-missing`.
- **`connection-renew-failed`:** the app couldn't give a new token just
  now. The connection stays as it is, and a later call tries again.
- **`connection-approver-not-a-reviewer`:** the person whose connection it
  is would approve the call, and has no reviewer seat at its rank.
- **`connection-approval-conflict`:** a rule asks for a second person to
  approve a call that uses a person's connection, which can't be met.

The HTTP API reference lists the errors each route answers.
