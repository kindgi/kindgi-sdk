# Kindgi on Azure Container Apps (Terraform)

> **Draft (runtime 0.1.6).** These steps ran end to end on a live subscription (2026-10-08), with a runtime built from source: a pack deployed and run, a key rotation, and the teardown.

A Terraform root module that runs Kindgi in one Azure resource group you already have:
- the runtime (the API, agent and flow execution) as a container app;
- your pack's code as a second container app, reachable only inside the environment;
- Kindgi's own PostgreSQL Flexible Server (16, pgvector), on a private network;
- everything they stand on: two user-assigned managed identities, a Container Registry, Key Vault (the key that wraps the runtime's secrets, and the secrets both services read), Log Analytics, and the network.

**One tenant:** the runtime serves the tenant it seeds (`seed_tenant_id`), and the plan refuses `KINDGI_TENANCY` or `KINDGI_PACK_ROUTING` other than `single` in `server_env` (or in `server_secret_env` at all). Serving many tenants needs a container app for each deployment's pack service, run by an orchestrator of your own, which this module doesn't make.

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
- **Pull access to the runtime image** `registry.kindgi.com/kindgi/runtime`, with your license key as the password: `docker login registry.kindgi.com --username kindgi` asks for the key.
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

Copy the runtime's **whole multi-platform index** by digest: a `docker pull` / `push` from an arm64 machine copies only arm64, and Container Apps needs amd64. The copy goes through the machine you run it on and takes both platforms, so on a slow uplink it can take most of an hour.

```sh
ACR=$(terraform output -raw image_registry)
az acr login -n "${ACR%%.*}"
docker buildx imagetools create --tag $ACR/runtime:<version> registry.kindgi.com/kindgi/runtime:<version>@sha256:<release digest>
kindgi build --local --push --env dev      # the pack image, signed; registry: <ACR>/<repo> in kindgi.config
```

The mirrored runtime keeps the release's digest. Set `server_image` and `pack_image` to the two digests (`…@sha256:…`).

## 3. Secret values

A Key Vault secret can't exist without a value, so you create each one. Every value is piped straight into Key Vault, or into az for the database password: none goes on disk, into Terraform, or onto a command line. Don't run these commands with `--debug`: it prints each request's body, values included.

```sh
# Off in this shell: az's log file, if it's on, records each request's body.
export AZURE_LOGGING_ENABLE_LOG_FILE=no

V=$(terraform output -raw key_vault_name)
PG=$(terraform output -raw database_server_name)
FQDN=$(terraform output -raw database_fqdn)
put() { az keyvault secret set --vault-name "$V" -n "$1" --file /dev/stdin --query id -o tsv; }

# Kindgi's database login: set its password (`@-` reads it from the input), then the URL with it.
DBPW=$(openssl rand -hex 24)
printf '%s' "$DBPW" | az postgres flexible-server update -g <rg> -n "$PG" --admin-password @- -o none
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

`pack_min_instances` (default 1) keeps one pack service replica running, around the clock ([Azure Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)), so the first tool call after a quiet spell doesn't wait for one to start. Keep it when response time matters; 0 lets the pack service scale to zero, which suits a dev deployment.

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
# In the shell from step 3: it defines `put` and keeps az's log file off. No `--debug`.
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

**With Continue with Google.** It needs the sign-in secret and `public_url`, as for the emailed link, and an OAuth client of type **Web application** in the Google Cloud console. Its authorized redirect URI is `public_url` followed by `/auth/kindgi/social/callback/google`:

```
https://kindgi-server.<environment domain>/auth/kindgi/social/callback/google
```

```sh
# In the shell from step 3. The Google client's secret: paste it; it never goes in a file.
read -rs GOOGLE_SECRET && printf '%s' "$GOOGLE_SECRET" | put google-client-secret && unset GOOGLE_SECRET
```

```hcl
public_url = "https://kindgi-server.<environment domain>"
server_env = {
  KINDGI_AUTH_GOOGLE_CLIENT_ID = "<client id>" # ends in .apps.googleusercontent.com
}
server_secret_env = {
  KINDGI_AUTH_SECRET               = { secret = "auth-secret", version = "<the version put printed>" }
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET = { secret = "google-client-secret", version = "<the version put printed>" }
}
```

- **Microsoft and GitHub, verified domains, and Turnstile** go the same way:
  - in `server_env`: `KINDGI_AUTH_MICROSOFT_CLIENT_ID` or `KINDGI_AUTH_GITHUB_CLIENT_ID`, `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant id>`) and the Turnstile site key;
  - in `server_secret_env`: `KINDGI_AUTH_MICROSOFT_CLIENT_SECRET` or `KINDGI_AUTH_GITHUB_CLIENT_SECRET`, and `KINDGI_AUTH_TURNSTILE_SECRET`;
  - each provider's redirect URI ends in its name: `…/auth/kindgi/social/callback/microsoft` or `…/github`.
- Several ways in share the two maps: with the emailed link too, they hold both sets of settings.
- The `…_PATH` forms read a file, which this module doesn't mount, so use the value forms.

## Upgrading

- **A deployment of this module** (either network shape, from runtime 0.1.8 or later) can be upgraded to 0.2.0 or later with `./upgrade.sh` (log in to `registry.kindgi.com` first: `docker login registry.kindgi.com --username kindgi` asks for your license key; see [Pull the runtime image](https://docs.kindgi.com/deploy/self-hosted/pull-the-runtime-image/)), with `az` signed in to the deployment's subscription: it reads the current version, copies the new image from `registry.kindgi.com` into the module's registry and runs the upgrade checks against the database, as Container Apps jobs in the module's environment that reach it the way the server does (the VNet, the server's identity, the database URL from Key Vault), stopping if one fails. It checks that the database server keeps at least 7 days of backups and has a restore point in the past, shows the plan, checks it, and applies exactly that plan only when you type `yes`. Just before it applies, it takes an on-demand backup on a server tier that takes one (all but Burstable, the module's default) and records the restore point: the UTC time the way back restores the server to. If the new revision doesn't come up it prints the way back rather than rolling back on its own. Outside the deployment, it logs docker in to the module's registry (`az acr login`) and tags the image `runtime:<version>` there, it creates a job for each check (`<name_prefix>-upgchk-<HHMMSS>-pk`, `-ss` and `-mhc`), printing each name as it makes it, and deletes each when the run ends, however it ends (a run killed outright can't: delete a leftover with `az containerapp job delete -n <name> -g <resource group> --yes`), and it writes the new image into your var-file's `server_image` (and `pack_image`), keeping the previous file next to it. It keeps the plan it applies there too, as `<var-file>.upgrade-<UTC time>.tfplan`: `terraform show` reads it, and since it holds what your var files and state hold, only you can read it. Give it one `--var-file` for each file the deployment's variables are in, in the order you give them to `terraform`. A file Terraform doesn't load on its own needs its own, such as a pack's env kept beside the var-file: from the directory it runs in, Terraform loads only `terraform.tfvars` and `*.auto.tfvars` (and their `.json`). It lists every file Terraform reads them from, and the `TF_VAR_` names set in the environment, and it stops if one of them, other than the var-file it writes, sets `server_image` (or `pack_image`, with `--pack-dir`): a later `terraform apply` without that `--var-file` would put the old image back. Before it asks for `yes` it checks the plan itself (`terraform show -json`): it stops if the plan creates, deletes or replaces anything, or changes anything but the new image and the in-place changes the releases crossed name in their steps to confirm by hand. So a var file left off the command, whose variables the plan would empty, stops it there, before anything is applied. To see all of that before it happens, add `--dry-run`: it runs the same reads and read-only checks, lists every change a real run would make, in order, with the names it would use, and shows Terraform's plan for the new image. The plan takes no state lock, but reading the variables through `terraform console` briefly does, so a dry run stops, without harm, while an apply holds it. It changes nothing (not your docker config, the var-file, the state or the subscription) and never asks for `yes`. Only a real run runs the runtime's own checks, since they run as jobs in your subscription, and with `--pack-dir` the dry run's plan shows `pack_image` unchanged, since the new pack's digest exists only after the build. Use the `upgrade.sh` as of the `@kindgi/sdk@<version>` tag of the release you're upgrading to: it knows the steps up to its own release and refuses a later `--to`. With an earlier `--to` it still plans its own module, whose changes past the target's release it lists and allows, and it says so. It first came with the `@kindgi/sdk@0.3.0` tag: to keep the module at an earlier release, upgrade by hand. A server-only release, such as 0.2.0.1, is a server fix for 0.2.0 with no SDK release of its own, so it has no `@kindgi/sdk@` tag of its own. From 0.2.0, or an earlier 0.2.0.N, it has no steps to confirm by hand. See `./upgrade.sh --help`. The notes below apply whichever way you upgrade.
- **The way back it prints** restores the database server to the restore point, into a new server, and never points the old runtime at the migrated one. In order: export the erasure ledger from the server serving now; stop the server's container app (az has no command for it, so through Container Apps' REST API, with `az rest`, and go on once its `runningStatus` is `Stopped`), since a new version of a secret restarts the active revisions that read it; restore the server to the restore point, in the module's database subnet and private DNS zone; allow pgvector on it (`azure.extensions`), give it a new admin password and add a new version of `database-url` that names it, tagged `kindgi-restored-server` with its name; copy the var-file back, set `database_url_version` to that new version, so the server reads the restored server's URL and not whatever Key Vault's refresh has picked up, and apply a saved plan (`back.tfplan`) that changes the images and that reference only; check that the only active revision is the new one, with the old image, then start the app and check that revision serves; then replay the erasures and run the old image's `check stored-secrets`. It prints each command with your names filled in, but for that last check, which it describes: run it by hand, as a job like the upgrade checks, with the server's secrets settings as well as the database URL. It runs none of them. The restored server isn't in Terraform's state, and the module's own server is still the migrated one, so `upgrade.sh` refuses to start while `database_url_version` is set, or while the version of `database-url` the way back added (by its tag) is the newest.
- **By hand**, for any deployment: staging first, with `az` set to the deployment's subscription (`az account set --subscription <subscription_id>`). Copy the new image by digest into the module's registry (step 2), run the new version's checks as a Container Apps job in the module's environment, as the server's identity, with `KINDGI_DATABASE_URL` from the `database-url` secret, check that the database server keeps at least 7 days of backups and note the UTC time just before you apply (your restore point), set `server_image` (and `pack_image`), `(umask 077 && terraform plan -var-file=<env>.tfvars -out=upgrade.tfplan)` (the plan holds your variables' values, secret ones too), read it, `terraform apply upgrade.tfplan`, delete the plan, and check the new revision serves. To go back, take the steps above.

## Operating it

- **Signed exports** (approval audit bundles, run provenance, compliance evidence) are off by default (`export_signing = "none"`). `"kms"`: the module makes an EC P-256 key in the vault (`<name_prefix>-exports`) and the server signs with it there, with Key Vault Crypto User on that key alone; exports are `ecdsa-p256-sha256`, since Key Vault has no Ed25519. `"secret"`: a key you put in the vault as `export-signing-key` (step 3).
- **Client addresses:** the server trusts one proxy, the Container Apps ingress, which appends the caller to `X-Forwarded-For` (`trusted_proxies = "1"`, `KINDGI_TRUSTED_PROXIES`), so rate limits and audit records see the caller. With Front Door or Application Gateway in front, set `"2"`.
- **One server replica** until several are verified. Migrations run at boot over a direct connection (port 5432, not the built-in PgBouncer on 6432).
- **Upgrades:** no script. Copy the new image by digest (step 2), check the database's point-in-time restore, set `server_image`, plan to a file under `umask 077`, read the plan, apply it, and check the new revision: https://docs.kindgi.com/deploy/self-hosted/azure-container-apps/#upgrade has each command. Migrations only go forward: the way back (same page) restores the database into a new server, points `database-url` at it, and applies the old image.
- **Rotating a secret:** add a version (`put` again). Every secret but the two pinned keys is referenced without a version, so a replica that starts after Container Apps picks up the new version gets it ([Microsoft: Key Vault secret URI and secret rotation](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation)). Never rotate the AAD key or the erasure ledger's key this way.
- **Rotating the key:** with `key_rotation_days` (default 90) Key Vault adds a key version on schedule. New secrets use it; old ones keep unwrapping with theirs.
- **Hardening:** the vault and registry are reached over their public endpoints, guarded by Entra RBAC. To close those, add private endpoints (the registry needs the Premium tier) and network rules.

## Renewing the license key

The license key expires, and the server warns from 30 days before (the startup banner, the console and `kindgi doctor`, each with the exact command). The server never calls Kindgi; renewing is something you run, here or from your own scheduler.

**Once, to enroll the deployment:** where you're signed in to Azure with access to the vault (`key_vault_admins`):

```sh
$(terraform output -raw license_enroll_command)   # fill in --for first
```

- It makes the renewer key, writes it to the vault as `license-renewer` (`license_renewer_secret`), never prints it, and prints one line to add on access.kindgi.com (for a key Kindgi issued, send it to Kindgi instead).
- **By hand, or from CI or cron:** `$(terraform output -raw license_renew_command)`. It asks access.kindgi.com for this deployment's key and checks the answer offline. It adds a version of `license-key` only when the key changed.
- **Or let the module run it:** set `license_renewal_schedule` (a cron in UTC, such as `"17 6 * * *"`) and apply. Enroll first: the services apply grants the job its roles on `license-renewer`, which exists once you've enrolled.
  - The job is a Container Apps job on the runtime image, running the same `kindgi license renew` on that schedule. The runtime image carries the `kindgi` CLI from 0.1.7.
  - It has an identity of its own, `<name_prefix>-license-renewer`. That identity reads `license-key` and `license-renewer`, and holds a custom role, `<name_prefix>-license-key-writer-…`, that can only set `license-key`, never delete it or read other secrets.
  - The server gets no access to the renewer key.
  - Its runs: `az containerapp job execution list -n <name_prefix>-license-renew -g <rg> -o table`.
  - **Two alerts come with it:** a failed run, and a key within 7 days of expiring (the run's own line, `⚠ It expires in N days`). With `license_usage_key_secret` (below), a third: a run that sent no counts (its line `counts: not sent (<why>)`). A production key's renewals never carry counts, so they never raise it. They go to the action groups in `alert_action_groups`; with none, they fire in Azure Monitor only.
- **Counts of the deployment's use,** for a non-production key (the docs' Renew the license key page says what they are, under "What renewing sends"): mint a system key holding `system:license` alone with the deployment's own token, put it in the vault, then set `license_usage_key_secret` to its secret's name and apply. The job then reads that secret too, and renews with `--runtime` (the server) and `--runtime-token` (that secret), as `license_renew_command` does. Terraform never holds the key, and the server gets no access to it.

  ```sh
  # Off in this shell: az's log file, if it's on, records each request's body.
  export AZURE_LOGGING_ENABLE_LOG_FILE=no
  V=$(terraform output -raw key_vault_name)
  put() { az keyvault secret set --vault-name "$V" -n "$1" --file /dev/stdin --query id -o tsv; }

  # The deployment's own token, read from the vault into this shell only.
  KINDGI_API_TOKEN=$(az keyvault secret show --vault-name "$V" -n api-token --query value -o tsv)
  KEY=$(curl -sS -X POST "$(terraform output -raw server_url)/v1/system/keys" \
    -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(uuidgen)" \
    -d '{"scopes": ["system:license"], "label": "license renewal"}' \
    | jq -r '.token // error(.error.message)') && [ -n "$KEY" ] \
    && printf '%s' "$KEY" | put license-usage-key
  unset KEY KINDGI_API_TOKEN
  ```

  Then `license_usage_key_secret = "license-usage-key"`. The key is never printed, and the token reaches `curl` as a header file, never in the list of processes. A refused mint prints its error instead, and nothing goes in the vault. To list the keys or revoke one, see "A key for the counts" on that page. A server serving one tenant that refuses the mint with `system-principal-required` is older than runtime 0.1.10, which has these keys: until you upgrade it, the job renews without counts.

  **Check the first run.** A renewal that can't send its counts still renews, with `counts: not sent (<why>)` in its log. The alert `<name_prefix>-license-counts-not-sent` raises it within a day. To know now, start a run after the apply, wait for it to finish, and read its counts line. The log reaches Log Analytics a few minutes after the run ends, so an empty answer right after it means ask again a little later:

  ```sh
  az containerapp job start -n <name_prefix>-license-renew -g <rg>
  az containerapp job execution list -n <name_prefix>-license-renew -g <rg> -o table   # until it shows Succeeded
  WS=$(az monitor log-analytics workspace list -g <rg> --query "[0].customerId" -o tsv)
  az monitor log-analytics query -w "$WS" --analytics-query \
    "ContainerAppConsoleLogs_CL | where column_ifexists('ContainerJobName_s', '') == '<name_prefix>-license-renew' | where Log_s has 'counts:' | order by TimeGenerated desc | take 5"
  ```

  `counts: sent (…)` is what you want. With `server_ip_allowlist` set, this check matters most: the job calls the server's URL, and the module doesn't check whether the list lets it in.
- **When a new key is used:** the server reads `license-key` without a version, so it gets the new key as for any rotated secret (see "Rotating a secret" above, and [Microsoft: Key Vault secret URI and secret rotation](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#key-vault-secret-uri-and-secret-rotation)). Until then it runs on the key it started with. A running server never stops over its key.
- **Stopping:** unset `license_renewal_schedule`, or stop the renewer on access.kindgi.com.

## Taking it down

```sh
terraform destroy -var-file=dev.tfvars
```

- With `key_vault_purge_protection = true` (the default), the deleted vault and its keys stay recoverable for `key_vault_soft_delete_retention_days`, and the vault's name stays taken until then. A sandbox can set purge protection off with `key_vault_purge_on_destroy = true`.
- The platform-managed infrastructure resource group goes with the environment: check it's gone (`az group exists -n <rg>-<name_prefix>-infra`).
