---
title: Security
description: How Kindgi keeps tenants apart, authenticates callers and handles secrets, and what to know before you deploy it.
sidebar:
  order: 7
---

This page covers four things: what keeps one tenant's data from another's,
who may call the API, what a tenant can't make the server do, and where
secrets live. It ends with what to check before you deploy.

## Tenants and isolation

Every record the runtime stores (runs and their journals, agents, flows,
tools, conversations, secrets) carries its **tenant** id. Postgres
**row-level security** restricts each query to the tenant it runs for.
Requests are handled as a database role that can't bypass those policies,
so a query that forgot its tenant finds nothing rather than another
tenant's rows.

A runtime serves the tenant it's started with, `KINDGI_TENANT_ID`. Without
one, it creates a new tenant at every start and prints its id, so set it
for anything that should keep its data across restarts. For hard
separation between customers or environments, give each its own runtime
and database.

## Calling the API

Every `/v1` request carries the deployment's API token:

```sh
curl -H "Authorization: Bearer $KINDGI_API_TOKEN" "$KINDGI_API_URL/v1/runs?limit=1"
```

Set it with `KINDGI_API_TOKEN` (a `kgi_bt_…` value from your secrets
store). Without it, the runtime generates one at each start and prints it.
Tokens are compared in constant time. A wrong or missing token gets `401`:

```json
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-88fd4597-bed6-4936-9906-83fafe44712d"}}
```

To rotate the token, restart the runtime with a new value.

With [authorization](../../deploy/authorization/) on, people and service
accounts have API keys of their own (`kgi_ak_…`), each acting with its
holder's grants and no more; revoking one refuses it from its next request
([People, API keys and service accounts](../../deploy/people-and-keys/)).

## Signing in to the console

People sign in to the console with their email first; the sign-in page then
offers the ways in the deployment has ([Turn on sign-in](../../deploy/sign-in/)):

- **Only people already added to a workspace get in,** by an email their
  provider has proved. Nobody is created by signing in, and roles stay
  Kindgi's: an identity provider says who someone is, not what they may do.
- **Google and Microsoft speak for a work email only through the company's
  own accounts,** and a workspace with its own identity provider signs its
  domain's people in with it alone.
- **The buttons a person sees grant nothing.** Which "Continue with" buttons
  appear depends on the email's domain alone; access is decided after the
  provider signs them in.
- **A workspace's own identity provider is offered only for a domain
  verified for that workspace,** so one workspace can't claim another
  company's domain and catch its people.
- **The first sign-in links the provider account to the person.** A
  different account with the same email is refused afterwards, so an address
  that moves to someone new can't take the person over.
- **Sessions are cookies the page's scripts can't read,** stored only as a
  hash, and no provider token is kept. A request signed in by the cookie
  that changes something must come from the console's own origin.
- **Signing in with an API token is off by default** outside `kindgi dev`.

## Following a run from a browser

Your backend keeps the API token. A browser that shows a run's progress
gets a **public run token** (`kgi_pt_…`) instead: `POST /v1/runs` returns
one as `publicAccessToken`, and your backend can mint more with
`POST /v1/tokens/public`.

A public run token is:

- **read-only:** it opens only `GET /v1/runs/{runId}/progress` and that
  run's event stream (`/progress/stream`);
- **limited to the runs it names:** up to 50;
- **short-lived:** 15 minutes by default, 24 hours at most.

With it, a browser can follow the run:

```sh
curl -H "Authorization: Bearer $PUBLIC_TOKEN" "$KINDGI_API_URL/v1/runs/$RUN_ID/progress"
```

```json
{"id":"086f8e9b-9368-4f3a-9c28-9a84fb3f1a09","flowId":"agent.turn","flowVersion":"1.1.0","status":"completed","createdAt":"2026-10-03T15:21:50.698Z","updatedAt":"2026-10-03T15:21:52.115Z","completedAt":"2026-10-03T15:21:52.115Z"}
```

Anything else it tries is refused with `403`, even reading the same run:

```json
{"error":{"code":"permission-denied","message":"A public run token can only follow the runs it names: GET /v1/runs/{runId}/progress and GET /v1/runs/{runId}/progress/stream","requestId":"req-0557ce73-7ae8-4b3f-b3b4-a70006d57d37"}}
```

Outside development mode, public run tokens are on only when the runtime has
a signing key (`KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH`, an Ed25519 key used for
nothing else). Browser origins that may call those routes are listed in
`KINDGI_CORS_ORIGINS`; with none listed, no CORS headers are sent.

## What a tenant can't make the server do

What a tenant registers (an MCP server, a model provider, a webhook)
shouldn't reach the machine the runtime runs on. `KINDGI_TENANT_HOST_ACCESS`
controls that:

- **`deployed`** (the default outside development mode) refuses an MCP
  endpoint that would run a command on the server (`stdio`), when it's
  registered and when the runtime connects to it. Run MCP servers over HTTP
  instead. It also refuses connections to the runtime's own host (a loopback
  address) and the cloud metadata endpoints, wherever configuration names a
  host: an image registry, a model provider, an HTTP tool, an MCP server.
- **`local`** (the default in development mode) allows it. Use it only on a
  machine where everyone holding an API token may run commands anyway.

Registering a `stdio` endpoint with the default:

```json
{"error":{"code":"host-access-denied","message":"MCP endpoint \"acme.docs\" uses the stdio transport, which runs a command on the server's host; KINDGI_TENANT_HOST_ACCESS=deployed refuses that. Run the MCP server over HTTP (streamable-http) instead.","requestId":"req-61bc35bf-9ca4-4894-b041-a5babbc7ec3f"}}
```

Outside development, a webhook goes only to a public address, and only over
https. Kindgi checks this when the webhook is registered, and again at every
delivery, for every address the receiver's name resolves to. A self-hosted runtime whose receiver is on
its own private network sets `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow`, which
opens RFC 1918, CGNAT and IPv6 unique-local addresses. Loopback and the
cloud metadata addresses stay refused.

## Secrets by reference

The runtime stores the **names** of secrets, not their values, wherever it
can:

- a model provider's API key, an MCP endpoint's credentials and a webhook
  endpoint's signing secret are each a `secretRef`, a name resolved in the
  tenant's own secrets when it's needed;
- a tool's code receives the secrets it declares, through its context
  (`ctx.secrets`). In development only, the pack's process also sees the
  values in your env files, since `kindgi dev` reads them for it;
- in development, Google credentials (for Vertex AI) reach the runtime only
  when `KINDGI_DEV_GOOGLE_CREDENTIALS` names them: `adc` for your gcloud
  login, or a credentials file's path. Without it, `kindgi dev` gives the
  runtime none, whatever login this machine has
  ([Connect Gemini on Vertex AI](../../guides/models/gemini-on-vertex-ai/)).

The values live where your other secrets live: in development, Kindgi's own
`.kindgi/secrets.env` beside your app's env files, a file your app doesn't
load; in production Postgres, envelope-encrypted with a key held in your
cloud's KMS (`KINDGI_SECRETS_BACKEND=postgres`,
`KINDGI_SECRETS_BACKEND_KMS=gcp`).

Webhooks the runtime sends (such as `run.finished`) are signed with the
endpoint's secret, so your app can check that they came from your runtime.

## Before you deploy

:::note[Postgres]
The runtime's database user needs `CREATEROLE` and must own the runtime's
database: the runtime uses it to set up the restricted role that requests run
as. It needn't be a superuser, so managed Postgres services such as Cloud SQL,
Amazon RDS and AlloyDB work. Create the `vector` extension once
([Self-host](../../deploy/self-host/)). With Kindgi 0.1.0, it had to be a
superuser.
:::

- **Development mode is for development.** `KINDGI_DEV=true` turns on
  settings meant for one machine (secrets from `.env` files, a console
  login that hands out the API token) and needs no license key. Never set it
  on a server others can reach.
- **Keep keys in your secrets store:** the API token, the license key
  (see [Licensing](../licensing/)), the public-token signing key, and the
  key that protects stored secrets.

:::note[Access to the runtime image]
The runtime image is in private preview: request access at contact@kindgi.com.
You get its pull credentials, a robot name and a token, and log in once with
`kindgi auth registry` (see [Install](../../start/install/#access-to-the-runtime-image)).
:::
