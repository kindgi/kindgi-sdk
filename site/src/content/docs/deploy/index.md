---
title: Deploy
description: Run Kindgi in your own infrastructure.
sidebar:
  order: 0
  label: Overview
---

Kindgi is self-host first: the runtime you run on your machine with
`kindgi dev` is the same image you deploy into your own infrastructure, next
to your data. Your pack's code runs beside it, in a pack service built from
your app.

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com.
:::

- **[Self-host with Docker](self-host/):** the runtime and your pack
  service as containers, with your own Postgres.
- **[Operate it](operate/):** health and logs, backups and restores,
  upgrades, and rotating its tokens and keys.
- **[Keep and purge deleted data](retention/):** how long deleted records
  are kept, and the retention policies and sweeps that purge them.
- **[Run with authorization](authorization/):** what it gives today and
  what it doesn't yet, and running OpenFGA next to the runtime.
- **[Google Cloud Run](cloud-run/):** the runtime and your pack's service as
  two Cloud Run services, with Cloud SQL, from Kindgi's Terraform module.
- **[Azure Container Apps](azure-container-apps/):** the runtime and your
  pack's service as two container apps, with PostgreSQL Flexible Server and
  Key Vault, from Kindgi's Terraform module.
- **Kindgi Cloud:** we run it for you. In private preview.
