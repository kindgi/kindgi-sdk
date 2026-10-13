---
title: Limits
description: The limits every Kindgi Cloud account has, what a call or a run sees past each one, and how to ask for more.
sidebar:
  order: 15
---

Every Kindgi Cloud account starts with the same limits. They keep one
workspace's load from slowing another's. For more, write to
contact@kindgi.com.

| Limit | What it counts | Default |
| --- | --- | --- |
| API requests | Requests to the API (`/v1`) and to artifact storage (`/s3`), together | 600 a minute |
| Webhook receives | Deliveries to your webhook triggers' receive URLs | 3,000 a minute |
| Runs at once | Top-level runs running at the same time | 20 |
| Runs pending | Runs waiting for a slot | 2,000 |
| Tool calls in flight | Tool calls running at the same time | 50 |
| Approvals pending | Approvals waiting for a decision | 500 |
| Agent turns' memory | What your workspace's running agent turns hold, by the size of their conversations | 192 MiB |
| Agent turns' memory, shared | The same for all workspaces together, so other workspaces' turns count toward it too | 384 MiB |

`GET /v1/tenant` answers your workspace's own values, as `limits`:

```json
CAPTURE: GET /v1/tenant's `limits` on the rehearsal workspace
```

Calls Kindgi's control plane makes to manage your workspace never count.

## Past each limit

### API requests

A request past the limit is refused with `429 rate-limit-exceeded`. It says
how long to wait in `Retry-After`, and which limit in `details.limit`
(`api-requests`):

```text
CAPTURE: the API requests limit's 429 body and its Retry-After header
```

Artifact storage (`/s3`) answers as S3 does, `503 SlowDown`, with
`Retry-After`:

```xml
CAPTURE: the /s3 SlowDown document
```

### Webhook receives

A delivery past the limit is refused with `429 rate-limit-exceeded`,
`details.limit: 'webhook-receives'`:

```text
CAPTURE: the webhook receives limit's 429
```

Whether the sender tries again is up to the sender. WooCommerce never
resends a delivery Kindgi refuses, and switches the webhook off after 7 in a
row ([Start runs from webhooks](../../guides/webhooks/start-runs-from-webhooks/)).

### Runs at once

A top-level run past the limit isn't refused. It's created `pending`, waits
for a slot, and starts when one frees, oldest first. A run that's waiting for
a person (suspended) holds no slot, and a run started inside another run
never waits.

### Runs pending

Past the limit of waiting runs, a new run is refused with
`429 rate-limit-exceeded`, `details.limit: 'runs-pending'`:

```text
CAPTURE: the runs pending limit's 429
```

A webhook delivery or a schedule past it starts no run. The fire is recorded
as refused (`rate-limited`), and it doesn't count toward pausing the
trigger.

```text
CAPTURE: a fire refused past runs pending, as the trigger's fires show it
```

### Tool calls in flight

A tool call past the limit waits up to 60 seconds for a slot. If none frees
in time, the call fails with `deadline-exceeded`, naming the limit:

```text
CAPTURE: the tool calls in flight limit's deadline-exceeded message
```

A run cancelled while its tool call waits stops waiting.

### Approvals pending

Past the limit, a step that would ask for an approval asks nothing. No
approval is recorded, and the step fails with `approvals-pending-limit`:

```text
CAPTURE: the approvals pending limit's step failure, as the run shows it
```

`POST /v1/runs` that waits for the run answers
`429 approvals-pending-limit`; with `wait: false` it answers 202, and the run
fails with that code. A promotion past it is also `429
approvals-pending-limit`.

```text
CAPTURE: the approvals pending limit's 429
```

### Agent turns' memory

While an agent turn runs, it holds memory for its conversation. Before each
call to the model, the turn counts four times the size of its conversation
as sent, and once more for each round it has done (a model call and its
tool calls). A resumed run's turn also counts the run's journal. A dry run
isn't counted. When the turn ends, what it held is free again.

A turn that would go past either limit fails before the model is called,
with `429 turn-memory-limit-reached`:

```json
CAPTURE: the turn's 429, as the run shows it
```

`details.limit` says which limit refused it: `tenant` for your workspace's,
`server` for the shared one. `heldBytes` and `limitBytes` say what was held
and the limit, and `runId` names the turn's run. There's no `Retry-After`:
try again later, or with a smaller conversation. Every tool call the turn
finished is in the conversation, so a new turn there doesn't call it again
([`turn-memory-limit-reached`](../../reference/errors/#turn-memory-limit-reached)).
A resume whose journal alone is over your workspace's limit fails at once.

These two limits are the same for every workspace, and `GET /v1/tenant`
doesn't list them.
