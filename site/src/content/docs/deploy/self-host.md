---
title: Self-host Kindgi
description: Run the Kindgi runtime with Docker and your own Postgres, then deploy a pack to it and run a flow.
sidebar:
  order: 1
---

You run four containers on one Docker network:

- **the runtime:** Kindgi's server, with its API, agents and flows;
- **Postgres;**
- **your pack's service:** your tools' code;
- **a registry** the runtime reads your pack's image from.

You then deploy a pack to it, and run a flow end to end. Everything here runs on one machine with Docker Desktop. On a server the pieces are the same; step 2 says what changes.

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com
:::

## Before you start

- **Docker**, and **Node 22.12** or later.
- **A pack.** This page uses the sample:

  ```sh
  npx @kindgi/cli init acme-pack --template=sample
  cd acme-pack
  pnpm install
  ```

- **A license key.** Outside development mode, the runtime needs one: a free non-production key covers staging and CI, and a production key comes with a commercial license. To get one: contact@kindgi.com. See [Licensing](../../concepts/licensing/). `kindgi dev` needs none.

## 1. Pull the runtime image

```sh
docker login quay.io
docker pull quay.io/kindgi/runtime:0.1.2
```

## 2. Start Postgres and a registry

```sh
docker network create kindgi

export DB_PASSWORD="$(openssl rand -hex 24)"
docker run -d --name kindgi-db --network kindgi \
  -e POSTGRES_USER=kindgi -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=kindgi \
  -v kindgi-db:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

docker run -d --name kindgi-registry -p 127.0.0.1:5050:5000 registry:2
```

:::note[Postgres]
The runtime needs **Postgres 16 with pgvector**. Its database user needn't be a superuser: it needs `CREATEROLE` and to own the runtime's database (the migrations create the restricted role that tenant queries run as), so managed Postgres such as Cloud SQL, Amazon RDS or AlloyDB works. Create the `vector` extension once, as a user allowed to: `CREATE EXTENSION IF NOT EXISTS vector`. The official image's `POSTGRES_USER` has all of this. With Kindgi 0.1.0, the user had to be a superuser.
:::

The runtime verifies your pack's image by reading it from a registry. On one machine with Docker Desktop, the name `registry.localhost` reaches the local registry from two places:

- **Docker:** it treats `*.localhost` as loopback, so it pushes there over plain HTTP;
- **the runtime's container:** `--add-host` (step 5) maps the name to your machine.

On Linux or a server, use your own registry instead, and give the runtime its credentials (`KINDGI_IMAGE_REGISTRY_HOST`, `_USERNAME`, `_PASSWORD`).

## 3. Build, sign and push your pack

If your app's code needs a generate step in the image (Prisma's client, for
example), set that up first:
[What the pack's image needs](../../start/existing-app/#what-the-packs-image-needs).

In a Python pack, run each `pnpm exec kindgi` on this page as
`npx --yes @kindgi/cli@0.1`, and lock its dependencies first (`uv lock`, or
`poetry lock`): the image installs them from the lockfile.

Pick a tenant id. The runtime serves this tenant, and the pack's signature names it:

```sh
uuidgen | tr 'A-Z' 'a-z'
```

Create a signing key:

```sh
pnpm exec kindgi key create acme-selfhost --env selfhost
```

Add an environment for this deployment to `kindgi.config.ts`:

```ts
environments: {
  selfhost: {
    endpoint: 'http://localhost:4000',
    registry: 'registry.localhost:5050',
    tenantId: '<your tenant id>',
    signingKey: '~/.kindgi/keys/acme-selfhost.pem',
    signerKeyId: 'acme-selfhost',
  },
},
```

In a Python pack, the same keys go in `pyproject.toml`:

```toml
[tool.kindgi.environments.selfhost]
endpoint = "http://localhost:4000"
registry = "registry.localhost:5050"
tenantId = "<your tenant id>"
signingKey = "~/.kindgi/keys/acme-selfhost.pem"
signerKeyId = "acme-selfhost"
```

Build the image with your own Docker, push it, and sign it:

```sh
pnpm exec kindgi build --local --push --env selfhost
```

```text
    ✓ Pushed registry.localhost:5050/acme-pack@sha256:faca44e8…
    ✓ /app/index.json in the image matches the local index byte for byte
    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)
  Deploy envelope written to …/acme-pack/.kindgi/build/deploy-envelope.json
```

A Python pack's build also says where its dependencies come from:

```text
    ✓ 22 pack file(s) in the image (the pack root, minus caches, virtualenvs and secrets); dependencies from uv.lock
```

The image is for `linux/amd64` by default. On Apple silicon it runs under emulation; `--platform` picks another.

## 4. Run your pack's service

Your tools' code runs in the pack's own container. The runtime calls it with a token both sides share:

```sh
echo "KINDGI_PACK_SERVICE_TOKEN=$(openssl rand -base64 32)" > pack.env
chmod 600 pack.env

docker run -d --name kindgi-pack --network kindgi --env-file pack.env \
  registry.localhost:5050/acme-pack@sha256:<the digest kindgi build printed>
```

Its log says it's listening:

```text
{"kind":"listening","port":8080,"packId":"acme-pack","artifactVersion":"20261003.1"}
```

## 5. Configure and start the runtime

Make an API token. Your CLI and apps send it as their bearer:

```sh
printf 'kgi_bt_%s\n' "$(openssl rand -hex 32)"
```

Put the runtime's settings in `kindgi.env`:

```sh
KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@kindgi-db:5432/kindgi
KINDGI_TENANT_ID=<your tenant id>
KINDGI_API_TOKEN=<the token>
KINDGI_ENV=production
KINDGI_PACK_SERVICE_URL=http://kindgi-pack:8080
KINDGI_PACK_SERVICE_TOKEN=<the same token as in pack.env>
KINDGI_IMAGE_REGISTRY_INSECURE_HOSTS=registry.localhost:5050
KINDGI_LICENSE_KEY=<your license key>
```

It holds the API token and the license key, so keep it to yourself:
`chmod 600 kindgi.env`.

Every setting is in the [environment variable reference](../../reference/env-vars/). Two are worth knowing now:

- **`KINDGI_ENV`** names the environment your tools' secrets resolve in.
- **`KINDGI_TENANT_HOST_ACCESS`** isn't set here, so it's `deployed`, the default outside development. It refuses an MCP endpoint that would run a command on the runtime's host (`stdio`). Run MCP servers over HTTP instead. `local` allows it; set that only on a machine where everyone with an API token may run commands.

Start the runtime:

```sh
docker run -d --name kindgi-server --network kindgi \
  --add-host registry.localhost:host-gateway \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  quay.io/kindgi/runtime:0.1.2
```

## 6. Check it

```sh
curl -s http://localhost:4000/ready
```

```text
{"ok":true,"database":"ok"}
```

`/ready` answers once the runtime is up and its database answers (`/health` checks only the process; see [Operate](../operate/#check-health-and-logs)).

Its log names what it's running with:

```sh
docker logs kindgi-server
```

```text
Kindgi API server listening on http://localhost:4000
  Tenant:  8f34192d-53bb-4fc2-bfb8-9094157b2404
  Token:   kgi_bt_…abb1 (provided)
  …
  Deployments: on (signed images, /v1/deployments)
  License: Docs example · non-production · until 2026-11-02
  ⚠ The license key expires in 29 days (2026-11-02). Renew it: contact@kindgi.com.
  Env: production (tool secrets resolve in it)
  Tenant host access: deployed (stdio MCP endpoints refused; KINDGI_TENANT_HOST_ACCESS)
  Pack service: http://kindgi-pack:8080 — acme-pack (artifact 20261003.1), protocol 2, 3 tools, 1 check
```

Without `KINDGI_LICENSE_KEY`, the runtime doesn't start. It exits with code 2 and says:

```text
KINDGI_LICENSE_KEY is not set. Outside development mode the Kindgi runtime needs a license key: a production key comes with a commercial license, and a free non-production key covers staging and CI. To get one: contact@kindgi.com. Local development needs none: `kindgi dev` runs the runtime with KINDGI_DEV=true.
```

A key within 30 days of expiry adds the warning under the license line, as this example key does.

## 7. Trust your key and deploy

The runtime deploys only images signed by a key its tenant trusts. Trust yours:

```sh
export KINDGI_API_TOKEN=<the token from kindgi.env>
pnpm exec kindgi key trust acme-selfhost --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
```

```text
  ✓ Trusted acme-selfhost (sha256:7bfbd97be075d796eb24f80d)
```

The fingerprint is the one `kindgi key create` printed.

Then deploy:

```sh
pnpm exec kindgi deploy --env selfhost --token "$KINDGI_API_TOKEN"
```

```text
  "status": 201,
  "outcome": "created",
  …
    "primitives": { "tools": 3, "guardrails": 1, "agents": 1, "flows": 1 },
```

The runtime checked the signature, read the pack's index from the image, and registered its tools, agents and flows.

## 8. Add a model, and run a flow

The sample's agent needs a model that can call tools. Any OpenAI-compatible endpoint whose model supports tool calling works. This example uses Ollama on the same machine (after `ollama pull llama3.1`), which needs no key. The runtime reaches it at `host.docker.internal`: Docker Desktop provides that name, and on Linux, add `--add-host host.docker.internal:host-gateway` to the runtime's `docker run`. Save it as `ollama.json`:

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "http://host.docker.internal:11434/v1" },
  "metadata": {
    "id": "ollama-local",
    "region": "unspecified",
    "models": [{ "name": "llama3.1", "contextWindow": 131072, "features": ["tool-use"],
                 "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }]
  }
}
```

```sh
pnpm exec kindgi providers register --spec=@ollama.json --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
pnpm exec kindgi runs start --flow=acme-pack.echo-flow --input='{"name":"Ada"}' --url http://localhost:4000 --token "$KINDGI_API_TOKEN"
```

```text
  "status": "completed",
  …
  "output": {
    "reply": "…",
    "greeting": "Hello, Ada!"
  }
```

The flow's tool step ran in your pack's container, and its agent step answered with the model; what the reply says depends on the model. A first call can outlast the agent's time budget while the model loads; run it again.

:::note[Models that need a key]
A provider that needs an API key (Anthropic, OpenAI, Gemini) keeps it in the runtime's secrets store, in Postgres (`KINDGI_SECRETS_BACKEND=postgres`). The store needs two keys, each 32 random bytes (`openssl rand 32`):

- **The AAD key,** which every stored secret is bound to: a file `KINDGI_SECRETS_AAD_KEY_PATH` names, or base64 in `KINDGI_SECRETS_AAD_KEY`. The same on every replica.
- **The key that wraps each secret's own key,** held in one of two places:
  - **Google Cloud KMS:** `KINDGI_SECRETS_BACKEND_KMS=gcp`, with its settings.
  - **A local key, on a single host:** `KINDGI_SECRETS_BACKEND_KMS=libsodium` and `KINDGI_SECRETS_LOCAL_KEY_ACK=single-node`, with the key in a file `KINDGI_SECRETS_LOCAL_KEY_PATH` names, or base64 in `KINDGI_SECRETS_LOCAL_KEY`. It must differ from the AAD key. The startup log then says `Secrets: Postgres, with a local key from /etc/kindgi/secrets-local.key (single-node; not a cloud KMS; KINDGI_SECRETS_LOCAL_KEY_ACK)`.

Mount key files into the container like the signing key in [Operate](../operate/#rotate-the-public-run-token-key): mode 0600, readable by the runtime's user (uid 10001). Back both keys up apart from the database: if either is lost, every stored secret is lost. Without them the runtime doesn't start, and says which setting is missing. The settings are in the [reference](../../reference/env-vars/). A keyless endpoint (Ollama, vLLM) needs no secrets store.
:::

## Clean up

```sh
docker rm -f kindgi-server kindgi-pack kindgi-registry kindgi-db
docker volume rm kindgi-db
docker network rm kindgi
```

## Next

[Operate a self-hosted runtime](../operate/): health and logs, backups,
upgrades, and rotating its tokens and keys.

## On Google Cloud Run

Coming soon.
