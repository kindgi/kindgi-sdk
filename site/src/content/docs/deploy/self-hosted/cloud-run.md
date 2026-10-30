---
title: Deploy on Google Cloud Run
description: Run the Kindgi runtime and your pack's service on Cloud Run, with Cloud SQL, Artifact Registry, Secret Manager and Cloud KMS, from Kindgi's Terraform module.
sidebar:
  order: 2
---

When you finish this page, the Kindgi runtime and your pack's service run
as two Cloud Run services in one Google Cloud project, with everything
around them, from Kindgi's Terraform module. You then deploy your pack, run
a flow, and turn on sign-in. The
[Cloud Run module reference](../cloud-run-reference/) has what the module
grants, the settings that change its shape, and its limits.

In the verification run, the first apply took about ten minutes, most of it
Cloud SQL. A tool call from the runtime to your pack took 42 ms at the
median, and 100 ms at p95.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::

## What you'll have

- **The runtime** (`kindgi-server`): Kindgi's server, on Cloud Run with its
  own service account and one instance. It has public ingress on port 4000,
  which Cloud Run passes as `PORT`. Its CPU is always allocated, so a run
  started in the background keeps running after its answer.
- **Your pack's service** (`kindgi-pack`): your tools' code, for every
  project the runtime serves
  ([Your tools' code](../../../concepts/security/#your-tools-code)).
  Internal ingress, and IAM-protected: only the runtime's service account
  may call it, with a Google ID token on every call. Its CPU is allocated only while a call runs,
  so the instance `pack_min_instances` keeps up bills at Cloud Run's lower
  idle rate between calls, and any others aren't billed then.
- **Cloud SQL** (Postgres 16) for the runtime's data, reached through the
  Cloud SQL socket, which encrypts the connection and checks the server
  ([Check the database's certificate](../database-tls/)).
- **Artifact Registry** for both images. The runtime also reads your pack's
  image from it when you deploy.
- **Secret Manager** for the runtime's secrets, and **a Cloud KMS key** that
  wraps the secrets the runtime stores, such as model API keys and webhook
  secrets.
- **A VPC** with Direct VPC egress and Cloud NAT, which carries the runtime's
  calls to your pack's service and out to model APIs and webhooks. Or, when
  your tools need a VPC you already have, that VPC through its connector
  ([A new VPC, or yours](../cloud-run-reference/#a-new-vpc-or-yours)).

Your organization may forbid public access to Cloud Run: its
`iam.allowedPolicyMemberDomains` policy then refuses `allUsers`. Set
`server_invoker_iam_disabled = true` and `server_public = false`. The
runtime's API token still guards every call.

Who calls whom:

- your app calls the runtime, with its API token;
- the runtime calls your pack's service, with an ID token, and Cloud SQL and
  model APIs;
- `kindgi deploy` calls the runtime with a signed envelope, and the runtime
  reads the pack's image from Artifact Registry.

## Before you start

- **A Google Cloud project,** and a Cloud Storage bucket for Terraform's
  state. Whoever applies the module is an Owner, or an Editor with Security
  Admin and Secret Manager Admin.
- **Terraform 1.6 or later, gcloud, Docker** with `buildx`, **jq**, **curl**,
  **openssl**, and your pack's `kindgi` CLI, 0.1.2 or later, which has
  `kindgi key trust`.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead. The
  build, `env plan` and deploy steps need the pack's folder, so they use
  `pnpm exec kindgi`.
- **Runtime 0.1.1 or later.** Cloud SQL has no superuser; 0.1.0 can't start
  on it.
- **A license key:** a non-production key covers staging, and it also pulls
  the runtime image. Get one at
  [access.kindgi.com](https://access.kindgi.com), or from contact@kindgi.com.
- **Docker logged in to `registry.kindgi.com`** with that key
  ([Pull the runtime image](../pull-the-runtime-image/)).
- **A pack** that `kindgi build --local --push` builds, with an environment
  block for this deployment in its config.

## 1. The foundation

The services need images and secret values that the next steps make. So
the first apply creates everything else: the APIs, the network, the service
accounts, the repository, the KMS key, Cloud SQL and the secrets'
containers.

The module is `deploy/gcp-cloud-run/` in the
[kindgi-sdk repository](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/gcp-cloud-run):
copy the folder from the release you run. Its `README.md` lists every
variable. `example.tfvars` is the shape on this page, with a new VPC.
`example-connector.tfvars` runs in a VPC you already have, through a
Serverless VPC Access connector.
[A new VPC, or yours](../cloud-run-reference/#a-new-vpc-or-yours) says which
to pick.

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

- `prod.tfvars` holds this deployment's variables. `example.tfvars` lists
  them.
- `-backend-config` tells `init` where the state goes: `<state bucket>`, and
  `<this deployment>` as its own `prefix` in it.
- `-target` limits this apply to the APIs, the network, the database, the
  secrets' containers and the grants, with what they need.

Give each deployment its own state `prefix`, never shared with your app's own
infrastructure.

The plan creates 34 resources. Cloud SQL is the long one, about six minutes.

The module sets Cloud SQL's edition to `ENTERPRISE`. A Postgres 16 instance
otherwise defaults to `ENTERPRISE_PLUS`, which takes only the
`db-perf-optimized-N-*` tiers, and the apply fails with
`Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition`.

## 2. The images into Artifact Registry

Cloud Run pulls from Artifact Registry. It can't pull from
`registry.kindgi.com`, which takes your license key as its password. With
Docker logged in there, copy the runtime image into Artifact Registry by
digest, with every platform it was built for:

```sh
REPO=$(terraform output -raw image_repository)
gcloud auth configure-docker "${REPO%%/*}"
docker buildx imagetools create --tag "$REPO/runtime:0.3.0" \
  registry.kindgi.com/kindgi/runtime:0.3.0@sha256:1f5cfe0032bb82b467781949978719d6a3da4d500cd994471f2f2e009c9a1b9f
```

- `REPO` is the repository's address, from the foundation's output.
  `configure-docker` lets Docker push to its host.
- `imagetools create --tag` copies the image by digest, every platform
  included, under the tag you give.

The copy keeps the release's digest. A plain `docker pull`, `tag` and `push`
from an Apple silicon machine pushes only the arm64 image, which Cloud Run
can't run.

The copy goes through the machine you run it on, every layer down and back up,
and takes both platforms (amd64 and arm64), so on a slow uplink it can take
most of an hour.

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

Then build and push your pack's image, signed. `--local` builds it on your
machine, `--push` pushes it to the `registry` of your pack's `prod`
environment block, and `--env prod` names that block:

```sh
pnpm exec kindgi build --local --push --env prod
```

It prints the build as JSON, then each step. The last steps:

```text
…
    ✓ Pushed …/acme@sha256:bd7bfe4f…

  Verifying build output
    ✓ /app/index.json in the image matches the local index byte for byte

  Signing locally
    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)
      key: …
…
```

Set `server_image` and `pack_image` in `prod.tfvars` to the two digests
(`…@sha256:…`).

With `tenancy = "multi"` ([Serve many tenants](#serve-many-tenants)) there's
no `pack_image` and no pack service: each deployment is a Cloud Run service of
its own.

## 3. The secrets

The services read their secrets from Secret Manager. Make each value here
and pipe it straight into Secret Manager: it's never on disk, in
Terraform's state or in a command's arguments, which other processes can
read and gcloud writes to its log file. Kindgi generates none of them. The
commands are for bash or zsh. To run with no KMS key, set
`secrets_backend = "none"` first
([Without a KMS key](../cloud-run-reference/#without-a-kms-key)).

```sh
N=kindgi   # name_prefix
CONN=$(terraform output -raw sql_connection_name)
P=$(gcloud config get-value project)

# Kindgi's database user: a built-in user, not an IAM one. The instance is
# named after name_prefix ($N); the database is database_name (kindgi).
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

- `N` is your `name_prefix`, `CONN` the Cloud SQL instance's connection
  name, and `P` your Google Cloud project's id.
- `curl` sends the database user's name and password to the Cloud SQL Admin
  API (`users.insert`) on its input, with your gcloud access token in a
  header read from a pipe. `jq` takes the operation's name, or prints the
  API's error, and `gcloud sql operations wait` waits until the user exists.
  The `&&`s stop at the first step that fails, and `[ -n "$OP" ]` stops them
  when `curl` got no answer: then no password goes into the secret.
- `gcloud secrets versions add <name> --data-file=-` adds what it reads on
  its input as the secret's next version.
- `openssl rand` makes random values, and `openssl genpkey -algorithm ed25519`
  an Ed25519 private key.
- `read -rs` reads the license key you paste, without showing it.

The server reads the AAD key's version that `secrets_aad_key_version` names
in `prod.tfvars`: `"1"`, the one you added. The example files have it. Every
secret stored in Postgres is bound to that key, so the module pins it and
refuses `latest`:

```text
secrets_aad_key_version is a version number ("1" for a new deployment), never "latest": every secret stored in Postgres is bound to the key it names.
```

**The database user** is a built-in Cloud SQL user. It isn't a superuser. But
it has `CREATEROLE`, and owns the database through `cloudsqlsuperuser`, which
is what the runtime needs. An IAM database user has neither.

**Your pack's own secrets:** `kindgi env plan --env prod` lists what your pack
needs. Create each secret and add its value. The module passes them to the
pack's service. `jq` turns the plan into the module's `pack_env` and
`pack_secret_env` variables:

```sh
pnpm exec kindgi env plan --env prod > /tmp/pack-env.json
jq '{pack_env: .env, pack_secret_env: .secret_env}' /tmp/pack-env.json > prod.pack-env.auto.tfvars.json
```

Keep that file in the module's folder, and keep its name's ending,
`.auto.tfvars.json`. Terraform reads `terraform.tfvars` and every
`*.auto.tfvars` file in the folder it runs in by itself, `.json` forms
included, for every `plan` and `apply` there, so the pack's env goes into
each without a `-var-file`. A file named otherwise,
`prod.pack-env.tfvars.json` say, is
read only by a command that names it with `-var-file`. A plan made without
it sets `pack_env` and `pack_secret_env` to nothing, and applying that plan
takes the pack's env away: while a name the pack requires has no value, its
service takes no calls. And since every such file in the folder is read,
keep one deployment's there
([Staging and production](#staging-and-production)).

## 4. The services

With the images and the secrets in place, apply the whole module. It creates
the two services:

```sh
terraform apply -var-file=prod.tfvars
```

The pack's service comes up first, in about 22 seconds. It's ready only when
every module loaded and every required variable is set. Then the runtime. On Cloud
Run it logs JSON, so its startup lines are the `lines` of one log record,
`Kindgi runtime ready`:

```sh
gcloud logging read 'resource.labels.service_name="'$N'-server" AND jsonPayload.message="Kindgi runtime ready"' \
  --limit=1 --format=json | jq -r '.[0].jsonPayload.lines[]'
```

`--limit=1` reads the newest such record, and `jq` prints its `lines`. They
name the pack's service it reached, and how it calls it
([How the runtime calls your pack's service](../cloud-run-reference/#how-the-runtime-calls-your-packs-service)):

```text
Pack service: https://kindgi-pack-…a.run.app — acme (artifact …), protocol 2, 3 tools, 1 check
Pack service auth: a Google ID token per call (KINDGI_PACK_SERVICE_AUTH)
```

The KMS check comes right before them, as a log line of its own:

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

**Keep the pack's service warm when response time matters.** The default,
`pack_min_instances = 1`, keeps one instance running, so the first tool
call after a quiet spell doesn't wait for one to start. That instance runs
around the clock ([Cloud Run pricing](https://cloud.google.com/run/pricing)).
`pack_min_instances = 0` lets the service stop when it's idle, which suits
a dev deployment: the first tool call after that waits for an instance to
start.

**When the runtime starts with the pack's service at zero**
(`pack_min_instances = 0`), the line can read instead:

```text
⚠ Pack service at https://… didn't answer within 5 s. The server is up; pack tools and checks fail until it answers.
```

The runtime waits 5 seconds for the pack's service when it starts, and a
service at zero takes longer than that to start an instance. It's harmless:
the first tool call waits for the instance, for up to about two minutes (the
service's startup check), and the runtime gives a call 120 seconds
(`pack_call_timeout_ms`; raise it if starts run near that). If tool calls keep
failing, read the pack's service logs: its startup check fails until every
module has loaded and every `env.required` value is set, and its logs name
what's missing.

### Call your app's Cloud Run services from a tool

When a tool calls one of your app's IAM-protected Cloud Run services, list it
in `pack_run_invokers`, by its name, not its URL:

```hcl excerpt
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

### OpenFGA behind Cloud Run IAM

When OpenFGA runs as a Cloud Run service of its own, with IAM on, the
runtime proves who it is to Cloud Run as well as to OpenFGA (runtime 0.1.8 or
later). Give the runtime's service account `roles/run.invoker` on OpenFGA's
service, run OpenFGA with a key and its playground off
([Require a key for OpenFGA](../../authorization/#require-a-key-for-openfga)), and
set:

```hcl
openfga_api_url = "https://openfga-…a.run.app" # OpenFGA's own service URL
server_env = {
  KINDGI_OPENFGA_AUTH = "google-id-token"
}
server_secret_env = {
  KINDGI_OPENFGA_PRESHARED_KEY = { secret = "kindgi-openfga-key", version = "1" }
}
```

Each call then carries a Google ID token for that URL, from the runtime's own
identity, in `X-Serverless-Authorization`, beside the key in `Authorization`.
With both headers, Cloud Run checks only `X-Serverless-Authorization`, and
passes the token on without its signature, so the key reaches OpenFGA
([Cloud Run: Authenticating service-to-service](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)).
The URL is the token's audience, so use OpenFGA's service URL itself, over
https. The startup line about OpenFGA's calls names the token too
(`KINDGI_OPENFGA_AUTH`).

Keep the key's secret pinned to a version, as here: then
[change the key](../../authorization/#require-a-key-for-openfga) one deploy at a
time.

### Serve many tenants

By default (`tenancy = "single"`) the server serves one tenant,
`seed_tenant_id`'s, and calls one pack service (`pack_image`). With `"multi"`,
on runtime 0.1.8 or later, it serves every tenant created through
`POST /v1/system/tenants`, and takes each request's tenant from its key or
session. Each deployment is then a Cloud Run service of its own: your
orchestrator creates it and records its endpoint through the runtime's
`/v1/system/…` deployment routes. This module doesn't.

```hcl
tenancy         = "multi"
openfga_api_url = "https://openfga-…a.run.app"
# no seed_tenant_id, seed_user_id or pack_image; secrets_backend stays "postgres"
server_env = {
  KINDGI_TENANT_HOST_ACCESS  = "isolated"
  KINDGI_PACK_ROUTING        = "per-deployment"
  KINDGI_PACK_ENDPOINT_HOSTS = "*-<project number>.<region>.run.app" # the deployments' services
}
server_secret_env = {
  KINDGI_OPENFGA_PRESHARED_KEY = { secret = "<a key OpenFGA accepts>", version = "1" }
}
```

- **What the plan needs, and names when it's missing:** `openfga_api_url`
  (without an authorization store no tenant would have an admin),
  `KINDGI_OPENFGA_PRESHARED_KEY` in `server_secret_env`
  ([Require a key for OpenFGA](../../authorization/#require-a-key-for-openfga)),
  `KINDGI_TENANT_HOST_ACCESS = "isolated"`,
  `KINDGI_PACK_ROUTING = "per-deployment"` and `KINDGI_PACK_ENDPOINT_HOSTS` in
  `server_env`, and `secrets_backend = "postgres"` (each endpoint's token is
  sealed under the secrets' key). The server won't start without them.
- **What the plan refuses:** `seed_tenant_id`, `seed_user_id`, `pack_image`,
  and what the pack service would run with: `pack_env`, `pack_secret_env`,
  `pack_cloud_sql_instances`, `pack_bucket_readers` and `pack_run_invokers`.
  The pack service's other settings do nothing without it.
- **Each deployment's service** (your orchestrator's):
  - **Its host** matches `KINDGI_PACK_ENDPOINT_HOSTS`. On Cloud Run,
    `*-<project number>.<region>.run.app` admits only one project's services;
    `*.run.app` and `*.<region>.run.app` are refused at start. Record its
    endpoint by that URL: Cloud Run's other URL for the service, the one
    ending in `.a.run.app`, doesn't match.
  - **The server calls it with its own identity** when the endpoint's auth is
    a Google ID token, so the service grants `roles/run.invoker` to the
    server's account (`terraform output service_accounts`).
  - **In `connector` mode its ingress is all traffic,** with IAM as the
    guard: the server's connector carries private ranges only. In `direct`
    mode it can be internal when it runs in the server's project (or inside a
    VPC Service Controls perimeter with it), as the module's own pack service
    does
    ([Cloud Run: Restrict network endpoint ingress](https://docs.cloud.google.com/run/docs/securing/ingress)).
- **What the module sets:** `KINDGI_TENANCY=multi`
  ([the variable](../../../reference/env-vars/#kindgi_tenancy)), and none of
  `KINDGI_TENANT_ID`, `KINDGI_SEED_USER_ID`, `KINDGI_PACK_SERVICE_URL`,
  `KINDGI_PACK_SERVICE_TOKEN` or `KINDGI_PACK_SERVICE_AUTH`. It creates no
  pack service, pack account or pack grants, and no shared pack token.
  `pack_call_timeout_ms` still caps each call.
- **The API token** is the operator's: it reaches only `/v1/system/*`, in no
  tenant. So step 5 and everything after it use a tenant's key instead:
  - **A tenant:** `POST /v1/system/tenants` with the API token. With
    `firstAdmin`, that person is its admin and holds every capability but
    `secrets:reveal`, to put on the keys they make
    ([Who can do what](../../people-and-keys/#who-can-do-what)). Without it,
    the answer carries the first admin's key, sent once. That key is a
    service account's, so the runs it starts count as unattended
    ([Service accounts](../../people-and-keys/#service-accounts)): for the
    work you start, add yourself as a person
    ([Add a person](../../people-and-keys/#add-a-person)) and use a key of your
    own.
  - **Its image repository:** the create's `imagePrefix`, or
    `PUT /v1/system/tenants/{tenantId}/image-prefix`, before its first
    deploy. Without it, a deploy is refused with `409 image-prefix-unset`.
  - **Its tools answer once your orchestrator has run the deployment's
    service and recorded its endpoint.** Until then, a run that calls one
    fails with `pack-endpoint-pending`: "The pack service of the deployment
    shipping … isn't ready yet."
- **An existing deployment** keeps its tenant, with its data, keys and
  people, as the first of many at the first `"multi"` boot. Before the
  switch:
  - **OpenFGA first:** if it has no `openfga_api_url` yet, add it (and the
    key) in a single-tenant apply. That boot makes the tenant's authorization
    store, with the seed user as its admin. Switching in the same apply
    leaves the tenant without one, and none can be made afterwards without
    naming its first admin.
  - **A key of the tenant** for anything that deploys or calls with the API
    token: after the switch, that token no longer reaches the tenant.
  - **Its deployments' services:** the switch removes the one pack service,
    so each deployment needs a service and a recorded endpoint of its own,
    as any tenant's does.
  - Then, in one apply: `tenancy = "multi"`, without `seed_tenant_id`,
    `seed_user_id` and `pack_image`, with the settings above.
- **After an upgrade that adds a step per tenant,**
  `kindgi-runtime tenants repair --all` has to run once: a server serving
  many tenants sets nothing up per tenant at boot. This module runs no such
  job. It also takes away access a tenant's record doesn't back (runtime
  0.3.0 or later): it finishes a removal that stopped part way, and revokes
  a service account's admin, membership or project role that its grants
  don't give. And it takes away the access an older runtime gave
  `00000000-0000-0000-0000-000000000000`, the id it named as the creator of
  what a key with no person behind it made; no person has that id.
  `--dry-run` shows what it would put back and take away, per tenant, and
  changes nothing.
- **An earlier runtime** ignores `KINDGI_TENANCY`. With no tenant id it would
  seed a new tenant at every start, so upgrade the runtime first.

## 5. Trust your key, and deploy

The runtime accepts only deploys signed by a key it trusts. Read its address
and the first API token, trust your pack's key, then deploy. With
`tenancy = "multi"`, use a key of the tenant here and after, not the API token,
and the tools answer once your orchestrator has recorded the deployment's
endpoint ([Serve many tenants](#serve-many-tenants)).

```sh
URL=$(terraform output -raw server_url)
export KINDGI_API_TOKEN=$(gcloud secrets versions access latest --secret=$N-api-token)
npx --yes @kindgi/cli@0.2 key trust acme-prod --url "$URL"
```

It prints the key the runtime now trusts, then says so:

```text
{
  "keyId": "acme-prod",
  "tenantId": "722e23b8-bbb4-43dc-9a37-9640e369fa7d",
  "algorithm": "ed25519",
  "publicKey": "UCeKMLv5KIFRJo5exp/5BKzsPOKzdlmJYYuLKVYmEVo=",
  "createdAt": "2026-10-12T14:28:47.190Z"
}

  ✓ Trusted acme-prod (sha256:60e5a3c06154b3ee3e425037)
    The runtime now accepts deploys this key signs.
```

- `gcloud secrets versions access` reads the API token from step 3.
- `acme-prod` is your signing key's id, from `~/.kindgi/keys/`.
- `--url` is the runtime's address. The commands send the API token,
  exported as `KINDGI_API_TOKEN`, which keeps it off the command line.
  `kindgi deploy` takes the address as `--endpoint`, and `--env prod` names
  the environment block to deploy.

```sh
pnpm exec kindgi deploy --env prod --endpoint "$URL"
```

It prints the deployment as JSON, then each step. The last steps:

```text
…
  Registering deployment
    ✓ POST /v1/deployments  →  201 Created
      deploymentId:    b27ee9ec-…
      artifactVersion: …
      primitives:      3 tools, 1 guardrail, 1 agent, 2 flows
      activatedAt:     2026-10-04T22:23:24.370Z

  Deploy complete.
  Runs started from now use image sha256:bd7bfe4f7d9c8… (artifactVersion …).
  With one pack service, runs already in flight call that service's current build, as new runs do: a call naming a tool version that build doesn't have fails with tool-version-mismatch.
```

To deploy a client's pack into its own project, add `--project <id or slug>` ([Deploy a client's pack into its project](../../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).

The runtime read your pack's image from Artifact Registry with its own token
(`KINDGI_IMAGE_REGISTRY_AUTH=google`) to check it before registering it.

A deploy that's refused, for an untrusted key or a missing variable, says
what to fix. Fix it and run the same command again.

## 6. Check it

Check the runtime answers, lists your pack's tools, and runs a flow:

```sh
curl "$URL/health"                                  # {"ok":true}
npx --yes @kindgi/cli@0.2 tools list --url "$URL"   # your pack's tools
npx --yes @kindgi/cli@0.2 runs start --flow=acme.greet-echo --input='{"name":"Ada"}' --url "$URL"
```

`--flow` names the flow to run, and `--input` is its input, as JSON.

In the verification run, every run completed. A new instance of the runtime
was ready in about 7 seconds, 8 with its first migrations, and the pack's
service in about 5.

## 7. Turn on sign-in

Nobody can sign in to the console until you turn sign-in on. The API, the
CLI and the SDKs take API tokens either way. Until then, the startup lines
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
secret given as a plain value: a name with `SECRET` in it, a preshared key,
or the SMTP URL.

**With an API token,** which the console's sign-in page then takes:

```hcl excerpt
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

```hcl excerpt
public_url = "https://kindgi-server-abc123-pd.a.run.app" # terraform output -raw server_url
server_env = {
  KINDGI_CONSOLE_TOKEN_SIGN_IN = "on"
  KINDGI_AUTH_EMAIL_FROM       = "kindgi@acme.example"
}
server_secret_env = {
  KINDGI_AUTH_SECRET         = { secret = "kindgi-auth-secret", version = "1" }
  KINDGI_AUTH_EMAIL_SMTP_URL = { secret = "kindgi-smtp-url", version = "1" }
}
```

Pin each secret to a version, as here, rather than `latest`: a new version
then reaches the runtime only when you change `version`.

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
https://kindgi-server-abc123-pd.a.run.app/auth/kindgi/social/callback/google
```

Store the client's secret, then give the runtime the client's ID and the
secret:

```sh
# The Google client's secret: paste it; it never goes in a file.
read -rs GOOGLE_SECRET && printf '%s' "$GOOGLE_SECRET" | gcloud secrets create $N-google-client-secret --data-file=- && unset GOOGLE_SECRET
```

```hcl excerpt
public_url = "https://kindgi-server-abc123-pd.a.run.app"
server_env = {
  KINDGI_AUTH_GOOGLE_CLIENT_ID = "<client id>"
}
server_secret_env = {
  KINDGI_AUTH_SECRET               = { secret = "kindgi-auth-secret", version = "1" }
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET = { secret = "kindgi-google-client-secret", version = "1" }
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

## Use Gemini

The runtime can call Gemini on Vertex AI with its own service account, so
there's no key to store. Set `vertex_ai = true` and apply: the module turns
on the Vertex AI API and grants the runtime's service account
`roles/aiplatform.user`. Then register the preset:

```sh
npx --yes @kindgi/cli@0.2 providers register --preset=gemini --project=<project> --models=gemini-3.8-flash --url "$URL"
```

```text
{
  "providerId": "gemini"
}
✓ Registered gemini: gemini-3.8-flash (default)
```

- `--preset=gemini` registers Gemini on Vertex AI.
- `<project>` is your Google Cloud project's id.
- `--models` lists the models to offer. The first is the default.

Without the role, every model call fails. This one was captured with
`gemini-2.5-flash`, and another model's call names that model:

```text
Model call to gemini (gemini-2.5-flash) failed: {"error":{"code":403,"message":"Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/<project>/locations/global/publishers/google/models/gemini-2.5-flash' (or it may not exist). …
```

A new grant can take a minute or two to apply.

## Staging and production

Run staging and production as two deployments of the module, so a change
or an upgrade reaches staging first. Each has its own:

- **Folder:** a copy of the module, at the same release. Terraform reads
  every `*.auto.tfvars.json` in the folder, so two deployments' pack env in
  one folder would both be read.
- **State:** its own `prefix` at `terraform init`
  (`-backend-config=prefix=staging`, say). Two deployments never share one.
- **Variables:** `staging.tfvars` in one folder and `prod.tfvars` in the
  other, each with its `project_id`, its `name_prefix`, and its
  `kindgi_env`: the env its tools' stored secrets resolve in, the one you
  name when you set them (`--env=staging`, say).
- **Pack env:** `kindgi env plan --env staging` reads your pack config's
  `staging` environment
  ([Per-environment values](../../../guides/secrets/per-environment-values/)),
  and its output goes into `staging.pack-env.auto.tfvars.json` in staging's
  folder. Each environment in the pack config can also name its
  deployment's address (`endpoint`), so `kindgi deploy --env staging`
  deploys there.
- **License key:** a non-production key covers staging, as long as it
  serves no end users and processes no live business data
  ([Two licenses](../../../concepts/licensing/#two-licenses)).

The two can go in two Google Cloud projects, or in one:

- **Two projects** keep them apart: each project's resources, roles and
  quotas are its own, and both deployments can keep the default
  `name_prefix`. Terraform takes the project from the var-file, but
  `gcloud` acts on the one it's set to, so set it to the deployment's
  before any `gcloud` command for it
  (`gcloud config set project <project_id>`).
- **One project** works with a `name_prefix` for each (`kindgi-staging`
  and `kindgi`, say): every resource the module makes is named with it. The
  module turns the project's APIs on and never off, so tearing one down
  leaves them on for the other. But the roles the module grants on the
  whole project, Cloud SQL Client for one, then cover both deployments'
  resources.

## Operate it

- **Upgrade at least every 90 days.** A preview release stops starting 90
  days after it was released. Cloud Run starts new instances on its own,
  and after that day none comes up. The
  runtime warns from 30 days before, at startup and once a day, in a log
  record with `jsonPayload.event = "kindgi.preview_expiry"`: set a log-based
  alert on it
  ([Licensing](../../../concepts/licensing/#preview-releases-stop-starting-after-90-days)).
- **Upgrade:** back up Cloud SQL, copy the new runtime image by digest, set
  `server_image`, and apply ([Upgrade by hand](#upgrade-by-hand) has the
  steps). The new revision takes all the traffic.
  Migrations only go forward: never run two runtime versions on one
  database, and go back by restoring the backup. From a module copy older
  than `secrets_aad_key_version`, add it to `prod.tfvars` first, set to the
  version your server reads, normally `1`
  (`gcloud secrets versions list $N-secrets-aad-key` lists them). Without
  it, `terraform plan` stops and asks for it. From a module copy that set
  only Terraform's deletion protection, the next apply also turns on
  Google's in the instance, in place, while `database_deletion_protection`
  is on (the default). If the plan says the instance `must be replaced`,
  stop: a replace deletes the database.
- **Or upgrade with the module's `upgrade.sh`:** a deployment of the
  module on runtime 0.1.8 or later, in any `network_mode`, can run it
  instead, to 0.2.0 or later. Before the `@kindgi/sdk@0.3.0` tag it takes
  `network_mode = "none"` only. It copies the new image from
  `registry.kindgi.com`, so [log in there](../pull-the-runtime-image/)
  first. It runs the upgrade checks against the database, then backs the
  database up, and changes the running deployment only when you type
  `yes`. Before it asks, it checks the plan: it stops if the plan creates,
  deletes or replaces anything, or changes anything but the new image and
  what the releases crossed change in place. So a var file left off the
  command, whose variables the plan would empty, stops it: give it one
  `--var-file` for each file your variables are in, since Terraform loads
  only `terraform.tfvars` and `*.auto.tfvars` (and their `.json`) on its
  own. `yes` applies exactly that plan, which it keeps next to the
  var-file's copy. If the new revision doesn't
  come up, it prints the way back rather than rolling back on its own. To
  see what it would do first, add `--dry-run`: it lists every change a real
  run would make, in order, and shows Terraform's plan for the new image,
  but changes nothing and never asks for `yes`. It doesn't run the upgrade
  checks against the database, since they run as jobs in your project. Use
  the `upgrade.sh` as of the `@kindgi/sdk@<version>` tag of the release
  you're upgrading to, or, before that release is out, its newest
  `@kindgi/sdk@<version>-rc.N` tag: it knows the steps up to its own release,
  and refuses a later `--to`. With an earlier `--to` it still plans its own
  module, whose changes past the target's release it lists and allows, and
  it says so. A server-only release, such as 0.2.0.1, is a
  server fix for 0.2.0 with no `@kindgi/sdk@` tag of its own: use the
  `upgrade.sh` as of the `@kindgi/sdk@0.2.0` tag, with `--to 0.2.0.1`. The
  module's README has the rest, under
  [Upgrading](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/gcp-cloud-run#upgrading),
  and `./upgrade.sh --help` lists its options.
- **Backups:** Cloud SQL backs the database up daily, with point-in-time
  recovery. On the module's edition (`ENTERPRISE`) it keeps 7 backups and
  7 days of transaction logs by default, in the multi-region nearest the
  instance ([Google: Cloud SQL backup options](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options)).
  To keep more, or choose where they're stored, set
  `database_backup_retention`, `database_point_in_time_days` (at most 7 on
  `ENTERPRISE`, and at most as many days as backups kept) and
  `database_backup_location`. A restore reaches any second within the
  logs' days, or one of the kept backups.
  - **Where the backups are kept:** the nearest multi-region can be
    outside the instance's region and country. When you promise where
    backups are kept, set `database_backup_location` to a region
    (`northamerica-northeast2`, say) or a multi-region (`us`, `eu`,
    `asia`); a zone is refused at plan. Point-in-time recovery's
    transaction logs stay in the instance's own location
    ([Google: transaction log retention](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#sb-log-retention)).
  - **Setting it on a running deployment** changes the instance in place.
    The backups taken before stay where they were
    ([Google: custom backup locations](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#sb-custom-backup-location)).
  - **On a host or a restored instance:** these set the module's own
    instance only. With `database_host_instance` they're refused at plan:
    the host's backups are the app's, set where that instance is managed.
    An instance `database_instance` names keeps its own.
- **Restore Cloud SQL:** a point-in-time recovery always makes a new
  instance, and a backup can go into one too (restored into the serving
  instance, it overwrites everything on it). `database_instance` moves the
  server onto the new instance: the instance's name, and a secret of yours
  holding the server's URL to it. The module's own instance stays as it is.
  The module's README has the steps, under
  [Serving from a restored instance](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/gcp-cloud-run#serving-from-a-restored-instance):
  - the new instance's deletion protection, which the module doesn't manage
    there: turn it on before it serves;
  - the new instance's URL, and the server's read access to it;
  - the erasure replay before it serves
    ([Erasures and backups](../back-up-and-restore/#erasures-and-backups));
  - the switch, and the way back.
- **Rotate a secret:** add a version, then roll a new revision of each service
  that reads it (`gcloud run services update … --update-labels=rotated=$(date +%s)`).
- **The AAD key is never rotated.** Every stored secret is bound to the
  version the server reads, so a new version is a key change that needs every
  stored secret re-encrypted first. The pin keeps a version added by mistake
  away from the server.
- **Client addresses:** the module trusts one proxy, Cloud Run's front end,
  which adds the caller to `X-Forwarded-For`. That's `trusted_proxies = "1"`,
  the runtime's `KINDGI_TRUSTED_PROXIES`, so rate limits and sign-in records
  see the caller. Behind an external Application Load Balancer, set `"2"`:
  it adds the client and then its own address
  ([Google: X-Forwarded-For header](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header)).
- **Database timeouts** (they need runtime 0.1.9 or later): the server's
  connections carry their own, 60 s a statement, 30 s waiting for a lock,
  and 30 s idle in a transaction, and a query waits at most 10 s for
  one of the server's pooled connections. `KINDGI_DB_STATEMENT_TIMEOUT_MS`,
  `KINDGI_DB_LOCK_TIMEOUT_MS`, `KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` and
  `KINDGI_DB_POOL_WAIT_TIMEOUT_MS` in `server_env` change them; `0` turns
  one off. A GET or HEAD the statement or lock timeout or the pool wait
  ends answers 503 `database-busy` with `Retry-After: 5` (under `/auth/`, a
  browser signing in is sent back to the sign-in page instead), any other
  request 500, and the log has a `db` warning naming the setting, its value
  and its variable. The instance itself ends any other session left idle in a
  transaction for 10 minutes (`database_idle_in_transaction_timeout_ms`, `0`
  for off). An instance from before that variable gets the flag at the next
  apply, in place: Cloud SQL lists it as needing no restart
  ([Cloud SQL: configure database flags](https://docs.cloud.google.com/sql/docs/postgres/flags)).
- **Erasures, after a restore:** a memory erasure keeps a keyed hash of whom
  it erased, so it can be replayed after you restore a backup. The key goes
  in Secret Manager, named in `server_secret_env`:

  ```sh
  openssl rand 32 | base64 | gcloud secrets create $N-erasure-ledger-key --data-file=-
  ```

  ```hcl excerpt
  server_secret_env = {
    KINDGI_ERASURE_LEDGER_KEY = { secret = "kindgi-erasure-ledger-key", version = "1" }
  }
  ```

  The startup lines then say:

  ```text
    Erasures: on; the ledger is replayable after a backup restore (key from KINDGI_ERASURE_LEDGER_KEY)
  ```

  Without it, they say erasures aren't replayable. Keep the key: losing it
  means losing replay
  ([Erasures and backups](../back-up-and-restore/#erasures-and-backups)).
- **Logs:** Cloud Logging, per service. The runtime logs JSON there, one
  record per line, and Cloud Logging reads each record's `severity`. Filter
  by `jsonPayload.traceId` to follow one request or run. The startup lines are
  the `lines` of its `boot` record, as in
  [The startup log](../restart-and-check-health/#the-startup-log). See
  [Logs](../logs/).

## Upgrade by hand

`upgrade.sh` runs these steps for you. Upgrade by hand instead if you'd
rather, or with `network_mode` `direct` or `connector` and an `upgrade.sh`
from before the `@kindgi/sdk@0.3.0` tag, which takes `"none"` only. Upgrade
staging first ([Staging and production](#staging-and-production)). Run the
steps in the
module's folder, as the identity that deploys the module, with `gcloud` set
to this deployment's project, the `project_id` in its var-file:

```sh
gcloud config set project <project_id>
```

Terraform acts on the var-file's project, and `gcloud` on the one it's set
to. Set to another deployment's project with the same `name_prefix`, the
backup in step 4 would back that one up, and the apply would then upgrade
this one with no backup. `N` is your `name_prefix`, and `REPO` the
repository from
[2. The images into Artifact Registry](#2-the-images-into-artifact-registry).

1. **Read the upgrade steps** of each release you're upgrading across, in
   its release notes, and take the new release's digest from its notes.
2. **Copy the new runtime image** into Artifact Registry by digest, every
   platform included, as in
   [2. The images into Artifact Registry](#2-the-images-into-artifact-registry),
   from `registry.kindgi.com` (it has 0.2.0 and later):

   ```sh
   docker buildx imagetools create --tag "$REPO/runtime:<version>" \
     registry.kindgi.com/kindgi/runtime:<version>@sha256:<digest>
   ```

3. **Run the new version's read-only checks** against the database
   ([Checks you can run before upgrading](../operate/#checks-you-can-run-before-upgrading)),
   as a Cloud Run job that reaches it the way the server does. With
   `direct` and a private-IP database:

   ```sh
   SA=$(terraform output -json service_accounts | jq -r .server)
   gcloud run jobs create $N-upgrade-check --region=<region> \
     --image="$REPO/runtime@sha256:<new digest>" --service-account="$SA" \
     --set-secrets=KINDGI_DATABASE_URL=$N-database-url:latest \
     --network=$N --subnet=$N-run --vpc-egress=all-traffic \
     --args=check,provider-keys --max-retries=0
   gcloud run jobs execute $N-upgrade-check --region=<region> --wait
   ```

   - **Other shapes:** with `connector` and a private-IP database, use
     `--vpc-connector=<your connector> --vpc-egress=private-ranges-only`
     in place of the three network flags. With a database on a public IP,
     add `--set-cloudsql-instances=<its connection name>`; with
     `connector`, the job then needs no network flags at all.
   - **Serving from a restored instance** (`database_instance` set): the
     server's URL is in that setting's `url_secret`, not
     `$N-database-url`. Name that secret in `--set-secrets`, and that
     instance's connection name in `--set-cloudsql-instances`.
   - **For each other check** the release notes name, change the job's
     `--args` with `gcloud run jobs update`, and run it again.
   - A check that finds something exits `1`, and one that can't run exits
     `2`: either way its run fails, and its logs say why. Delete the job
     when you're done (`gcloud run jobs delete`).
   - In private-IP mode the server also checks that the database's
     certificate chains to the instance's CAs
     (`KINDGI_DATABASE_SERVER_CA`). The job doesn't: with the URL's
     `sslmode=require` alone, it encrypts the connection and checks no
     certificate. It only reads, over the private network.
4. **Back up the database,** just before you apply:
   - **The module's own instance** (`$N`), which holds only Kindgi's
     database, or the one `database_instance` names: an on-demand backup.

     ```sh
     gcloud sql backups create --instance=$N --description="before <version>"
     ```

   - **With `database_host_instance`,** the instance's backups are the
     app's: export Kindgi's database instead, as `upgrade.sh` does. The
     instance's own service account writes the export, so give it write on
     the bucket first:

     ```sh
     SQL_SA=$(gcloud sql instances describe <instance> --format='value(serviceAccountEmailAddress)')
     gcloud storage buckets add-iam-policy-binding gs://<bucket> \
       --member="serviceAccount:$SQL_SA" --role=roles/storage.objectAdmin
     gcloud sql export sql <instance> gs://<bucket>/<file>.sql.gz --database=<database_name>
     ```

   Writes made after the backup aren't in it.
5. **Set the new image:** `server_image` in `prod.tfvars`, to
   `$REPO/runtime@sha256:<new digest>`. If the release notes say to rebuild
   the pack, rebuild it and set `pack_image` too. Keep a copy of the file as
   it was: it's your way back.
6. **Plan, and save the plan:**

   ```sh
   (umask 077 && terraform plan -var-file=prod.tfvars -out=upgrade.tfplan)
   ```

   Terraform also reads every `*.auto.tfvars.json` in the folder, your
   pack's env among them. Read the plan: it should change the services'
   images, and what the release notes say. A plan that removes the pack's
   env was made without its file ([3. The secrets](#3-the-secrets)).

   The plan holds your variables' values, secret ones too: `umask 077`
   keeps it readable by you alone, and you delete it once it's applied.
7. **Apply exactly that plan:**

   ```sh
   terraform apply upgrade.tfplan
   rm upgrade.tfplan
   ```

   A saved plan applies as you read it, with the variables it was made
   with, so it takes no `-var-file`. If the state changed since, Terraform
   refuses it as stale: plan again. The new revision takes all the traffic
   once it's ready.
8. **Check it,** as in [6. Check it](#6-check-it).

**If it doesn't come up, go back.** Nothing rolls back on its own, and
migrations only go forward, so never point the old version at the migrated
database:

1. **First, export the erasure ledger** from the server serving now
   ([Erasures and backups](../back-up-and-restore/#erasures-and-backups)).
   It holds every erasure so far, those made after the backup too. If no
   server answers, the backup's own ledger is all there is.
2. **Save the plan that goes back, before you bring the database back.**
   Put `server_image`, and `pack_image`, back from the copy of
   `prod.tfvars` you kept, then plan, and read it:

   ```sh
   (umask 077 && terraform plan -var-file=prod.tfvars -out=back.tfplan)
   ```

   Like the upgrade's plan, this one holds your secret values too.

   The server runs its migrations each time one of its instances starts.
   So apply this plan as soon as the database is back: an instance of the
   new version that starts in between, on a restart or a scale-up, would
   migrate the database forward again.
3. **Bring the database back, then apply that plan at once:**
   - **From a backup:** restore it into the instance it came from. That
     overwrites everything on the instance, which is what going back
     needs:

     ```sh
     gcloud sql backups list --instance=$N
     gcloud sql backups restore <backup id> --restore-instance=$N
     ```

     The new version serves until the apply, and a restore takes the
     instance down for minutes. If the new version's revision started an
     instance after the restore finished (its logs show it), restore once
     more after the apply: by then only the old revision serves.

     With a database on a public IP, you can restore into a new instance
     instead, and move the server onto it, as **Restore Cloud SQL** under
     [Operate it](#operate-it) says: set `database_instance` along with the
     old images, and plan again for the apply. The server then moves and
     goes back in one revision, so the new version never serves from the
     restored instance. Private-IP mode can't serve from another instance.
   - **From an export:** make a fresh database on the instance, import the
     export into it as `kindgi`, and add a version of the server's database
     URL secret that names the fresh database, with the password set as in
     [3. The secrets](#3-the-secrets), never in a command's arguments. Add
     that version last, right before the apply. Don't change
     `database_name` instead: the module would drop the migrated database,
     then fail to create the fresh one.

     ```sh
     gcloud sql databases create <fresh> --instance=<instance>
     gcloud sql import sql <instance> gs://<bucket>/<file>.sql.gz \
       --database=<fresh> --user=kindgi
     ```

   Then apply the saved plan:

   ```sh
   terraform apply back.tfplan
   rm back.tfplan
   ```

   If Terraform refuses it as stale, plan again and apply at once.
4. **Replay the erasures before anyone uses it**
   ([Erasures and backups](../back-up-and-restore/#erasures-and-backups)).
   A replay matches only when the server has its ledger key
   (**Erasures, after a restore** under [Operate it](#operate-it)). With
   `secrets_backend = "postgres"`, also run the old version's
   `check stored-secrets`, as a job like the checks in the upgrade's
   step 3, with the server's secrets settings as well as its database URL.

## Tear it down

Cloud SQL can't be deleted while `database_deletion_protection` is on (the
default). It turns on Terraform's deletion protection and Google's, which
refuses a delete from the console, gcloud or the Cloud SQL API as well. Set
it to `false` and apply first: the apply turns both off. The KMS key ring and
key outlive `terraform destroy`: Google Cloud never deletes them. Take them
out of Terraform's state, destroy the rest, then schedule the key's versions
for destruction:

```sh
terraform apply -var-file=prod.tfvars -var=database_deletion_protection=false
terraform state rm 'google_kms_crypto_key.secrets[0]' 'google_kms_key_ring.kindgi[0]'   # none with secrets_backend = "none"
terraform destroy -var-file=prod.tfvars
gcloud kms keys versions destroy 1 --key=… --keyring=… --location=…
```

If the destroy stops at the subnet (`is already being used by …/addresses/serverless-ipv4-cloudrun-…`),
Cloud Run hasn't released its addresses: run it again later.

## Next

- [Cloud Run module reference](../cloud-run-reference/): the network, the
  secrets backend, the IAM it sets up, and its limits.
- [Operate a self-hosted runtime](../operate/): health, backups, upgrades
  and rotating keys.
- [Turn on sign-in](../sign-in/): every way in, and what each setting does.
