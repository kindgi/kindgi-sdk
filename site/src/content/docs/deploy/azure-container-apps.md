---
title: Deploy on Azure Container Apps
description: Run the Kindgi runtime and your pack's service on Azure Container Apps, with PostgreSQL Flexible Server, Container Registry, Key Vault and managed identities, from Kindgi's Terraform module.
sidebar:
  order: 2.5
---

Kindgi's Terraform module runs the runtime and your pack's service as two
container apps in one Azure resource group you already have, with everything
around them. In the verification run, the first apply took about seven minutes
(most of it PostgreSQL), the services under three more, and a new runtime
replica was ready 10 seconds after its container started, its first
migrations included.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub for the
runtime image's pull credentials, and log in once with `kindgi auth registry`
(see [Install](../../start/install/#access-to-the-runtime-image)). Questions or trouble: contact@kindgi.com.
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

Who calls whom: your app calls the runtime (its API token); the runtime calls
your pack's service (the pack token), PostgreSQL, Key Vault and model APIs;
`kindgi deploy` calls the runtime with a signed envelope, and the runtime
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
- **Terraform** 1.11 or later (the database's admin password is write-only),
  the **Azure CLI**, **Docker** with `buildx`, **jq**, and your pack's
  `kindgi` CLI (0.1.6 or later). The module needs the `azurerm` provider 5.9
  or later; its lock file pins it.
- **Runtime 0.1.6 or later:** the first with Key Vault keys and the
  registry's managed identity.
- **Access to the runtime image** (`kindgi auth registry`; see
  [Install](../../start/install/)).
- **A license key:** a non-production key covers staging. Get one at
  [access.kindgi.com](https://access.kindgi.com), or from contact@kindgi.com.
- **A pack** that `kindgi build --local --push` builds, with an environment
  block for this deployment in its config, whose `registry` is the module's
  registry (step 2 prints it).
- **Your Azure Policy assignments checked**
  (`az policy assignment list -g <rg> --disable-scope-strict-search`): allowed
  locations, required tags, or a rule against public network access change the
  recipe.

## 1. The foundation

The module is `deploy/azure-container-apps/` in the
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

Give each deployment its own state key, never shared with your app's own
infrastructure.

The services need images and secret values that don't exist yet, so the first
apply creates everything else:

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

The image variables need only a digest-shaped placeholder here, and
`secrets_aad_key_version` and `erasure_ledger_key_version` may stay empty.
The plan creates 22 resources; in the verification run the apply took 6
minutes 47 seconds. The database's admin password is write-only: Terraform
sends a random one that nobody keeps, and it never reaches the state. You set
the real one in step 3.

The vault has purge protection on (`key_vault_purge_protection`, default
`true`). Every secret the runtime stores is wrapped by the vault's key, so a
deleted key, secret or vault stays recoverable for
`key_vault_soft_delete_retention_days` (default 90), and nobody can purge it
sooner, an owner included. Once on, purge protection can't be turned off.

### A new VNet, or yours

- **A new VNet** (the default, `example.tfvars`): the module creates the VNet,
  a subnet for the environment, a delegated subnet and a private DNS zone for
  PostgreSQL. Pick it when your tools reach only the internet, or nothing
  outside your pack.
- **Yours** (`example-existing-vnet.tfvars`): give it two empty delegated
  subnets and a private DNS zone (`environment_subnet_id`,
  `database_subnet_id`, `database_private_dns_zone_id`); the module creates no
  network. Pick it when your pack's tools reach private resources in that
  VNet: an app database, an internal service, a private endpoint.

In both, the environment holds only Kindgi's two apps. The private DNS zone
and its link get your tags except any whose name has a colon: Azure ignores
those there.

## 2. The images into the registry

Copy the runtime image into the module's registry by digest, with every
platform it was built for:

```sh
ACR=$(terraform output -raw image_registry)
az acr login -n "${ACR%%.*}"
docker buildx imagetools create --tag "$ACR/runtime:0.1.6" \
  quay.io/kindgi/runtime:0.1.6@sha256:<the release's digest>
```

The copy keeps the release's digest. (A plain `docker pull`, `tag` and `push`
from an Apple silicon machine pushes only the arm64 image, which Container
Apps can't run.)

Then build and push your pack's image, signed:

```sh
pnpm exec kindgi build --local --push --env dev
```

```text
    ✓ Pushed acmeep0y.azurecr.io/acme@sha256:4d18e695…
    ✓ /app/index.json in the image matches the local index byte for byte
    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)
```

Set `server_image` and `pack_image` in `dev.tfvars` to the two digests
(`…@sha256:…`).

## 3. The secrets

Make each value here and pipe it straight into Key Vault: it's never on disk
or in Terraform's state, and Kindgi generates none of them. The one
exception is the database password, which `az postgres flexible-server update`
takes as an argument.

```sh
V=$(terraform output -raw key_vault_name)
PG=$(terraform output -raw database_server_name)
FQDN=$(terraform output -raw database_fqdn)
put() { az keyvault secret set --vault-name "$V" -n "$1" --file /dev/stdin --query id -o tsv; }

# Kindgi's database login: set its password, then the URL with it.
DBPW=$(openssl rand -hex 24)
az postgres flexible-server update -g <rg> -n "$PG" --admin-password "$DBPW" -o none
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

Put the two keys' versions in `secrets_aad_key_version` and
`erasure_ledger_key_version`. The server reads those versions, never the
latest: every secret stored in Postgres is bound to the AAD key, and erasures
replay after a backup restore only with the same ledger key. The module
refuses anything else:

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

**Signed exports** are off by default (`export_signing = "none"`). With
`"secret"`, the server signs with the key you put in the vault above as
`export-signing-key` (Ed25519, or an EC P-256 key from
`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`). With
`"kms"`, the module makes an EC P-256 key in the vault and the server signs
there, so the private key never leaves Key Vault; exports are then
`ecdsa-p256-sha256`, since Key Vault has no Ed25519. See
[Export signed evidence](../../guides/observability/export-signed-evidence/).

**The database login** is the server's admin, a member of `azure_pg_admin`
with `CREATEROLE`, which is what the runtime needs.

**Your pack's own secrets:** `kindgi env plan --env dev` lists what your pack
needs. Create each one in the same vault with `put`, and the module passes
them to the pack's service, which gets read access to exactly those:

```sh
pnpm exec kindgi env plan --env dev > pack-env.json
jq '{pack_env: .env, pack_secret_env: .secret_env}' pack-env.json > dev.pack-env.auto.tfvars.json
```

Terraform reads `*.auto.tfvars.json` only from the module's directory.

## 4. The services

```sh
terraform apply -var-file=dev.tfvars
```

The module waits a minute after granting the apps' roles before it creates
them, so they start with the roles in place. In the verification run the apply
took 2 minutes 43 seconds, and the runtime reached Key Vault and the pack's
service on its first start, with no warning.

The runtime logs JSON, so its startup lines are the `lines` of one record,
`Kindgi runtime ready`, in Log Analytics:

```sh
WS=$(az monitor log-analytics workspace list -g <rg> --query "[0].customerId" -o tsv)
az monitor log-analytics query -w "$WS" --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '<name_prefix>-server' and Log_s contains 'Kindgi runtime ready' | top 1 by TimeGenerated" \
  --query "[0].Log_s" -o tsv | jq -r '.lines[]'
```

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

The run itself carries on: in the verification run it completed 30 seconds
later. Start a run that can take longer in the background (`wait: false`) and
follow it, as `kindgi runs start` does: it followed another run of the same
flow to its end, 273 seconds later. For the same reason, the module refuses a `pack_call_timeout_ms`
(the runtime's wait for one tool call) of 240000 or more.

### Client addresses

Container Apps' ingress appends the caller's address to `X-Forwarded-For`
([Microsoft: HTTP headers](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http-headers)).
The module sets `KINDGI_TRUSTED_PROXIES=1` (`trusted_proxies`), so rate limits
and audit records see the caller, not the ingress. If you put Front Door or
Application Gateway in front, set `trusted_proxies = "2"`. See
[Behind a load balancer or ingress](../self-host/#behind-a-load-balancer-or-ingress).

## 5. Trust your key, and deploy

```sh
URL=$(terraform output -raw server_url)
KINDGI_API_TOKEN=$(az keyvault secret show --vault-name "$V" -n api-token --query value -o tsv)
pnpm exec kindgi key trust acme-dev --label dev --url "$URL" --token "$KINDGI_API_TOKEN"
```

```text
  ✓ Trusted acme-dev (sha256:d872dbbf…)
    The runtime now accepts deploys this key signs.
```

```sh
pnpm exec kindgi deploy --env dev --endpoint "$URL" --token "$KINDGI_API_TOKEN"
```

```text
    ✓ POST /v1/deployments  →  201 Created
      deploymentId:    8ae8c6d0-…
      artifactVersion: 20261008.211554
      primitives:      3 tools, 1 guardrail, 1 agent, 2 flows
      activatedAt:     2026-10-08T21:22:04.191Z

  Deploy complete.
```

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

```sh
curl "$URL/health"                                   # {"ok":true}
pnpm exec kindgi tools list --url "$URL" --token …   # your pack's tools
pnpm exec kindgi runs start --flow=acme.greet-flow --input='{"name":"Azure"}' --url "$URL" --token …
```

In the verification run, that flow (one tool step) completed in 399 ms, start
to finish, with the output `{"greeting":"Hello, Azure!"}`.

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

- **Upgrade:** make sure a restorable backup exists (automatic backups with
  point-in-time restore are on), copy the new runtime image by digest, set
  `server_image`, and apply. Migrations only go forward: never run two runtime
  versions on one database, and go back by restoring the backup.
- **Rotate a secret:** add a version (`put` again). The apps read their
  secrets when they start, and the module references every secret but the two
  pinned keys without a version, so a replica that starts after Container
  Apps picks up the new version gets it (when that happens:
  [Microsoft: Key Vault secret URI and secret rotation](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation)).
  Never rotate the AAD key or the erasure ledger's key this way: they're
  pinned.
- **Rotate the wrapping key:** with `key_rotation_days` (90 by default), Key
  Vault adds a key version on schedule. New secrets use it, and the ones
  stored before keep unwrapping with theirs. In the verification run, a secret
  stored before `az keyvault key rotate` read back the same after it.
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
- **Logs:** Log Analytics, per app (`ContainerAppConsoleLogs_CL`); the
  platform's events, such as image pulls and restarts, are in
  `ContainerAppSystemLogs_CL`. Filter the runtime's records by `traceId` to
  follow one request or run. See [Logs](../logs/).

## Tear it down

```sh
terraform destroy -var-file=dev.tfvars
```

- **The vault:** with `key_vault_purge_protection = true` (the default), the
  deleted vault and its keys stay recoverable for
  `key_vault_soft_delete_retention_days`, and its name stays taken until then
  ([Microsoft: Key Vault soft-delete](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview)).
  A sandbox can leave purge protection off from the start
  (`key_vault_purge_protection = false` before the vault exists) and set
  `key_vault_purge_on_destroy = true`, if whoever runs Terraform may purge.
- **The infrastructure group** goes with the environment. Check:
  `az group exists -n <rg>-<name_prefix>-infra`.
- **How long:** in the verification run, one `destroy` took 25 minutes, most
  of it the environment.
- **On azurerm 5.8**, the destroy stopped after each container app and the
  environment were already deleted, with
  `polling support for the Content-Type "" was not implemented`. 5.9 fixes it,
  which is why the module needs it.

## Limits today

- **One runtime replica.** Several aren't supported yet.
- **Requests end at 240 seconds:** follow long runs instead of waiting
  ([above](#requests-longer-than-240-seconds)).
