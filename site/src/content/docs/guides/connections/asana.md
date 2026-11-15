---
title: Asana
description: Register your company's own Asana MCP app with Kindgi, so people, or the company, can connect Asana, and agents can use the tools of Asana's MCP server.
sidebar:
  order: 29
  label: Asana
---

When you finish this page, people in your workspace can connect their
Asana user, and your agents and flows can call the tools of Asana's own MCP
server as them: reading and changing the tasks, projects and comments their
Asana user may. A tenant admin can connect the company's Asana user too,
for runs that act for nobody, such as a shared schedule's. They connect
through an MCP app in Asana's developer console, which you register with
Kindgi once. The tools come from Asana's server, which Kindgi registers as
an MCP endpoint
([Sign in as a connection](../../tools/mcp-servers/#sign-in-as-a-connection)).

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **Kindgi 0.8.0 or later,** the runtime and the CLI.
- **An Asana user** to create the app with.
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). This page
  runs it in your pack's directory, as `pnpm exec kindgi`
  ([Install](../../../start/install/)).

## 1. Create the MCP app at Asana

In Asana's developer console, at `https://app.asana.com/0/my-apps`, or from
your profile photo, **Settings → Apps → View developer console**
([Asana: Integrating with Asana's MCP server](https://developers.asana.com/docs/integrating-with-asanas-mcp-server)):

1. **Create new app.** Give it a name people recognize when they connect,
   pick **MCP app** as its type, and choose **Create app**.
2. **Keep the Client ID and the Client secret** Asana shows next.
3. **OAuth:** add the console's connect page as a redirect URL:

   ```text
   https://kindgi.acme.com/console/connect/callback
   ```

   A runtime on your own machine at `http://localhost:18096` sends people
   back to `http://localhost:18096/console/connect/callback`. Asana takes
   `http` on `localhost` from a sign-in that uses PKCE, as Kindgi's does
   ([Asana: OAuth](https://developers.asana.com/docs/oauth)). An app takes
   more than one redirect URL.
4. **Manage distribution:** under **Distribution method**, choose
   **Specific workspaces** and add yours, or **Any workspace**, then **Save
   changes**. You can add only the workspaces you're a member of. Someone
   whose workspace isn't on the list can't connect: Asana tells them the app
   isn't available to their workspace.

There are no scopes to pick, and Kindgi's sign-in asks for none: an MCP app
has none, and Asana refuses a sign-in that asks for one. What a tool may do
is what the Asana user who connected may, and everything it does shows in
Asana as theirs. A token from an MCP app works with Asana's MCP server only,
not with Asana's REST API.

## 2. Store the client secret

The secret goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
pnpm exec kindgi secrets set ACME_ASANA_CONNECT_SECRET --env=prod --scope=tenant
```

- `ACME_ASANA_CONNECT_SECRET` is the secret's name. The registration keeps
  only this name.
- `--env` is the env your runtime serves, its `KINDGI_ENV`: `prod` here, as
  on Kindgi Cloud. `kindgi auth whoami` prints yours, in its `servedEnv`
  field
  ([Three things called env](../../../concepts/local-staging-production/#three-things-called-env)).
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

## 3. Register the app with Kindgi

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **Asana** as the **App**:

- **Client id:** the app's Client ID.
- **Client secret: its name in Kindgi's secrets:** the environment and name
  you stored it under, `prod/ACME_ASANA_CONNECT_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows the **Redirect URI** you entered in
step 1.

Or register it from the command line:

```sh
pnpm exec kindgi connection-apps add asana --client-id=<client-id> --client-secret-ref=prod/ACME_ASANA_CONNECT_SECRET
```

The command prints the registration as JSON, with the Redirect URI as its
`redirectUrl`. `--projects=<project-id>,…` lets only those projects' runs
use it.

## 4. Connect

Each person connects their own Asana user. In a project, open
**Connections**, choose **Connect an app**, pick Asana, sign in to Asana,
and allow what's asked. Asana says its users pick one workspace there: the
connection reaches that workspace only. Or, from a terminal:

```sh
pnpm exec kindgi connections connect asana --permissions=mcp.tools
```

Asana has one permission, `mcp.tools`, and every connection holds it: "Use
Asana's tools as you: read and change the tasks, projects and comments your
Asana user may".

Kindgi doesn't learn which Asana user or workspace connected. So the
connection is named Asana, unless the connect gives it a name (`--label`),
and each person has one Asana connection: connecting again renews it,
whichever Asana user signs in, and whichever workspace they pick.

**The company's connection** is a tenant admin's to make. In a project,
open **Connections**, choose **Connect an app**, pick Asana, and under
**For** choose **The company**, or add `--for-company` to the command. Then
sign in to Asana as the user the company's runs act as: everything they do
in Asana shows as that user's. The company has one Asana connection too.

On Asana's Enterprise+ and Legacy Enterprise plans, an Asana admin can
block apps. If yours is blocked, Asana asks the person to send their admin
a request to unblock it
([Asana: Using Asana's MCP server](https://developers.asana.com/docs/using-asanas-mcp-server)).

## 5. Register Asana's MCP server

Once you've connected, register Asana's server at the runtime, so your
agents and flows get its tools:

```sh
pnpm exec kindgi mcp add asana
```

```text
  Registered "asana" (preset asana) at the runtime: it signs in as each person's own Asana connection.
  Its tools are listed with yours (3c7e1f90-…).
```

Each call of its tools then uses the connection of the person the run acts
for. An agent's call in a run they started waits for them to connect, if
they haven't.

For the company's connection instead, which a shared schedule's or a
webhook's run can use too, a tenant admin connects it first (step 4), then
registers the server with `--as=company`:

```sh
pnpm exec kindgi mcp add asana --as=company --scope=project:<project-id>
```

`--scope=project:<project-id>` gives its tools to that project only, and
without it, the whole workspace has them. Its tools are named after the
endpoint's id, `asana`. To have both, give the second one an id of its own,
such as `--server-name=asana-company`
([Sign in as a connection](../../tools/mcp-servers/#sign-in-as-a-connection)).

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at Asana. The access token it last had works until its hour is up,
and what the person allowed stays allowed until it's removed at Asana.

Asana's help center says a person removes an app from their profile photo,
**Settings → Apps**, with **Deauthorize** next to it.

## When Asana ends access

Asana sends Kindgi no notice, so Kindgi finds out the next time it renews
the token. The connection then needs reconnecting. A run its
owner started waits for them to connect again. In any other run, the call
fails with `connection-missing`, and the **Connections** page shows it.
While the connection the tools are listed with needs reconnecting, the
endpoint keeps the tools it last listed.
