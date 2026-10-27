---
title: Deploy on Azure Container Apps
description: Run the Kindgi runtime and your pack's service on Azure Container Apps, with PostgreSQL Flexible Server, Container Registry, Key Vault and managed identities, from Kindgi's Terraform module.
sidebar:
  order: 2.5
---

When you finish this page, the Kindgi runtime and your pack's service run
as two container apps in an Azure resource group you already have, with
everything around them, from Kindgi's Terraform module. You then deploy your
pack to it and run a flow.

In the verification run, the first apply took about seven minutes, most of
it PostgreSQL. The services took under three more. A new runtime replica was
ready 10 seconds after its container started, its first migrations
included.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::

## What you'll have

- **The runtime** (`<name_prefix>-server`): Kindgi's server, a container app
  with its own user-assigned managed identity. External ingress, port 4000,
  one replica.
- **Your pack's service** (`<name_prefix>-pack`): your tools' code.
  Environment-internal ingress: only apps in the same Container Apps
  environment reach it, and the runtime sends the shared pack token on every
  call.
- **PostgreSQL Flexible Server** (16, with pgvector) for the runtime's data,
  on a private subnet with no public access.
- **Azure Container Registry** for both images. The runtime also reads your
  pack's image from it, with its own identity, when you deploy.
- **Key Vault** for the secrets both apps read, and **an RSA key** that
  wraps the secrets the runtime stores (model API keys, webhook secrets).
- **A VNet** with a subnet for the environment and a delegated one for
  PostgreSQL, or two subnets in a VNet you already have
  ([A new VNet, or yours](#a-new-vnet-or-yours)).
- **Log Analytics** for both apps' logs.

**One tenant:** the runtime serves the tenant it seeds (`seed_tenant_id`),
and the plan refuses `KINDGI_TENANCY` or `KINDGI_PACK_ROUTING` other than
`single`. [Serving many tenants](../serve-many-tenants/) needs a container
app for each deployment's pack service, run by an orchestrator of your own,
which this module doesn't make.

Who calls whom:

- your app calls the runtime, with its API token;
- the runtime calls your pack's service, with the pack token, and
  PostgreSQL, Key Vault and model APIs;
- `kindgi deploy` calls the runtime with a signed envelope, and the runtime
  reads the pack's image from the registry.

## Before you start

- **An Azure resource group**, and Owner on it, or Contributor plus User
  Access Administrator: the module grants roles to its identities. It never
  creates the group, and never writes at the subscription level.
- **The resource providers registered**, once per subscription, by someone
  allowed to:

  ```sh
  for p in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry \
           Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network; do
    az provider register -n $p
  done
  ```

- **A second resource group, made by Azure:** a Container Apps environment on
  a VNet keeps its infrastructure in a platform-managed group named
  `<your group>-<name_prefix>-infra`. Azure creates it with the environment
  and deletes it with the environment. If your policies forbid new resource
  groups, exempt this one.
- **Terraform 1.11 or later,** since the database's admin password is
  write-only. Also the **Azure CLI**, **Docker** with `buildx`, **jq**, and
  your pack's `kindgi` CLI, 0.1.6 or later. The module needs the `azurerm`
  provider 5.9 or later, and its lock file pins it.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead. The
  build, `env plan` and deploy steps need the pack's folder, so they use
  `pnpm exec kindgi`.
- **Runtime 0.1.6 or later:** the first with Key Vault keys and the
  registry's managed identity.
- **A license key:** a non-production key covers staging, and it also pulls
  the runtime image. Get one at
  [access.kindgi.com](https://access.kindgi.com), or from contact@kindgi.com.
- **Docker logged in to `registry.kindgi.com`** with that key
  ([Pull the runtime image](../pull-the-runtime-image/)).
- **A pack** that `kindgi build --local --push` builds, with an environment
  block for this deployment in its config, whose `registry` is the module's
  registry (step 2 prints it).
- **Your Azure Policy assignments checked,** with
  `az policy assignment list -g <rg> --disable-scope-strict-search`. Allowed
  locations, required tags, or a rule against public network access change the
  recipe.

## 1. The foundation

This step creates everything the two apps need, before their images and
secrets exist. The module is `deploy/azure-container-apps/` in the
[kindgi-sdk repository](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/azure-container-apps):
copy the folder from the release you run. Its `README.md` lists every
variable.

Terraform's state goes in a storage container of its own:

```sh
az storage account create -n <state account> -g <rg> --sku Standard_LRS \
  --allow-blob-public-access false --min-tls-version TLS1_2
az storage container create -n tfstate --account-name <state account> --auth-mode login
az role assignment create --assignee <you> --role "Storage Blob Data Contributor" \
  --scope "$(az storage account show -n <state account> -g <rg> --query id -o tsv)"
```

- `<state account>` is a new storage account's name, and `<rg>` your
  resource group.
- `--allow-blob-public-access false` and `--min-tls-version TLS1_2` keep the
  state private, and over TLS 1.2 or later.
- `--auth-mode login` creates the container as you, with your Entra ID
  sign-in.
- `<you>` is your own user, such as your email: the role lets you read and
  write the state.

Give each deployment its own state key, never shared with your app's own
infrastructure.

The services need images and secret values that the next steps make, so the
first apply creates everything else:

```sh
cp example.tfvars dev.tfvars   # subscription_id, resource_group_name, kindgi_env, the seed ids, …
terraform init -backend-config=resource_group_name=<rg> -backend-config=storage_account_name=<state account> \
  -backend-config=container_name=tfstate -backend-config=key=<this deployment>.tfstate -backend-config=use_azuread_auth=true
terraform apply -var-file=dev.tfvars \
  -target=azurerm_container_app_environment.kindgi \
  -target=azurerm_postgresql_flexible_server_database.kindgi \
  -target=azurerm_postgresql_flexible_server_configuration.extensions \
  -target=azurerm_role_assignment.server_wraps \
  -target=azurerm_role_assignment.server_pulls \
  -target=azurerm_role_assignment.pack_pulls
```

- `dev.tfvars` holds this deployment's variables. `example.tfvars` lists
  them.
- `-backend-config` tells `init` where the state goes: the storage account
  and container you made, and `<this deployment>.tfstate`, its own key.
  `use_azuread_auth=true` reads it as you, with no storage key.
- `-target` limits this apply to the environment, the database and the
  roles, with what they need.

The image variables need only a digest-shaped placeholder here.
`secrets_aad_key_version` and `erasure_ledger_key_version` may stay empty.
The plan creates 22 resources. In the verification run, the apply took 6
minutes 47 seconds. The database's admin password is write-only: Terraform
sends a random one that nobody keeps, and it never reaches the state. You set
the real one in step 3.

The vault has purge protection on: `key_vault_purge_protection`, `true` by
default. Every secret the runtime stores is wrapped by the vault's key. So a
deleted key, secret or vault stays recoverable for
`key_vault_soft_delete_retention_days`, 90 by default, and nobody can purge
it sooner, an owner included. Once on, purge protection can't be turned
off.

### A new VNet, or yours

- **A new VNet,** the default in `example.tfvars`: the module creates the
  VNet, a subnet for the environment, and a delegated subnet and a private
  DNS zone for PostgreSQL. Pick it when your tools reach only the internet,
  or nothing outside your pack.
- **Yours,** in `example-existing-vnet.tfvars`: give it two empty delegated
  subnets and a private DNS zone, as `environment_subnet_id`,
  `database_subnet_id` and `database_private_dns_zone_id`. The module then
  creates no network. Pick it when your pack's tools reach private resources
  in that VNet: an app database, an internal service, a private endpoint.

In both, the environment holds only Kindgi's two apps. The private DNS zone
and its link get your tags except any whose name has a colon: Azure ignores
those there.

## 2. The images into the registry

The two apps run from images in the module's registry, which they pull with
their managed identities, never a password. With Docker logged in to
`registry.kindgi.com`, copy the runtime image into the module's registry by
digest, with every platform it was built for:

```sh
ACR=$(terraform output -raw image_registry)
az acr login -n "${ACR%%.*}"
docker buildx imagetools create --tag "$ACR/runtime:0.1.10" \
  quay.io/kindgi/runtime:0.1.10@sha256:b6bdf6bcc6fb86fd1e16a2fce7d37dc066b766a0b4313dd3f19e2c904b3b01b3
```

- `ACR` is the registry's address, from the foundation's output, and
  `${ACR%%.*}` its name, for `az acr login`.
- `imagetools create --tag` copies the image by digest, every platform
  included, under the tag you give.

The copy keeps the release's digest. A plain `docker pull`, `tag` and `push`
from an Apple silicon machine pushes only the arm64 image, which Container
Apps can't run.

The copy goes through the machine you run it on, every layer down and back up,
and takes both platforms (amd64 and arm64), so on a slow uplink it can take
most of an hour.

Then build and push your pack's image, signed:

```sh
pnpm exec kindgi build --local --push --env dev
```

- `--local` builds the image on your machine.
- `--push` pushes it to the `registry` of your pack's `dev` environment
  block, here the module's.
- `--env dev` names that environment block.

It prints the build as JSON, then each step. The last steps:

```text
…
    ✓ Pushed acmeep0y.azurecr.io/acme@sha256:4d18e695…

  Verifying build output
    ✓ /app/index.json in the image matches the local index byte for byte

  Signing locally
    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)
      key: acme-dev

  Deploy envelope written to …/.kindgi/build/deploy-envelope.json
  Run `kindgi deploy --env=dev` to POST it.
```

Set `server_image` and `pack_image` in `dev.tfvars` to the two images by
digest, `…@sha256:…`.

## 3. The secrets

The apps read their secrets from Key Vault. Make each value here and pipe
it in, straight into Key Vault or, for the database password, into az:
it's never on disk, on a command line or in Terraform's state, and Kindgi
generates none of them. Don't run these commands with `--debug`: it prints
each request's body, values included.

```sh
# Off in this shell: az's log file, if it's on, records each request's body.
export AZURE_LOGGING_ENABLE_LOG_FILE=no

V=$(terraform output -raw key_vault_name)
PG=$(terraform output -raw database_server_name)
FQDN=$(terraform output -raw database_fqdn)
put() { az keyvault secret set --vault-name "$V" -n "$1" --file /dev/stdin --query id -o tsv; }

# Kindgi's database login: set its password, then the URL with it.
DBPW=$(openssl rand -hex 24)
printf '%s' "$DBPW" | az postgres flexible-server update -g <rg> -n "$PG" --admin-password @- -o none
printf 'postgres://kindgiadmin:%s@%s:5432/kindgi?sslmode=require' "$DBPW" "$FQDN" | put database-url
unset DBPW

# The token the runtime and the pack's service share.
openssl rand -hex 32 | tr -d '\n' | put pack-service-token

# The first API token.
printf 'kgi_bt_%s' "$(openssl rand -hex 32)" | put api-token

# The AAD key and the erasure ledger's key: 32 bytes, base64. Each prints the
# secret's id; its last segment is the version to pin.
openssl rand 32 | base64 | tr -d '\n' | put secrets-aad-key
openssl rand 32 | base64 | tr -d '\n' | put erasure-ledger-key

# The key that signs public run tokens.
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n' | put public-token-key

# Only with export_signing = "secret": the key that signs exports, base64.
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n' | put export-signing-key

# The license key, pasted, never echoed.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | put license-key && unset LICENSE_KEY
```

- `put` stores what it reads on its input as the Key Vault secret its
  argument names, and prints the secret's id.
- `--admin-password @-` reads the database password from its input.
- `AZURE_LOGGING_ENABLE_LOG_FILE=no` keeps az's log file off in this shell,
  whatever az's configuration says.
- `openssl rand -hex 24` and `openssl rand -hex 32` make random values, and
  `openssl rand 32 | base64` 32 random bytes in base64.
- `openssl genpkey -algorithm ed25519` makes an Ed25519 private key.
- `read -rs` reads the license key you paste, without showing it.

Put the two keys' versions in `secrets_aad_key_version` and
`erasure_ledger_key_version`. The server reads those versions, never the
latest. Every secret stored in Postgres is bound to the AAD key, and
erasures replay after a backup restore only with the same ledger key. The
module refuses anything else:

```text
Error: Invalid value for variable
…
secrets_aad_key_version: a 32-hex Key Vault secret version id.
```

and, left empty, at the services' apply:

```text
Error: Resource precondition failed
…
secrets_aad_key_version is needed for the services: the version `az keyvault
secret set` printed for secrets-aad-key (README, step 3).
```

**Signed exports** are off by default, with `export_signing = "none"`:

- With `"secret"`, the server signs with the key you put in the vault as
  `export-signing-key`. It's Ed25519, or an EC P-256 key from
  `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`.
- With `"kms"`, the module makes an EC P-256 key in the vault, and the
  server signs there, so the private key never leaves Key Vault. Exports
  are then `ecdsa-p256-sha256`, since Key Vault has no Ed25519.

See [Export signed evidence](../../../guides/observability/export-signed-evidence/).

**The database login** is the server's admin, a member of `azure_pg_admin`
with `CREATEROLE`, which is what the runtime needs.

**Your pack's own secrets:** `kindgi env plan --env dev` lists what your pack
needs. Create each one in the same vault with `put`. The module passes them
to the pack's service, which gets read access to exactly those:

```sh
pnpm exec kindgi env plan --env dev > pack-env.json
jq '{pack_env: .env, pack_secret_env: .secret_env}' pack-env.json > dev.pack-env.auto.tfvars.json
```

`jq` turns the plan's `env` and `secret_env` into the module's `pack_env`
and `pack_secret_env` variables. Terraform reads `*.auto.tfvars.json` only
from the module's directory, and there it reads each such file by itself,
for every `plan` and `apply`. So keep the name's ending: a file such as
`dev.pack-env.tfvars.json` is read only with `-var-file`, and a plan made
without it takes the pack's env away.

## 4. The services

With the images and the secrets in place, apply the whole module. It creates
the two container apps:

```sh
terraform apply -var-file=dev.tfvars
```

The module waits a minute after granting the apps' roles before it creates
them, so they start with the roles in place. In the verification run, the
apply took 2 minutes 43 seconds. The runtime reached Key Vault and the
pack's service on its first start, with no warning.

The runtime logs JSON, so its startup lines are the `lines` of one record,
`Kindgi runtime ready`, in Log Analytics:

```sh
WS=$(az monitor log-analytics workspace list -g <rg> --query "[0].customerId" -o tsv)
az monitor log-analytics query -w "$WS" --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '<name_prefix>-server' and Log_s contains 'Kindgi runtime ready' | top 1 by TimeGenerated" \
  --query "[0].Log_s" -o tsv | jq -r '.lines[]'
```

- `WS` is the Log Analytics workspace's id.
- `--analytics-query` finds the runtime's newest `Kindgi runtime ready`
  record. `<name_prefix>` is your `name_prefix` variable.
- `--query "[0].Log_s" -o tsv` prints that record, and `jq -r '.lines[]'`
  its lines.

The first time, the CLI installs its `log-analytics` extension. A new
replica's lines take a minute or more to reach the workspace.
`az containerapp logs show -n <name_prefix>-server -g <rg> --type console`
streams the running replica's lines at once.

Before them, the runtime checks the key:

```text
KMS probe OK (azure-key-vault): azure-key-vault 7.5 (wrap/unwrap round trip, RSA-OAEP-256, key acme-secrets version 28fedcfb…) (999ms)
```

Then the lines name the license and the pack's service it reached:

```text
  License: … · non-production · until 2026-11-20
  Env: dev (tool secrets resolve in it)
  …
  Pack service: https://acme-pack.internal.… — acme (artifact 20261008.211554), protocol 2, 3 tools, 1 check
```

**Keep the pack's service warm when response time matters.** The default,
`pack_min_instances = 1`, keeps one replica running, so the first tool call
after a quiet spell doesn't wait for one to start. That replica runs around
the clock
([Azure Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)).
`pack_min_instances = 0` lets the service scale to zero when it's idle,
which suits a dev deployment: the first tool call after that waits for a
replica to start.

### How the runtime calls your pack's service

The pack's service has environment-internal ingress, and the environment holds
only Kindgi's two apps. From outside, its address answers 404. Inside, a call
without the pack token is refused by the pack's service:

```text
{"error":"Bad pack token"}
```

with status 401. `KINDGI_PACK_SERVICE_AUTH=token` makes the runtime send the
token on every call.

### Requests longer than 240 seconds

Container Apps ends HTTP requests at 240 seconds
([Microsoft: Ingress, HTTP](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http)).
A start that waits for a run longer than that gets this at 240 seconds:

```text
HTTP/2 504
content-length: 14
content-type: text/plain
…

stream timeout
```

The run itself carries on: in the verification run, it completed 30 seconds
later. Start a run that can take longer in the background, with
`wait: false`, and follow it, as `kindgi runs start` does. It followed
another run of the same flow to its end, 273 seconds later. For the same
reason, the module refuses a `pack_call_timeout_ms` of 240000 or more: the
runtime's wait for one tool call.

### Client addresses

Container Apps' ingress appends the caller's address to `X-Forwarded-For`
([Microsoft: HTTP headers](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http-headers)).
The module sets `KINDGI_TRUSTED_PROXIES=1`, from `trusted_proxies`, so rate
limits and audit records see the caller, not the ingress. If you put Front
Door or Application Gateway in front, set `trusted_proxies = "2"`
([Behind a load balancer or ingress](../self-host/#behind-a-load-balancer-or-ingress)).

## 5. Trust your key, and deploy

The runtime accepts only deploys signed by a key it trusts. Trust your
pack's key, then deploy:

```sh
URL=$(terraform output -raw server_url)
export KINDGI_API_TOKEN=$(az keyvault secret show --vault-name "$V" -n api-token --query value -o tsv)
npx --yes @kindgi/cli@0.2 key trust acme-dev --label dev --url "$URL"
```

It prints the key the runtime now trusts, then says so:

```text
{
  "keyId": "acme-dev",
  "tenantId": "722e23b8-bbb4-43dc-9a37-9640e369fa7d",
  "algorithm": "ed25519",
  "publicKey": "YoQxkUZcrXvo7NKCJmalfcMcGWMfNJzBhk+nhNctQBE=",
  "label": "dev",
  "createdAt": "2026-10-12T14:28:40.122Z"
}

  ✓ Trusted acme-dev (sha256:1b5dcdf07dacf4e91c1bab5b)
    The runtime now accepts deploys this key signs.
```

- `acme-dev` is your signing key's id, from `~/.kindgi/keys/`. `--label` is
  a label the runtime keeps with it.
- `--url` is the runtime's address. The commands send the API token from
  the vault, exported as `KINDGI_API_TOKEN`, which keeps it off the command
  line. `kindgi deploy` takes the address as `--endpoint`.
- `--env dev` deploys the pack's `dev` environment block.

```sh
pnpm exec kindgi deploy --env dev --endpoint "$URL"
```

It prints the deployment as JSON, then each step. The last steps:

```text
…
  Registering deployment
    ✓ POST /v1/deployments  →  201 Created
      deploymentId:    8ae8c6d0-…
      artifactVersion: 20261008.211554
      primitives:      3 tools, 1 guardrail, 1 agent, 2 flows
      activatedAt:     2026-10-08T21:22:04.191Z

  Deploy complete.
  Runs started from now use image sha256:4d18e69581b56… (artifactVersion 20261008.211554).
  Runs already in flight continue on their pinned image.
```

To deploy a client's pack into its own project, add `--project <id or slug>` ([Deploy a client's pack into its project](../../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).

The runtime read your pack's image from the registry with its own identity
(`KINDGI_IMAGE_REGISTRY_AUTH=azure`) to check it before registering it.
The module sets `KINDGI_IMAGE_REGISTRY_HOST` to the registry's login server.
If you set it yourself, give the login server alone: `<name>.azurecr.io`, or
`.azurecr.cn` / `.azurecr.us` in those clouds. The runtime exchanges its
Entra token at `https://<host>/oauth2/exchange`, so the host decides where
that token goes. Anything else, such as a scheme, a port or a path, stops the
runtime at startup with exit code 2:

```text
KINDGI_IMAGE_REGISTRY_AUTH=azure signs in to an Azure Container Registry: KINDGI_IMAGE_REGISTRY_HOST must be its login server (<name>.azurecr.io, or .azurecr.cn / .azurecr.us in those clouds), with no scheme, port or path. Got "https://myregistry.azurecr.io".
```

## 6. Check it

Check the runtime answers, lists your pack's tools, and runs a flow:

```sh
curl "$URL/health"                                  # {"ok":true}
npx --yes @kindgi/cli@0.2 tools list --url "$URL"   # your pack's tools
npx --yes @kindgi/cli@0.2 runs start --flow=acme.greet-flow --input='{"name":"Azure"}' --url "$URL"
```

`--flow` names the flow to run, and `--input` is its input, as JSON.

In the verification run, that flow (one tool step) completed in 399 ms, start
to finish, with the output `{"greeting":"Hello, Azure!"}`.

## 7. Turn on sign-in

Nobody can sign in to the console until you turn sign-in on. The API, the
CLI and the SDKs take API tokens either way. Until then, the startup lines
say so:

```text
  ⚠ Console sign-in: nobody can sign in to the console. KINDGI_CONSOLE_TOKEN_SIGN_IN=on allows an API token; KINDGI_AUTH_SECRET_PATH turns on sign-in with identity providers.
```

The runtime's own settings go in two variables, as the pack's do:
`server_env` for plain values, and `server_secret_env` for Key Vault
secrets, read with the runtime's identity. You create each secret in the
module's vault with `put` ([3. The secrets](#3-the-secrets)), and the
runtime gets read access to exactly those. The plan refuses a name the
module sets itself (its own variables cover those, such as `public_url`
below), `KINDGI_DEV`, a name in both maps, and a secret given as a plain
value: a name with `SECRET` in it, or the SMTP URL.

**With an API token,** which the console's sign-in page then takes:

```hcl excerpt
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}
```

**With an emailed link,** you need the runtime's sign-in secret, an SMTP
server and `public_url`:

```sh
# In the shell from step 3: it defines `put` and keeps az's log file off. No `--debug`.
# The sign-in secret: 32 bytes, base64.
openssl rand 32 | base64 | tr -d '\n' | put auth-secret
# The SMTP URL, password included: paste it; it never goes in a file.
read -rs SMTP_URL && printf '%s' "$SMTP_URL" | put smtp-url && unset SMTP_URL
```

```hcl excerpt
public_url = "https://kindgi-server.<environment domain>" # terraform output -raw server_url
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
  KINDGI_AUTH_EMAIL_FROM       = "kindgi@acme.example"
}
server_secret_env = {
  KINDGI_AUTH_SECRET         = { secret = "auth-secret", version = "<the version put printed>" }
  KINDGI_AUTH_EMAIL_SMTP_URL = { secret = "smtp-url", version = "<the version put printed>" }
}
```

Pin each secret to a version, as here, rather than `latest`: a new version
then reaches the runtime only when you change `version`, not whenever
Container Apps picks it up.

- **`public_url`** (`KINDGI_PUBLIC_URL`) is the address people open the
  console at: `terraform output -raw server_url` after the first apply, so
  the emailed link comes with a second apply, or your own domain in front.
  Console sessions are then accepted from that address only. The plan
  refuses `KINDGI_AUTH_SECRET` without it, because the runtime wouldn't
  start. A tool that pauses hands other systems a link made from it too
  ([On a server you run](../../../guides/tools/wait-for-another-system/#on-a-server-you-run)).

**With Continue with Google,** you need the sign-in secret and `public_url`,
as for the emailed link, and an OAuth client of type **Web application** in
the Google Cloud console ([Google](../sign-in/#google)). Its authorized
redirect URI is `public_url` followed by
`/auth/kindgi/social/callback/google`:

```text
https://kindgi-server.<environment domain>/auth/kindgi/social/callback/google
```

Store the client's secret, then give the runtime the client's ID and the
secret:

```sh
# In the shell from step 3. The Google client's secret: paste it; it never goes in a file.
read -rs GOOGLE_SECRET && printf '%s' "$GOOGLE_SECRET" | put google-client-secret && unset GOOGLE_SECRET
```

```hcl excerpt
public_url = "https://kindgi-server.<environment domain>"
server_env = {
  KINDGI_AUTH_GOOGLE_CLIENT_ID = "<client id>"
}
server_secret_env = {
  KINDGI_AUTH_SECRET               = { secret = "auth-secret", version = "<the version put printed>" }
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET = { secret = "google-client-secret", version = "<the version put printed>" }
}
```

- `<client id>` is the client's ID in the Google Cloud console, ending in
  `.apps.googleusercontent.com`.
- **Microsoft and GitHub** go the same way, with `MICROSOFT` or `GITHUB` in
  the names, and a redirect URI ending in `microsoft` or `github`
  ([Continue with Google, Microsoft or GitHub](../sign-in/#continue-with-google-microsoft-or-github)).
  So do verified domains and Turnstile: `KINDGI_AUTH_VERIFIED_DOMAINS` and
  the Turnstile site key in `server_env`, and `KINDGI_AUTH_TURNSTILE_SECRET`
  in `server_secret_env`.
- **Several ways in** share the two maps: with the emailed link too, they
  hold both sets of settings.
- **The module mounts no files,** so use the value forms of the settings,
  such as `KINDGI_AUTH_GOOGLE_CLIENT_SECRET`, not their `…_PATH` forms.

**Check it worked:** after the apply, the new revision's startup lines
([4. The services](#4-the-services)) say which ways in the console has,
instead of the warning. With Continue with Google alone:

```text
  Console sign-in: identity providers (KINDGI_CONSOLE_TOKEN_SIGN_IN=on also allows an API token)
  …
  Continue with: Google (the deployment's own apps)
```

What each setting does, and the ways in: [Turn on sign-in](../sign-in/).

## The roles it sets up

| Who | Role | On |
|---|---|---|
| The runtime's identity | Key Vault Crypto Service Encryption User | the key that wraps stored secrets (the startup check wraps and unwraps with it) |
| | Key Vault Secrets User | each of its secrets |
| | AcrPull | the registry |
| | Key Vault Crypto User, only with `export_signing = "kms"` | the export signing key |
| The pack's identity | Key Vault Secrets User | the pack token and your pack's secrets |
| | AcrPull | the registry |
| Whoever runs Terraform, and `key_vault_admins` | Key Vault Secrets Officer, Key Vault Crypto Officer | the vault |

## Operate it

- **Upgrade at least every 90 days.** A preview release stops starting 90
  days after it was released. Container Apps starts new replicas on its
  own, and after that day none comes up. The runtime warns from 30 days before, at startup and once a
  day, in a log record with `"event": "kindgi.preview_expiry"`: alert on it
  in Log Analytics
  ([Licensing](../../../concepts/licensing/#preview-releases-stop-starting-after-90-days)).
- **Upgrade:** make sure a restorable backup exists. Automatic backups with
  point-in-time restore are on. Copy the new runtime image by digest, set
  `server_image`, and apply. Migrations only go forward: never run two runtime
  versions on one database, and go back by restoring the backup.
- **Rotate a secret:** add a version with `put` again. The apps read their
  secrets when they start. The module references every secret but the two
  pinned keys without a version. So a replica that starts after Container
  Apps picks up the new version gets it
  ([Microsoft: Key Vault secret URI and secret rotation](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation)
  says when that happens). Never rotate the AAD key or the erasure ledger's
  key this way: they're pinned.
- **Rotate the wrapping key:** with `key_rotation_days`, 90 by default, Key
  Vault adds a key version on schedule. New secrets use it, and the ones
  stored before keep unwrapping with theirs. In the verification run, a secret
  stored before `az keyvault key rotate` read back the same after it.
- **Renew the license key:** enroll once, then run
  `$(terraform output -raw license_renew_command)` by hand or from your
  scheduler. Or set `license_renewal_schedule`, a cron in UTC, and the
  module runs it as a job of its own. It comes with an alert for a failed run,
  and one for a key within 7 days of its end
  ([Renew the license key](../renew-the-license-key/#on-a-schedule)). With
  `license_usage_key_secret` too, its renewals carry counts of the
  deployment's use
  ([A key for the counts](../renew-the-license-key/#a-key-for-the-counts)),
  and an alert says when a run sent none.
- **A key the runtime can't use:** a new replica exits with code 2 and says
  why, and what to check:

  ```text
  KMS probe failed at boot: kms-unauthorized: Azure Key Vault refused probe (HTTP 403): Forbidden: Caller is not authorized to perform action on resource.
  …
  . Check KINDGI_SECRETS_AZURE_KEY_ID (an RSA key's URL, without a version) and KINDGI_AZURE_CLIENT_ID (the runtime's managed identity), that the identity has the Key Vault Crypto Service Encryption User role on the key or its vault, and that the vault's network rules let the runtime in.
  ```

  In the verification run, the replica that couldn't start didn't replace the
  one serving. Its lines are in Log Analytics:

  ```sh
  az monitor log-analytics query -w "$WS" --analytics-query \
    "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '<name_prefix>-server' | order by TimeGenerated desc | take 50"
  ```
- **Logs:** Log Analytics, per app, in `ContainerAppConsoleLogs_CL`. The
  platform's events, such as image pulls and restarts, are in
  `ContainerAppSystemLogs_CL`. Filter the runtime's records by `traceId` to
  follow one request or run ([Logs](../logs/)).

## Tear it down

```sh
terraform destroy -var-file=dev.tfvars
```

- **The vault:** with `key_vault_purge_protection = true`, the default, the
  deleted vault and its keys stay recoverable for
  `key_vault_soft_delete_retention_days`, and its name stays taken until then
  ([Microsoft: Key Vault soft-delete](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview)).
  A sandbox can leave purge protection off from the start, with
  `key_vault_purge_protection = false` before the vault exists. It can then
  set `key_vault_purge_on_destroy = true`, if whoever runs Terraform may
  purge.
- **The infrastructure group** goes with the environment. Check:
  `az group exists -n <rg>-<name_prefix>-infra`.
- **How long:** in the verification run, one `destroy` took 25 minutes, most
  of it the environment.
- **On azurerm 5.8**, the destroy stopped after each container app and the
  environment were already deleted, with
  `polling support for the Content-Type "" was not implemented`. 5.9 fixes it,
  which is why the module needs it.

## Limits

- **One runtime replica.** Several aren't supported.
- **Requests end at 240 seconds:** follow long runs instead of waiting
  ([Requests longer than 240 seconds](#requests-longer-than-240-seconds)).

## Next

- [Operate a self-hosted runtime](../operate/): health, backups, upgrades
  and rotating keys.
- [Renew the license key](../renew-the-license-key/): on the module's
  schedule.
- [Logs](../logs/): what the runtime logs, and how to follow a run.
- [Turn on sign-in](../sign-in/): every way in, and what each setting does.
