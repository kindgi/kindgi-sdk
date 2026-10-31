# Kindgi on Google Cloud Run (Terraform)

A Terraform root module that runs Kindgi in one GCP project:
- the runtime (the API, agent and flow execution) as a Cloud Run service;
- the pack orchestrator, a Cloud Run Job from the runtime's image that Cloud Scheduler runs once a minute. It gives each pack deployment an IAM-protected Cloud Run service of its own ("5. The pack orchestrator");
- Kindgi's own Cloud SQL (Postgres 16) instance (unless `database_host_instance` points at an existing one);
- everything they stand on: service accounts, an Artifact Registry repository, a KMS key for the runtime's secrets and each pack service's token, and Secret Manager containers.

**Three network shapes** (`network_mode`):

| | `direct` (default) | `connector` | `none` |
|---|---|---|---|
| For | a project of its own | a project that already has a VPC | a small dev deployment (below) |
| Network | a new VPC and subnet, Direct VPC egress (all traffic), Cloud NAT | an existing Serverless VPC Access connector, private-ranges-only egress; nothing created | no VPC at all; nothing created |
| Each pack service | internal ingress, plus IAM | all ingress, plus IAM (a server without VPC egress can't reach an internal service); the connector for private ranges | all ingress, plus IAM |
| Database | public IP (`/cloudsql`) or private IP | public IP (`/cloudsql`) or private IP | public IP (`/cloudsql`) only |
| Example values | `example.tfvars` | `example-connector.tfvars` | `example-dev.tfvars` |

In every shape a pack service admits only accounts that may invoke the project's Cloud Run services, the runtime's among them, and then checks a token of its own. The runtime sends a Google ID token with each call, so a public URL on a pack service is still closed to everyone else. Because the orchestrator makes and deletes those services, the runtime's account has `roles/run.invoker` on the whole project: run one installation of this module per project.

The `direct` shape was deployed end to end on 2026-10-04, with runtime 0.1.1 and the module's earlier single pack service:
- the runtime reached the internal pack service with its ID token;
- `kindgi deploy` read the pack image from Artifact Registry with the runtime's own token;
- flows ran through the pack: tool-call hop p50 42 ms, p95 100 ms.

The `connector` shape is the same resources wired to an existing connector.

### A small dev deployment

For a dev environment next to an app, with no project of its own: `network_mode = "none"` (no VPC), and Kindgi's database on the app's existing Cloud SQL instance (`database_host_instance`). `example-dev.tfvars` is a starting point. Not for production.

- **No VPC.** The server and the pack services reach the internet through Cloud Run's own egress; each pack service takes all ingress, closed by IAM (`pack_ingress = "INGRESS_TRAFFIC_ALL"`). There is no static egress IP, and the pack's tools reach only public addresses and the instances in `pack_cloud_sql_instances` — not a private-IP database.
- **A shared database instance.** With `database_host_instance` set, the module makes no instance of its own: it creates Kindgi's `database_name` database on the named instance, and the operator creates Kindgi's user on that instance (step 3, run against the host). The instance must have a public IP and run **Postgres 16 or later** — before 16 a `CREATEROLE` user, which Kindgi's needs, could take any other role, so the two databases wouldn't be walled off. Run **one Kindgi deployment per host instance** (Kindgi's role and `PUBLIC` connect are instance-wide). The server's account gets `roles/cloudsql.client` on the app's instance, scoped to it by an IAM condition. The app's instance admins can reset Kindgi's database password; only secrets you store through Kindgi's API stay sealed under its key. Backups, point-in-time recovery and deletion protection are the app instance's, not Kindgi's, and the module refuses its backup variables with a host; `database_deletion_protection` instead keeps Kindgi's database object from a Terraform-side drop (`ABANDON`). Choose a host or the module's own instance **at the first apply** — moving later is a dump and restore.
- **Pack services at zero.** A deployment's pack service scales to zero when idle, and the first tool call after that waits for an instance to start. A pinned version's service stays warm instead: one instance, with CPU only during calls ("The pack services"). The server allows `pack_call_timeout_ms` for a single tool call (default 120 s, `KINDGI_PACK_CALL_TIMEOUT_MS`); raise it if cold starts run near that. The server, unlike the packs, keeps one instance on (`server_min_instances` stays at its default of 1): a run started without waiting, an Improve pass or a test run keeps going after its response returns and needs an instance — and the CPU on it — to finish.

## Before you start

- Terraform ≥ 1.6, `gcloud`, Docker, `openssl`, `curl`, `jq`, and your pack's `kindgi` CLI (0.1.2 or later, for `kindgi key trust`).
- **Permission to create the resources:** an Owner, or Editor plus Security Admin and Secret Manager Admin.
- **A region with Cloud Scheduler:** the orchestrator's schedule is made in `region` ([Cloud Scheduler locations](https://cloud.google.com/scheduler/docs/locations)).
- **Pull access to the runtime image** `registry.kindgi.com/kindgi/runtime`, with your license key as the password: `docker login registry.kindgi.com --username kindgi` asks for the key.
- **A license key** from Kindgi (`KINDGI_LICENSE_KEY`; a non-production key for a pilot).
- **A TypeScript pack** with an `environments.<env>` block in `kindgi.config.ts` (`registry`, `signingKey`, `signerKeyId`, `tenantId`).
- **Check your org policies first**, since they change the recipe:
  - `iam.allowedPolicyMemberDomains` forbids `allUsers`: use `server_invoker_iam_disabled = true` instead of `server_public`;
  - `sql.restrictPublicIp` forbids the instance's (closed) public IP: use `database_private_network`.

  `gcloud resource-manager org-policies describe <constraint> --project=<p> --effective`

## 1. State, and the foundation (no services yet)

```sh
gcloud storage buckets create gs://<state bucket> --location=<region> --uniform-bucket-level-access
gcloud storage buckets update gs://<state bucket> --versioning
cp example.tfvars dev.tfvars      # or example-connector.tfvars / example-dev.tfvars; fill in
terraform init -backend-config=bucket=<state bucket> -backend-config=prefix=<this deployment>
```

Give each deployment its own state prefix. Never share a root module or a prefix with your app's own infrastructure. Staging and production are two deployments, each in its own copy of this folder, with its own prefix, var-file and pack env ([Staging and production](https://docs.kindgi.com/deploy/self-hosted/cloud-run/#staging-and-production)).

The services need images and secret values that don't exist yet, so the first apply leaves them out:

```sh
terraform apply -var-file=dev.tfvars \
  -target=google_project_service.apis \
  -target=google_compute_router_nat.nat \
  -target=google_artifact_registry_repository_iam_member.server_reads_images \
  -target=google_kms_crypto_key_iam_member.server_wraps \
  -target=google_sql_database.kindgi \
  -target=google_secret_manager_secret_iam_member.server_reads \
  -target=google_project_iam_member.server_sql_client
```

- `server_image` only needs a digest-shaped placeholder here.
- The Cloud SQL instance takes about 6 minutes.
- `database_edition` defaults to `ENTERPRISE`: Postgres 16 instances otherwise default to `ENTERPRISE_PLUS`, which takes only `db-perf-optimized-N-*` tiers.

## 2. Images into Artifact Registry

Cloud Run pulls from Artifact Registry. Copy the runtime's **whole multi-platform index** by digest. A `docker pull` / `push` from an arm64 machine would copy only arm64, and Cloud Run needs amd64. The copy goes through the machine you run it on and takes both platforms, so on a slow uplink it can take most of an hour.

**An existing repository instead of the module's own (`image_repository`).**
- **Setting it:** `image_repository = { project, location, repository }` uses a repository you already have. The module then creates none.
- **What it grants:** the server's service account gets `roles/artifactregistry.reader` on it, to read deployed pack images. A repository in another project also grants this project's Cloud Run service agent the same role, so it can pull the images.
- **Check its cleanup policies first.** A policy that deletes tags or images by age can delete the digest a running revision pins, and the next instance start then fails. Keep Kindgi's images out of such a policy, or use the module's own repository.
- **Where images go:** `terraform output image_repository` names where they go, in either case.

```sh
REPO=$(terraform output -raw image_repository)
gcloud auth configure-docker <region>-docker.pkg.dev
docker buildx imagetools create --tag $REPO/runtime:<version> registry.kindgi.com/kindgi/runtime:<version>@sha256:<release digest>
kindgi build --local --push --env dev      # the pack image, signed; writes .kindgi/build/deploy-envelope.json
```

The mirrored runtime keeps the release's digest. Set `server_image` to it (`…@sha256:…`). The orchestrator runs from the same image.

The pack image needs no variable: `kindgi deploy` (step 6) registers the image `kindgi build` pushed, and the orchestrator runs that deployment's service from it.

## 3. Secret values

Each value is piped straight into Secret Manager. None goes on disk, into Terraform's state or into a command's arguments, which other processes can read and gcloud writes to its log file. `N` is your `name_prefix`. The commands are for bash or zsh.

With `database_host_instance` set there is no `$N` instance of the module's own: in the `instances/…/users` path below, use the host instance's name in place of `$N` (the `$N-…` secret names stay as they are).

```sh
CONN=$(terraform output -raw sql_connection_name)
P=$(gcloud config get-value project)

# Kindgi's database user: a built-in user (it gets CREATEROLE; not an IAM user).
# Made through the Cloud SQL Admin API rather than `gcloud sql users create --password`:
# the body goes in on stdin and the token in a header from a pipe.
# Each step runs only if the one before it worked, so the secret never holds
# a password the user wasn't given.
DBPW=$(openssl rand -hex 24)
OP=$(printf '{"name":"kindgi","password":"%s"}' "$DBPW" \
  | curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)") \
      -H 'Content-Type: application/json' --data-binary @- \
      "https://sqladmin.googleapis.com/v1/projects/$P/instances/$N/users" \
  | jq -r '.name // error(.error.message)') && [ -n "$OP" ] \
  && gcloud sql operations wait "$OP" --project=$P \
  && printf 'postgres://kindgi:%s@/kindgi?host=/cloudsql/%s' "$DBPW" "$CONN" \
  | gcloud secrets versions add $N-database-url --data-file=-
unset DBPW

# The bearer the server seeds (the first admin token).
printf 'kgi_bt_%s' "$(openssl rand -hex 32)" | gcloud secrets versions add $N-api-token --data-file=-

# The key for secrets stored in Postgres: 32 bytes, base64, the same on every replica.
# Its first version is the one `secrets_aad_key_version` pins ("1").
# Not with secrets_backend = "none": there is no such secret then.
openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-

# The key that signs public run tokens: Ed25519, PKCS#8 PEM, base64.
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-public-token-key --data-file=-

# Only with export_signing = "secret": the key that signs exports (audit bundles, provenance, evidence).
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-export-signing-key --data-file=-

# The license key: paste it; it never goes in a file.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | gcloud secrets versions add $N-license-key --data-file=- && unset LICENSE_KEY
```

With `database_private_network` set, the URL is `postgres://kindgi:<password>@<private ip>:5432/kindgi?sslmode=require` (`terraform output database_private_ip`). `sslmode=require` encrypts the connection and checks no certificate, and the private IP isn't in the instance's certificate. So the module also sets `KINDGI_DATABASE_SERVER_CA` to the instance's server CAs, and the server (runtime 0.2.0 on; an earlier one ignores it) checks that the database's certificate chains to one of them and is in date. It doesn't check the name: the instance's default per-instance CA signs that one instance's certificate alone, and "Verifying the CA verifies the server identity since each instance has a unique CA" ([Google: SSL/TLS certificates](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl)). Through `/cloudsql` (no `database_private_network`), the Cloud SQL connector encrypts the connection and checks the instance itself. An OpenFGA of yours that reaches the instance by its private IP opens a connection of its own, which these settings don't reach: give it the same CAs as a file, with `sslmode=verify-ca&sslrootcert=<file>` in its datastore URI (`gcloud sql ssl server-ca-certs list --instance=$N --format="value(cert)" > database-ca.pem` writes the file).

**Your pack's own secrets** aren't Terraform's: each deployment's pack service gets its env from the runtime. A secret of yours in Secret Manager that a pack's env names as a cloud secret goes in `pack_secret_readers` ("The pack services").

**Without a secrets store (`secrets_backend = "none"`).** By default (`"postgres"`), secrets set through Kindgi's API are envelope-encrypted in its database under a Cloud KMS key this module creates. The key exists with `"none"` too: each pack service's token is sealed under it. With `"none"`:
- **Not created:** the `<prefix>-secrets-aad-key` secret. `secrets_aad_key_version` isn't needed.
- **The server stores no secrets of its own.** `/v1/secrets` isn't served (it answers 404 `route-not-found`), and nothing can be stored through Kindgi's API. A pack gets its plain env values and cloud secrets ("The pack services"), never a secret stored in Kindgi. The boot record has no KMS probe line for the store, only the pack endpoints' one.
- **No webhooks, in or out.** A webhook trigger's signing secret and an endpoint's secret are kept in the store, so their routes aren't served: `/v1/webhooks`, `/v1/hooks` and `/v1/webhook-endpoints` answer 404 `route-not-found`. No webhook starts a run, and none is sent.
- **Sign-in:** Continue with Google, Microsoft or GitHub and the emailed link work (step 7). A workspace's own identity provider needs `"postgres"`: its client secret and keys are references into the store, so adding or changing one answers 409 `identity-providers-need-secrets-store`.
- **Who it fits:** a deployment whose packs need plain env values and cloud secrets only, whose model uses the service's own identity, Gemini on Vertex AI (`vertex_ai = true`), and that takes and sends no webhooks. A provider that needs an API key stored in Kindgi doesn't fit it.
- **Changing an existing deployment from `"postgres"`:** the secrets stored under the key would become unreadable to the server. Move them out first. The key itself stays, since the pack services' tokens are sealed under it.

**Turning the store on later (`"none"` to `"postgres"`).** Nothing was stored, so nothing moves. The key is there already, and the pack services' tokens stay sealed under it. The server's next revision reads `<prefix>-secrets-aad-key`, so that secret comes first, before the services change:

1. Set `secrets_backend = "postgres"`. Leave `secrets_aad_key_version` unset until step 4.
2. Apply only what the store stands on: the new secret with the server's read access (the targets below also name the APIs and the server's grant on the key, which are there already).

   ```sh
   terraform apply -var-file=dev.tfvars \
     -target=google_project_service.apis \
     -target=google_kms_crypto_key_iam_member.server_wraps \
     -target=google_secret_manager_secret_iam_member.server_reads
   ```

   Terraform warns that resource targeting is in effect and the applied changes may be incomplete. Both are expected: step 4 completes them.

3. Add the secret's first version, as above:

   ```sh
   openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-
   ```

4. Set `secrets_aad_key_version = "1"`, and apply in full, as in "4. The services". The server's new revision stores secrets in Postgres, and its boot has the store's KMS probe record too. Webhooks, and a workspace's own identity providers, work from then on.

## 4. The services

```sh
terraform apply -var-file=dev.tfvars
```

The server's boot lines name what it reached. On Cloud Run the runtime logs JSON, so they're the `lines` of one record, `Kindgi runtime ready`:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND jsonPayload.message="Kindgi runtime ready"' \
  --limit=1 --format=json | jq -r '.[0].jsonPayload.lines[]'
```

```
Background work: tenant <seed tenant id>
Pack services: one per deployment, at the endpoints recorded through the system API (1 allowed host pattern), each endpoint's token sealed under KINDGI_PACK_ENDPOINT_KMS_KEY's key
```

The module sets the server to route each tool call to its deployment's own pack service (`KINDGI_PACK_ROUTING=per-deployment`), at a Cloud Run URL of this project and region (`KINDGI_PACK_ENDPOINT_HOSTS = "*-<project number>.<region>.run.app"`), with each service's token sealed under the module's key (`KINDGI_PACK_ENDPOINT_KMS_KEY`). `server_env` and `server_secret_env` can't set these. No deployment has a service until the pack orchestrator is on (step 5).

The KMS key's checks are records of their own, logged just before: one for the pack endpoints' tokens, and with `secrets_backend = "postgres"` one for the store:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND textPayload:"KMS probe"' \
  --limit=2 --format='value(textPayload)'
```

```
Pack endpoint KMS probe OK (gcp-cloud-kms): gcp-cloud-kms v1 (encrypt/decrypt round trip, key version 1) (…ms)
KMS probe OK (gcp-cloud-kms): gcp-cloud-kms v1 (encrypt/decrypt round trip, key version 1) (170ms)
```

The runtime's KMS key needs `roles/cloudkms.cryptoKeyEncrypterDecrypter`. A runtime before 0.1.3 also needs `roles/cloudkms.viewer`, because its boot probe reads the key; from 0.1.3 the probe is an encrypt/decrypt round trip. The module grants both.

## 5. The pack orchestrator

The pack orchestrator is `kindgi-runtime packs orchestrate`, run from the server's image as the Cloud Run Job `$N-pack-orchestrator`. Cloud Scheduler runs it once a minute. Each pass makes a service for each deployment that needs one, gives running ones their changed pack env, and retires what should go, through the server's system routes and as its own account (`$N-orch`). The server never makes or deletes a service.

It works with a system key of its own, which only a server that already routes per deployment can mint. So it takes two applies. The first (step 4) makes the orchestrator's account, its grants and the `$N-orchestrator-key` secret. The second, once the key is in that secret, makes the Job and its schedule. Until then `terraform output orchestrator_key_steps` prints these steps, with your names in them.

1. Mint the key with the deployment's own token, and keep it as the first version of `$N-orchestrator-key`:

   ```sh
   URL=$(terraform output -raw server_url)
   curl -sS -X POST "$URL/v1/system/keys" \
     -H @<(printf 'Authorization: Bearer %s\n' "$(gcloud secrets versions access latest --secret=$N-api-token)") \
     -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"scopes": ["system:deployments", "system:pack-env"], "label": "pack orchestrator"}' \
     | jq -j '.token // error(.error.message)' \
     | gcloud secrets versions add $N-orchestrator-key --data-file=-
   ```

   Behind Cloud Run IAM (neither `server_public` nor `server_invoker_iam_disabled`), your gcloud account needs `roles/run.invoker` on the server, and the call needs its ID token as well. Add this line after the `curl` line:

   ```sh
     -H @<(printf 'X-Serverless-Authorization: Bearer %s\n' "$(gcloud auth print-identity-token)") \
   ```

2. Set `orchestrator_key_version` to the version it printed (`"1"` the first time), and apply again. That makes the Job and its schedule, and `orchestrator_key_steps` is null from then on. Pin it, never `"latest"`: a version added by mistake must not reach the Job.

   ```sh
   terraform apply -var-file=dev.tfvars
   ```

3. Deploy each pack (step 6). After an upgrade from the module's single pack service, deploy each one again: `kindgi deploy` with the same image is enough, with `--idempotency-key <new value>` so it isn't answered as the earlier deploy was. Until then, a deployment from before the server routed per deployment has no routes, and its tool calls answer `pack-route-missing`.

A new deployment waits up to about a minute for its service, until the next pass. Until then its tool calls answer `pack-endpoint-pending`.

**The Job:** 1 vCPU and 1 GiB, and a 600 s timeout as a backstop. Cloud Scheduler starts it at `* * * * *` (UTC), with an OAuth token of the orchestrator's account. Neither retries: next minute's run is the retry, and a pass that starts while another runs exits doing nothing. The Job reads the key's pinned version.

**What the orchestrator's account may do:**
- **Cloud Run:** `roles/run.developer` on the project. It creates, updates and deletes the project's services and runs its Jobs, Cloud Scheduler's call included. It reads a service's IAM policy and never sets one.
- **The pack account:** `roles/iam.serviceAccountUser` on it, so each pack service runs as `$N-pack`, and as no other account.
- **The pack services' own secrets:** each service's token and secret env values are `kp-` secrets of its own. A custom role, `<prefix>_pack_secrets` (`name_prefix` with `-` as `_`), lets it create, get and delete those secrets and add, list and destroy their versions, on secrets whose name starts with `kp-` only. It never reads a value: values come from the runtime.
- **Finding what a stopped pass left:** a second custom role, `<prefix>_secret_list`, lists the project's secrets, names and labels only. A list is asked of the project, not of one secret, so it has no condition.
- **Its key:** read access to `$N-orchestrator-key`.
- **The server:** behind Cloud Run IAM, `roles/run.invoker` on it, and the Job sends a Google ID token with each call (`KINDGI_ORCHESTRATOR_RUNTIME_AUTH=google-id-token`).

## 6. Register the pack

Trust the pack's signing key on the runtime, then deploy. With `tenancy = "multi"`, `<api token>` here and after is a key of the tenant, not the API token ("Many tenants").

```sh
URL=$(terraform output -raw server_url)
kindgi key trust <key id> --label dev --url "$URL" --token <api token>
kindgi deploy --env dev --endpoint "$URL" --token <api token>
```

`kindgi deploy` answers `201 Created` and lists what it registered. The runtime reads the image from Artifact Registry with its own identity (`KINDGI_IMAGE_REGISTRY_AUTH=google`).

The deployment's tools answer once the orchestrator has made its pack service, at its next pass, within about a minute. Until then a tool call answers `pack-endpoint-pending`. `kindgi deployments get <deployment-id>` shows whether its service is ready, and the command that sets a name it's missing (`kindgi deployments list --table` lists the ids).

A deploy that was refused (say, before the key was trusted) runs again when you retry it as is, after fixing the cause: a refusal isn't kept for its `Idempotency-Key`. A deploy that went through is: the default key is the request body's hash, so the same image deployed again answers the same deployment, unless you give `--idempotency-key <new value>`.

Then `kindgi health`, `kindgi tools list` and a run, with `--url "$URL" --token <api token>`.

## 7. Turn on sign-in

**Nobody can sign in to the console until you turn sign-in on.** The API takes API tokens either way. Since runtime 0.1.5, console sign-in is off by default outside `kindgi dev`, and the server's boot lines say so: `⚠ Console sign-in: nobody can sign in to the console. …`

The server's own settings go in two variables:
- `server_env`: plain values;
- `server_secret_env`: Secret Manager references, read with the server's identity. You create each secret, and the server gets read access to exactly those (a secret in another project is granted there).

The plan refuses a name the module sets itself (its own variables cover those, such as `public_url` below), `KINDGI_DEV`, and a secret given as a plain value.

**With the API token,** which the console's sign-in page takes:

```hcl
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}
```

**With an emailed link.** It needs the server's sign-in secret, an SMTP server and `public_url`:

```sh
# The sign-in secret: 32 bytes, base64.
openssl rand 32 | base64 | gcloud secrets create $N-auth-secret --data-file=-
# The SMTP URL, password included: paste it; it never goes in a file.
read -rs SMTP_URL && printf '%s' "$SMTP_URL" | gcloud secrets create $N-smtp-url --data-file=- && unset SMTP_URL
```

```hcl
public_url = "https://kindgi-dev-server-abc123-pd.a.run.app" # terraform output -raw server_url
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
  KINDGI_AUTH_EMAIL_FROM       = "kindgi@acme.example"
}
server_secret_env = {
  KINDGI_AUTH_SECRET         = { secret = "kindgi-dev-auth-secret", version = "1" }
  KINDGI_AUTH_EMAIL_SMTP_URL = { secret = "kindgi-dev-smtp-url", version = "1" }
}
```

Pin each secret to a version, as above, rather than `latest`: a new version then reaches the server only when you change `version` here.

- **`public_url`** (`KINDGI_PUBLIC_URL`) is the URL people open the console at. On a new deployment that's `terraform output -raw server_url` after the first apply, so the emailed link comes with a second apply. With your own domain in front, it's that domain.
  - Console sessions are then accepted from that origin only, so open the console there.
  - The plan refuses `KINDGI_AUTH_SECRET` without it, because the server wouldn't start.

**With Continue with Google.** It needs the sign-in secret and `public_url`, as for the emailed link, and an OAuth client of type **Web application** in the Google Cloud console. Its authorized redirect URI is `public_url` followed by `/auth/kindgi/social/callback/google`:

```
https://kindgi-dev-server-abc123-pd.a.run.app/auth/kindgi/social/callback/google
```

```sh
# The Google client's secret: paste it; it never goes in a file.
read -rs GOOGLE_SECRET && printf '%s' "$GOOGLE_SECRET" | gcloud secrets create $N-google-client-secret --data-file=- && unset GOOGLE_SECRET
```

```hcl
public_url = "https://kindgi-dev-server-abc123-pd.a.run.app"
server_env = {
  KINDGI_AUTH_GOOGLE_CLIENT_ID = "<client id>" # ends in .apps.googleusercontent.com
}
server_secret_env = {
  KINDGI_AUTH_SECRET               = { secret = "kindgi-dev-auth-secret", version = "1" }
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET = { secret = "kindgi-dev-google-client-secret", version = "1" }
}
```

- **Microsoft and GitHub, verified domains, and Turnstile** go the same way:
  - in `server_env`: `KINDGI_AUTH_MICROSOFT_CLIENT_ID` or `KINDGI_AUTH_GITHUB_CLIENT_ID`, `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant id>`) and the Turnstile site key;
  - in `server_secret_env`: `KINDGI_AUTH_MICROSOFT_CLIENT_SECRET` or `KINDGI_AUTH_GITHUB_CLIENT_SECRET`, and `KINDGI_AUTH_TURNSTILE_SECRET`;
  - each provider's redirect URI ends in its name: `…/auth/kindgi/social/callback/microsoft` or `…/github`.
- Several ways in share the two maps: with the emailed link too, they hold both sets of settings.
- The `…_PATH` forms read a file, which this module doesn't mount, so use the value forms.

## The pack services

The orchestrator makes each deployment's service, named `kp-…`, with the `pack_*` settings. Every one runs as the one pack account, `$N-pack`, so whatever one pack may read, each may.

- **Size:** 1 vCPU and 1 GiB, with a startup CPU boost.
- **Scaling:** up to `pack_max_instances` instances (8 by default), each running `pack_concurrency` calls at once (32 by default), both whole numbers from 1 to 1000. A pinned version's service stays warm: one instance, with CPU only during calls. Every other one scales to zero.
- **Timeout:** `pack_timeout`, whole seconds up to `"3600s"` (`"300s"` by default). Keep it above the server's `pack_call_timeout_ms`.
- **Network:** internal ingress in `direct`; all ingress in `connector` and `none`, with IAM as the guard. In `connector` mode each service uses the connector for private ranges.
- **Databases:** the Cloud SQL instances in `pack_cloud_sql_instances`, at most 10, mounted at `/cloudsql`. The pack account gets `roles/cloudsql.client`.
- **Buckets:** `pack_bucket_readers`, read with `roles/storage.objectViewer`, and `pack_bucket_object_prefixes` to narrow a bucket to some prefixes.

**The pack's env.** Terraform doesn't hold it. Each deployment's pack service gets its env from the runtime: the names its pack declares, with the values set through Kindgi, plain ones with `kindgi env set` ([Declare the environment your code reads](https://docs.kindgi.com/guides/secrets/pack-env/#in-a-deployment)). When a value changes, the orchestrator's next pass gives the running service its new env, with no deploy. A required name with no value keeps the service from serving, and `kindgi deployments get <deployment-id>` names it. With `secrets_backend = "none"` a pack gets no secret stored in Kindgi: its plain values, and cloud secrets (below).

**A secret of yours in Secret Manager (`pack_secret_readers`).** A pack's env can name one as a cloud secret, pinned to a version: `kindgi env set <NAME> --cloud-secret projects/<project>/secrets/<secret>/versions/<n> --tenant=<id> --scope=<kind>[:id] --env=<name>`, with a system key. List each such secret in `pack_secret_readers`, as `{ secret, project }`: the secret's id, not its path, with `project` left out for this project. The pack account gets `roles/secretmanager.secretAccessor` on each secret alone, in the secret's own project, so whoever applies must be able to grant there. Every pack service runs as that one account, so each pack can read every secret listed. The plan refuses a path, a `kp-` id and a secret named twice.

**Recording each read.** Secret Manager logs a read of a secret's value only with its Data Access audit logs on. To record each read of a pack's secrets, turn on `DATA_READ` for Secret Manager in the project, and in each project `pack_secret_readers` names ([Cloud Audit Logs: Data Access](https://cloud.google.com/logging/docs/audit/configure-data-access)).

**A Cloud Run service the pack's code calls (`pack_run_invokers`).** When a tool calls one of your app's IAM-protected Cloud Run services, list it as `{ project, location, service }`, with the service's name, not its URL. The pack account gets `roles/run.invoker` on it. The grant is added beside the service's other members, and nothing else of the service changes.
- **The token:** the pack's code fetches a Google ID token for the service's URL from the metadata server and sends it as `Authorization: Bearer`. In Node that's google-auth-library's `getIdTokenClient(url)`; in Python, `google.oauth2.id_token.fetch_id_token`.
- **The ingress:** the call leaves through the pack service's own egress. In `direct` and `none` that's Cloud Run's internet egress; in `connector`, the connector carries private ranges only. A service with ingress `all` takes the call, with IAM as the guard. A service with internal ingress refuses it, with a 404 (Google's "Page not found" page, not a 403): Cloud Run counts a call from another service as internal only when the caller sends all its traffic through a VPC, and a pack service doesn't in any shape.

**Cost.** A warm pack service bills at Cloud Run's idle rate between calls. At the defaults (1 vCPU, 1 GiB, one instance) that's about $13 a month in a Tier 1 region ([Cloud Run pricing](https://cloud.google.com/run/pricing)). A service at zero bills only while it runs. The Job is billed per second of each pass.

**How many.** Cloud Run allows 1,000 services per region in a project ([Cloud Run quotas](https://cloud.google.com/run/quotas)), so unregister old versions you don't need.

## Many tenants (`tenancy`)

By default (`tenancy = "single"`) the server serves one tenant, `seed_tenant_id`'s. With `"multi"`, on runtime 0.1.8 or later, it serves every tenant created through `POST /v1/system/tenants`, and takes each request's tenant from its key or session. Either way each deployment is a Cloud Run service of its own, which the pack orchestrator makes ("5. The pack orchestrator").

```hcl
tenancy         = "multi"
openfga_api_url = "https://openfga-…a.run.app"
# no seed_tenant_id or seed_user_id
server_env = {
  KINDGI_TENANT_HOST_ACCESS = "isolated"
}
server_secret_env = {
  KINDGI_OPENFGA_PRESHARED_KEY = { secret = "<a key OpenFGA accepts>", version = "1" }
}
```

- **What the plan needs, and names when it's missing:** `openfga_api_url` (without an authorization store no tenant would have an admin), `KINDGI_OPENFGA_PRESHARED_KEY` in `server_secret_env`, and `KINDGI_TENANT_HOST_ACCESS = "isolated"` in `server_env`. The server won't start without them.
- **What the plan refuses:** `seed_tenant_id` and `seed_user_id`.
- **What the module sets:** `KINDGI_TENANCY=multi`, and neither `KINDGI_TENANT_ID` nor `KINDGI_SEED_USER_ID`. `pack_call_timeout_ms` still caps each call.
- **The API token** (`$N-api-token`) is the operator's: it reaches only `/v1/system/*`, in no tenant. So step 6 and everything after it use a tenant's key instead:
  - **A tenant:** `POST /v1/system/tenants` with the API token. Without `firstAdmin`, the answer carries the first admin's key, sent once.
  - **Its image repository:** the create's `imagePrefix`, or `PUT /v1/system/tenants/{tenantId}/image-prefix`, before its first deploy. Without it, a deploy is refused with `409 image-prefix-unset`.
  - **Its tools answer once the orchestrator has made the deployment's service** (step 6). Until then, a run that calls one fails with `pack-endpoint-pending`: "The pack service of the deployment shipping … isn't ready yet."
- **An existing deployment** keeps its tenant, with its data, keys and people, as the first of many at the first `"multi"` boot. Before the switch:
  - **OpenFGA first:** if it has no `openfga_api_url` yet, add it (and the key) in a single-tenant apply. That boot makes the tenant's authorization store, with the seed user as its admin. Switching in the same apply leaves the tenant without one, and none can be made afterwards without naming its first admin.
  - **A key of the tenant** for anything that deploys or calls with `$N-api-token`: after the switch, that token no longer reaches the tenant.
  - Then, in one apply: `tenancy = "multi"`, without `seed_tenant_id` and `seed_user_id`, with the settings above.
- **After an upgrade that adds a step per tenant,** `kindgi-runtime tenants repair --all` has to run once: a server serving many tenants sets nothing up per tenant at boot. This module runs no such job. It also takes away access a tenant's record doesn't back (runtime 0.3.0 or later): it finishes a removal that stopped part way, and revokes a service account's admin, membership or project role that its grants don't give. And it takes away the access an older runtime gave `00000000-0000-0000-0000-000000000000`, the id it named as the creator of what a key with no person behind it made; no person has that id. `--dry-run` shows what it would put back and take away, per tenant, and changes nothing.
- **An earlier runtime** ignores `KINDGI_TENANCY`. With no tenant id it would seed a new tenant at every start, so upgrade the runtime first.
- **`"single"`** sets no `KINDGI_TENANCY`. Its deployments get pack services of their own too.

## Testing the module

`terraform init -backend=false && terraform test` runs the tests in `tests/` with a mock Google provider. No credentials are used and no cloud calls are made. `tests/module.tftest.hcl` plans the module with each option and checks what it would create: the default secrets backend and repository, `secrets_backend = "none"` with the endpoint tokens' key, the AAD key's pin, an existing repository in the same project and in another, the pack's invoker grants, the client-address setting, the server's own settings (sign-in), the tenancy: `single` and `multi` with each setting it needs, and what each refuses; the routing per deployment and the pack orchestrator: its Job only once its key is set, its schedule, its rights and the pack account's, the key steps, and what the pack settings refuse; `database_instance`: the server's volume, URL secret and grants on another instance, the module's own instance and grant kept, and each refusal; and the database's backups: Cloud SQL's defaults, each setting, and what each refuses. `tests/store-on-later.tftest.hcl` applies, in order, a deployment without a secrets store and the steps that turn one on later: the full plan refused until `secrets_aad_key_version` is set, the targeted apply of what the store stands on, and then the full apply, with the server's new settings.

## Upgrading

- **A deployment of this module** (any `network_mode`, from runtime 0.1.8 or later) can be upgraded to 0.2.0 or later with `./upgrade.sh` (log in to `registry.kindgi.com` first: `docker login registry.kindgi.com --username kindgi` asks for your license key; see [Pull the runtime image](https://docs.kindgi.com/deploy/self-hosted/pull-the-runtime-image/)): it reads the current version, mirrors the new image from `registry.kindgi.com` into Artifact Registry and runs the upgrade checks against the database, as jobs that reach it the way the server does (its VPC egress, then the `/cloudsql` socket or the database's private IP), stopping if one fails, backs up Kindgi's database as an export, shows the plan, checks it, and applies exactly that plan only when you type `yes`, and if the new revision doesn't come up it prints the way back rather than rolling back on its own. Outside the deployment, it grants the Cloud SQL instance's service account `roles/storage.objectAdmin` on the backup bucket (the grant stays; a new grant can take a few minutes to take effect, and the export waits for it), and it writes the new image into your var-file's `server_image` (and `pack_image`), keeping the previous file next to it. It keeps the plan it applies there too, as `<var-file>.upgrade-<UTC time>.tfplan`: `terraform show` reads it, and since it holds what your var files and state hold, only you can read it. Give it one `--var-file` for each file the deployment's variables are in, in the order you give them to `terraform`. A file Terraform doesn't load on its own needs its own, such as a pack's env kept beside the var-file: from the directory it runs in, Terraform loads only `terraform.tfvars` and `*.auto.tfvars` (and their `.json`). It lists every file Terraform reads them from, and the `TF_VAR_` names set in the environment, and it stops if one of them, other than the var-file it writes, sets `server_image` (or `pack_image`, with `--pack-dir`): a later `terraform apply` without that `--var-file` would put the old image back. Before it asks for `yes` it checks the plan itself (`terraform show -json`): it stops if the plan creates, deletes or replaces anything, or changes anything but the new image and the in-place changes the releases crossed name in their steps to confirm by hand. So a var file left off the command, whose variables the plan would empty, stops it there, before anything is applied. To see all of that before it happens, add `--dry-run`: it runs the same reads and read-only checks, lists every change a real run would make, in order, with the names it would use, and shows Terraform's plan for the new image. The plan takes no state lock, but reading the variables through `terraform console` briefly does, so a dry run stops, without harm, while an apply holds it. It changes nothing (not your docker config, the var-file or the state) and never asks for `yes`. Only a real run runs the runtime's own checks, since they run as jobs in your project, and with `--pack-dir` the dry run's plan shows `pack_image` unchanged, since the new pack's digest exists only after the build. Use the `upgrade.sh` as of the `@kindgi/sdk@<version>` tag of the release you're upgrading to: it knows the steps up to its own release and refuses a later `--to`. With an earlier `--to` it still plans its own module, whose changes past the target's release it lists and allows, and it says so. Before the `@kindgi/sdk@0.3.0` tag it takes `network_mode = "none"` only, and one `--var-file`: to 0.2.0 or one of its server fixes, upgrade any other deployment by hand. A server-only release, such as 0.2.0.1, is a server fix for 0.2.0 with no SDK release of its own, so it has no `@kindgi/sdk@` tag of its own: run the `upgrade.sh` as of the `@kindgi/sdk@0.2.0` tag with `--to 0.2.0.1`. From 0.2.0, or an earlier 0.2.0.N, it has no steps to confirm by hand. See `./upgrade.sh --help`. The notes below apply whichever way you upgrade.
- **To runtime 0.1.5: add `KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"` to `server_env` first, or nobody can sign in to the console.** Up to 0.1.4 the console's sign-in page took the API token on its own. From 0.1.5 that's off by default outside `kindgi dev`. The API keeps taking tokens either way, and "7. Turn on sign-in" has the other ways in.
- **The module turns Cloud Resource Manager on** (`cloudresourcemanager.googleapis.com`). Its own calls to it are billed to the caller's project, but another root on the same project that reads the project with its calls billed there (the provider's `user_project_override`) needs it on, and couldn't turn it on before that read. A deployment made with an earlier copy of the module gets it at its next apply: one `google_project_service` to add.
- **The instance gets a backstop for sessions left idle in a transaction** (`database_idle_in_transaction_timeout_ms`, 10 minutes by default; 0 turns it off). A deployment made with an earlier copy of the module gets it at its next apply: one flag added to the instance, changed in place. Cloud SQL lists `idle_in_transaction_session_timeout` as a flag that needs no restart ([Cloud SQL: configure database flags](https://docs.cloud.google.com/sql/docs/postgres/flags)).
- **The instance gets Google's deletion protection** (`settings.deletion_protection_enabled`) from `database_deletion_protection`, true by default, beside Terraform's own. Until now the variable set only Terraform's, which a delete from the console, gcloud or the Cloud SQL API ignores. A deployment made with an earlier copy of the module gets it at its next apply. Its plan shows the instance updated in place. Google lists the setting as changeable after creation and names no restart for it ([Cloud SQL: instance settings](https://docs.cloud.google.com/sql/docs/postgres/instance-settings)). If the plan says the instance `must be replaced`, stop: a replace deletes the database. With `database_deletion_protection = false`, Google's protection stays off. With a private-IP database (`database_private_network`), the plan also shows the server's `KINDGI_DATABASE_SERVER_CA` as `(known after apply)`: with the instance changing, the module reads its CAs during the apply. It's still the instance's CAs.
- **By hand**, for any deployment (and for `network_mode = "direct"` or `"connector"` with an `upgrade.sh` from before the `@kindgi/sdk@0.3.0` tag, which takes `"none"` only): staging first, with `gcloud` set to the deployment's project (`gcloud config set project <project_id>`). Copy the new image by digest (step 2), run the new version's checks as a Cloud Run job that reaches the database, back the database up, set `server_image` (and `pack_image`), `(umask 077 && terraform plan -var-file=<env>.tfvars -out=upgrade.tfplan)` (the plan holds your variables' values, secret ones too), read it, `terraform apply upgrade.tfplan`, delete the plan, and check the new revision serves. The steps, the commands and the way back: [Upgrade by hand](https://docs.kindgi.com/deploy/self-hosted/cloud-run/#upgrade-by-hand).
- **Upgrades roll forward:** migrations only go forward, so an older runtime can break on a database a newer one migrated. Deploy a new runtime revision at 100% traffic, keep a database backup from before, and roll back by restoring it.

## Operating it

- **Client addresses:** the server trusts one proxy, Cloud Run's front end, which appends the caller to `X-Forwarded-For` (`trusted_proxies = "1"`, `KINDGI_TRUSTED_PROXIES`), so rate limits and audit records see the caller. With an external Application Load Balancer in front, set `"2"`: it appends the client and then its own address ([Google: the X-Forwarded-For header](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header)).
- **Backups:** Cloud SQL backs the database up daily, with point-in-time recovery. By default it keeps 7 backups and 7 days of transaction logs on `ENTERPRISE` (the module's edition), 15 backups and 14 days on `ENTERPRISE_PLUS`, in the multi-region nearest the instance ([Google: Cloud SQL backup options](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options)).
  - **Changing them:** `database_backup_retention`, `database_point_in_time_days` (at most 7 days on `ENTERPRISE`, and at most as many days as backups kept, both checked at plan) and `database_backup_location` (for example 30 backups, in `us`).
  - **Where the backups are kept:** the nearest multi-region can be outside the instance's region and country. When you promise where backups are kept, set `database_backup_location` to a region (`northamerica-northeast2`, say) or a multi-region (`us`, `eu`, `asia`); a zone is refused at plan. Point-in-time recovery's transaction logs stay in the instance's own location ([Google: transaction log retention](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#sb-log-retention)).
  - **Setting it on a running deployment** changes the instance in place. The backups taken before stay where they were ([Google: custom backup locations](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#sb-custom-backup-location)).
  - **What a restore reaches:** any second within the logs' days, or one of the kept daily backups.
  - **On a host or a restored instance:** these set the module's own instance only. With `database_host_instance` they're refused at plan: the host's backups are the app's, set where that instance is managed. An instance `database_instance` names keeps its own.
- **One server instance** (`server_max_instances = 1`) until several replicas are verified. Migrations run at boot and need a direct database connection (the socket or a private IP, not a transaction pooler).
- **Rotating a secret:** add a version, then roll a new revision of the server (`gcloud run services update $N-server --update-labels=rotated=$(date +%s)`). The orchestrator's key is pinned: mint a new one as in step 5, add it as a version, set `orchestrator_key_version` to that version and apply. Once the Job runs with it, revoke the old one: `POST /v1/system/keys/{keyId}/revoke`, with its id from `GET /v1/system/keys`.
- **Rotating the database's server CA** (private-IP mode): the server trusts the CAs the instance lists at the last apply, so add the new one, apply, and only then rotate. Applying after the rotation is too late: the server refuses the new certificate until it has the new CA.
  1. `gcloud sql ssl server-ca-certs create --instance=$N` adds the upcoming CA.
  2. `terraform apply`: the server's new revision trusts it and the current one. An OpenFGA of yours that checks these CAs gets them again here too (`gcloud sql ssl server-ca-certs list`, as above) and restarts with the new file.
  3. `gcloud sql ssl server-ca-certs rotate --instance=$N` moves the instance to the new CA ([Google: manage SSL/TLS](https://docs.cloud.google.com/sql/docs/postgres/manage-ssl-instance)).
- **The AAD key is pinned, never rotated this way.** The server reads the version `secrets_aad_key_version` names, not `latest`. Every secret stored in Postgres is bound to it: a new version is a key change that needs every stored secret re-encrypted, and a version added by mistake must not reach the server.
  - **Upgrading from a module copy before this variable:** set it to the version your server reads now. `gcloud secrets versions list $N-secrets-aad-key` shows it; normally `1`.
- **Database timeouts:** from runtime 0.1.9, the server's connections carry their own: 60 s a statement, 30 s waiting for a lock, and 30 s idle in a transaction; a query waits at most 10 s for one of the server's pooled connections. `KINDGI_DB_STATEMENT_TIMEOUT_MS`, `KINDGI_DB_LOCK_TIMEOUT_MS`, `KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` and `KINDGI_DB_POOL_WAIT_TIMEOUT_MS` in `server_env` change them; 0 turns one off. The three Postgres timeouts win over the instance's flags. A GET or HEAD the statement or lock timeout or the pool wait ends answers 503 `database-busy` with `Retry-After: 5` (under `/auth/`, a browser signing in is sent back to the sign-in page instead), any other request 500, and the server's log has a `db` warning naming the setting, its value and its variable. The instance's `database_idle_in_transaction_timeout_ms` is the backstop for every other session on the module's own instance. The module sets no such flag on an instance `database_instance` or `database_host_instance` names; set it yourself if you want it — on a shared host instance it also ends the app's own sessions left idle that long, so that's the operator's call ([Cloud SQL: configure database flags](https://docs.cloud.google.com/sql/docs/postgres/flags)).
- **Slow tools:** the runtime waits `KINDGI_PACK_CALL_TIMEOUT_MS` (default 120 s, `pack_call_timeout_ms`) for a tool call. Keep the pack services' `pack_timeout` above it.

## Serving from a restored instance

A point-in-time recovery always makes a new instance ([Google: point-in-time recovery](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr)). A backup can go into a new one too ([Google: restoring](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restoring)); restored into the instance that serves, it overwrites everything on it. `database_instance` moves the server onto the new instance and leaves the module's own as it is. Public-IP mode only: the server reaches whichever instance it serves from through its `/cloudsql` volume.

With `database_host_instance` set there is no instance of the module's own, so a restore drill clones the app's whole instance (all its databases and users): it needs clone rights on that instance, works only if the app turned on backups or point-in-time recovery, and the clone should be deleted when the drill is done.

1. **Restore into a new instance in this project.** `S` is the instance the server serves from: `$N`, or `database_instance.name` after an earlier restore, since writes made since that switch are only there. With `database_host_instance` set there is no `$N` instance of the module's own — set `S` to the host instance's name (or `database_instance.name` after an earlier restore). `R` is the new one's name, such as `$N-r20261023`:

   ```sh
   S=$N
   R=$N-r<yyyymmdd>
   gcloud sql instances clone $S $R --point-in-time='<yyyy-mm-ddThh:mm:ss.000Z>'
   ```

   It needs a public IP, as the module's own has. The plan refuses an instance without one. The module doesn't manage this instance, so its deletion protection is yours to turn on, as the module does for its own. Do it before the instance serves:

   ```sh
   gcloud sql instances patch $R --deletion-protection
   ```
2. **Its URL, in a secret of its own,** with a new password for the database user. The restored user has the old one. The password goes through the Cloud SQL Admin API (`users.update`), as in "3. Secret values": the body on stdin and the token in a header from a pipe, never in a command's arguments. Each step runs only if the one before it worked.

   ```sh
   gcloud secrets create $R-database-url --replication-policy=user-managed --locations=<region>
   CONN=$(gcloud sql instances describe $R --format='value(connectionName)')
   P=$(gcloud config get-value project)
   DBPW=$(openssl rand -hex 24)
   OP=$(printf '{"password":"%s"}' "$DBPW" \
     | curl -sS -X PUT -H @<(printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)") \
         -H 'Content-Type: application/json' --data-binary @- \
         "https://sqladmin.googleapis.com/v1/projects/$P/instances/$R/users?name=kindgi" \
     | jq -r '.name // error(.error.message)') && [ -n "$OP" ] \
     && gcloud sql operations wait "$OP" --project=$P \
     && printf 'postgres://kindgi:%s@/kindgi?host=/cloudsql/%s' "$DBPW" "$CONN" \
     | gcloud secrets versions add $R-database-url --data-file=-
   unset DBPW
   ```

3. **Let the server read it:**

   ```sh
   gcloud secrets add-iam-policy-binding $R-database-url --role=roles/secretmanager.secretAccessor \
     --member="serviceAccount:$(terraform output -json service_accounts | jq -r .server)"
   ```

   The module doesn't grant this one, since the secret isn't the module's. If a Terraform root of yours makes the secret, that root makes the grant too. When two roots hold the same grant, the first to remove it takes it away from the other.
4. **Replay the erasure ledger on it before it serves.** A restore brings back what an erasure cleared. The runtime image's `erasures replay` does it, with the server's settings, `KINDGI_DATABASE_URL` from `$R-database-url`, and this instance at `/cloudsql`: a Cloud Run job, say. The docs' "Back up and restore" page has the command, under Erasures and backups.
5. **Switch,** in your tfvars, then `terraform apply`:

   ```hcl
   database_instance = {
     name       = "kindgi-prod-r20261023"
     url_secret = "kindgi-prod-r20261023-database-url"
   }
   ```

   - **What the apply changes:**
     - the server's `/cloudsql` volume names the new instance alone;
     - `KINDGI_DATABASE_URL` reads `url_secret`;
     - the server's account gets `roles/cloudsql.client`, conditioned on the new instance, before the new revision starts.
   - **The new revision applies the image's migrations** at boot, as on any start, and takes the traffic once it's ready. The old revision keeps its grant on the module's instance for the requests it still has.
   - **The plan refuses:**
     - private-IP mode;
     - the module's own instance or its `$N-database-url`;
     - the host instance itself (`database_host_instance`), where Kindgi's database lives — serve from a clone of it;
     - an instance without a public IP;
     - a connection name for `name`, or a path for `url_secret`.
6. **The module's own instance stays,** with its deletion protection. The `sql_connection_name` output still names it. Writes made since the restore point are on it alone. (With `database_host_instance` set there is no instance of the module's own: going back points the server at the host instance again, and `sql_connection_name` names the host.)

**Anything else on the instance** comes back with it: another database there, an OpenFGA store's, say. That moves on your side, in the same window.

**Going back:** set `database_instance` to null and apply. The server's revision changes first, and only then does the grant on the restored instance go: the module removes it only after the server's new revision is in. Writes made since the switch stay on the restored instance.

## Taking it down

```sh
terraform state rm 'google_kms_crypto_key.secrets' 'google_kms_key_ring.kindgi'   # GCP never deletes key rings or keys
terraform destroy -var-file=dev.tfvars
gcloud kms keys versions destroy 1 --key=$N-secrets --keyring=$N --location=<region>   # scheduled, 30 days
```

- The pack services and their `kp-` secrets are the orchestrator's, not in Terraform's state, so `terraform destroy` leaves them. Once it has run, so no pass makes them again, list them, and delete each with `gcloud run services delete <name> --region=<region>` and `gcloud secrets delete <name>`:

  ```sh
  gcloud run services list --region=<region> --filter='metadata.name ~ ^kp-' --format='value(metadata.name)'
  gcloud secrets list --filter='name ~ /secrets/kp-' --format='value(name)'
  ```
- Set `database_deletion_protection = false` and apply first, for the instance to go. The apply turns off Google's deletion protection, which would refuse the delete, and writes Terraform's own to its state.
- In the `direct` shape the subnet can't be deleted until Cloud Run releases its `serverless-ipv4-cloudrun-*` addresses, some time after the services are gone (about 3 hours in our run). Run `terraform destroy` again later.
