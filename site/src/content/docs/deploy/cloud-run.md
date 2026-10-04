---
title: Deploy on Google Cloud Run
description: Run the Kindgi runtime and your pack's service on Cloud Run, with Cloud SQL, Artifact Registry, Secret Manager and Cloud KMS, from Kindgi's Terraform module.
sidebar:
  order: 2
---

<!-- DRAFT: written from the verification run on runtime 0.1.1. Before this is
published: the module merged at deploy/gcp-cloud-run/ (#49), and
`kindgi key trust`'s output (0.1.2). Gemini from a deployed runtime isn't on
this page: it hasn't been run on one. -->

Kindgi's Terraform module runs the runtime and your pack's service as two Cloud
Run services in one Google Cloud project, with everything around them. Built
end to end on runtime 0.1.1, the first apply takes about ten minutes (most of
it Cloud SQL), and a tool call from the runtime to your pack takes 42 ms at the
median (100 ms at p95).

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com
:::

## What you'll have

- **The runtime** (`kindgi-server`): Kindgi's server, on Cloud Run with its
  own service account. Public ingress, port 4000, always-allocated CPU (so a
  run started in the background keeps running after its answer), one
  instance.
- **Your pack's service** (`kindgi-pack`): your tools' code. Internal ingress,
  and IAM-protected: only the runtime's service account may call it, with a
  Google ID token on every call.
- **Cloud SQL** (Postgres 16) for the runtime's data, reached through the
  Cloud SQL socket.
- **Artifact Registry** for both images. The runtime also reads your pack's
  image from it when you deploy.
- **Secret Manager** for the runtime's secrets, and **a Cloud KMS key** that
  wraps the secrets the runtime stores (model API keys, webhook secrets).
- **A VPC** with Direct VPC egress and Cloud NAT, which carries the runtime's
  calls to your pack's service and out to model APIs and webhooks.

If your organization forbids public access to Cloud Run (the
`iam.allowedPolicyMemberDomains` policy refuses `allUsers`), set
`server_invoker_iam_disabled = true` and `server_public = false`: the
runtime's API token still guards every call.

Who calls whom: your app calls the runtime (its API token); the runtime calls
your pack's service (an ID token), Cloud SQL, and model APIs; `kindgi deploy`
calls the runtime with a signed envelope, and the runtime reads the pack's
image from Artifact Registry.

## Before you start

- **A Google Cloud project**, with an Owner (or Editor plus Security Admin and
  Secret Manager Admin) to apply the module, and a Cloud Storage bucket for
  Terraform's state.
- **Terraform** 1.6 or later, **gcloud**, **Docker** with `buildx`, and your
  pack's `kindgi` CLI.
- **Runtime 0.1.1 or later.** Cloud SQL has no superuser; 0.1.0 can't start
  on it.
- **Access to the runtime image** (`kindgi auth registry`; see
  [Install](../../start/install/)).
- **A license key:** a non-production key covers staging; contact@kindgi.com.
- **A pack** that `kindgi build --local --push` builds, with an environment
  block for this deployment in its config.

## 1. The foundation

The services need images and secret values that don't exist yet, so the first
apply creates everything else: the APIs, the network, the service accounts,
the repository, the KMS key, Cloud SQL and the secrets' containers.

The module is `deploy/gcp-cloud-run/` in the
[kindgi-sdk repository](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/gcp-cloud-run):
copy the folder from the release you run. Its `README.md` lists every
variable. `example.tfvars` is the shape on this page (a new VPC);
`example-connector.tfvars` runs in a VPC you already have, through a
Serverless VPC Access connector.

```sh
cp example.tfvars prod.tfvars   # project_id, region, kindgi_env, the seed ids, …
terraform init -backend-config=bucket=<state bucket> -backend-config=prefix=<this deployment>
terraform apply -var-file=prod.tfvars \
  -target=google_project_service.apis \
  -target=google_compute_router_nat.nat \
  -target=google_artifact_registry_repository_iam_member.server_reads_images \
  -target=google_kms_crypto_key_iam_member.server_wraps \
  -target=google_sql_database.kindgi \
  -target=google_secret_manager_secret_iam_member.server_reads \
  -target=google_secret_manager_secret_iam_member.pack_reads_token \
  -target=google_project_iam_member.server_sql_client
```

Give each deployment its own state `prefix`, never shared with your app's own
infrastructure.

The plan creates 34 resources. Cloud SQL is the long one, about six minutes.

The module sets Cloud SQL's edition to `ENTERPRISE`. A Postgres 16 instance
otherwise defaults to `ENTERPRISE_PLUS`, which takes only the
`db-perf-optimized-N-*` tiers, and the apply fails with
`Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition`.

## 2. The images into Artifact Registry

Cloud Run pulls from Artifact Registry, not from the runtime's private
registry. Copy the runtime image there by digest, with every platform it was
built for:

```sh
REPO=$(terraform output -raw image_repository)
gcloud auth configure-docker "${REPO%%/*}"
docker buildx imagetools create --tag "$REPO/runtime:0.1.1" \
  quay.io/kindgi/runtime:0.1.1@sha256:<the release's digest>
```

The copy keeps the release's digest. (A plain `docker pull`, `tag` and `push`
from an Apple silicon machine pushes only the arm64 image, which Cloud Run
can't run.)

Then build and push your pack's image, signed:

```sh
pnpm exec kindgi build --local --push --env prod
```

```text
✓ Pushed …/acme@sha256:bd7bfe4f…
✓ /app/index.json in the image matches the local index byte for byte
✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)
```

Set `server_image` and `pack_image` in `prod.tfvars` to the two digests
(`…@sha256:…`).

## 3. The secrets

Make each value here and pipe it straight into Secret Manager: it's never on
disk or in Terraform's state, and Kindgi generates none of them.

```sh
N=kindgi   # name_prefix
CONN=$(terraform output -raw sql_connection_name)

# Kindgi's database user: a built-in user, not an IAM one. The instance is
# named after name_prefix ($N); the database is database_name (kindgi).
DBPW=$(openssl rand -hex 24)
gcloud sql users create kindgi --instance=$N --password="$DBPW"
printf 'postgres://kindgi:%s@/kindgi?host=/cloudsql/%s' "$DBPW" "$CONN" \
  | gcloud secrets versions add $N-database-url --data-file=-
unset DBPW

# The token the runtime and the pack's service share. No trailing newline:
# the two sides would disagree about the token.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add $N-pack-service-token --data-file=-

# The first API token, and the two keys, base64.
printf 'kgi_bt_%s' "$(openssl rand -hex 32)" | gcloud secrets versions add $N-api-token --data-file=-
openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-public-token-key --data-file=-

# The license key, pasted, never echoed.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | gcloud secrets versions add $N-license-key --data-file=- && unset LICENSE_KEY
```

**The database user** is a built-in Cloud SQL user. It isn't a superuser, but
it has `CREATEROLE` and owns the database through `cloudsqlsuperuser`, which is
what the runtime needs. An IAM database user has neither.

**Your pack's own secrets:** `kindgi env plan --env prod` lists what your pack
needs. Create each secret, add its value, and the module passes them to the
pack's service:

```sh
pnpm exec kindgi env plan --env prod > /tmp/pack-env.json
jq '{pack_env: .env, pack_secret_env: .secret_env}' /tmp/pack-env.json > prod.pack-env.auto.tfvars.json
```

## 4. The services

```sh
terraform apply -var-file=prod.tfvars
```

The pack's service comes up first (22 seconds), and is ready only when every
module loaded and every required variable is set. Then the runtime. Its
startup log names the pack's service it reached, and how it calls it:

```text
Pack service: https://kindgi-pack-…a.run.app — acme (artifact 20261004.1), protocol 2, 3 tools, 1 check
Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

### How the runtime calls your pack's service

The pack's service has internal ingress and requires IAM, so nothing but the
runtime reaches it. `KINDGI_PACK_SERVICE_AUTH=google-id-token` makes the
runtime mint a Google ID token for the pack's URL, from its own service
account, on every call. Cloud Run checks it (the runtime's service account
has `roles/run.invoker` on the pack's service, and no one else does), then the
pack's service checks the shared pack token.

If the pack's service refuses the token, the runtime's startup log says so:
`⚠ Pack service at https://… isn't answering (pack-service-unauthorized: The pack service rejected the pack token).`

## 5. Trust your key, and deploy

<!-- TODO 0.1.2: `kindgi key trust <keyId> --url … --token …` (#19), with its output. -->

```sh
pnpm exec kindgi key trust acme-prod --url "$(terraform output -raw server_url)" --token "$KINDGI_API_TOKEN"
pnpm exec kindgi deploy --env prod --endpoint "$(terraform output -raw server_url)" --token "$KINDGI_API_TOKEN"
```

```text
✓ POST /v1/deployments  →  201 Created
  artifactVersion: 20261004.1
  primitives:      3 tools, 1 guardrail, 1 agent, 2 flows
Deploy complete.
```

The runtime read your pack's image from Artifact Registry with its own token
(`KINDGI_IMAGE_REGISTRY_AUTH=google`) to check it before registering it.

A deploy that was refused (an untrusted key, a missing variable) is replayed
when you retry it unchanged: after fixing the cause, retry with a new key,
`--idempotency-key <new value>`.

## 6. Check it

```sh
curl "$(terraform output -raw server_url)/health"     # {"ok":true}
pnpm exec kindgi tools list --url … --token …         # your pack's tools
pnpm exec kindgi runs start --flow=acme.greet-echo --input='{"name":"Ada"}' --url … --token …
```

In the verification run: every run completed; a new instance of the runtime
was ready in about 7 seconds (8 with its first migrations), the pack's
service in about 5.

## The IAM it sets up

| Who | Role | On |
|---|---|---|
| The runtime's service account | `roles/run.invoker` | the pack's service (and no one else) |
| | `roles/cloudkms.cryptoKeyEncrypterDecrypter` and `roles/cloudkms.viewer` | the KMS key (the startup check reads the key's metadata) |
| | `roles/artifactregistry.reader` | the repository |
| | `roles/cloudsql.client` | the project, conditioned on Kindgi's instance |
| | `roles/secretmanager.secretAccessor` | each of its secrets |
| | `roles/aiplatform.user`, only with `vertex_ai = true` | the project |
| The pack's service account | `roles/secretmanager.secretAccessor` | the pack token and your pack's secrets |
| | what your tools need | your own resources |

## Operate it

- **Upgrade:** back up Cloud SQL, copy the new runtime image by digest, set
  `server_image`, and apply. The new revision takes all the traffic.
  Migrations only go forward: never run two runtime versions on one
  database, and go back by restoring the backup.
- **Rotate a secret:** add a version, then roll a new revision of each service
  that reads it (`gcloud run services update … --update-labels=rotated=$(date +%s)`).
  Never rotate the AAD key this way: every stored secret is bound to it.
- **Logs:** Cloud Logging, per service. The runtime's startup lines are in
  [Operate](../operate/#the-startup-log).

## Tear it down

Cloud SQL is protected from deletion: set `database_deletion_protection =
false` and apply first. The KMS key ring and key outlive `terraform destroy`:
Google Cloud never deletes them. Take them out of Terraform's state, destroy
the rest, then schedule the key's versions for destruction:

```sh
terraform apply -var-file=prod.tfvars -var=database_deletion_protection=false
terraform state rm google_kms_crypto_key.secrets google_kms_key_ring.kindgi
terraform destroy -var-file=prod.tfvars
gcloud kms keys versions destroy 1 --key=… --keyring=… --location=…
```

If the destroy stops at the subnet (`is already being used by …/addresses/serverless-ipv4-cloudrun-…`),
Cloud Run hasn't released its addresses yet: run it again later.

## Limits today

- **One runtime instance.** Several aren't supported yet.
- **Signing in through OAuth** doesn't work on Cloud SQL yet; API tokens do.
