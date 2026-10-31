---
title: Self-host Kindgi
description: Run the Kindgi runtime with Docker and your own Postgres, then deploy a pack to it and run a flow.
sidebar:
  order: 1
---

This guide runs the Kindgi runtime on your own machine with Docker and
Postgres, deploys a pack to it, and runs a flow end to end.

You run four containers on one Docker network:

- **the runtime:** Kindgi's server, with its API, agents and flows;
- **Postgres;**
- **your pack's service:** your tools' code;
- **a registry** the runtime reads your pack's image from.

Everything here runs on one machine with Docker Desktop. On a server the pieces are the same; step 2 says what changes.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::

## Before you start

- **Docker**, `openssl`, `uuidgen` and `curl`, and for a TypeScript pack
  **Node 22.12** or later and **pnpm**.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead. The
  build and deploy steps need the pack's folder, so they use `pnpm exec kindgi`.
- **Ollama**, with `llama3.1` pulled, for the flow in step 8.
- **A pack.** This page uses the sample. `--template=sample` picks it, and
  `acme-pack` is its folder and its pack id:

  ```sh
  npx --yes @kindgi/cli@0.2 init acme-pack --template=sample
  cd acme-pack
  pnpm install
  ```

  `init` lists the files it made, and `pnpm install` its packages.

- **A license key.** Outside development mode, the runtime needs one, and
  pulling its image needs one too. A free non-production key covers staging
  and CI: get one at [access.kindgi.com](https://access.kindgi.com). A
  production key comes with a commercial license from contact@kindgi.com.
  [Licensing](../../../concepts/licensing/) explains the keys.

## 1. Pull the runtime image

The runtime runs from Kindgi's image. Log in to its registry with your
license key, and pull it:

```sh
docker login registry.kindgi.com --username kindgi
docker pull registry.kindgi.com/kindgi/runtime:0.3.1
```

`docker login` asks for the password: paste your key. It prints
`Login Succeeded`. `docker pull` prints the image's digest when it's done.
[Pull the runtime image](../pull-the-runtime-image/) covers logging in from a
script or CI, and other clients.

## 2. Start Postgres and a registry

The runtime keeps its data in Postgres, and reads your pack's image from a
registry. Make a network for the containers, start Postgres on it, and start
the registry on your machine's port 5050:

```sh
docker network create kindgi

export DB_PASSWORD="$(openssl rand -hex 24)"
docker run -d --name kindgi-db --network kindgi \
  -e POSTGRES_USER=kindgi -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=kindgi \
  -v kindgi-db:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

docker run -d --name kindgi-registry -p 127.0.0.1:5050:5000 registry:2
```

- **`docker network create kindgi`** makes the network the containers
  share. It prints the network's id.
- **`DB_PASSWORD`** is a random password for Postgres, kept in your shell
  for step 5.
- **`-d`** runs a container in the background, **`--name`** names it, and
  **`--network kindgi`** puts it on the network. Each `docker run -d`
  prints the new container's id.
- **`-e`** sets the database's user, password and name.
  **`-v kindgi-db:/var/lib/postgresql/data`** keeps the data in a volume,
  `kindgi-db`.
- **`-p 127.0.0.1:5050:5000`** publishes the registry on your machine's port
  5050, and only there.

:::note[Postgres]
The runtime needs **Postgres 16 with pgvector**. Its database user needn't be a superuser. It needs `CREATEROLE`, because the migrations create the restricted role that tenant queries run as, and it must own the runtime's database. So managed Postgres such as Cloud SQL, Amazon RDS or AlloyDB works. Create the `vector` extension once, as a user allowed to: `CREATE EXTENSION IF NOT EXISTS vector`. The official image's `POSTGRES_USER` has all of this.
:::

The runtime verifies your pack's image by reading it from a registry. On one machine with Docker Desktop, the name `registry.localhost` reaches the local registry from two places:

- **Docker:** it treats `*.localhost` as loopback, so it pushes there over plain HTTP;
- **the runtime's container:** `--add-host` (step 5) maps the name to your machine.

On Linux or a server, use your own registry instead, and give the runtime its credentials: `KINDGI_IMAGE_REGISTRY_HOST`, `KINDGI_IMAGE_REGISTRY_USERNAME` and `KINDGI_IMAGE_REGISTRY_PASSWORD`.

Whichever registry you use, two things stop the runtime from reading it:

- **A loopback address,** such as `localhost`, `127.0.0.1` or `::1`: by default the runtime refuses to connect to its own host. `KINDGI_TENANT_HOST_ACCESS` decides that, as step 5 says. `registry.localhost` isn't one here: in the runtime's container, `--add-host` maps it to your machine's address on Docker's network.
- **A port Node's fetch refuses,** such as 5060 or 5061: the Fetch standard's [bad ports](https://fetch.spec.whatwg.org/#bad-port), which browsers refuse too. Serve the registry on another port.

## 3. Build, sign and push your pack

If your app's code needs a generate step in the image (Prisma's client, for
example), set that up first:
[What the pack's image needs](../../../start/existing-app-typescript/#what-the-packs-image-needs).

In a Python pack, run each `kindgi` command on this page, `pnpm exec kindgi` and
`npx --yes @kindgi/cli@0.2` alike, as `uv run kindgi`. Lock its dependencies
first (`uv lock`, or `poetry lock`): the image installs them from the lockfile.

Pick a tenant id. The runtime serves this tenant, and the pack's signature names it:

```sh
uuidgen | tr 'A-Z' 'a-z'
```

It prints the id in lower case. Keep it for the config and `kindgi.env`.

Keep the id in lower case. With an upper-case one, manage the tenant's people
one way only: with the API token as the bearer of your CLI or API calls, or
through the console and API keys, not both. A runtime that already runs with
an upper-case id keeps it as it is.

Create a signing key. `acme-selfhost` is the key's id, and `--env selfhost`
also prints the lines to add to the `selfhost` environment:

```sh
npx --yes @kindgi/cli@0.2 key create acme-selfhost --env selfhost
```

It prints the key's JSON, then the paths of its private and public key files
and its fingerprint.
[Rotate a signing key](../rotate-keys/#rotate-a-signing-key) shows that
output in full for a second key, with the key lines the `selfhost` block has
by then.

Add an environment for this deployment to `kindgi.config.ts`:

```ts excerpt
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

- **`endpoint`** is the runtime's URL, and **`registry`** the registry the
  image goes to.
- **`tenantId`** is the id `uuidgen` printed, in place of
  `<your tenant id>`.
- **`signingKey`** and **`signerKeyId`** are the key you created.

In a Python pack, the same keys go in `pyproject.toml`:

```toml excerpt
[tool.kindgi.environments.selfhost]
endpoint = "http://localhost:4000"
registry = "registry.localhost:5050"
tenantId = "<your tenant id>"
signingKey = "~/.kindgi/keys/acme-selfhost.pem"
signerKeyId = "acme-selfhost"
```

Build the image with your own Docker, push it, and sign it. `--local` builds
with your Docker, `--push` pushes to the environment's registry, and
`--env selfhost` picks the environment:

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

The build imports every tool, guardrail and flow module to index it, inside
the image, so anything a module does when it's imported runs during the
build too, without your app's files or services. Open files, databases and
connections lazily, inside the handler. A module that opens a database file
at import fails the build with `unable to open database file`.

With `--push`, as here, the image is for `linux/amd64`, and on Apple silicon it runs under emulation. Without `--push`, it's for your machine's platform. `--platform` picks another.

## 4. Run your pack's service

Your tools' code runs in the pack's own container. The runtime calls it with a token both sides share:

```sh
echo "KINDGI_PACK_SERVICE_TOKEN=$(openssl rand -hex 32)" > pack.env
chmod 600 pack.env

docker run -d --name kindgi-pack --network kindgi --env-file pack.env \
  registry.localhost:5050/acme-pack@sha256:<the digest kindgi build printed>
```

`--env-file pack.env` gives the container the token, and
`<the digest kindgi build printed>` is the digest from step 3's
`✓ Pushed` line. `docker run -d` prints the container's id. The container's
log, `docker logs kindgi-pack`, says it's listening:

```text
{"time":"2026-10-08T19:38:48.568Z","level":"info","severity":"INFO","subsystem":"pack","message":"Listening on port 8080","port":8080,"packId":"acme-pack","artifactVersion":"20261008.193828","event":"listening","kind":"listening"}
```

`pack.env` holds the token and the variables your pack declares. The
service drops any other variable before your code loads. Its log names each
one, as `env-dropped`, never its value.
[Declare the environment your code reads](../../../guides/secrets/pack-env/#in-a-deployment)
says more.

This one service runs the tools' code of every project the runtime serves,
in the same processes, with one environment.
[Your tools' code](../../../concepts/security/#your-tools-code) says what
that means, and how to keep projects apart.
It runs only the tool versions in the build you started it with: after you
start a newer one, an agent or flow version that locked a tool version the
build no longer has fails when it calls that tool
([A self-hosted runtime runs what your pack has](../../../guides/agents/agent-and-tool-versions/#a-self-hosted-runtime-runs-what-your-pack-has)).

## 5. Configure and start the runtime

Make an API token. Your CLI and apps send it as their bearer:

```sh
printf 'kgi_bt_%s\n' "$(openssl rand -hex 32)"
```

It prints the new token.

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
KINDGI_LOG_FORMAT=pretty
# To try the console on your machine: sign in with the API token.
# In a real deployment, set up single sign-on instead and remove this line.
KINDGI_CONSOLE_TOKEN_SIGN_IN=on
```

- **`<DB_PASSWORD>`** is the password from step 2: `echo "$DB_PASSWORD"`
  prints it.
- **`<your tenant id>`** is the id `uuidgen` printed. The runtime takes it
  in lower case. If an earlier runtime ran with it in upper case, the start
  says what to do: [A tenant id given in upper case](../serve-many-tenants/#a-tenant-id-given-in-upper-case).
- **`<the token>`** is the API token `printf` printed.
- **`<the same token as in pack.env>`** is `pack.env`'s
  `KINDGI_PACK_SERVICE_TOKEN`.
- **`<your license key>`** is the key you were sent.

It holds the API token and the license key, so keep it to yourself:
`chmod 600 kindgi.env`.

Every setting is in the [environment variable reference](../../../reference/env-vars/). These are worth knowing now:

- **`KINDGI_DATABASE_URL`** connects to Postgres directly, or through a pooler in session mode. The runtime holds session locks on its connection while it migrates. A pooler in transaction mode, such as PgBouncer's `pool_mode = transaction`, doesn't keep them, as [PgBouncer's pooling modes](https://www.pgbouncer.org/features.html) describes. `sslmode=require` in it encrypts the connection but takes any certificate: [Check the database's certificate](../database-tls/) shows how the runtime checks that the server it reached is your database.
  - **Through PgBouncer:** on runtime 0.1.9 or later, the runtime sends its [database timeouts](../../../reference/env-vars/#kindgi_db_statement_timeout_ms) as startup parameters. A PgBouncer on its default settings refuses them, so the runtime can't connect (`unsupported startup parameter: statement_timeout`). On PgBouncer 1.26.0 or later, have it pass them on with `track_extra_parameters = statement_timeout, lock_timeout, idle_in_transaction_session_timeout` ([PgBouncer's settings](https://www.pgbouncer.org/config.html#track_extra_parameters)). Earlier versions mishandle a tracked parameter that Postgres doesn't report, as it doesn't these three, when a client sends it at startup (fixed in 1.26.0, [PgBouncer's changelog](https://www.pgbouncer.org/changelog.html)). `ignore_startup_parameters` with the same names lets the runtime connect, but PgBouncer drops them, and your role's, database's or server's settings hold instead. The runtime's admin commands (`kindgi-runtime tenants …` and `kindgi-runtime check …`) send theirs the same way, with no statement timeout, and don't read back what's in effect. So behind a PgBouncer that drops them, a long purge or check runs under those settings, and can be ended by them.
  - **The runtime checks at boot:** its startup line shows the timeouts Postgres has in effect, and it logs a warning for each one that differs from what it sent.
- **`KINDGI_ENV`** names the environment your tools' secrets resolve in.
- **The port** is 4000 unless something sets another. The runtime takes the first that's set: `KINDGI_API_PORT`, then the platform's `PORT`, then 4000. Cloud Run, Render, Heroku and Fly set `PORT`. [`KINDGI_API_PORT`](../../../reference/env-vars/#kindgi_api_port) has the whole order.
- **`KINDGI_CONSOLE_TOKEN_SIGN_IN=on`** lets you sign in to the console by pasting the API token from this file, so you can try the console straight away. It's off by default outside `kindgi dev`, and with it off and no single sign-on, nobody can sign in to the console. In a real deployment, [turn on sign-in](../sign-in/) with your organization's identity provider instead, and remove the line. The token works for the API, the CLI and the SDKs either way.
- **`KINDGI_LOG_FORMAT=pretty`** makes `docker logs` readable by eye. Without it, a container logs JSON, one record per line, for a log platform to index, as [Logs](../logs/) describes.
- **`KINDGI_PACK_SERVICE_URL`** is the pack service's address only. A user and password in it stop the runtime at boot (exit code 2): `` KINDGI_PACK_SERVICE_URL must not carry a user or password ("https://svc:***@pack.example.com"): the server authenticates to the pack service with KINDGI_PACK_SERVICE_TOKEN. Remove the "user:password@" part. ``
- **`KINDGI_TENANT_HOST_ACCESS`** isn't set here, so it's `deployed`, the default outside development. It refuses a `stdio` MCP endpoint, which would run a command on the runtime's host. Run MCP servers over HTTP instead. It also refuses connections to the runtime's own host, at a loopback address, and to the cloud metadata endpoints, wherever your configuration names a host: an image registry, a model provider, an HTTP tool, an MCP server. `local` allows all of it, so a registry at `localhost` needs it. Set that only on a machine where everyone with an API token may run commands.

Start the runtime:

```sh
docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
  --add-host registry.localhost:host-gateway \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  registry.kindgi.com/kindgi/runtime:0.3.1
```

- **`--restart unless-stopped`** brings the runtime back by itself after a
  crash, or after its database was unreachable for a while.
- **`--add-host registry.localhost:host-gateway`** maps the registry's name
  to your machine.
- **`-p 127.0.0.1:4000:4000`** publishes the API on your machine's port
  4000, and only there. **`--env-file kindgi.env`** gives it its settings.

`docker run -d` prints the container's id.

## 6. Check it

Ask the runtime whether it's ready. `-s` hides `curl`'s progress:

```sh
curl -s http://localhost:4000/ready
```

```text
{"ok":true,"database":"ok","erasures":"unreplayable"}
```

`/ready` answers once the runtime is up and its database answers. `/health` checks only the process, as [Check health and logs](../restart-and-check-health/#check-health-and-logs) explains. Its `erasures` says whether an erasure can be replayed after a backup restore. It's `unreplayable` until you set `KINDGI_ERASURE_LEDGER_KEY`, as [Erasures and backups](../back-up-and-restore/#erasures-and-backups) shows.

Open `http://localhost:4000/` in Chrome or Firefox: it leads to the console, at `/console/`, where you sign in with the API token from `kindgi.env`. The sign-in is a `Secure` cookie, which Safari keeps only over `https`, even on `localhost`. A runtime started without the console answers there with a short page naming what it serves: `/health`, `/ready`, and the API reference at `/docs`.

Its log names what it's running with:

```sh
docker logs kindgi-server
```

```text
Kindgi API server listening on http://localhost:4000 (local to this host or container: set KINDGI_PUBLIC_URL to the address clients use)
  Tenant:  …
  Token:   kgi_bt_…3236 (provided)
  User:    … (KINDGI_API_TOKEN's user from now on; KINDGI_SEED_USER_ID names one)
  …
  Console: http://localhost:4000/console/
  Console sign-in: an API token (KINDGI_CONSOLE_TOKEN_SIGN_IN)
  Deployments: on (signed images, /v1/deployments)
  …
  License: …
  …
  Env: production (tool secrets resolve in it)
  Tenant host access: deployed (stdio MCP endpoints refused; tenant-chosen hosts can't reach the metadata server or this host; KINDGI_TENANT_HOST_ACCESS)
  Pack service: http://…:8080 — acme-pack (artifact …), protocol 2, 3 tools, 1 check
```

Without `KINDGI_LICENSE_KEY`, the runtime doesn't start. It exits with code 2 and says:

```text
KINDGI_LICENSE_KEY is not set. Outside development mode the Kindgi runtime needs a license key: a production key comes with a commercial license, and a free non-production key covers staging and CI. To get one: contact@kindgi.com. Local development needs none: `kindgi dev` runs the runtime with KINDGI_DEV=true.
```

A key within 30 days of expiry adds a warning under the license line:

```text
  License: Docs example · non-production · until 2026-11-02
  ⚠ The license key expires in 29 days (2026-11-02). Renew it: contact@kindgi.com.
```

**Behind a proxy or a load balancer,** or on a published port other than the one it binds, set `KINDGI_PUBLIC_URL` in `kindgi.env` to the address clients use. The first line then names both. The banner's links use the public address: `Docs`, and `Console` when it serves the console:

```text
Kindgi API server listening on http://localhost:4000 (reached at https://kindgi.example.com)
  …
  Docs:    https://kindgi.example.com/docs
  …
```

### Behind a load balancer or ingress

The runtime limits how often one client can ask for some things, such as a page that starts sign-in. It also records the client's address in its sign-in records. For both, it needs to know which address is the client's.

**Unset, it uses the address of whatever connects to it.** It ignores `X-Forwarded-For`, because any client can send that header with any address in it. That's right when clients connect directly. Behind a proxy, every request comes from the proxy, so every client shares one limit, and the runtime warns once:

```text
Requests arrive through a proxy (X-Forwarded-For), but KINDGI_TRUSTED_PROXIES is unset: every client counts as the proxy, so rate limits are shared by everyone. Set it to the number of proxies in front (e.g. 1) or their IP ranges.
```

Tell it which proxies to trust with `KINDGI_TRUSTED_PROXIES` in `kindgi.env`, in one of two forms:

- **How many proxies are in front:** `1` behind one load balancer or ingress, `2` behind two, such as Azure Front Door in front of a Container Apps ingress.

  ```sh
  KINDGI_TRUSTED_PROXIES=1
  ```

- **Your proxies' addresses:** IPs or CIDR ranges, comma-separated.

  ```sh
  KINDGI_TRUSTED_PROXIES=10.0.0.0/8, 192.168.0.0/16
  ```

Each proxy appends the address it got the request from to the right of `X-Forwarded-For`. So the runtime reads that header from the right, skips the proxies you trust, and takes the next address as the client's. It never takes the leftmost address on its own: that's the one a client can write.

Count only the proxies that are really in front. One too many, and a client can choose its own address. One too few, and every client counts as your outermost proxy.

The start log says which it uses, with one of these lines:

```text
  Client address: the connection's peer (KINDGI_TRUSTED_PROXIES unset; behind a proxy, set it)
  Client address: X-Forwarded-For behind 1 trusted proxy hop (KINDGI_TRUSTED_PROXIES)
  Client address: X-Forwarded-For behind trusted proxies 10.0.0.0/8, 192.168.0.0/16 (KINDGI_TRUSTED_PROXIES)
```

**Caching:** every `/v1` answer, data and errors alike, says
`Cache-Control: no-store`, so neither a proxy nor a browser keeps one to show
it again, or to someone else. Outside `/v1`, on the console's files and
the docs, the runtime doesn't add `no-store`.

Point the load balancer's health check at `/ready`, as
[Check health and logs](../restart-and-check-health/#check-health-and-logs)
explains.

## 7. Trust your key and deploy

The runtime deploys only images signed by a key its tenant trusts. Trust
yours, with the API token exported as `KINDGI_API_TOKEN`. `--url` is the
runtime:

```sh
export KINDGI_API_TOKEN=<the token from kindgi.env>
npx --yes @kindgi/cli@0.2 key trust acme-selfhost --url http://localhost:4000
```

It prints the trusted key as JSON, then confirms it:

```text
…
  ✓ Trusted acme-selfhost (sha256:7bfbd97be075d796eb24f80d)
…
```

The fingerprint is the one `kindgi key create` printed. The runtime now
accepts deploys this key signs.

Then deploy. `--env selfhost` picks the environment:

```sh
pnpm exec kindgi deploy --env selfhost
```

```text
  "status": 201,
  "outcome": "created",
  …
    "primitives": { "tools": 3, "guardrails": 1, "agents": 1, "flows": 1 },
```

To deploy a client's pack into its own project, add `--project <id or slug>` ([Deploy a client's pack into its project](../../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).

The runtime checked the signature, read the pack's index from the image, and registered its tools, agents and flows.

## 8. Add a model, and run a flow

The sample's agent needs a model that can call tools. Any OpenAI-compatible endpoint whose model supports tool calling works. This example uses Ollama on the same machine, which needs no key. Pull its model first, with `ollama pull llama3.1`. The runtime reaches it at `host.docker.internal`. Docker Desktop provides that name. On Linux, add `--add-host host.docker.internal:host-gateway` to the runtime's `docker run`. Save the provider as `ollama.json`:

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

Register it, then start the sample's flow. `--spec=@ollama.json` reads the
provider from the file, `--flow` is the flow, and `--input` its input:

```sh
npx --yes @kindgi/cli@0.2 providers register --spec=@ollama.json --url http://localhost:4000
npx --yes @kindgi/cli@0.2 runs start --flow=acme-pack.echo-flow --input='{"name":"Ada"}' --url http://localhost:4000
```

`register` prints the provider's id, as JSON. The run ends:

```text
  "status": "completed",
  …
  "output": {
    "reply": "…",
    "greeting": "Hello, Ada!"
  }
```

The flow's tool step ran in your pack's container, and its agent step answered with the model. What the reply says depends on the model. A first call can outlast the agent's time budget while the model loads. If it does, run it again.

:::note[Models that need a key]
A provider that needs an API key (Anthropic, OpenAI, Gemini) keeps it in the runtime's secrets store, in Postgres (`KINDGI_SECRETS_BACKEND=postgres`). The store needs two keys, each 32 random bytes (`openssl rand 32`):

- **The AAD key,** which every stored secret is bound to: a file `KINDGI_SECRETS_AAD_KEY_PATH` names, or base64 in `KINDGI_SECRETS_AAD_KEY`. The same on every replica.
- **The key that wraps each secret's own key,** held in one of two places:
  - **Google Cloud KMS:** `KINDGI_SECRETS_BACKEND_KMS=gcp`, with its settings.
  - **A local key, on a single host:** `KINDGI_SECRETS_BACKEND_KMS=libsodium` and `KINDGI_SECRETS_LOCAL_KEY_ACK=single-node`, with the key in a file `KINDGI_SECRETS_LOCAL_KEY_PATH` names, or base64 in `KINDGI_SECRETS_LOCAL_KEY`. It must differ from the AAD key. The startup log then says `Secrets: Postgres, with a local key from /etc/kindgi/secrets-local.key (single-node; not a cloud KMS; KINDGI_SECRETS_LOCAL_KEY_ACK)`.

Mount key files into the container like the signing key in [Rotate the public run token key](../rotate-keys/#rotate-the-public-run-token-key): mode 0600, readable by the runtime's user (uid 10001). Back both keys up apart from the database: if either is lost, every stored secret is lost. Without them the runtime doesn't start, and says which setting is missing. The settings are in the [reference](../../../reference/env-vars/). A keyless endpoint, such as Ollama or vLLM, needs no secrets store. To keep the secrets in Azure Key Vault, Google Secret Manager or HashiCorp Vault instead, follow [Keep secrets in your own secret manager](../secret-manager/).
:::

## Clean up

To remove the containers, the database's volume and the network:

```sh
docker rm -f kindgi-server kindgi-pack kindgi-registry kindgi-db
docker volume rm kindgi-db
docker network rm kindgi
```

Each command prints the names it removed. `-f` removes a container even while
it runs.

## Next

- [Operate a self-hosted runtime](../operate/): health and logs, backups,
  upgrades, and rotating its tokens and keys.
- [Deploy on Google Cloud Run](../cloud-run/): the same pieces as Cloud Run
  services, with Cloud SQL, Artifact Registry and Cloud KMS.
- [Turn on sign-in](../sign-in/), for the console in a real deployment.
