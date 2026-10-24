---
title: Reference
description: Every API route, SDK export, CLI command, setting and event.
sidebar:
  order: 0
  label: Overview
---

These pages describe everything you can call, import, run or set in Kindgi,
so you can look up the exact name, option or field you need. Most of them are
generated from Kindgi's own sources (the API spec, the SDKs, the CLI and the
schemas), so they match the release they document.

- **[Features by SDK](sdks/):** which features the TypeScript, Python, Java
  and Scala SDKs have, and what to do where one lacks a feature.
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
- **[Java](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java#readme)
  and Scala (preview):** the README of `com.kindgi:kindgi-client`, the API
  client for Java and Scala apps, and
  [`kindgi-pack`'s](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java/kindgi-pack),
  for packs. See also [Call Kindgi from a Java app](../start/java-app/).
- **[CLI](cli/):** every `kindgi` command, its flags and its subcommands.
- **[Environment variables](env-vars/):** every `KINDGI_*` variable the
  runtime and the pack service read.
- **[Error codes](errors/):** every error code the HTTP API answers with:
  its status, what it means, what its details hold, and the operations that
  answer it.
- **[Packages](packages/):** every public `@kindgi/*` package: what it's for
  and how to use it.
- **[JSON Schemas](schemas/):** the documents Kindgi reads and writes (the
  pack index, the pack protocol, flows, tools, events, …), field by field.
