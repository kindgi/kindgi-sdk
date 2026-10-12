---
title: Contributing
description: How the SDK repository is organized and the rules for changes.
sidebar:
  order: 0
  label: Overview
---

These pages show how the SDK repository is organized and what every change
to it must pass. They come from the contributor docs in the
[kindgi-sdk repository](https://github.com/kindgi/kindgi-sdk), so they change
with the code.

- [The repository](repository/): setup, the checks every change passes, and
  how releases work.
- [API route conventions](api-route-conventions/): URL shapes, auth, request
  and response bodies, pagination, streaming and errors for every `/v1` route.
- [Adding an HTTP route](adding-a-route/): the checklist, from the handler to
  the generated OpenAPI document and the TypeScript client.

While the SDK is in preview, the repository doesn't accept external
contributions. To report a problem with Kindgi or with these docs, open an
issue in the repository. Report a security vulnerability privately, as the
repository's security policy describes.
