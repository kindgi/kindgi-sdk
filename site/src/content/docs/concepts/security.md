---
title: Security
description: How Kindgi keeps tenants apart, authenticates callers and handles secrets, and what to know before you deploy it.
sidebar:
  order: 7
---

This page explains what keeps each tenant's data and secrets safe in Kindgi,
so you know what to check before you deploy it. It covers what keeps one
tenant's data from another's and one project's tool code from another's,
who may call the API, what a tenant can't make the server do, and where
secrets live.

## Tenants and isolation

Every record the runtime stores (runs and their journals, agents, flows,
tools, conversations, secrets) carries its **tenant** id. Postgres
**row-level security** restricts each query to the tenant it runs for.
Requests are handled as a database role that can't bypass those policies,
so a query that forgot its tenant finds nothing rather than another
tenant's rows.

A runtime serves the tenant it's started with, `KINDGI_TENANT_ID`. Without
one, it creates a new tenant at every start and prints its id. So set it for
anything that should keep its data across restarts. For hard separation
between customers or environments, give each its own runtime and database.

## Your tools' code

Your tools' code runs outside the runtime, in your pack's service, where
row-level security doesn't reach. What keeps one project's tool code from
another's is how that service runs:

- **On a runtime you run yourself,** every project's tool calls go to the
  one pack service the runtime names (`KINDGI_PACK_SERVICE_URL`), by
  default. One pack's code handles them all, in one process, as one
  identity: whatever the service runs as. Each call is given only the
  secrets and values its tool declares, for its run (`ctx.secrets`,
  `ctx.env`). But every call passes through the same process, so code that
  keeps a value, in a module-level variable say, can hand it to another
  project's call. And the service's own environment is the same for every
  call
  ([Run your pack's service](../../deploy/self-hosted/self-host/#4-run-your-packs-service)).
  So trust that code with every project the runtime serves. To keep
  projects apart, give each its own installation, with its own runtime,
  database and pack service: a testing installation apart from
  production, say, or one for each customer. A runtime that serves many
  tenants can give each deployment its own pack service instead, to run
  under an identity of its own (`KINDGI_PACK_ROUTING=per-deployment`,
  which needs `KINDGI_TENANCY=multi`;
  [Serve many tenants](../../deploy/self-hosted/serve-many-tenants/)).
- **On Kindgi Cloud,** each deployment's tools' code runs in a pack service
  of its own, apart from every other workspace's. Up to 3 of a workspace's
  projects run their tools' code under an identity of their own, so other
  projects' code can't read their secrets. Past that, projects share one
  identity within the workspace
  ([Limits](../../hosted/limits/#projects-with-their-own-tool-identity)).

## Calling the API

Every `/v1` request carries the deployment's API token, in an
`Authorization: Bearer` header. The runtime reads the token from
`KINDGI_API_TOKEN`, a `kgi_bt_…` value you set from your secrets store.
Without it, the runtime generates a token at each start and prints it.
Tokens are compared in constant time. A wrong or missing token gets `401`:

```json
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-88fd4597-bed6-4936-9906-83fafe44712d"}}
```

The `curl` examples in these docs pass the header as
`-H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")`. In bash or
zsh it reaches curl through a pipe, so the token stays out of the process
list (`ps`), where `-H "Authorization: Bearer $KINDGI_API_TOKEN"` would show
it.

To rotate the token, restart the runtime with a new value.

A request's body is at most 10 MiB. A bigger one is refused with
`413 request-too-large`, with the limit in `details.maxBytes`, as soon as
it's past the limit: a body that declares its length up front isn't read at
all. A JSON body that nests objects and arrays more than 128 levels deep is
refused with `400 bad-input`, with the limit in `details.maxDepth`, a
webhook delivery's included. An artifact upload and a webhook delivery have
size limits of their own
([Keep files with a run](../../guides/runs/keep-files-with-a-run/),
[Start runs from webhooks](../../guides/webhooks/start-runs-from-webhooks/)).

Rendering an agent's instructions template may use 16,777,216 of the
template engine's memory units, roughly the characters of the strings the
render builds and the items of its arrays. A render past it fails the
agent's turn with `model-invocation-failed`:
`Prompt render failed: Template render failed: the render went over its memory limit of 16777216`.
No setting changes it.

The template can render in a worker process instead of the server's own
(it needs runtime 0.1.9 or later): with `KINDGI_TEMPLATE_RENDER_WORKERS`
at 1 or more, the default on a runtime serving many tenants
(`KINDGI_TENANCY=multi`).
The worker's heap has a cap of its own
(`KINDGI_TEMPLATE_RENDER_WORKER_HEAP_MIB`, 128 MiB by default): a render
that runs it out fails the turn with the message above, and the server
keeps running. A worker takes only the server's timezone and locale from
its environment, never its database URLs, keys or tokens.

With [authorization](../../deploy/authorization/) on, people and service
accounts have API keys of their own, `kgi_ak_…`. Each key acts with its
holder's grants and no more. A revoked key is refused from its next request.
[People, API keys and service accounts](../../deploy/people-and-keys/) shows
how keys are made and revoked.

## Signing in to the console

People sign in to the console with their email first. The sign-in page then
offers the ways in the deployment has, which
[Turn on sign-in](../../deploy/self-hosted/sign-in/) sets up:

- **Only people already added to a workspace get in,** by an email their
  provider has proved. Nobody is created by signing in, and roles stay
  Kindgi's: an identity provider says who someone is, not what they may do.
- **Google and Microsoft speak for a work email only through the company's
  own accounts.** A workspace with its own identity provider signs its
  domain's people in with that provider alone.
- **The buttons a person sees grant nothing.** Which "Continue with" buttons
  appear depends on the email's domain alone. Access is decided after the
  provider signs the person in.
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

With it, a browser can follow the run. The same request with `curl`:

```sh
curl -H @<(printf 'Authorization: Bearer %s\n' "$PUBLIC_TOKEN") "$KINDGI_API_URL/v1/runs/$RUN_ID/progress"
```

- `$PUBLIC_TOKEN` is the public run token, such as the run's
  `publicAccessToken`.
- `$KINDGI_API_URL` is your runtime's URL.
- `$RUN_ID` is the id of a run the token names.

It prints the run's progress:

```json
{"id":"086f8e9b-9368-4f3a-9c28-9a84fb3f1a09","flowId":"agent.turn","flowVersion":"1.1.0","status":"completed","createdAt":"2026-10-03T15:21:50.698Z","updatedAt":"2026-10-03T15:21:52.115Z","completedAt":"2026-10-03T15:21:52.115Z"}
```

Anything else it tries is refused with `403`, even reading the same run:

```json
{"error":{"code":"permission-denied","message":"A public run token can only follow the runs it names: GET /v1/runs/{runId}/progress and GET /v1/runs/{runId}/progress/stream","requestId":"req-0557ce73-7ae8-4b3f-b3b4-a70006d57d37"}}
```

Outside development mode, public run tokens are on only when the runtime has
a signing key. `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` names it: an Ed25519
key used for nothing else. `KINDGI_CORS_ORIGINS` lists the browser origins
that may call those routes. With none listed, no CORS headers are sent.

## What a tenant can't make the server do

What a tenant registers (an MCP server, a model provider, a webhook)
shouldn't reach the machine the runtime runs on. `KINDGI_TENANT_HOST_ACCESS`
controls that:

- **`deployed`** (the default outside development mode) refuses an MCP
  endpoint that would run a command on the server (`stdio`), when it's
  registered and when the runtime connects to it. Run MCP servers over HTTP
  instead. It also refuses connections to the runtime's own host (a loopback
  address) and the cloud metadata endpoints, wherever configuration names a
  host: an image registry, a model provider, an HTTP tool, an MCP server,
  and a tenant's SSO identity provider. An identity provider
  whose origin the operator allows in `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`
  connects all the same ([Set up SSO](../../guides/sso/)).
- **`isolated`** is for a runtime whose tenants don't trust one another. It
  refuses all that `deployed` does, and also private networks (RFC 1918,
  CGNAT, and IPv6 unique-local and site-local addresses) wherever
  configuration names a host,
  and the runtime's own cloud credentials: a model provider can't sign in as
  the runtime. A Gemini provider on Vertex AI then needs a service-account key
  in `secret_ref`, and Azure OpenAI's `auth: entra` and Bedrock's
  `auth: aws-identity` are refused; use their API keys. The runtime won't start
  with it in development mode, or with `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow`
  or `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`.
- **`local`** (the default in development mode) allows it. Use it only on a
  machine where everyone holding an API token may run commands anyway.

Registering a `stdio` endpoint with the default:

```json
{"error":{"code":"host-access-denied","message":"MCP endpoint \"acme.docs\" uses the stdio transport, which runs a command on the server's host; KINDGI_TENANT_HOST_ACCESS=deployed refuses that. Run the MCP server over HTTP (streamable-http) instead.","requestId":"req-61bc35bf-9ca4-4894-b041-a5babbc7ec3f"}}
```

With `isolated`, a provider that would sign in as the runtime is refused
when it's registered, and nothing is stored. The `bedrock` preset signs in
as the runtime's AWS identity, so
`kindgi providers register --preset=bedrock --region=us-east-2` prints:

```text
Error [invalid-request]: Provider "bedrock" doesn't fit adapter @kindgi/adapter-model-bedrock: adapter_config.auth = aws-identity (the default) signs in as the runtime's own AWS identity, which this deployment doesn't let tenant configuration use (KINDGI_TENANT_HOST_ACCESS). Set auth = api-key, with secret_ref naming a Bedrock API key.
  ✗ /adapter_config/auth: adapter_config.auth = aws-identity (the default) signs in as the runtime's own AWS identity, which this deployment doesn't let tenant configuration use (KINDGI_TENANT_HOST_ACCESS). Set auth = api-key, with secret_ref naming a Bedrock API key.
```

A provider registered before the runtime moved to `isolated`, and that signs
in as the runtime, isn't used there. Here, a `bedrock` preset registration:
a turn that needs it fails with `422 capability-routing-failed`, and the
error's message names the setting the adapter refuses:

```json
{"error":{"code":"capability-routing-failed","message":"No registered provider satisfies the capability declaration. Provider \"bedrock\" can't be set up on this runtime: adapter @kindgi/adapter-model-bedrock refuses its /adapter_config/auth (GET /v1/providers/bedrock/check says why).","details":{"runId":"a6b708ca-d4cc-4cc7-a365-be066858d59f"},"requestId":"req-8b1ef821-9ec2-4f01-9c92-18eeedf4a9b0"}}
```

[`GET /v1/providers/bedrock/check`](../../guides/models/#check-a-registration)
gives the adapter's own words, the same as the refusal above, at
`/adapter_config/auth`. The runtime's log has them too, in its
`factory throw` line.

Unregister such a provider, and register it again with a key of its own:
for Bedrock, [an API key](../../guides/models/#with-a-bedrock-api-key); for
Gemini on Vertex AI,
[a service-account key](../../guides/models/gemini-on-vertex-ai/#on-a-runtime-that-keeps-tenants-apart);
for Azure OpenAI, the `azure-openai` preset, with the resource's key.

Outside development, a webhook goes only to a public address, and only over
https. Kindgi checks this when the webhook is registered, and again at every
delivery, for every address the receiver's name resolves to. A self-hosted runtime whose receiver is on
its own private network sets `KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow`, which
opens RFC 1918, CGNAT, and IPv6 unique-local and site-local addresses.
Loopback and the cloud metadata addresses stay refused. A runtime with
`KINDGI_TENANT_HOST_ACCESS=isolated` doesn't start with that setting (exit
code 2):

```text
KINDGI_TENANT_HOST_ACCESS=isolated refuses private networks to tenant configuration, and KINDGI_WEBHOOK_PRIVATE_NETWORKS=allow opens them to webhooks: set one of them, not both.
```

A model provider's calls carry only its own registration's settings and its
own key: nothing of the server's environment goes with them.

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

The values live where your other secrets live:

- **In development,** in Kindgi's own `.kindgi/secrets.env`, beside your
  app's env files. Your app doesn't load that file.
- **In production,** in Postgres, envelope-encrypted with a key held in your
  cloud's KMS. `KINDGI_SECRETS_BACKEND=postgres` and
  `KINDGI_SECRETS_BACKEND_KMS=gcp` set that up.

Webhooks the runtime sends (such as `run.finished`) are signed with the
endpoint's secret, so your app can check that they came from your runtime.

## Before you deploy

:::note[Postgres]
The runtime's database user needs `CREATEROLE` and must own the runtime's
database: the runtime uses it to set up the restricted role that requests run
as. It needn't be a superuser, so managed Postgres services such as Cloud SQL,
Amazon RDS and AlloyDB work. Create the `vector` extension once, as
[Self-host](../../deploy/self-hosted/self-host/) shows.
:::

- **Development mode is for development.** `KINDGI_DEV=true` turns on
  settings meant for one machine (secrets from `.env` files, a console
  login that hands out the API token) and needs no license key. Never set it
  on a server others can reach.
- **Keep keys in your secrets store:** the API token, the license key
  (see [Licensing](../licensing/)), the public-token signing key, and the
  key that protects stored secrets.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../../deploy/self-hosted/pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::
