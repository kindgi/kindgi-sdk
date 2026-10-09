---
title: Deploy on Google Cloud Run
description: Run the Kindgi runtime and your pack's service on Cloud Run, with Cloud SQL, Artifact Registry, Secret Manager and Cloud KMS, from Kindgi's Terraform module.
sidebar:
  order: 2
---

Kindgi's Terraform module runs the runtime and your pack's service as two Cloud
Run services in one Google Cloud project, with everything around them. Built
end to end on runtime 0.1.1, the first apply takes about ten minutes (most of
it Cloud SQL), and a tool call from the runtime to your pack takes 42 ms at the
median (100 ms at p95).

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub for the
runtime image's pull credentials, and log in once with `kindgi auth registry`
(see [Install](../../start/install/#access-to-the-runtime-image)). Questions or trouble: contact@kindgi.com.
:::

## What you'll have

- **The runtime** (`kindgi-server`): Kindgi's server, on Cloud Run with its
  own service account. Public ingress, port 4000 (Cloud Run passes it as
  `PORT`, which the runtime listens on), always-allocated CPU (so a
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
  calls to your pack's service and out to model APIs and webhooks. Or, when
  your tools need a VPC you already have, that VPC through its connector
  ([A new VPC, or yours](#a-new-vpc-or-yours)).

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
  pack's `kindgi` CLI (0.1.2 or later, for `kindgi key trust`).
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

### A new VPC, or yours

`network_mode` decides how both services reach a VPC:

- **`direct`** (the default, `example.tfvars`): the module creates a VPC and a
  subnet (`subnet_cidr`, default `10.10.0.0/24`), Direct VPC egress for all
  traffic, and Cloud NAT. Pick it when your tools reach only the internet,
  or nothing outside your pack.
- **`connector`** (`example-connector.tfvars`): both services use a Serverless
  VPC Access connector you already have, for private ranges only. Name it in
  `vpc_connector`, as
  `projects/<project>/locations/<region>/connectors/<name>`. The module
  creates no VPC, router or NAT, and calls to the internet (model APIs, your
  pack service's URL, webhooks) go out through Cloud Run's own egress.

Pick `connector` when your pack's tools reach private resources in a VPC you
already have: a database on a private IP, an internal service. With `direct`,
the pack runs in a new VPC of its own, not connected to yours.

Connector mode also needs `pack_ingress = "INGRESS_TRAFFIC_ALL"`, as in the
example: the runtime reaches your pack's service through Cloud Run's own
egress, not the VPC, so the pack service has to accept all traffic. IAM still
admits only the runtime's service account. The module refuses connector mode
without `vpc_connector` or without that ingress, and says which.

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
docker buildx imagetools create --tag "$REPO/runtime:0.1.4" \
  quay.io/kindgi/runtime:0.1.4@sha256:<the release's digest>
```

The copy keeps the release's digest. (A plain `docker pull`, `tag` and `push`
from an Apple silicon machine pushes only the arm64 image, which Cloud Run
can't run.)

**A repository you already have** instead of the module's own:
`image_repository = { project, location, repository }`. The module then creates
none, gives the runtime's service account `roles/artifactregistry.reader` on
it, and, for a repository in another project, gives this project's Cloud Run
service agent the same role so it can pull. `terraform output image_repository`
names where images go, either way.

:::caution[Check the repository's cleanup policies]
A cleanup policy that deletes tags or images by age can delete the digest a
running revision pins, and the next instance start then fails. Keep Kindgi's
images out of such a policy, or use the module's own repository.
:::

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

# The token the runtime and the pack's service share.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add $N-pack-service-token --data-file=-

# The first API token, and the two keys, base64.
printf 'kgi_bt_%s' "$(openssl rand -hex 32)" | gcloud secrets versions add $N-api-token --data-file=-
openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-   # version 1 (not with secrets_backend = "none")
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-public-token-key --data-file=-
# Only with export_signing = "secret": the key that signs exports.
openssl genpkey -algorithm ed25519 | base64 | gcloud secrets versions add $N-export-signing-key --data-file=-

# The license key, pasted, never echoed.
read -rs LICENSE_KEY && printf '%s' "$LICENSE_KEY" | gcloud secrets versions add $N-license-key --data-file=- && unset LICENSE_KEY
```

The server reads the AAD key's version that `secrets_aad_key_version` names in
`prod.tfvars`: `"1"`, the one just added (the example files have it). Every
secret stored in Postgres is bound to that key, so the module pins it and
refuses `latest`:

```text
secrets_aad_key_version is a version number ("1" for a new deployment), never "latest": every secret stored in Postgres is bound to the key it names.
```

### Without a KMS key

By default (`secrets_backend = "postgres"`), secrets set through Kindgi's API
(a model's API key, a webhook's secret) are envelope-encrypted in its
database under a Cloud KMS key the module creates. With
`secrets_backend = "none"`:

- **Not created:** the KMS key ring and key, their grants, and the
  `$N-secrets-aad-key` secret; `secrets_aad_key_version` isn't needed.
- **The runtime stores no secrets of its own.** `/v1/secrets` isn't served:
  it answers `404 route-not-found`, and the runtime checks no KMS key at
  start.
- **Who it fits:** a deployment whose pack's secrets all come by reference
  (`pack_secret_env`) and whose model uses the service's own identity
  ([Gemini on Vertex AI](#use-gemini)). A provider whose API key would be
  stored in Kindgi doesn't fit it.
- **An existing deployment stays as it is:** changing it from `"postgres"`
  stops the plan at the key's `prevent_destroy`, on purpose, since the
  secrets stored under it would become unreadable. Move them out first.

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
module loaded and every required variable is set. Then the runtime. On Cloud
Run it logs JSON, so its startup lines are the `lines` of one log record,
`Kindgi runtime ready`:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND jsonPayload.message="Kindgi runtime ready"' \
  --limit=1 --format=json | jq -r '.[0].jsonPayload.lines[]'
```

They name the pack's service it reached, and how it calls it:

```text
Pack service: https://kindgi-pack-…a.run.app — acme (artifact …), protocol 2, 3 tools, 1 check
Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

The KMS check comes just before, as a log line of its own:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND textPayload:"KMS probe"' \
  --limit=1 --format='value(textPayload)'
```

```text
KMS probe OK (gcp-cloud-kms): gcp-cloud-kms v1 (encrypt/decrypt round trip, key version 1) (170ms)
```

**On the first apply,** the pack service line can read instead:

```text
⚠ Pack service at https://… isn't answering (pack-service-unauthorized: The platform in front of the pack service refused the call: check the identity token (KINDGI_PACK_SERVICE_AUTH) and that the server may invoke the service). The server is up; pack tools and checks fail until it answers.
```

The runtime's permission to call the pack's service is seconds old then, and
Google Cloud is still applying it. It clears without a restart: in our run,
the first tool call, 3½ minutes after the warning, worked. If tool calls still
fail after that, check that the runtime's service account has
`roles/run.invoker` on the pack's service.

### How the runtime calls your pack's service

The pack's service has internal ingress and requires IAM, so nothing but the
runtime reaches it. `KINDGI_PACK_SERVICE_AUTH=google-id-token` makes the
runtime mint a Google ID token for the pack's URL, from its own service
account, on every call. Cloud Run checks it (the runtime's service account
has `roles/run.invoker` on the pack's service, and no one else does), then the
pack's service checks the shared pack token.

If the pack's service refuses the token, the runtime's startup log says so:
`⚠ Pack service at https://… isn't answering (pack-service-unauthorized: The pack service rejected the pack token).`

### Call your app's Cloud Run services from a tool

When a tool calls one of your app's IAM-protected Cloud Run services, list it
in `pack_run_invokers`, by its name, not its URL:

```hcl
pack_run_invokers = [
  { project = "acme-app", location = "europe-west1", service = "orders-api" },
]
```

The pack's service account gets `roles/run.invoker` on each one, beside its
other members; nothing else of the service changes. The tool asks the
metadata server for a Google ID token for the service's URL and sends it as
`Authorization: Bearer`:

```ts
// tools/call-service/index.ts
// acme.call-service: calls one of the app's IAM-protected Cloud Run services
// with a Google ID token for its URL from the metadata server, and reports
// what came back, as is.

import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const Input = z.object({ url: z.string().url() });

const Output = z.object({
  token: z.string(),
  status: z.number().optional(),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});

const METADATA =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

const defined = defineTool({
  id: 'acme.call-service' as ToolId,
  description: "Call an app Cloud Run service with the pack's Google ID token; report the answer.",
  version: '0.1.0',
  input: Input,
  output: Output,
  effects: [{ kind: 'reads', resource: 'external:cloud-run' }],
  mutating: false,
  handler: async ({ url }) => {
    const audience = new URL(url).origin;
    const minted = await fetch(`${METADATA}?audience=${encodeURIComponent(audience)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!minted.ok) return { token: `refused ${minted.status}`, body: await minted.text() };
    const idToken = (await minted.text()).trim();
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${idToken}` } });
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'www-authenticate', 'server', 'x-cloud-trace-context']) {
        const value = res.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { token: 'minted', status: res.status, body: (await res.text()).slice(0, 2000), headers };
    } catch (cause) {
      return { token: 'minted', error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
    }
  },
});

if (defined.kind === 'err') {
  throw new Error(`acme.call-service failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

The call leaves through the pack's own egress, so the service's ingress has
to take it. A service with ingress `all` does, with IAM as the guard. A
service with internal ingress refuses it with a `404`, Google's "Page not
found" page, not a `403`, so the tool's error can look like a wrong URL.
A call from Cloud Run to an internal service has to go through a VPC
network, and the pack's calls to your services don't
([Cloud Run: Restrict network endpoint ingress](https://docs.cloud.google.com/run/docs/securing/ingress)).

## 5. Trust your key, and deploy

```sh
pnpm exec kindgi key trust acme-prod --url "$(terraform output -raw server_url)" --token "$KINDGI_API_TOKEN"
```

```text
  ✓ Trusted acme-prod (sha256:…)
```

```sh
pnpm exec kindgi deploy --env prod --endpoint "$(terraform output -raw server_url)" --token "$KINDGI_API_TOKEN"
```

```text
✓ POST /v1/deployments  →  201 Created
  artifactVersion: …
  primitives:      3 tools, 1 guardrail, 1 agent, 2 flows
Deploy complete.
```

The runtime read your pack's image from Artifact Registry with its own token
(`KINDGI_IMAGE_REGISTRY_AUTH=google`) to check it before registering it.

A deploy that's refused (an untrusted key, a missing variable) says what to
fix. Fix it and run the same command again.

## 6. Check it

```sh
curl "$(terraform output -raw server_url)/health"     # {"ok":true}
pnpm exec kindgi tools list --url … --token …         # your pack's tools
pnpm exec kindgi runs start --flow=acme.greet-echo --input='{"name":"Ada"}' --url … --token …
```

In the verification run: every run completed; a new instance of the runtime
was ready in about 7 seconds (8 with its first migrations), the pack's
service in about 5.

## 7. Turn on sign-in

Nobody can sign in to the console until you turn sign-in on; the API, the
CLI and the SDKs take API tokens either way. Until then the startup lines
say so:

```text
  ⚠ Console sign-in: nobody can sign in to the console. KINDGI_CONSOLE_TOKEN_SIGN_IN=on allows an API token; KINDGI_AUTH_SECRET_PATH turns on sign-in with identity providers.
```

The runtime's own settings go in two variables, as the pack's do:
`server_env` for plain values, and `server_secret_env` for Secret Manager
secrets, read with the runtime's identity. You create each secret, and the
runtime gets read access to exactly those (a secret in another project is
granted there). The plan refuses a name the module sets itself (its own
variables cover those, such as `public_url` below), `KINDGI_DEV`, and a
secret given as a plain value: a name with `SECRET` in it, or the SMTP URL.

**With an API token,** which the console's sign-in page then takes:

```hcl
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
}
```

**With an emailed link,** you need the runtime's sign-in secret, an SMTP
server and `public_url`:

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

Pin each secret to a version, as here, rather than `latest`: a new version
then reaches the runtime only when you change `version`.

- **`public_url`** (`KINDGI_PUBLIC_URL`) is the address people open the
  console at: `terraform output -raw server_url` after the first apply, so
  the emailed link comes with a second apply, or your own domain in front.
  Console sessions are then accepted from that address only. The plan
  refuses `KINDGI_AUTH_SECRET` without it, because the runtime wouldn't
  start.
- **Continue with Google, Microsoft or GitHub, verified domains and
  Turnstile** go the same way: each provider's client id,
  `KINDGI_AUTH_VERIFIED_DOMAINS` and the Turnstile site key in `server_env`;
  each `…_CLIENT_SECRET` and `KINDGI_AUTH_TURNSTILE_SECRET` in
  `server_secret_env`. The module mounts no files, so use the value forms of
  the settings, not their `…_PATH` forms.

**Check it worked:** after the apply, the new revision's startup lines say
where it's reached, and which ways in the console has, instead of the
warning. From a deployment with identity providers and the emailed link:

```text
Kindgi API server listening on http://localhost:4000 (reached at https://kindgi-server-…a.run.app)
  Console sign-in: identity providers, or an API token (KINDGI_CONSOLE_TOKEN_SIGN_IN)
  …
  Pack service: https://kindgi-pack-…a.run.app — acme (artifact 20261009.132057), protocol 2, 4 tools, 1 check
  Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

What each setting does, and the ways in: [Turn on sign-in](../sign-in/).

## The IAM it sets up

| Who | Role | On |
|---|---|---|
| The runtime's service account | `roles/run.invoker` | the pack's service (and no one else) |
| | `roles/cloudkms.cryptoKeyEncrypterDecrypter`, not with `secrets_backend = "none"` | the KMS key (the startup check encrypts and decrypts with it) |
| | `roles/cloudkms.viewer` | the KMS key; needed only by runtimes before 0.1.3, whose startup check read the key's metadata |
| | `roles/artifactregistry.reader` | the repository, or yours (`image_repository`) |
| | `roles/cloudsql.client` | the project, conditioned on Kindgi's instance |
| | `roles/secretmanager.secretAccessor` | each of its secrets, and each one in `server_secret_env` |
| | `roles/aiplatform.user`, only with `vertex_ai = true` | the project: [Gemini](#use-gemini) |
| | `roles/cloudkms.signerVerifier` and `roles/cloudkms.publicKeyViewer`, only with `export_signing = "kms"` | the export signing key: [signed exports](../../guides/observability/export-signed-evidence/) |
| The pack's service account | `roles/secretmanager.secretAccessor` | the pack token and your pack's secrets |
| | `roles/run.invoker` | each service in `pack_run_invokers` |
| | what your tools need | your own resources |

## Use Gemini

The runtime can call Gemini on Vertex AI with its own service account, so
there's no key to store. Set `vertex_ai = true` and apply: the module turns
on the Vertex AI API and grants the runtime's service account
`roles/aiplatform.user`. Then register the preset:

```sh
pnpm exec kindgi providers register --preset=gemini --project=<project> --models=gemini-3.8-flash --url … --token …
```

```text
✓ Registered gemini: gemini-3.8-flash (default)
```

Without the role, every model call fails (this one was captured with
`gemini-2.5-flash`; another model's call names that model):

```text
Model call to gemini (gemini-2.5-flash) failed: {"error":{"code":403,"message":"Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/<project>/locations/global/publishers/google/models/gemini-2.5-flash' (or it may not exist). …
```

A new grant can take a minute or two to apply.

## Operate it

- **To runtime 0.1.5:** add `KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"` to
  `server_env` first, or nobody can sign in to the console. Up to 0.1.4 its
  sign-in page took the API token on its own; from 0.1.5 that's off by
  default ([7. Turn on sign-in](#7-turn-on-sign-in) has the other ways in).
- **Upgrade:** back up Cloud SQL, copy the new runtime image by digest, set
  `server_image`, and apply. The new revision takes all the traffic.
  Migrations only go forward: never run two runtime versions on one
  database, and go back by restoring the backup. From a module copy older
  than `secrets_aad_key_version`, add it to `prod.tfvars` first, set to the
  version your server reads now (`gcloud secrets versions list $N-secrets-aad-key`,
  normally `1`); without it, `terraform plan` stops and asks for it.
- **Rotate a secret:** add a version, then roll a new revision of each service
  that reads it (`gcloud run services update … --update-labels=rotated=$(date +%s)`).
- **The AAD key is never rotated.** Every stored secret is bound to the
  version the server reads, so a new version is a key change that needs every
  stored secret re-encrypted first. The pin keeps a version added by mistake
  away from the server.
- **Client addresses:** the module trusts one proxy, Cloud Run's front end,
  which adds the caller to `X-Forwarded-For` (`trusted_proxies = "1"`, the
  runtime's `KINDGI_TRUSTED_PROXIES`), so rate limits and sign-in records see
  the caller. Behind an external Application Load Balancer, set `"2"`: it
  adds the client and then its own address
  ([Google: X-Forwarded-For header](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header)).
- **Erasures, after a restore:** a memory erasure keeps a keyed hash of whom
  it erased, so it can be replayed after you restore a backup. The key goes
  in Secret Manager, named in `server_secret_env`:

  ```sh
  openssl rand 32 | base64 | gcloud secrets create $N-erasure-ledger-key --data-file=-
  ```

  ```hcl
  server_secret_env = {
    KINDGI_ERASURE_LEDGER_KEY = { secret = "kindgi-dev-erasure-ledger-key", version = "1" }
  }
  ```

  The startup lines then say:

  ```text
    Erasures: on; the ledger is replayable after a backup restore (key from KINDGI_ERASURE_LEDGER_KEY)
  ```

  Without it, they say erasures aren't replayable. Keep the key: losing it
  means losing replay ([Operate](../operate/)).
- **Logs:** Cloud Logging, per service. The runtime logs JSON there, one
  record per line, and Cloud Logging reads each record's `severity`; filter by
  `jsonPayload.traceId` to follow one request or run. The startup lines are
  the `lines` of its `boot` record, as in
  [Operate](../operate/#the-startup-log). See [Logs](../logs/).

## Tear it down

Cloud SQL is protected from deletion: set `database_deletion_protection =
false` and apply first. The KMS key ring and key outlive `terraform destroy`:
Google Cloud never deletes them. Take them out of Terraform's state, destroy
the rest, then schedule the key's versions for destruction:

```sh
terraform apply -var-file=prod.tfvars -var=database_deletion_protection=false
terraform state rm 'google_kms_crypto_key.secrets[0]' 'google_kms_key_ring.kindgi[0]'   # none with secrets_backend = "none"
terraform destroy -var-file=prod.tfvars
gcloud kms keys versions destroy 1 --key=… --keyring=… --location=…
```

If the destroy stops at the subnet (`is already being used by …/addresses/serverless-ipv4-cloudrun-…`),
Cloud Run hasn't released its addresses yet: run it again later.

## Limits today

- **One runtime instance.** Several aren't supported yet.
- **Sign-in with an identity provider** hasn't been checked on Cloud SQL yet;
  API tokens work.
