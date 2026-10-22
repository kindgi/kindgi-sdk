---
title: Cloud Run module reference
description: What Kindgi's Cloud Run Terraform module creates and grants, the settings that change its network and secrets, how the runtime calls your pack's service, and the module's limits.
sidebar:
  order: 2.2
  label: Cloud Run module reference
---

This page lists what Kindgi's Cloud Run module sets up: its network, its
secrets backend, the IAM it grants, and its limits.
[Deploy on Google Cloud Run](../cloud-run/) walks through a deployment with
it. The module's `variables.tf` lists every variable, with its description
and default.

## A new VPC, or yours

`network_mode` decides how both services reach a VPC:

- **`direct`,** the default, in `example.tfvars`: the module creates a VPC,
  a subnet, Direct VPC egress for all traffic, and Cloud NAT. The subnet is
  `subnet_cidr`, `10.10.0.0/24` by default. Pick it when your tools reach
  only the internet, or nothing outside your pack.
- **`connector`,** in `example-connector.tfvars`: both services use a
  Serverless VPC Access connector you already have, for private ranges only.
  Name it in `vpc_connector`, as
  `projects/<project>/locations/<region>/connectors/<name>`. The module
  creates no VPC, router or NAT. Calls to the internet go out through Cloud
  Run's own egress: model APIs, your pack service's URL and webhooks.

Pick `connector` when your pack's tools reach private resources in a VPC you
already have: a database on a private IP, an internal service. With `direct`,
the pack runs in a new VPC of its own, not connected to yours.

Connector mode also needs `pack_ingress = "INGRESS_TRAFFIC_ALL"`, as in the
example: the runtime reaches your pack's service through Cloud Run's own
egress, not the VPC, so the pack service has to accept all traffic. IAM still
admits only the runtime's service account. The module refuses connector mode
without `vpc_connector` or without that ingress, and says which.

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
Kindgi's API are envelope-encrypted in its database, under a Cloud KMS key
the module creates. Those are secrets such as a model's API key or a
webhook's secret. With `secrets_backend = "none"`:

- **Not created:** the KMS key ring and key, their grants, and the
  `$N-secrets-aad-key` secret. `secrets_aad_key_version` isn't needed.
- **The runtime stores no secrets of its own.** `/v1/secrets` isn't served:
  it answers `404 route-not-found`, and the runtime checks no KMS key at
  start.
- **Sign-in:** Continue with Google, Microsoft or GitHub and the emailed
  link work. A workspace's own identity provider needs `"postgres"`: its
  client secret and keys are references into the store, so adding or
  changing one answers `409 identity-providers-need-secrets-store`.
- **Who it fits:** a deployment whose pack's secrets all come by reference,
  in `pack_secret_env`, and whose model uses the service's own identity
  ([Gemini on Vertex AI](../cloud-run/#use-gemini)). A provider whose API key
  would be stored in Kindgi doesn't fit it.
- **An existing deployment stays as it is:** changing it from `"postgres"`
  stops the plan at the key's `prevent_destroy`, on purpose, since the
  secrets stored under it would become unreadable. Move them out first.

## How the runtime calls your pack's service

The pack's service has internal ingress and requires IAM, so nothing but the
runtime reaches it. `KINDGI_PACK_SERVICE_AUTH=google-id-token` makes the
runtime mint a Google ID token for the pack's URL, from its own service
account, on every call. Cloud Run checks it: the runtime's service account
has `roles/run.invoker` on the pack's service, and no one else does. Then the
pack's service checks the shared pack token.

If the pack's service refuses the token, the runtime's startup log says so:
`⚠ Pack service at https://… isn't answering (pack-service-unauthorized: The pack service rejected the pack token).`

## The IAM it sets up

| Who | Role | On |
|---|---|---|
| The runtime's service account | `roles/run.invoker` | the pack's service (and no one else) |
| | `roles/cloudkms.cryptoKeyEncrypterDecrypter`, not with `secrets_backend = "none"` | the KMS key (the startup check encrypts and decrypts with it) |
| | `roles/cloudkms.viewer` | the KMS key; needed only by older runtimes, whose startup check read the key's metadata |
| | `roles/artifactregistry.reader` | the repository, or yours (`image_repository`) |
| | `roles/cloudsql.client` | the project, conditioned on Kindgi's instance |
| | `roles/cloudsql.client`, only with `database_instance` | the project, conditioned on that instance, with a condition of its own: [serving from a restored instance](../cloud-run/#operate-it) |
| | `roles/secretmanager.secretAccessor` | each of its secrets, and each one in `server_secret_env`; not `database_instance`'s `url_secret`, which you grant |
| | `roles/aiplatform.user`, only with `vertex_ai = true` | the project: [Gemini](../cloud-run/#use-gemini) |
| | `roles/cloudkms.signerVerifier` and `roles/cloudkms.publicKeyViewer`, only with `export_signing = "kms"` | the export signing key: [signed exports](../../../guides/observability/export-signed-evidence/) |
| The pack's service account | `roles/secretmanager.secretAccessor` | the pack token and your pack's secrets |
| | `roles/run.invoker` | each service in `pack_run_invokers` |
| | what your tools need | your own resources |

## Limits

- **One runtime instance.** Several instances sharing one database aren't
  verified, so the module runs one.

## See also

- [Deploy on Google Cloud Run](../cloud-run/): the deployment, step by step.
- [Operate a self-hosted runtime](../operate/): health, backups and
  upgrades.
