# Run events: progress in the browser, webhooks when a run finishes

Your application starts a run with `POST /v1/runs` (with `options.wait: false`, the call returns at once with the run id). Two ways to follow it:

- **In the browser, while it runs:** hand the browser a public run token and let it follow the run's events directly (below).
- **On your server, when it ends:** register a **webhook endpoint**; Kindgi sends it a signed `run.finished` event when a top-level run completes, fails or is cancelled.

## Follow a run from the browser

When the deployment issues public run tokens, `POST /v1/runs` returns `publicAccessToken`: a short-lived (15 minutes by default), read-only token for that run. Your backend passes the run id and the token to the browser, which follows the run without any secret:

```ts
import { subscribeToRun } from '@kindgi/sdk/client';

for await (const event of subscribeToRun({
  apiUrl: 'https://kindgi.example.com',
  runId,
  accessToken, // from your backend
  refreshAccessToken: () => fetch('/api/kindgi-token?runId=' + runId).then((r) => r.text()),
})) {
  showProgress(event.kind, event.nodeId); // run.step-started, run.step-completed, …
}
// The loop ends after run.completed, run.failed or run.cancelled.
```

- The token can follow only the runs it names and their descendants (an agent step's turn, for example), and only through the progress routes, `GET /v1/runs/{runId}/progress` and `GET /v1/runs/{runId}/progress/stream`. Every other route answers 403.
- Progress is status, steps and timing, never inputs, outputs or payloads. Show the result from your own backend.
- To mint a fresh token (when one expires, or for runs started elsewhere), your backend calls `POST /v1/tokens/public` (`client.tokens.createPublic({ runIds })`).
- The deployment lists your site's origin in `KINDGI_CORS_ORIGINS`, so the browser may call it.

`subscribeToRun` reconnects by itself (the server ends a stream after a few minutes; it resumes after the last event) and calls `refreshAccessToken` when the token expires.

## Register an endpoint

Kindgi signs each request with a secret your receiver also knows. It lives with your other secrets, and the endpoint refers to it by name:

1. Create a strong secret: `POST /v1/webhook-endpoints/generate-secret` (`kindgi.webhookEndpoints.generateSecret()`), `generateWebhookSecret()` from `@kindgi/sdk/webhooks` (`webhooks.generate_secret()` in Python), or any `whsec_` + base64 of at least 24 random bytes.
2. Store it where both sides read secrets: your `.env` in development (`ACME_WEBHOOK_SECRET=whsec_…`), your secrets store in production (`POST /v1/secrets`).
3. Register the endpoint with its name:

```ts
import { createClient } from '@kindgi/sdk/client';

const kindgi = createClient({ apiUrl, auth: { kind: 'apiToken', token } });
const endpoint = await kindgi.webhookEndpoints.create({
  url: 'https://app.example.com/hooks/kindgi',
  events: ['run.finished'],
  secretRef: { envName: 'local', name: 'ACME_WEBHOOK_SECRET' },
  filter: { flowIds: ['acme.order-review'] }, // optional
});
```

Kindgi checks that the secret exists and is strong (`400 webhook-secret-not-found`, `400 webhook-secret-too-weak`), and keeps only its name.

The filter narrows which runs reach the endpoint: `projectId`, `flowIds` (any version), and `includeDryRuns` (dry runs are left out by default). Runs started inside another run, such as an agent step's turn, never produce `run.finished`.

The deployment may refuse some URLs: production deployments typically require https and refuse private network addresses (`400 webhook-url-refused`, with the reason).

## What your endpoint receives

```http
POST /hooks/kindgi
content-type: application/json
webhook-id: 5c6f…            (the event id: the same on every retry)
webhook-timestamp: 1759363200
webhook-signature: v1,K7m…=

{
  "id": "5c6f…",
  "type": "run.finished",
  "createdAt": "2026-10-02T00:00:00.000Z",
  "data": {
    "run": {
      "id": "…", "projectId": "…", "flowId": "acme.order-review", "flowVersion": "1.0.0",
      "status": "completed", "dryRun": false, "failureMessage": null,
      "createdAt": "…", "completedAt": "…"
    }
  }
}
```

`status` is `completed`, `failed` or `cancelled`; `failureMessage` says why when it isn't `completed`. The event carries the run's identity and outcome, never its input or output: fetch the run (`GET /v1/runs/{runId}`) if you need more, or have the flow's last step write its result where your application reads it.

Answer with any 2xx status within 10 seconds. Anything else, or no answer, is retried with backoff for about a day. Delivery is **at least once**: deduplicate on `webhook-id`.

## Verify the signature

Requests are signed in the [Standard Webhooks](https://www.standardwebhooks.com) format. Verify against the **raw** body, before parsing it:

```ts
import { verifyWebhook } from '@kindgi/sdk/webhooks';

const result = verifyWebhook({ secret, headers: request.headers, body: rawBody });
if (result.kind !== 'ok') return new Response(null, { status: 401 });
if (await alreadyHandled(result.id)) return new Response(null, { status: 204 });
```

In Python, `kindgi.webhooks` does the same (see the [Python SDK](../sdks/python/README.md#receiving-webhooks)):

```python
from kindgi import webhooks

try:
    delivery = webhooks.verify(secret, request.headers, raw_body)
except webhooks.WebhookVerificationError:
    return Response(status_code=401)
event = webhooks.parse_event(raw_body)  # RunFinishedEvent | WebhookTestEvent
```

Both reject timestamps more than 5 minutes from your clock and compare in constant time. In other languages, use any Standard Webhooks library with the same secret.

## Operate it

| You want to | Call |
| --- | --- |
| Check the receiver end to end | `POST /v1/webhook-endpoints/{endpointId}/test` sends a signed `webhook.test` event |
| See what was sent and how the endpoint answered | `GET /v1/webhook-endpoints/{endpointId}/deliveries` (`?status=failed` for the ones that gave up) |
| Send an event again | `POST /v1/webhook-endpoints/{endpointId}/deliveries/{deliveryId}/redeliver` |
| Replace the secret | Rotate it in your secrets store (`POST /v1/secrets/{name}/rotate`): for a day, requests carry a signature for both versions, so the receiver can switch without dropping events. Or point `secretRef` at another secret (`PATCH`). In development, change the value in `.env` on both sides |
| Stop receiving events | `POST /v1/webhook-endpoints/{endpointId}/unregister` |
