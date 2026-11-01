---
title: Set approval rules for every agent
description: Publish a tenant policy that makes chosen tools ask for approval and raises the reviewer role, whatever each agent says.
sidebar:
  order: 4
---

This guide publishes a tenant policy that makes chosen tools ask for
approval, and raises the reviewer role, for every agent.

An agent's own `hitl` settings are up to whoever writes the agent. A
tenant's `hitl` **policy** sets rules every agent is held to: a tool that must
always ask, and a lowest reviewer role. A policy can only make an agent
stricter, never looser.

## Before you start

- **A runtime,** such as `kindgi dev`, with Kindgi 0.2's CLI.
- **`KINDGI_API_URL` and `KINDGI_API_TOKEN`** set in your shell. Policies
  are published through the HTTP API. With `kindgi dev`, they're `apiUrl`
  and `token` in the pack's `.kindgirc.json`.
- **An agent that calls the tool you gate.** This guide uses
  `acme-ops.status-agent`, which calls `acme-ops.post-update`.

## Publish a policy

Publish the rules as a `hitl` policy with an id and a version:

```sh
curl -X POST "$KINDGI_API_URL/v1/policies" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN") -H 'content-type: application/json' \
  -d '{
    "id": "acme.approval-rules",
    "version": "1.0.0",
    "kind": "hitl",
    "description": "Status page posts need a senior reviewer",
    "spec": {
      "minReviewerRole": "senior",
      "tools": { "acme-ops.post-update": "always_ask" }
    }
  }'
```

```json
{"policyId":"acme.approval-rules","version":"1.0.0"}
```

It applies from the next run. `id` and `version` name the policy, and
`kind: "hitl"` makes it an approval policy. The `spec`:

- **`tools`**: tool id to gate. `always_ask` makes every call of that tool,
  by any agent, wait for a decision, even an agent with no `hitl` settings of
  its own.
- **`minReviewerRole`**: `standard`, `senior` or `admin`. Approvals need at
  least this role, whatever the agent asks for.

## What it changes

An agent that calls `acme-ops.post-update` and has no approval settings now
waits. `--agent` is the agent, and `--input` its input:

```sh
pnpm exec kindgi runs start --agent=acme-ops.status-agent --input='{"userMessage":"Checkout is back to normal."}'
```

```json
{
  "id": "dd30a1ce-cfb6-42d8-b951-987be9cb31c1",
  …
  "status": "suspended",
  …
}
```

The approval needs a `senior` reviewer, so a `standard` reviewer doesn't see
it. Under `kindgi dev`, you're an `admin`, who sees everything. To try this,
register yourself as `standard` first, with
`kindgi reviewers register --spec='{"role":"standard"}'`. Then list the
pending approvals. `--status=pending` lists only the ones still `pending`:

```sh
pnpm exec kindgi approvals list --status=pending
```

```json
{
  "data": [],
  "hasMore": false
}
```

Register yourself as `senior`, with
`kindgi reviewers register --spec='{"role":"senior"}'`, and list them again.
The approval is there:

```json
{
  "data": [
    {
      "id": "a7a223bd-ac2f-4f69-9961-b00bd2501625",
      …
      "requiredRole": "senior",
      "status": "pending",
      "title": "Approve a call to acme-ops.post-update",
      …
    }
  ],
  "hasMore": false
}
```

## Change or remove it

A policy is versioned. Publish the same `id` with a higher `version` to change
it. The latest version is the one that applies. Several `hitl` policies with
different ids all apply: every tool any of them gates asks, and the highest
`minReviewerRole` wins.

To remove a policy, unregister **every** version: unregistering only the
latest makes the version before it apply again.

A change applies to approvals not asked for yet. A turn already waiting keeps
the approval it asked for: the reviewer's answer still decides, even if the
policy no longer gates that tool.

Unregister a version by the policy's id and the version, in the path:

```sh
curl -X POST "$KINDGI_API_URL/v1/policies/acme.approval-rules/versions/1.0.0/unregister" \
  -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")
```

```json
{"policyId":"acme.approval-rules","version":"1.0.0","unregistered":true}
```

`GET /v1/policies` lists the tenant's policies.
[Policies in the HTTP API](../../../reference/api/operations/tags/policies/)
has every operation.

## Next

- [Ask before a tool runs](../ask-before-a-tool-runs/)
- [Decide an approval](../decide-an-approval/)
- [Ask before a long conversation continues](../ask-after-n-turns/)
