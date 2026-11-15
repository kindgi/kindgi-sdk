---
title: HubSpot
description: Register your company's own HubSpot MCP connector with Kindgi, so people, or the company, can connect HubSpot, and agents can use the tools of HubSpot's MCP server.
sidebar:
  order: 28
  label: HubSpot
---

When you finish this page, people in your workspace can connect their
HubSpot user, and your agents and flows can call the tools of HubSpot's own
MCP server as them: reading and changing the records their HubSpot user
may, such as contacts, companies, deals and tickets. A tenant admin can
connect the company's HubSpot user too, for runs that act for nobody, such
as a shared schedule's. They connect through an MCP connector in your
HubSpot account, which you register with Kindgi once. The tools come from
HubSpot's server, which Kindgi registers as an MCP endpoint
([Sign in as a connection](../../tools/mcp-servers/#sign-in-as-a-connection)).

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **Kindgi 0.8.0 or later,** the runtime and the CLI.
- **A HubSpot account,** and someone in it with the developer platform:
  HubSpot gives it to super admins by default, and anyone else needs a
  Developer seat, or the **Developer tools access** permission
  ([HubSpot: Developer seats](https://developers.hubspot.com/docs/apps/developer-platform/developer-seats)).
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). This page
  runs it in your pack's directory, as `pnpm exec kindgi`
  ([Install](../../../start/install/)).

## 1. Create the MCP connector at HubSpot

In your HubSpot account
([HubSpot: Integrate AI tools with the HubSpot MCP server](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)):

1. **Development → MCP Connectors → Create MCP connector.** HubSpot's
   earlier pages call it an MCP auth app.
2. Fill in:
   - **Name:** one people recognize when they connect.
   - **Redirect URL:** the console's connect page:

     ```text
     https://kindgi.acme.com/console/connect/callback
     ```

     A runtime on your own machine at `http://localhost:18096` sends people
     back to `http://localhost:18096/console/connect/callback`: HubSpot
     takes `http` on `localhost`. A connector takes more than one redirect
     URL, and the first is its default.
   - **Description** and **Icon** are optional.

   Then choose **Create**.
3. **Keep the Client ID and the Client secret** from the connector's
   details page, where HubSpot takes you next.

There are no scopes to pick, and Kindgi's sign-in asks for none: HubSpot
sets them from the tools its MCP server has when someone connects, and what
they allow then. Whatever a tool does, it does as the HubSpot user who
connected, with that user's permissions in HubSpot.

## 2. Store the client secret

The secret goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
pnpm exec kindgi secrets set ACME_HUBSPOT_CONNECT_SECRET --env=prod --scope=tenant
```

- `ACME_HUBSPOT_CONNECT_SECRET` is the secret's name. The registration
  keeps only this name.
- `--env` is the env your runtime serves, its `KINDGI_ENV`: `prod` here, as
  on Kindgi Cloud. `kindgi auth whoami` prints yours, in its `servedEnv`
  field
  ([Three things called env](../../../concepts/local-staging-production/#three-things-called-env)).
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

## 3. Register the connector with Kindgi

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **HubSpot** as the **App**:

- **Client id:** the connector's Client ID.
- **Client secret: its name in Kindgi's secrets:** the environment and name
  you stored it under, `prod/ACME_HUBSPOT_CONNECT_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows the **Redirect URI** you entered in
step 1.

Or register it from the command line:

```sh
pnpm exec kindgi connection-apps add hubspot --client-id=<client-id> --client-secret-ref=prod/ACME_HUBSPOT_CONNECT_SECRET
```

The command prints the registration as JSON, with the Redirect URI as its
`redirectUrl`. `--projects=<project-id>,…` lets only those projects' runs
use it.

## 4. Connect

Each person connects their own HubSpot user. In a project, open
**Connections**, choose **Connect an app**, pick HubSpot, and sign in to
HubSpot. HubSpot asks which of their HubSpot accounts to connect, and what
to allow, from what their HubSpot user may do. Or, from a terminal:

```sh
pnpm exec kindgi connections connect hubspot --permissions=mcp.tools
```

HubSpot has one permission, `mcp.tools`, and every connection holds it:
"Use HubSpot's tools as you: read and change the records your HubSpot user
may, as far as the connector allows".

Kindgi doesn't learn which HubSpot user or account connected. So the
connection is named HubSpot, unless the connect gives it a name
(`--label`), and each person has one HubSpot connection: connecting again
renews it, whichever HubSpot user signs in.

**The company's connection** is a tenant admin's to make. In a project,
open **Connections**, choose **Connect an app**, pick HubSpot, and under
**For** choose **The company**, or add `--for-company` to the command. Then
sign in to HubSpot as the user the company's runs act as: everything they
do in HubSpot shows as that user's. The company has one HubSpot connection
too.

HubSpot lets super admins require their approval before others connect an
app, and see who has connected it, in HubSpot's settings under
**Integrations → Connected Apps**
([HubSpot: Manage access to apps](https://knowledge.hubspot.com/integrations/manage-access-to-ai-connectors)).

## 5. Register HubSpot's MCP server

Once you've connected, register HubSpot's server at the runtime, so your
agents and flows get its tools:

```sh
pnpm exec kindgi mcp add hubspot
```

```text
  Registered "hubspot" (preset hubspot) at the runtime: it signs in as each person's own HubSpot connection.
  Its tools are listed with yours (3c7e1f90-…).
```

Each call of its tools then uses the connection of the person the run acts
for. An agent's call in a run they started waits for them to connect, if
they haven't.

For the company's connection instead, which a shared schedule's or a
webhook's run can use too, a tenant admin connects it first (step 4), then
registers the server with `--as=company`:

```sh
pnpm exec kindgi mcp add hubspot --as=company
```

Its tools are named after the endpoint's id, such as
`hubspot.get_user_details`. To have both, give the second one an id of its
own, such as `--server-name=hubspot-company`. `--scope=project:<project-id>`
gives the tools to one project only
([Sign in as a connection](../../tools/mcp-servers/#sign-in-as-a-connection)).
Which tools HubSpot's server lists, and to whom, is HubSpot's to set: it
depends on the account's subscription, the user's permissions and the
account's settings.

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at HubSpot, since HubSpot's MCP server has no way to give a token
back: what the person allowed stays allowed until it's removed at HubSpot.

HubSpot's docs say a connected app is uninstalled in HubSpot's settings,
under **Integrations → Connected Apps**, with **Actions → Uninstall**
([HubSpot: Connect apps to HubSpot](https://knowledge.hubspot.com/integrations/connect-apps-to-hubspot)).
A super admin can uninstall one person's from the app's **Manage access**
page, or take back the app's approval, which uninstalls it for everyone who
installed it
([HubSpot: Manage access to apps](https://knowledge.hubspot.com/integrations/manage-access-to-ai-connectors)).

## When HubSpot ends access

HubSpot sends Kindgi no notice, so Kindgi finds out the next time it renews
the token. The connection then needs reconnecting. A run its owner started
waits for them to connect again. In any other run, the call fails with
`connection-missing`, and the **Connections** page shows it. While the
connection the tools are listed with needs reconnecting, the endpoint keeps
the tools it last listed.

HubSpot's changelog says that when its server reaches new kinds of
records, a connector may need connecting again before its tools reach them
([HubSpot changelog](https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available)).
Connecting HubSpot again in Kindgi renews the connection with what the
person allows then.
