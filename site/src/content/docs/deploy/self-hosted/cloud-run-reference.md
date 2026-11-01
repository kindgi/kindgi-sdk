---
title: Cloud Run module reference
description: What Kindgi's Cloud Run Terraform module creates and grants, the settings that change its network and secrets, how the runtime calls your pack services, and the module's limits.
sidebar:
  order: 2.2
  label: Cloud Run module reference
---

This page lists what Kindgi's Cloud Run module sets up: its network, its
secrets backend, how the runtime calls your pack services, the IAM it
grants, and its limits.
[Deploy on Google Cloud Run](../cloud-run/) walks through a deployment with
it. The module's `variables.tf` lists every variable, with its description
and default.

## A new VPC, or yours

`network_mode` decides how the runtime and the pack services reach a VPC:

- **`direct`,** the default, in `example.tfvars`: the module creates a VPC,
  a subnet, Direct VPC egress for all the runtime's traffic, and Cloud NAT.
  The subnet is `subnet_cidr`, `10.10.0.0/24` by default. The pack services
  take internal traffic only, which the runtime sends through the VPC.
  Their own calls go out through Cloud Run's egress, to the internet. Pick
  it when your tools reach only the internet, or nothing outside your pack.
- **`connector`,** in `example-connector.tfvars`: the runtime and every pack
  service use a Serverless VPC Access connector you already have, for
  private ranges only. Name it in `vpc_connector`, as
  `projects/<project>/locations/<region>/connectors/<name>`. The module
  creates no VPC, router or NAT. Calls to the internet go out through Cloud
  Run's own egress: model APIs, the pack services' URLs and webhooks.

Pick `connector` when your pack's tools reach private resources in a VPC you
already have: a database on a private IP, an internal service. With `direct`,
the module's VPC is a new one, not connected to yours, and the pack services
reach no VPC at all.

Connector mode also needs `pack_ingress = "INGRESS_TRAFFIC_ALL"`, as in the
example: the runtime reaches each pack service through Cloud Run's own
egress, not the VPC, so the pack services have to accept all traffic. IAM
still admits only accounts that may invoke the project's services, the
runtime's among them. The module refuses connector mode without
`vpc_connector` or without that ingress, and says which.

### Cloud NAT ports

With `direct`, the server's calls to the internet go out through the
module's Cloud NAT, and so does Cloud Run's Cloud SQL connection to a
database on a public IP. The NAT gives each server instance ports, one per
connection open at the same time to one destination (an address, port and
protocol). A closed connection's port stays taken for
`nat_tcp_time_wait_timeout_sec`, 30 seconds by default.

Each server instance starts with `nat_min_ports_per_vm` ports, 64 by
default. When it nears that limit, the NAT doubles its ports, up to
`nat_max_ports_per_vm`, 4096 by default. While the NAT adds ports, a new
connection can time out. The NAT's
`router.googleapis.com/nat/dropped_sent_packets_count` metric counts such
drops, with `reason = OUT_OF_RESOURCES`. If it shows any, raise
`nat_min_ports_per_vm`. Each NAT address has 64,512 TCP ports for all
instances together, and with `nat_static_ip` its one address is the ceiling
([how Cloud NAT assigns ports](https://docs.cloud.google.com/nat/docs/ports-and-addresses)).

Lowering `nat_max_ports_per_vm` later breaks the NAT's open connections
([Google's list of NAT changes that drop connections](https://docs.cloud.google.com/nat/docs/tune-nat-configuration)).
Upgrading from a module copy with fixed ports doesn't, as long as
`nat_max_ports_per_vm` stays at 1024 or more. Cloud NAT bills by the
instances using it, the data it processes and its addresses, not by port
([Cloud NAT pricing](https://cloud.google.com/nat/pricing)).

Dynamic ports need the NAT's endpoint-independent mapping off. Google's list
covers turning the mapping off and turning dynamic ports on one at a time,
not both in one update, and says an incompatible change fails. So before
upgrading, check the mapping. The module names both the router and the NAT
`<name_prefix>-nat`:

```sh
gcloud compute routers nats describe <name_prefix>-nat \
  --router=<name_prefix>-nat --region=<region> \
  --format='value(enableEndpointIndependentMapping)'
```

If it prints `True`, turn the mapping off on its own first, which drops no
connections, then apply:

```sh
gcloud compute routers nats update <name_prefix>-nat \
  --router=<name_prefix>-nat --region=<region> \
  --no-enable-endpoint-independent-mapping
```

## Without a KMS key

By default, with `secrets_backend = "postgres"`, the secrets set through
Kindgi's API are envelope-encrypted in its database, under the module's
Cloud KMS key. Those are secrets such as a model's API key or a webhook's
secret. The key exists with either setting: each pack service's token is
sealed under it. With `secrets_backend = "none"`:

- **Not created:** the `$N-secrets-aad-key` secret, and the runtime's read
  access to it. `secrets_aad_key_version` isn't needed.
- **The runtime stores no secrets of its own.** `/v1/secrets` isn't served:
  it answers `404 route-not-found`. At start the runtime checks the KMS key
  for the pack services' tokens only, not for a store.
- **A pack gets its plain env values and cloud secrets only,** never a
  secret stored in Kindgi
  ([Read a secret of yours](../cloud-run/#read-a-secret-of-yours)).
- **No webhooks, in or out.** A webhook trigger's signing secret, and an
  endpoint's, are kept in the store. So `/v1/webhooks`, `/v1/hooks` and
  `/v1/webhook-endpoints` aren't served either: no webhook starts a run,
  and none is sent.
- **Sign-in:** Continue with Google, Microsoft or GitHub and the emailed
  link work. A workspace's own identity provider needs `"postgres"`: its
  client secret and keys are references into the store, so adding or
  changing one answers `409 identity-providers-need-secrets-store`.
- **Who it fits:** a deployment whose packs need plain env values and cloud secrets only,
  whose model uses the service's own identity
  ([Gemini on Vertex AI](../cloud-run/#use-gemini)), and that takes and sends
  no webhooks. A provider whose API key would be stored in Kindgi doesn't
  fit it.
- **An existing deployment from `"postgres"`:** the secrets stored under the
  key would become unreadable to the runtime. Move them out first. The key
  itself stays, since the pack services' tokens are sealed under it.

### Turn the store on later

Going from `"none"` to `"postgres"` moves nothing, since nothing was stored.
The key is there already, and the pack services' tokens stay sealed under
it. The server's next revision reads the `$N-secrets-aad-key` secret, so
that secret comes first, before the services change:

1. Set `secrets_backend = "postgres"`. Leave `secrets_aad_key_version`
   unset until step 4.
2. Apply only what the store stands on: the new secret, with the server's
   read access. The targets also name the APIs and the server's grant on the
   key, which are there already.

   ```sh
   terraform apply -var-file=prod.tfvars \
     -target=google_project_service.apis \
     -target=google_kms_crypto_key_iam_member.server_wraps \
     -target=google_secret_manager_secret_iam_member.server_reads
   ```

   Terraform warns that resource targeting is in effect and the applied
   changes may be incomplete. Both are expected: step 4 completes them.

3. Add the secret's first version, as in [The secrets](../cloud-run/#3-the-secrets):

   ```sh
   openssl rand 32 | base64 | gcloud secrets versions add $N-secrets-aad-key --data-file=-
   ```

4. Set `secrets_aad_key_version = "1"`, and apply in full, as in
   [The services](../cloud-run/#4-the-services). The server's new revision
   stores secrets in Postgres and checks the KMS key for the store at start
   too. Webhooks, and a workspace's own identity providers, work from then
   on.

## How the runtime calls your pack services

Each deployment of your pack has a Cloud Run service of its own, which the
pack orchestrator makes, named `kp-…`
([Turn on the pack orchestrator](../cloud-run/#turn-on-the-pack-orchestrator)).
The orchestrator records the service's URL and its token through the
runtime's system routes. The runtime keeps the token sealed under the
module's KMS key (`KINDGI_PACK_ENDPOINT_KMS_KEY`).

Each tool call goes to the newest deployment in the run's project that
shipped the tool version it names (`KINDGI_PACK_ROUTING=per-deployment`). On
every call:

- **The host has to match.** The runtime calls only a URL whose host matches
  `KINDGI_PACK_ENDPOINT_HOSTS`, which the module sets to
  `*-<project number>.<region>.run.app`: this project's services in this
  region. Cloud Run's other URL for a service, the one ending in
  `.a.run.app`, doesn't match.
- **Cloud Run checks a Google ID token.** The runtime mints one for the
  service's URL from its own service account. That account has
  `roles/run.servicesInvoker` on the project, so it may invoke each pack
  service the orchestrator makes, and run none of the project's Jobs. The pack
  services require IAM, so nothing without the role reaches them.
- **The pack service checks its own token,** the one the runtime unsealed.

A tool call the runtime can't route answers with a code of its own:

- `pack-endpoint-pending`: the deployment's service isn't ready yet. A new
  deployment waits for the orchestrator's next pass, within about a minute.
- `pack-endpoint-cleared`: the deployment's service was taken down.
- `pack-route-missing`: no deployment into the run's project (the default
  project, for a run with none) shipped that version. A deployment registered before the runtime
  routed per deployment has no routes either: deploy it again
  ([5. Trust your key, and deploy](../cloud-run/#5-trust-your-key-and-deploy)).

## The IAM it sets up

| Who | Role | On |
|---|---|---|
| The runtime's service account | `roles/run.servicesInvoker` | the project, so it may invoke each pack service |
| | `roles/cloudkms.cryptoKeyEncrypterDecrypter` | the KMS key (it seals the pack services' tokens, and the startup checks encrypt and decrypt with it) |
| | `roles/cloudkms.viewer` | the KMS key; needed only by older runtimes, whose startup check read the key's metadata |
| | `roles/artifactregistry.reader` | the repository, or yours (`image_repository`) |
| | `roles/cloudsql.client` | the project, conditioned on Kindgi's instance |
| | `roles/cloudsql.client`, only with `database_instance` | the project, conditioned on that instance, with a condition of its own: [serving from a restored instance](../cloud-run/#operate-it) |
| | `roles/secretmanager.secretAccessor` | each of its secrets, and each one in `server_secret_env`; not `database_instance`'s `url_secret`, which you grant |
| | `roles/aiplatform.user`, only with `vertex_ai = true` | the project: [Gemini](../cloud-run/#use-gemini) |
| | `roles/cloudkms.signerVerifier` and `roles/cloudkms.publicKeyViewer`, only with `export_signing = "kms"` | the export signing key: [signed exports](../../../guides/observability/export-signed-evidence/) |
| The pack orchestrator's account (`$N-orch`) | `roles/run.developer` | the project: it creates, updates and deletes the pack services, and runs its Job, Cloud Scheduler's call included; it reads a service's IAM policy and never sets one |
| | `roles/iam.serviceAccountUser` | the pack account, so each pack service runs as it, and as no other account |
| | `roles/artifactregistry.reader` | the repository, or yours (`image_repository`): Cloud Run checks that whoever makes a service, or a new revision of one, may read its image |
| | `<prefix>_pack_secrets`, a custom role (`name_prefix` with `-` as `_`) | the project, conditioned on secrets whose name starts with `kp-`: it gets and deletes them, and adds, lists and destroys their versions; it never reads a value |
| | `<prefix>_secret_create_list`, a custom role | the project, with no condition, since a create and a list name the project: it creates secrets, which hold no value until the `kp-` role adds one, and lists them, names and labels only, to find what a stopped pass left |
| | `roles/secretmanager.secretAccessor` | its key, `$N-orchestrator-key` |
| | `roles/run.invoker`, only behind Cloud Run IAM | the runtime's service; the Job then sends a Google ID token with each call (`KINDGI_ORCHESTRATOR_RUNTIME_AUTH=google-id-token`) |
| The pack account (`$N-pack`), which every pack service runs as | `roles/secretmanager.secretAccessor` | the project, conditioned on secrets whose name starts with `kp-`: each service's token and secret env values |
| | `roles/secretmanager.secretAccessor` | each secret in `pack_secret_readers`, in its own project |
| | `roles/cloudsql.client`, only with `pack_cloud_sql_instances` | the project |
| | `roles/storage.objectViewer` | each bucket in `pack_bucket_readers`, narrowed by `pack_bucket_object_prefixes` |
| | `roles/run.invoker` | each service in `pack_run_invokers` |
| | what your tools need | your own resources |

## Limits

- **One runtime instance.** Several instances sharing one database aren't
  verified, so the module runs one.
- **One installation per project.** The runtime may invoke every Cloud Run
  service in the project, the orchestrator may create and delete them, and
  the pack account may read every `kp-` secret in it. So two installations
  in one project would reach each other's pack services and secrets.
  `name_prefix` can't be `kp` or start with `kp-`.
- **1,000 services per region in a project**, which a quota request can
  raise ([Cloud Run quotas](https://cloud.google.com/run/quotas)). Each
  deployment the runtime still serves has one, so unregister old versions
  you don't need.
- **A region with Cloud Scheduler.** The orchestrator's schedule is made in
  the module's `region`
  ([Cloud Scheduler locations](https://cloud.google.com/scheduler/docs/locations)).
  Some Cloud Run regions have none, such as `us-east5`, `europe-north1` and
  `australia-southeast2`, and the schedule can't be made there.

## See also

- [Deploy on Google Cloud Run](../cloud-run/): the deployment, step by step.
- [Operate a self-hosted runtime](../operate/): health, backups and
  upgrades.
