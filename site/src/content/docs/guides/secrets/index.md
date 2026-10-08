---
title: Secrets and environment
description: Where a pack's settings and secrets live on your machine and in a deployment, and how your code gets them.
sidebar:
  order: 0
  label: Overview
---

A pack's code needs three kinds of values, and Kindgi keeps them apart:

- **Secrets a tool uses for a tenant**: an API key, a signing key. A tool
  declares them by name, and Kindgi resolves them for each call from the
  tenant's secrets (`ctx.secrets`). Model providers, HTTP tools, MCP
  endpoints and webhooks name theirs the same way.
- **Env values a tool uses per project**: a base URL, a region, an account
  id, which aren't secret but differ per tenant, org or project. A tool
  declares them by name, and Kindgi resolves them for each call, the
  project's value before its org's and the tenant's (`ctx.env`).
- **Your code's own environment**: a service URL, a database your app owns,
  a feature flag. Your code reads them from `process.env` or `os.environ`,
  and the pack declares which ones it needs.

On your machine, `kindgi dev` keeps both in the pack's env files. In a
deployment, secrets live in the runtime's secrets store, and the pack
service gets the environment the pack declares.

- [Keep local values in env files](env-files/): what `kindgi dev` reads, and
  what reaches your code.
- [Store a secret](store-a-secret/): `kindgi secrets`, its environments and
  scopes.
- [Declare the environment your code reads](pack-env/): `env.required` and
  `env.optional`.
- [Set values per environment](per-environment-values/): the pack service's
  environment in staging or production, and `kindgi env plan`.

[Give a tool a secret](../tools/give-a-tool-a-secret/) and
[Give a tool per-project values](../tools/give-a-tool-env-values/) show the
tool's side.
