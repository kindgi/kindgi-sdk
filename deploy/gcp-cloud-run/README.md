# Kindgi on Google Cloud Run (Terraform)

A Terraform root module that runs Kindgi in one GCP project:
- the runtime (the API, agent and flow execution) as a Cloud Run service;
- your pack's code as a second, IAM-protected Cloud Run service;
- Kindgi's own Cloud SQL (Postgres 16) instance;
- everything they stand on: service accounts, an Artifact Registry repository, a KMS key for the runtime's secrets (unless `secrets_backend = "none"`, below), and Secret Manager containers.

**Two network shapes** (`network_mode`):

| | `direct` (default) | `connector` |
|---|---|---|
| For | a project of its own | a project that already has a VPC |
| Network | a new VPC and subnet, Direct VPC egress (all traffic), Cloud NAT | an existing Serverless VPC Access connector, private-ranges-only egress; nothing created |
| The pack service | internal ingress, plus IAM | all ingress, plus IAM (a server without VPC egress can't reach an internal service) |
| Example values | `example.tfvars` | `example-connector.tfvars` |

In both shapes only the runtime's service account may invoke the pack service. The runtime sends a Google ID token (`KINDGI_PACK_SERVICE_AUTH=google-id-token`), so a public URL on the pack service is still closed to everyone else.

The `direct` shape was deployed end to end on 2026-10-04, with runtime 0.1.1:
- the runtime reached the internal pack service with its ID token;
- `kindgi deploy` read the pack image from Artifact Registry with the runtime's own token;
- flows ran through the pack: tool-call hop p50 42 ms, p95 100 ms.

The `connector` shape is the same resources wired to an existing connector.

## Before you start

- Terraform ≥ 1.6, `gcloud`, Docker, `openssl`, and your pack's `kindgi` CLI (0.1.2 or later, for `kindgi key trust`).
- **Permission to create the resources:** an Owner, or Editor plus Security Admin and Secret Manager Admin.
- **Pull access to the runtime image** `quay.io/kindgi/runtime` (`kindgi auth registry`).
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
cp example.tfvars dev.tfvars      # or example-connector.tfvars; fill in
terraform init -backend-config=bucket=<state bucket> -backend-config=prefix=<this deployment>
```

Give each deployment its own state prefix. Never share a root module or a prefix with your app's own infrastructure.

The services need images and secret values that don't exist yet, so the first apply leaves them out:

```sh
terraform apply -var-file=dev.tfvars \
  -target=google_project_service.apis \
  -target=google_compute_router_nat.nat \
  -target=google_artifact_registry_repository_iam_member.server_reads_images \
  -target=google_kms_crypto_key_iam_member.server_wraps \
  -target=google_sql_database.kindgi \
  -target=google_secret_manager_secret_iam_member.server_reads \
  -target=google_secret_manager_secret_iam_member.pack_reads_token \
  -target=google_project_iam_member.server_sql_client
```

- The image variables only need a digest-shaped placeholder here.
- The Cloud SQL instance takes about 6 minutes.
- `database_edition` defaults to `ENTERPRISE`: Postgres 16 instances otherwise default to `ENTERPRISE_PLUS`, which takes only `db-perf-optimized-N-*` tiers.

## 2. Images into Artifact Registry

Cloud Run pulls from Artifact Registry. Copy the runtime's **whole multi-platform index** by digest. A `docker pull` / `push` from an arm64 machine would copy only arm64, and Cloud Run needs amd64.

**An existing repository instead of the module's own (`image_repository`).**
- **Setting it:** `image_repository = { project, location, repository }` uses a repository you already have. The module then creates none.
- **What it grants:** the server's service account gets `roles/artifactregistry.reader` on it, to read deployed pack images. A repository in another project also grants this project's Cloud Run service agent the same role, so it can pull the images.
- **Check its cleanup policies first.** A policy that deletes tags or images by age can delete the digest a running revision pins, and the next instance start then fails. Keep Kindgi's images out of such a policy, or use the module's own repository.
- **Where images go:** `terraform output image_repository` names where they go, in either case.

```sh
REPO=$(terraform output -raw image_repository)
gcloud auth configure-docker <region>-docker.pkg.dev
docker buildx imagetools create --tag $REPO/runtime:<version> quay.io/kindgi/runtime:<version>@sha256:<release digest>
kindgi build --local --push --env dev      # the pack image, signed; writes .kindgi/build/deploy-envelope.json
```

The mirrored runtime keeps the release's digest. Set `server_image` and `pack_image` to the two digests (`…@sha256:…`).

## 3. Secret values

Each value is piped straight into Secret Manager. None goes on disk or into Terraform's state. `N` is your `name_prefix`.

```sh
CONN=$(terraform output -raw sql_connection_name)

# Kindgi's database user: a built-in user (it gets CREATEROLE; not an IAM user).
DBPW=$(openssl rand -hex 24)
gcloud sql users create kindgi --instance=$N --password="$DBPW"
printf 'postgres://kindgi:%s@/kindgi?host=/cloudsql/%s' "$DBPW" "$CONN" \
  | gcloud secrets versions add $N-database-url --data-file=-
unset DBPW

# The token the server and the pack service share: no trailing newline.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add $N-pack-service-token --data-file=-

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

With `database_private_network` set, the URL is `postgres://kindgi:<password>@<private ip>:5432/kindgi?sslmode=require` (`terraform output database_private_ip`).

**Your pack's own secrets** (`secret_env` in `kindgi env plan --env dev`): create each one and add its value, then list it in `pack_secret_env`. The pack service gets read access to exactly those.

**Without a KMS key (`secrets_backend = "none"`).** By default (`"postgres"`), secrets set through Kindgi's API are envelope-encrypted in its database under a Cloud KMS key this module creates. With `"none"`:
- **Not created:** the KMS key ring, the key and its grants, and the `<prefix>-secrets-aad-key` secret. `secrets_aad_key_version` isn't needed.
- **The server stores no secrets of its own.** `/v1/secrets` isn't served (it answers 404 `route-not-found`), and nothing can be stored through Kindgi's API. The boot record has no KMS probe line.
- **Who it fits:** a deployment whose pack secrets all come by reference (`pack_secret_env`) and whose model uses the service's own identity, Gemini on Vertex AI (`vertex_ai = true`). A provider that needs an API key stored in Kindgi doesn't fit it.
- **Changing an existing deployment from `"postgres"`:** the key's `prevent_destroy` stops the plan. That's on purpose: secrets stored under the key would become unreadable. Move them out first, then take the key out of state, as in "Taking it down".

## 4. The pack's env

```sh
kindgi env plan --env=dev > pack-env.json      # exits 1 if a required name has no value
jq '{pack_env: .env, pack_secret_env: .secret_env}' pack-env.json > dev.pack-env.auto.tfvars.json
```

**A Cloud Run service the pack's code calls (`pack_run_invokers`).** When a tool calls one of your app's IAM-protected Cloud Run services, list it as `{ project, location, service }`, with the service's name, not its URL. The pack's service account gets `roles/run.invoker` on it. The grant is added beside the service's other members, and nothing else of the service changes.
- **The token:** the pack's code fetches a Google ID token for the service's URL from the metadata server and sends it as `Authorization: Bearer`. In Node that's google-auth-library's `getIdTokenClient(url)`; in Python, `google.oauth2.id_token.fetch_id_token`.
- **The ingress:** the call leaves through the pack's own egress. In `direct` that's Cloud Run's internet egress; in `connector`, the connector carries private ranges only. A service with ingress `all` takes the call, with IAM as the guard. A service with internal ingress refuses it, with a 404 (Google's "Page not found" page, not a 403): Cloud Run counts a call from another service as internal only when the caller sends all its traffic through a VPC, and the pack doesn't in either shape.

## 5. The services

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
Pack service: https://<pack service> — <pack id> (artifact …), protocol 2, 3 tools, 1 check
Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

With the KMS key (`secrets_backend = "postgres"`), the key's check is its own record, logged just before:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND textPayload:"KMS probe"' \
  --limit=1 --format='value(textPayload)'
```

```
KMS probe OK (gcp-cloud-kms): gcp-cloud-kms v1 (encrypt/decrypt round trip, key version 1) (170ms)
```

**On the first apply** the pack service line can read `⚠ Pack service at https://… isn't answering (pack-service-unauthorized: The platform in front of the pack service refused the call: …)`. The server's invoker grant on the pack service is seconds old then, and IAM is still propagating it. Calls work once it has, without a restart (in our run, the first tool call, 3½ minutes after the warning, worked). If tool calls still fail after that, check that the server's service account has `roles/run.invoker` on the pack service.

The runtime's KMS key needs `roles/cloudkms.cryptoKeyEncrypterDecrypter`. A runtime before 0.1.3 also needs `roles/cloudkms.viewer`, because its boot probe reads the key; from 0.1.3 the probe is an encrypt/decrypt round trip. The module grants both.

## 6. Register the pack

Trust the pack's signing key on the runtime, then deploy:

```sh
URL=$(terraform output -raw server_url)
kindgi key trust <key id> --label dev --url "$URL" --token <api token>
kindgi deploy --env dev --endpoint "$URL" --token <api token>
```

`kindgi deploy` answers `201 Created` and lists what it registered. The runtime reads the image from Artifact Registry with its own identity (`KINDGI_IMAGE_REGISTRY_AUTH=google`).

A deploy that was refused (say, before the key was trusted) is answered the same way when you retry it: the default `Idempotency-Key` is the request body's hash. After fixing the cause, retry with `--idempotency-key <new value>`.

Then `kindgi health`, `kindgi tools list` and a run, with `--url "$URL" --token <api token>`.

## 7. Turn on sign-in

**Nobody can sign in to the console until you turn sign-in on.** The API takes API tokens either way. Since runtime 0.1.5, console sign-in is off by default outside `kindgi dev`, and the server's boot lines say so: `⚠ Console sign-in: nobody can sign in to the console. …`

The server's own settings go in two variables, as the pack's do:
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

- **`public_url`** (`KINDGI_PUBLIC_URL`) is the URL people open the console at. On a new deployment that's `terraform output -raw server_url` after the first apply, so the emailed link comes with a second apply. With your own domain in front, it's that domain.
  - Console sessions are then accepted from that origin only, so open the console there.
  - The plan refuses `KINDGI_AUTH_SECRET` without it, because the server wouldn't start.
- **Continue with Google, Microsoft or GitHub, verified domains, and Turnstile** go the same way:
  - in `server_env`: each provider's client id, `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant id>`) and the Turnstile site key;
  - in `server_secret_env`: each `…_CLIENT_SECRET` and `KINDGI_AUTH_TURNSTILE_SECRET`.
  - The `…_PATH` forms read a file, which this module doesn't mount, so use the value forms.

## Testing the module

`terraform init -backend=false && terraform test` runs `tests/module.tftest.hcl` with a mock Google provider. No credentials are used and no cloud calls are made. It plans the module with each option and checks what it would create: the default secrets backend and repository, `secrets_backend = "none"`, the AAD key's pin, an existing repository in the same project and in another, the pack's invoker grants, the client-address setting, and the server's own settings (sign-in).

## Upgrading

- **To runtime 0.1.5: add `KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"` to `server_env` first, or nobody can sign in to the console.** Up to 0.1.4 the console's sign-in page took the API token on its own. From 0.1.5 that's off by default outside `kindgi dev`. The API keeps taking tokens either way, and "7. Turn on sign-in" has the other ways in.
- **Upgrades roll forward:** migrations only go forward, so an older runtime can break on a database a newer one migrated. Deploy a new runtime revision at 100% traffic, keep a database backup from before, and roll back by restoring it.

## Operating it

- **Client addresses:** the server trusts one proxy, Cloud Run's front end, which appends the caller to `X-Forwarded-For` (`trusted_proxies = "1"`, `KINDGI_TRUSTED_PROXIES`), so rate limits and audit records see the caller. With an external Application Load Balancer in front, set `"2"`: it appends the client and then its own address ([Google: the X-Forwarded-For header](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header)).
- **One server instance** (`server_max_instances = 1`) until several replicas are verified. Migrations run at boot and need a direct database connection (the socket or a private IP, not a transaction pooler).
- **Rotating a secret:** add a version, then roll a new revision of each service that reads it (`gcloud run services update <service> --update-labels=rotated=$(date +%s)`).
- **The AAD key is pinned, never rotated this way.** The server reads the version `secrets_aad_key_version` names, not `latest`. Every secret stored in Postgres is bound to it: a new version is a key change that needs every stored secret re-encrypted, and a version added by mistake must not reach the server.
  - **Upgrading from a module copy before this variable:** set it to the version your server reads now. `gcloud secrets versions list $N-secrets-aad-key` shows it; normally `1`.
- **Slow tools:** the runtime waits `KINDGI_PACK_CALL_TIMEOUT_MS` (default 120 s, `pack_call_timeout_ms`) for a tool call. Keep the pack service's `pack_timeout` above it.

## Taking it down

```sh
terraform state rm 'google_kms_crypto_key.secrets[0]' 'google_kms_key_ring.kindgi[0]'   # GCP never deletes key rings or keys (none with secrets_backend = "none")
terraform destroy -var-file=dev.tfvars
gcloud kms keys versions destroy 1 --key=$N-secrets --keyring=$N --location=<region>   # scheduled, 30 days
```

- Set `database_deletion_protection = false` first, for the instance to go.
- In the `direct` shape the subnet can't be deleted until Cloud Run releases its `serverless-ipv4-cloudrun-*` addresses, some time after the services are gone (about 3 hours in our run). Run `terraform destroy` again later.
