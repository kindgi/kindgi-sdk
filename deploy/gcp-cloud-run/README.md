# Kindgi on Google Cloud Run (Terraform)

A Terraform root module that runs Kindgi in one GCP project:
- the runtime (the API, agent and flow execution) as a Cloud Run service;
- your pack's code as a second, IAM-protected Cloud Run service;
- Kindgi's own Cloud SQL (Postgres 16) instance;
- everything they stand on: service accounts, an Artifact Registry repository, a KMS key for the runtime's secrets, and Secret Manager containers.

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

- Terraform ≥ 1.6, `gcloud`, Docker, `openssl`, and your pack's `kindgi` CLI.
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
openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-

# The key that signs public run tokens: Ed25519, PKCS#8 PEM, base64.
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-public-token-key --data-file=-

# The license key: paste it; it never goes in a file.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | gcloud secrets versions add $N-license-key --data-file=- && unset LICENSE_KEY
```

With `database_private_network` set, the URL is `postgres://kindgi:<password>@<private ip>:5432/kindgi?sslmode=require` (`terraform output database_private_ip`).

**Your pack's own secrets** (`secret_env` in `kindgi env plan --env dev`): create each one and add its value, then list it in `pack_secret_env`. The pack service gets read access to exactly those.

## 4. The pack's env

```sh
kindgi env plan --env=dev > pack-env.json      # exits 1 if a required name has no value
jq '{pack_env: .env, pack_secret_env: .secret_env}' pack-env.json > dev.pack-env.auto.tfvars.json
```

## 5. The services

```sh
terraform apply -var-file=dev.tfvars
```

The server's boot lines name what it reached:

```
KMS probe OK (gcp-cloud-kms): …
Background work: tenant <seed tenant id>
Pack service: https://<pack service> — <pack id> (artifact …), protocol 2, 3 tools, 1 check
Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

The runtime's KMS key needs `roles/cloudkms.cryptoKeyEncrypterDecrypter` **and** `roles/cloudkms.viewer` (the boot probe reads the key). The module grants both.

## 6. Register the pack

Trust the pack's signing key on the runtime, then deploy:

```sh
URL=$(terraform output -raw server_url)
PUB=$(kindgi key export <key id> --format=raw-hex | xxd -r -p | base64)   # the 32 raw bytes, base64
curl -sS -X POST "$URL/v1/signing-keys" -H "authorization: Bearer <api token>" \
  -H 'content-type: application/json' --data "{\"keyId\":\"<key id>\",\"publicKey\":\"$PUB\"}"
kindgi deploy --env dev --endpoint "$URL" --token <api token>
```

`kindgi deploy` answers `201 Created` and lists what it registered. The runtime reads the image from Artifact Registry with its own identity (`KINDGI_IMAGE_REGISTRY_AUTH=google`).

A deploy that was refused (say, before the key was trusted) is answered the same way when you retry it: the default `Idempotency-Key` is the request body's hash. After fixing the cause, retry with `--idempotency-key <new value>`.

Then `kindgi health`, `kindgi tools list` and a run, with `--url "$URL" --token <api token>`.

## Operating it

- **One server instance** (`server_max_instances = 1`) until several replicas are verified. Migrations run at boot and need a direct database connection (the socket or a private IP, not a transaction pooler).
- **Upgrades roll forward:** migrations only go forward, so an older runtime can break on a database a newer one migrated (from 0.1.2 it refuses to start there, and names the migrations). Deploy a new runtime revision at 100% traffic, keep a database backup from before, and roll back by restoring it.
- **Rotating a secret:** add a version, then roll a new revision of each service that reads it (`gcloud run services update <service> --update-labels=rotated=$(date +%s)`). Never rotate the AAD key this way: every secret stored in Postgres is bound to it.
- **Slow tools:** the runtime waits `KINDGI_PACK_CALL_TIMEOUT_MS` (default 120 s, `pack_call_timeout_ms`) for a tool call. Keep the pack service's `pack_timeout` above it.

## Taking it down

```sh
terraform state rm google_kms_crypto_key.secrets google_kms_key_ring.kindgi   # GCP never deletes key rings or keys
terraform destroy -var-file=dev.tfvars
gcloud kms keys versions destroy 1 --key=$N-secrets --keyring=$N --location=<region>   # scheduled, 30 days
```

- Set `database_deletion_protection = false` first, for the instance to go.
- In the `direct` shape the subnet can't be deleted until Cloud Run releases its `serverless-ipv4-cloudrun-*` addresses, some time after the services are gone. Run `terraform destroy` again later.
