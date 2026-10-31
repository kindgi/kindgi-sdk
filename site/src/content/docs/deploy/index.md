---
title: Where your agents run
description: Kindgi Cloud runs Kindgi for you, or you run it in your own infrastructure. Where to start for each, and the pages that apply to both.
sidebar:
  order: 0
  label: Overview
---

Your agents run in one of two places:

- **Kindgi Cloud:** we run Kindgi for you. You deploy your pack with the
  Kindgi CLI, and Kindgi Cloud builds it and runs it.
- **Self-hosted:** you run Kindgi in your own infrastructure, next to your
  data, and operate it there.

Either way, you build and test the pack on your machine with `kindgi dev`.

## Kindgi Cloud

We run it for you. In private preview.

- **[Deploy your agent to Kindgi Cloud](../hosted/deploy-your-agent/):**
  sign the CLI in, sign the pack, give it your model key, deploy it, try it
  and go live. Then change an agent once it's live.
- **[Limits](../hosted/limits/):** the limits every Kindgi Cloud account
  has, what a call or a run sees past each one, and how to ask for more.

## Self-hosted

Kindgi is self-host first: the runtime you run on your machine with
`kindgi dev` is the same image you deploy. Your pack's code runs beside it,
in a pack service built from your app.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../deploy/self-hosted/pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::

- **[Self-host with Docker](self-hosted/self-host/):** the runtime and your pack
  service as containers, with your own Postgres.
- **[Operate it](self-hosted/operate/):** health and logs, backups and restores,
  upgrades, and rotating its tokens and keys.
- **[Serve many tenants](self-hosted/serve-many-tenants/):** one runtime for tenants
  who don't trust one another: the settings it starts only with, the
  operator's system keys, a pack service for each deployment, and closing
  and purging a tenant.
- **[Keep secrets in your own secret manager](self-hosted/secret-manager/):** Azure Key
  Vault, Google Secret Manager or HashiCorp Vault holds the secrets set
  through Kindgi's API, and Kindgi keeps their names and versions.
- **[Choose where the runtime keeps files](self-hosted/store-files/):** a
  directory, a Google Cloud Storage bucket, or an S3 bucket holds
  artifacts, the erasure ledger's copies and purge records.
- **[Keep and purge deleted data](retention/):** how long deleted records
  are kept, and the retention policies and sweeps that purge them.
- **[Turn on sign-in](self-hosted/sign-in/):** people sign in to the console with their
  organization's identity provider, Google, Microsoft or GitHub, or a link
  by email.
- **[Publish the addresses your calls come from](self-hosted/egress-addresses/):** for
  a site that admits only known addresses, and `kindgi egress` to print
  them.
- **[Google Cloud Run](self-hosted/cloud-run/):** the runtime and your pack's service as
  two Cloud Run services, with Cloud SQL, from Kindgi's Terraform module.
- **[Azure Container Apps](self-hosted/azure-container-apps/):** the runtime and your
  pack's service as two container apps, with PostgreSQL Flexible Server and
  Key Vault, from Kindgi's Terraform module.

## On both

These pages apply on Kindgi Cloud and on a runtime you run. Each says, in an
**On Kindgi Cloud** note, what's different there.

- **[People, API keys and service accounts](people-and-keys/):** add people
  and give them roles and their own keys, give pipelines service accounts,
  and remove someone in one step.
- **[Ship a pack from CI](ship-from-ci/):** test on every pull request,
  deploy to staging from main, and promote the same signed build to prod
  through its release gate policy, with keys that reach only what each step
  needs.
- **[Run with authorization](authorization/):** what it gives and what it
  doesn't. On a runtime you run, you run OpenFGA next to it.
