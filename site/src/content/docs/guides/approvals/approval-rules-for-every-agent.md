---
title: Set approval rules for every agent
description: Publish a tenant policy that makes chosen tools ask for approval and raises the reviewer role, whatever each agent says.
sidebar:
  order: 4
---

An agent's own `hitl` settings are up to whoever writes the agent. A
tenant's `hitl` **policy** sets rules every agent is held to: a tool that must
always ask, and a lowest reviewer role. A policy can only make an agent
stricter, never looser.

Policies are published through the HTTP API. With `kindgi dev`, the URL and
token are the ones it prints (they're also in the pack's `.kindgirc.json`).

## Publish a policy

```sh
curl -X POST "$KINDGI_API_URL/v1/policies" \
  -H "Authorization: Bearer $KINDGI_API_TOKEN" -H 'content-type: application/json' \
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

It applies from the next run. The `spec`:

- **`tools`**: tool id to gate. `always_ask` makes every call of that tool,
  by any agent, wait for a decision, even an agent with no `hitl` settings of
  its own.
- **`minReviewerRole`**: `standard`, `senior` or `admin`. Approvals need at
  least this role, whatever the agent asks for.

## What it changes

An agent that calls `acme-ops.post-update` and has no approval settings now
waits:

```sh
kindgi runs start --agent=acme-ops.status-agent --input='{"userMessage":"Checkout is back to normal."}'
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
it:

```sh
kindgi approvals list --status=pending
```

```json
{
  "items": []
}
```

Once you're registered as `senior`
(`kindgi reviewers register --spec='{"role":"senior"}'`), it's there:

```json
{
  "items": [
    {
      "id": "a7a223bd-ac2f-4f69-9961-b00bd2501625",
      …
      "requiredRole": "senior",
      "status": "pending",
      "title": "HITL review: acme-ops.post-update",
      …
    }
  ]
}
```

## Change or remove it

A policy is versioned. Publish the same `id` with a higher `version` to change
it; the latest version is the one that applies. Several `hitl` policies (with
different ids) all apply: every tool any of them gates asks, and the highest
`minReviewerRole` wins.

To remove a policy, unregister **every** version: unregistering only the
latest makes the version before it apply again.

```sh
curl -X POST "$KINDGI_API_URL/v1/policies/acme.approval-rules/versions/1.0.0/unregister" \
  -H "Authorization: Bearer $KINDGI_API_TOKEN"
```

```json
{"policyId":"acme.approval-rules","version":"1.0.0","unregistered":true}
```

`GET /v1/policies` lists the tenant's policies. See
[Policies in the HTTP API](../../../reference/api/operations/tags/policies/).
