---
title: Webhooks
description: Get a signed run.finished request when a run ends, verify it in your app, and test and replay deliveries.
sidebar:
  order: 0
  label: Overview
---

Instead of polling a run, let Kindgi tell your app when it ends. Register a
**webhook endpoint**, a URL in your app, and Kindgi sends it a signed
`run.finished` request each time a run you started completes, fails or is
cancelled.

- [Get a webhook when a run finishes](receive-run-finished/): the signing
  secret, registering the endpoint, and what each request carries.
- [Verify a webhook](verify-a-webhook/): check the signature in TypeScript
  or Python, and deduplicate retries.
- [Test and replay deliveries](test-and-replay/): send a test event, see
  what was delivered, and send a failed delivery again.

Requests are signed in the [Standard Webhooks](https://www.standardwebhooks.com)
format, so a receiver in another language can use any Standard Webhooks
library.
