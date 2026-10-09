# Kindgi on Azure Container Apps (Terraform)

> **Draft (runtime 0.1.6).** These steps ran end to end on a live subscription (2026-10-08), with a runtime built from source: a pack deployed and run, a key rotation, and the teardown. Until runtime 0.1.6 is released, step 2's image isn't on Quay yet.

A Terraform root module that runs Kindgi in one Azure resource group you already have:
- the runtime (the API, agent and flow execution) as a container app;
- your pack's code as a second container app, reachable only inside the environment;
- Kindgi's own PostgreSQL Flexible Server (16, pgvector), on a private network;
- everything they stand on: two user-assigned managed identities, a Container Registry, Key Vault (the key that wraps the runtime's secrets, and the secrets both services read), Log Analytics, and the network.

**Two network shapes:**

| | New VNet (default) | Existing VNet |
|---|---|---|
| For | a resource group of its own | a VNet whose private resources (an app database, internal services, private endpoints) the pack's tools reach |
| Network | a VNet, a subnet for the environment, a delegated subnet and private DNS zone for PostgreSQL | nothing: give it two empty delegated subnets in that VNet and a private DNS zone (`environment_subnet_id`, `database_subnet_id`, `database_private_dns_zone_id`) |
| Example values | `example.tfvars` | `example-existing-vnet.tfvars` |

In both shapes the pack service's ingress is **environment-internal**: only apps in the same Container Apps environment reach it, and the environment holds only Kindgi's two apps. The runtime sends the pack token on every call (`KINDGI_PACK_SERVICE_AUTH=token`).

**One platform limit to know:** Container Apps ends HTTP requests at **240 seconds** ([Microsoft: Ingress, HTTP](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview#http)). A request still open then gets `504` with the body `stream timeout`; the run itself carries on. Start runs that can take longer with `wait: false` and follow them (events or polling), as `kindgi runs start` does; a stream cut at the limit resumes with `Last-Event-ID`. For the same reason the runtime's wait for one tool call (`pack_call_timeout_ms`) must stay under 240 000.

## Before you start

- Terraform ≥ 1.11, the Azure CLI, Docker, `openssl`, and your pack's `kindgi` CLI (0.1.6 or later).
- **Permission in the resource group:** Owner, or Contributor plus User Access Administrator (the module grants roles to its identities).
- **The subscription's resource providers registered,** once per subscription, by someone allowed to (the module never writes at the subscription level):

  ```sh
  for p in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry \
           Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network; do
    az provider register -n $p
  done
  ```
- **A second resource group, made by Azure:** a Container Apps environment on a VNet keeps its infrastructure in a platform-managed resource group next to yours. The module names it `<your group>-<name_prefix>-infra`; Azure creates it with the environment and deletes it with the environment. If your policies forbid new resource groups, exempt this one.
- **Pull access to the runtime image** `quay.io/kindgi/runtime` (`kindgi auth registry`).
- **A license key** from Kindgi (`KINDGI_LICENSE_KEY`; a non-production key for a pilot).
- **Check your Azure Policy assignments** (`az policy assignment list -g <rg> --disable-scope-strict-search`): allowed locations, required tags, or a rule forbidding public network access change the recipe.

## 1. State, and the foundation (no services yet)

```sh
az storage account create -n <state account> -g <rg> --sku Standard_LRS \
  --allow-blob-public-access false --min-tls-version TLS1_2
az storage container create -n tfstate --account-name <state account> --auth-mode login
az role assignment create --assignee <you> --role "Storage Blob Data Contributor" \
  --scope "$(az storage account show -n <state account> -g <rg> --query id -o tsv)"
cp example.tfvars dev.tfvars      # or example-existing-vnet.tfvars; fill in
terraform init -backend-config=resource_group_name=<rg> -backend-config=storage_account_name=<state account> \
  -backend-config=container_name=tfstate -backend-config=key=<this deployment>.tfstate -backend-config=use_azuread_auth=true
```

Give each deployment its own state key. Never share a root module or a key with your app's own infrastructure.

The services need images and secret values that don't exist yet, so the first apply leaves them out:

```sh
terraform apply -var-file=dev.tfvars \
  -target=azurerm_container_app_environment.kindgi \
  -target=azurerm_postgresql_flexible_server_database.kindgi \
  -target=azurerm_postgresql_flexible_server_configuration.extensions \
  -target=azurerm_role_assignment.server_wraps \
  -target=azurerm_role_assignment.server_pulls \
  -target=azurerm_role_assignment.pack_pulls
```

- The image variables only need a digest-shaped placeholder here, and `secrets_aad_key_version` and `erasure_ledger_key_version` may stay empty.
- The PostgreSQL server takes several minutes.
- The PostgreSQL admin password is write-only: Terraform sends a random one that nobody keeps, and it never reaches the state or the plan. You set the real one in step 3.

## 2. Images into the registry

Copy the runtime's **whole multi-platform index** by digest: a `docker pull` / `push` from an arm64 machine copies only arm64, and Container Apps needs amd64.

```sh
ACR=$(terraform output -raw image_registry)
az acr login -n "${ACR%%.*}"
docker buildx imagetools create --tag $ACR/runtime:<version> quay.io/kindgi/runtime:<version>@sha256:<release digest>
kindgi build --local --push --env dev      # the pack image, signed; registry: <ACR>/<repo> in kindgi.config
```

The mirrored runtime keeps the release's digest. Set `server_image` and `pack_image` to the two digests (`…@sha256:…`).

## 3. Secret values

A Key Vault secret can't exist without a value, so you create each one. Every value is piped straight into Key Vault: none goes on disk, into Terraform, or onto a command line, except the database password, which `az postgres flexible-server update` takes as an argument (as `gcloud sql users create` does on GCP).

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

# The token the server and the pack service share: no trailing newline.
openssl rand -hex 32 | tr -d '\n' | put pack-service-token

# The bearer the server seeds (the first admin token).
printf 'kgi_bt_%s' "$(openssl rand -hex 32)" | put api-token

# The key for secrets stored in Postgres: 32 bytes, base64. It prints the
# secret's id; its last segment is secrets_aad_key_version.
openssl rand 32 | base64 | tr -d '\n' | put secrets-aad-key

# The erasure ledger's key: 32 bytes, base64. It prints the secret's id;
# its last segment is erasure_ledger_key_version.
openssl rand 32 | base64 | tr -d '\n' | put erasure-ledger-key

# The key that signs public run tokens: Ed25519, PKCS#8 PEM, base64.
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n' | put public-token-key

# Only with export_signing = "secret": the key that signs exports, base64
# (Ed25519 here; an EC P-256 key works too).
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n' | put export-signing-key

# The license key: paste it; it never goes in a file.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | put license-key && unset LICENSE_KEY
```

Put the two keys' versions in `secrets_aad_key_version` and `erasure_ledger_key_version`. The server reads those versions, never "latest":
- every secret stored in Postgres is bound to the AAD key, so a new version would make them all unreadable;
- erasures replay after a backup restore only with the same ledger key.

**Your pack's own secrets** (`secret_env` in `kindgi env plan --env dev`): create each one in the same vault with `put`. The pack service gets read access to exactly those.

## 4. The pack's env

```sh
kindgi env plan --env=dev > pack-env.json      # exits 1 if a required name has no value
jq '{pack_env: .env, pack_secret_env: .secret_env}' pack-env.json > dev.pack-env.auto.tfvars.json
```

Terraform reads `*.auto.tfvars.json` only from the working directory; anywhere else it's silently ignored. Each `secret` is a name in the module's vault; `project` (a GCP field) is refused.

## 5. The services

```sh
terraform apply -var-file=dev.tfvars
```

The server's boot lines name what it reached:

```sh
az containerapp logs show -n <name_prefix>-server -g <rg> --type console --tail 100
```

```
KMS probe OK (azure-key-vault): azure-key-vault 7.5 (wrap/unwrap round trip, RSA-OAEP-256, key <name> version <v>)
{"subsystem":"boot","message":"Kindgi runtime ready", "lines":[… "  License: <holder> · non-production · until <date>", …
  "  Pack service: https://<name_prefix>-pack.internal.<environment domain> — <pack id> (artifact …), protocol 2, 4 tools, 1 check"]}
```

`logs show` streams the running replica. For a replica that stopped (a boot that failed), query Log Analytics:

```sh
WS=$(az monitor log-analytics workspace list -g <rg> --query "[0].customerId" -o tsv)
az monitor log-analytics query -w "$WS" --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '<name_prefix>-server' | order by TimeGenerated desc | take 50"
```

A boot that can't use the key exits 2 and says why (`KMS probe failed at boot: kms-unauthorized: …`, then what to check). In the live check, a restart that couldn't boot left the replica before it serving.

## 6. Register the pack

Trust the pack's signing key on the runtime, then deploy:

```sh
URL=$(terraform output -raw server_url)
kindgi key trust <key id> --label dev --url "$URL" --token <api token>
kindgi deploy --env dev --endpoint "$URL" --token <api token>
```

The runtime reads the pack image from the registry with its own identity (`KINDGI_IMAGE_REGISTRY_AUTH=azure`). Then `kindgi health`, `kindgi tools list` and a run, with `--url "$URL" --token <api token>`.

## 7. Turn on sign-in

**Nobody can sign in to the console until you turn sign-in on.** The API takes API tokens either way. Console sign-in is off by default outside `kindgi dev`, and the server's boot lines say so: `⚠ Console sign-in: nobody can sign in to the console. …`

The server's own settings go in two variables, as the pack's do:
- `server_env`: plain values;
- `server_secret_env`: Key Vault references, read with the server's identity. You create each secret in the module's vault (`put`, step 3), and the server gets read access to exactly those.

The plan refuses a name the module sets itself (its own variables cover those, such as `public_url` below), `KINDGI_DEV`, a name in both maps, and a secret given as a plain value. The Cloud Run module takes the same variables, with Secret Manager references.

**With the API token,** which the console's sign-in page takes:

```hcl
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}
```

**With an emailed link.** It needs the server's sign-in secret, an SMTP server and `public_url`:

```sh
# The sign-in secret: 32 bytes, base64.
openssl rand 32 | base64 | tr -d '\n' | put auth-secret
# The SMTP URL, password included: paste it; it never goes in a file.
read -rs SMTP_URL && printf '%s' "$SMTP_URL" | put smtp-url && unset SMTP_URL
```

```hcl
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

- **`public_url`** (`KINDGI_PUBLIC_URL`) is the URL people open the console at: `terraform output -raw server_url` after the services apply, or your own domain in front. The emailed link therefore comes with a second apply.
  - Console sessions are then accepted from that origin only, so open the console there.
  - The plan refuses `KINDGI_AUTH_SECRET` without it, because the server wouldn't start.
- **Pin each secret to a version**, as above, rather than `latest`: a new version then reaches the server only when you change `version` here, not whenever Container Apps picks it up.
- **Continue with Google, Microsoft or GitHub, verified domains, and Turnstile** go the same way:
  - in `server_env`: each provider's client id, `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant id>`) and the Turnstile site key;
  - in `server_secret_env`: each `…_CLIENT_SECRET` and `KINDGI_AUTH_TURNSTILE_SECRET`.
  - The `…_PATH` forms read a file, which this module doesn't mount, so use the value forms.

## Operating it

- **Signed exports** (approval audit bundles, run provenance, compliance evidence) are off by default (`export_signing = "none"`). `"kms"`: the module makes an EC P-256 key in the vault (`<name_prefix>-exports`) and the server signs with it there, with Key Vault Crypto User on that key alone; exports are `ecdsa-p256-sha256`, since Key Vault has no Ed25519. `"secret"`: a key you put in the vault as `export-signing-key` (step 3).
- **Client addresses:** the server trusts one proxy, the Container Apps ingress, which appends the caller to `X-Forwarded-For` (`trusted_proxies = "1"`, `KINDGI_TRUSTED_PROXIES`), so rate limits and audit records see the caller. With Front Door or Application Gateway in front, set `"2"`.
- **One server replica** until several are verified. Migrations run at boot over a direct connection (port 5432, not the built-in PgBouncer on 6432).
- **Upgrades roll forward:** migrations only go forward. Before a new runtime version boots on the database, make sure a restorable backup exists (automatic backups with point-in-time restore are on), and roll back by restoring it.
- **Rotating a secret:** add a version (`put` again). Every secret but the two pinned keys is referenced without a version, so a replica that starts after Container Apps picks up the new version gets it ([Microsoft: Key Vault secret URI and secret rotation](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation)). Never rotate the AAD key or the erasure ledger's key this way.
- **Rotating the key:** with `key_rotation_days` (default 90) Key Vault adds a key version on schedule. New secrets use it; old ones keep unwrapping with theirs.
- **Hardening:** the vault and registry are reached over their public endpoints, guarded by Entra RBAC. To close those, add private endpoints (the registry needs the Premium tier) and network rules.

## Taking it down

```sh
terraform destroy -var-file=dev.tfvars
```

- With `key_vault_purge_protection = true` (the default), the deleted vault and its keys stay recoverable for `key_vault_soft_delete_retention_days`, and the vault's name stays taken until then. A sandbox can set purge protection off with `key_vault_purge_on_destroy = true`.
- The platform-managed infrastructure resource group goes with the environment: check it's gone (`az group exists -n <rg>-<name_prefix>-infra`).
