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
your app. (The 0.1.5 CLI's `kindgi dev` runs runtime 0.1.5; deploy 0.1.5.1,
its [security fix](operate/#runtime-0151) for authorization, which changes
nothing under `kindgi dev`.)

:::note[Access to the runtime image]
The runtime image is in private preview: request access at contact@kindgi.com.
You get its pull credentials, a robot name and a token, and log in once with
`kindgi auth registry` (see [Install](../start/install/#access-to-the-runtime-image)).
:::

- **[Self-host with Docker](self-host/):** the runtime and your pack
  service as containers, with your own Postgres.
- **[Operate it](operate/):** health and logs, backups and restores,
  upgrades, and rotating its tokens and keys.
- **[Keep and purge deleted data](retention/):** how long deleted records
  are kept, and the retention policies and sweeps that purge them.
- **[Run with authorization](authorization/):** what it gives today and
  what it doesn't yet, and running OpenFGA next to the runtime.
- **[People, API keys and service accounts](people-and-keys/):** add people
  and give them roles and their own keys, give pipelines service accounts,
  and remove someone in one step.
- **[Turn on sign-in](sign-in/):** people sign in to the console with their
  organization's identity provider, Google, Microsoft or GitHub, or a link
  by email.
- **[Google Cloud Run](cloud-run/):** the runtime and your pack's service as
  two Cloud Run services, with Cloud SQL, from Kindgi's Terraform module.
- **Kindgi Cloud:** we run it for you. In private preview.
