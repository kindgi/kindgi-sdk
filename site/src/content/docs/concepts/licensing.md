---
title: Licensing
description: Free to build, paid for production, and how the runtime's license key works.
sidebar:
  order: 8
---

This page explains what you can do with Kindgi for free, when you need a
license, and how the runtime checks its license key.

Kindgi is free to build with. Running it in production needs a commercial
license. The license comes as a key, which the runtime checks when it starts.

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

`kindgi dev` runs the runtime in development mode, with `KINDGI_DEV=true`.
Development mode needs no license key, so everything you build and test on
your machine is free.

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub for the
runtime image's pull credentials, and log in once with `kindgi auth registry`
(see [Install](../../start/install/#access-to-the-runtime-image)). Questions or trouble: contact@kindgi.com.
:::

## Running outside development mode

Anywhere else, the runtime needs its key: on a server, in staging, and in CI
that runs the runtime itself. It reads the key from the `KINDGI_LICENSE_KEY`
environment variable, which you set from your secrets store. A key starts
with `kgi_lk_`.

When it starts, the runtime checks the key and prints the license under its
banner:

```text
  License: Docs example · non-production · until 2027-10-03
```

The check is **offline**: the runtime verifies the key's signature against
public keys built into the release. It never calls Kindgi, at startup or
later.

There are two kinds of key:

- **A production key** comes with a commercial license, from
  contact@kindgi.com.
- **A non-production key** is free, for staging and CI that run the runtime
  outside development mode. Get one at
  [access.kindgi.com](https://access.kindgi.com), or from contact@kindgi.com.

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
  expires soon, and says how to renew it. Where the deployment is set up to
  serve one tenant (without `KINDGI_TENANCY=multi`) and its database holds
  only that one, that tenant's admins also see a line on every console page.
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

To renew a production key, which goes with your contract, write to
contact@kindgi.com. A non-production key from access.kindgi.com renews when
you sign in there again. When access.kindgi.com has it turned on, a
deployment can also renew its key itself, by hand or on a schedule. See
[Renew the license key](../../deploy/self-hosted/renew-the-license-key/).

## Preview releases stop starting after 90 days

Until Kindgi 1.0, each runtime release stops starting 90 days after it was
released. That holds in every mode, development mode included. A setup that
upgrades with each release never meets it.

- **From 30 days before,** the startup banner warns, and so does
  `kindgi dev`. So does the console, for the same tenant admins as a key's
  expiry ([above](#when-a-key-expires)).
- **From that day on,** the runtime refuses to start, with exit code 2. In
  development mode it says:

  ```text
  This preview build of the Kindgi runtime (0.1.0-preview.3, released 2026-07-01) expired on 2026-09-29: until Kindgi 1.0, a release stops starting 90 days after it was released. Run a newer release. With `kindgi dev`, update the Kindgi CLI (`@kindgi/cli`, or `kindgi-cli` from PyPI): it runs the runtime release the CLI pins.
  ```

  Outside development mode it ends "Run a newer release, or start this one
  with a production license key: contact@kindgi.com."
- **A running server never stops,** as with a key. But a platform that
  restarts instances on its own (Cloud Run, Container Apps) doesn't bring
  one back after that day. **Upgrade at least every 90 days** while Kindgi is
  in preview.
- **A production key exempts** the build.
- **`GET /v1/license` reports it** as `preview`: the version, when it was
  released, the day it stops starting, and the days left.
- **For a log alert:** in the JSON log format, the warning is also a record
  with `"event": "kindgi.preview_expiry"`. It's logged at startup and once a
  day while the server runs, and once more when the runtime refuses to start.
- **From 1.0 on,** releases don't expire.
