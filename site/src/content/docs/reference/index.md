---
title: Reference
description: Every API route, SDK export, CLI command, setting and event.
sidebar:
  order: 0
  label: Overview
---

The reference is generated from Kindgi's own sources (the API spec, the
SDKs, the CLI and the schemas), so it matches the release it documents.

- **[HTTP API](api/):** every route, its parameters, request and response
  bodies, and the errors it answers, with a request example for each. From
  the API's OpenAPI specification.
- **[TypeScript](typescript/sdk/):** `@kindgi/sdk`, by the path you import
  from:
  - `@kindgi/sdk/define`: defining tools, agents, flows and checks;
  - `@kindgi/sdk/client`: the API client, its resources and its errors;
  - `@kindgi/sdk/types`: IDs and shared types;
  - `@kindgi/sdk/webhooks`: verifying the webhooks Kindgi sends (server
    only).

  Everything is also exported from `@kindgi/sdk` itself.
- **[Python](python/):** the `kindgi` package: authoring (`kindgi`), the API
  client (`kindgi.client`) with every `client.<resource>` and the API's
  models, `kindgi.webhooks`, and `python -m kindgi.pack`.
- **[CLI](cli/):** every `kindgi` command, its flags and its subcommands.
- **[Environment variables](env-vars/):** every `KINDGI_*` variable the
  runtime and the pack service read.
- **[Packages](packages/):** every public `@kindgi/*` package: what it's for
  and how to use it.
- **[JSON Schemas](schemas/):** the documents Kindgi reads and writes (the
  pack index, the pack protocol, flows, tools, events, …), field by field.
