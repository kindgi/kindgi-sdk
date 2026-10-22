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

Each person or company has one live connection per registration and
environment. A person's connection serves every project the registration
allows.

Only a connection's owner and your workspace's admins can see it or remove
it. Registering an app is for workspace admins only.

## Where the token is kept

- **The long-lived token** (a refresh token) is one secret in your
  workspace's secret store, written when the person connects. People's own
  secret commands can't read or change it.
- **Access tokens** are kept only in the runtime's memory, until shortly
  before they expire.
- **A GitHub App connection keeps no token.** Each call's token is made from
  the app's private key, which stays in your secret store.

A token goes only into the one call that needs it: never into a run's
journal, a log, an approval or an error. The journal records which
connection and account a call used.

## Renewal

- **Only when a call needs it.** Nothing renews a connection in the
  background, so a connection nobody uses isn't kept alive.
- **An idle connection lapses** when the app says so: Google ends access
  unused for six months. The next call that needs it asks its owner to
  connect again ([When the connection is missing](../use-a-connection/#when-the-connection-is-missing)).
- **The connection's page shows when it was last used,** so you can
  disconnect what nobody uses.

## Disconnecting

The connection's owner, or a workspace admin, disconnects it from the
console's **Connections** page. Kindgi then:

1. **Stops new uses** at once, on every replica.
2. **Withdraws access at the app,** where that's safe:
   - **Google:** withdraws the grant, unless another live connection in
     your workspace uses the same Google account. Google's withdrawal
     covers the whole grant, so it would end that connection's access too.
   - **GitHub:** revokes the live token. The app stays installed on your
     organization until you uninstall it on GitHub
     ([GitHub](../github/#disconnecting)).
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

An app can tell Kindgi when access ends on its side, at the notices address
its registration shows. Each notice is checked by its signature.

- **GitHub:**
  - the app uninstalled from your organization: its connection is removed;
  - the app suspended: its connection needs reconnecting, and works again
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
  run's project. An admin registers it.
- **`connection-needs-a-person`:** the tool needs a person's connection,
  and the run acts as nobody: a service account's run, or an event's.
- **`connection-missing`:** the connection isn't there, lacks a
  permission, or needs reconnecting, and the run can't wait for its owner.
  The error names the app and what's missing.
- **`connection-declined`:** the person declined, or didn't allow a
  permission the call needs.
- **`connection-timed-out`:** nobody connected before the wait ran out.
- **`connection-rejected`:** the app refused the token, after one renewal
  and one more try.
- **`connection-approver-not-a-reviewer`:** the person whose connection it
  is would approve the call, and has no reviewer seat at its rank.
- **`connection-approval-conflict`:** a rule asks for a second person to
  approve a call that uses a person's connection, which can't be met yet.

The HTTP API reference lists the errors each route answers.
