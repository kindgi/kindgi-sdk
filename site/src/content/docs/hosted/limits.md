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
| API requests | Requests to the API (`/v1`) | 600 a minute |
| Webhook receives | Deliveries to your webhook triggers' receive URLs | 3,000 a minute |
| Runs at once | Top-level runs running at the same time | 20 |
| Runs pending | Runs waiting for a slot | 2,000 |
| Tool calls in flight | Tool calls running at the same time | 50 |
| Approvals pending | Approvals waiting for a decision | 500 |
| Projects in production | Projects in production at the same time | 1 |
| Projects with their own tool identity | Projects whose tools' code runs under an identity of their own | 3 |
| Agent turns' memory | What your workspace's running agent turns hold, by the size of their conversations | 192 MiB |
| Agent turns' memory, shared | The same for all workspaces together, so other workspaces' turns count toward it too | 384 MiB |

`GET /v1/tenant` answers your workspace's own values, as `limits`. It gives
the limits, not how much of each is in use. `productionAllowed` says whether
your workspace can put a project in production
([Projects in production](#projects-in-production)).

```json
{"id":"…","name":"Example Studio","slug":"ex-6bc9a070","createdAt":"2026-10-15T18:39:15.557Z","updatedAt":"2026-10-15T18:39:15.566Z","productionAllowed":true,"limits":{"apiRequestsPerMinute":600,"webhookReceivesPerMinute":3000,"runsAtOnce":20,"runsPending":2000,"toolCallsInFlight":50,"approvalsPending":500,"projectsInProduction":1}}
```

Calls Kindgi's control plane makes to manage your workspace never count.

## Past each limit

### API requests

A request past the limit is refused with `429 rate-limit-exceeded`. It says
how long to wait in `Retry-After`, and which limit in `details.limit`
(`api-requests`):

```text
HTTP 429
retry-after: 33
{"error":{"code":"rate-limit-exceeded","message":"This workspace's limit on API requests a minute is reached: try again in 33 s.","details":{"limit":"api-requests"},"requestId":"req-…"}}
```

### Webhook receives

Each trigger also has a limit of its own, checked first: 600 deliveries a
minute by default, at most 6,000, set with `--rate-limit`
([Start runs from webhooks](../../guides/webhooks/start-runs-from-webhooks/#what-kindgi-does-with-each-request)).
A trigger at the default never reaches your workspace's 3,000: its own limit
refuses first, with `429 rate-limit-exceeded` and no `details.limit`:

```text
HTTP 429
retry-after: 55
{"error":{"code":"rate-limit-exceeded","message":"Too many deliveries to this trigger: try again shortly","requestId":"req-…"}}
```

Past your workspace's limit, a delivery is refused with
`429 rate-limit-exceeded`, with `Retry-After` and
`details.limit: 'webhook-receives'`:

```text
HTTP 429
retry-after: 38
{"error":{"code":"rate-limit-exceeded","message":"This workspace's limit on webhook deliveries a minute is reached: try again in 38 s.","details":{"limit":"webhook-receives"},"requestId":"req-…"}}
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
`429 rate-limit-exceeded`, `details.limit: 'runs-pending'`. There's no
`Retry-After`:

```text
HTTP 429
{"error":{"code":"rate-limit-exceeded","message":"This workspace's limit on runs waiting to start (2000) is reached: try again once some have started.","details":{"limit":"runs-pending","runsPending":2000},"requestId":"req-…"}}
```

A webhook delivery or a schedule past it starts no run. The fire is recorded
as refused (`rate-limited`), and it doesn't count toward pausing the
trigger. A delivery is still answered `202`, with the fire's id.
`kindgi webhooks fires <trigger-id>` shows the fire:

```json
{
  "data": [
    {
      "fireId": "…",
      "triggerId": "…",
      "firedAt": "2026-10-13T11:18:47.529Z",
      "outcome": "refused",
      "detail": "rate-limited: flow acme.order-review@1.0.0 didn't start: rate-limit-exceeded: This workspace's limit on runs waiting to start (2000) is reached: try again once some have started.",
      "countsTowardPause": false
    }
  ],
  "hasMore": false
}
```

### Tool calls in flight

A tool call past the limit waits up to 60 seconds for a slot. If none frees
in time, the tool isn't run, and the call fails with `deadline-exceeded`,
naming the limit. An agent's turn takes that as it takes any tool's failure.
Here an agent's tool call waited out the minute, and its run failed with
[`tool-invocation-failed`](../../reference/errors/#tool-invocation-failed):

```text
{"id":"…","tenantId":"…","projectId":"…","flowId":"agent.turn","flowVersion":"1.1.0","status":"failed",…,"createdAt":"2026-10-13T11:43:56.569Z",…,"completedAt":"2026-10-13T11:44:56.689Z",…,"failure":{"code":"tool-invocation-failed","message":"Tool \"acme.lookup-order\" was not run: deadline-exceeded: This workspace's limit on tool calls in flight (50) was reached, and no call finished before this one's deadline.","cause":{"code":"precondition-failed","message":"…","toolId":"acme.lookup-order","reason":"deadline-exceeded",…}},…}
```

A run cancelled while its tool call waits stops waiting.

### Approvals pending

Past the limit, a step that would ask for an approval asks nothing. No
approval is recorded, and the step fails with `approvals-pending-limit`:

```text
{"id":"…","tenantId":"…","projectId":"…","flowId":"agent.turn","flowVersion":"1.1.0","status":"failed",…,"failure":{"code":"approvals-pending-limit","message":"This workspace's limit on approvals waiting for a decision (500) is reached: decide some before asking for more."},…}
```

`POST /v1/runs` that waits for the run answers
`429 approvals-pending-limit`, with no `Retry-After`. `details` gives the
limit (`approvalsPending`) and the run (`runId`). With `wait: false` it
answers 202, and the run fails with that code. A request to pin an agent
version past it is also `429 approvals-pending-limit`.

```text
HTTP 429
{"error":{"code":"approvals-pending-limit","message":"This workspace's limit on approvals waiting for a decision (500) is reached: decide some before asking for more.","details":{"approvalsPending":500,"runId":"…"},"requestId":"req-…"}}
```

### Projects in production

One of your workspace's projects can be in production at a time. Putting
another in is refused with `403 production-limit-reached`, until one is
taken out. A project already in production stays in, and the others keep
working as staging
([Put a project in production](../../guides/projects/organize-by-org-and-project/#put-a-project-in-production)):

```text
HTTP 403
{"error":{"code":"production-limit-reached","message":"This workspace's limit is 1 project in production, and it has 1. To put another in production: https://platform.kindgi.com/cloud/account/billing, or take one out of production first.","details":{"projectId":"…","limit":"projects-in-production","projectsInProduction":1,"inProduction":1,"next":"https://platform.kindgi.com/cloud/account/billing"},"requestId":"req-…"}}
```

`details` gives the limit (`projectsInProduction`), how many are in
production (`inProduction`) and the project you asked for (`projectId`).
`next` is the link the message gives. Taking a project out of production is
never refused.

Production must also be allowed for your workspace, as `productionAllowed`
in `GET /v1/tenant` shows. Until it is, putting a project in production is
refused with `403 production-not-allowed` instead, and its `details.next`
links to the same page.

### Projects with their own tool identity

Your workspace's tools' code runs apart from every other workspace's. Up to
3 of its projects run their tools' code under an identity of their own, so
other projects' code can't read their secrets. Past that, projects share
one identity within your workspace: their secrets are apart from those 3
projects', not from one another's. Nothing is refused past the limit, and
`GET /v1/tenant` doesn't list it
([Your tools' code](../../concepts/security/#your-tools-code)).

### Agent turns' memory

While an agent turn runs, it holds memory for its conversation. Before each
call to the model, the turn counts four times the size of its conversation
as sent, and once more for each round it has done (a model call and its
tool calls). A resumed run also counts its journal while it runs. A dry run
isn't counted. When the turn ends, what it held is free again.

A turn that would go past either limit fails before the model is called,
with `429 turn-memory-limit-reached`:

```text
{"error":{"code":"turn-memory-limit-reached","message":"The turn needs more memory than the workspace's share of turn memory has left (0.0 of … MiB held). Retry later, or use a smaller conversation.","details":{"limit":"tenant","heldBytes":0,"limitBytes":…,"runId":"…"},"requestId":"…"}}
```

`details.limit` says which limit refused it: `tenant` for your workspace's,
`server` for the shared one. `heldBytes` and `limitBytes` say what was held
and the limit, and `runId` names the turn's run, which has failed with the
same code. There's no `Retry-After`:
try again later, or with a smaller conversation. Every tool call the turn
finished is in the conversation, so a new turn there doesn't call it again
([`turn-memory-limit-reached`](../../reference/errors/#turn-memory-limit-reached)).

A resumed run whose journal alone is over your workspace's limit fails at
once, with the same code. One that only finds no room yet waits:

- **A conversation's turn** goes back to `pending`, first in line, and goes
  on when other turns free enough.
- **A turn that's a step of a flow** is tried again about every 5 minutes.
  The third try without room fails it with `turn-memory-limit-reached`,
  about 15 minutes on, and the flow's retry policy then applies to the step.

These two limits are the same for every workspace, and `GET /v1/tenant`
doesn't list them.
