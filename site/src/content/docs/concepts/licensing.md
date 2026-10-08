---
title: Licensing
description: Free to build, paid for production, and how the runtime's license key works.
sidebar:
  order: 8
---

Kindgi is free to build with. Running it in production needs a commercial
license, which comes as a license key the runtime checks when it starts.

## Two licenses

| Part | License | In short |
|---|---|---|
| The SDKs and the CLI: the `@kindgi/*` npm packages and the `kindgi` Python package | Apache-2.0 | Use, change and ship them, commercially too. |
| The runtime: the server that runs your packs, and its container image | Business Source License 1.1 | Free for non-production use, with no time limit. Production use needs a commercial license. Each release becomes Apache-2.0 four years after it's first published. |

**Non-production** means building, testing and evaluating software with
the runtime, including CI and staging environments that serve no end users
and process no live business data.

**Production** means using the runtime to serve end users or customers, or
to process live business data as part of an organization's operations.
That includes internal systems your own employees use.

## Building needs no key

```sh
kindgi dev
```

`kindgi dev` runs the runtime in development mode (`KINDGI_DEV=true`), which
needs no license key. Everything you build and test on your machine is free.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub for the
runtime image's pull credentials, and log in once with `kindgi auth registry`
(see [Install](../../start/install/#access-to-the-runtime-image)). Questions or trouble: contact@kindgi.com.
:::

## Running outside development mode

Anywhere else (a server, staging, CI that runs the runtime itself), give the
runtime its key in `KINDGI_LICENSE_KEY`, from your secrets store:

```sh
KINDGI_LICENSE_KEY=kgi_lk_…
```

When it starts, the runtime checks the key and prints the license under its
banner:

```text
  License: Docs example · non-production · until 2027-10-03
```

The check is **offline**: the runtime verifies the key's signature against
public keys built into the release. It never calls Kindgi, at startup or
later.

There are two kinds of key, both from contact@kindgi.com:

- **A production key** comes with a commercial license.
- **A non-production key** is free, for staging and CI that run the runtime
  outside development mode.

The runtime starts with either and prints which one it has.

## Without a valid key

Outside development mode, a runtime with no key doesn't start. It exits with
code 2 and says why:

```text
KINDGI_LICENSE_KEY is not set. Outside development mode the Kindgi runtime needs a license key: a production key comes with a commercial license, and a free non-production key covers staging and CI. To get one: contact@kindgi.com. Local development needs none: `kindgi dev` runs the runtime with KINDGI_DEV=true.
```

A key that was changed, or that Kindgi didn't issue, is refused the same
way, with its own message.

## When a key expires

- **From 30 days before** the expiry date, the banner warns that the key
  expires soon.
- **After it expires,** the runtime still starts for 14 days, with a warning
  that says until when.
- **After those 14 days,** it refuses to start, naming the date the key
  expired.

```text
KINDGI_LICENSE_KEY expired on 2026-07-31, more than 14 days ago. Renew it: contact@kindgi.com.
```

The key is checked only when the runtime starts, so a running server never
stops because of its key. A platform that restarts instances on its own
(scaling, a deploy) keeps working through the grace period while you renew.
