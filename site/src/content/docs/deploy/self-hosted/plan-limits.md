---
title: Plan limits
description: How the runtime counts the flows and agents in production against the license key's plan, warns at the plan, and refuses new ones past its margin, while what runs keeps running.
sidebar:
  order: 3.25
---

A production license covers up to a number of flows and agents
([What a production license covers](../../../concepts/licensing/#what-a-production-license-covers)).
The runtime counts the ones in production against its license key's plan.
At the plan, a write's answer warns. Past the most the key runs, the plan's
number and a margin, a write that adds new ones is refused, and adds none of
them. What runs keeps running.

## What counts

- **Each flow and each agent your packs define, in the projects you put in
  production**
  ([Put a project in production](../../../guides/projects/organize-by-org-and-project/#put-a-project-in-production)).
- **Once in the installation,** however many projects in production or
  versions run it.
- **Projects not in production don't count,** and neither do tools,
  guardrails, data blocks or people. A suspended project in production still
  counts.
- **Nothing is counted** under a license key that names no number of flows
  and agents, such as an Enterprise key, or in development mode.

## When it's checked

Each write that can add a flow or an agent to production asks first:

- deploying a pack (`kindgi deploy`, `POST /v1/deployments`);
- promoting a build (`kindgi promote`,
  `POST /v1/deployments/{deploymentId}/promotions`);
- publishing an agent or a flow (`POST /v1/agents`, `POST /v1/flows`), or
  reinstating a retired version of one;
- putting a project in production
  (`PUT /v1/projects/{projectId}/production`), which counts every flow and
  agent that runs in it;
- the agent version a suggested change's check makes.

A write into a project that isn't in production adds nothing. The deploy
check (`POST /v1/deployments/check`, which `kindgi deploy` asks before it
builds the image, when the pack has blocks or the deploy names `--replace`)
and a promotion's check (`kindgi promote --check`) answer as the write would,
with nothing written.

## The margin

The most a key runs is a fifth over its plan, rounded down, and always at
least one over:

| Plan | Flows | Most flows | Agents | Most agents |
|---|---|---|---|---|
| Free | 1 | 2 | 2 | 3 |
| Starter | 3 | 4 | 10 | 12 |
| Business | 10 | 12 | 30 | 36 |

## At the plan: a warning

Once a count reaches its plan, the answer to each write that counts carries
`planWarning`: for each count at its plan or past it, the key's `plan`, the
`most` it runs, and `inUse`, how many run in production with this write.
`kindgi deploy` and `kindgi promote` print a line for each, flows first:

```text
⚠ 11 agents run in production; your plan has 10. Past 12, new ones are refused.
```

## Past the most: refused

A write that would take a count past the most is refused with
`403 plan-limit-reached`, and none of the flows and agents it adds is added.
The message says what the write adds, the most, and how many run:

```text
This adds 2 agents to production, and this runtime's license key runs at most 12: its plan's 10, and a margin. 11 run in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or renew the key on a larger plan.
```

Its `details` name each count over and the ids the write adds
([plan-limit-reached](../../../reference/errors/#plan-limit-reached)). When
the runtime names where a larger plan is (`KINDGI_PRODUCTION_NEXT_URL`), the
message ends with it, and `details.next` has it.

A suggested change's check is refused the same way when the agent version it
makes would go past the most. The edit's block version stays, as a failed
check leaves it, and a suggested change just made is kept too: check it
again (`POST /v1/suggested-changes/{suggestedChangeId}/check`) once there's
room.

A runtime that serves other tenants too counts their flows and agents under
the same key. So a tenant's refusal leaves the key's numbers out and says to
ask whoever runs the runtime, and its answers carry no warning.

## What keeps running

- **Flows and agents that run keep running,** and changes to them go
  through: a new version of an agent that runs in production adds nothing.
- **A key renewed on a smaller plan takes nothing down,** and neither does a
  build that comes back into production. The count can then be past the
  most with no write; the next new flow or agent is refused.

## Make room

- **Unregister the versions of a flow or an agent that run in production.**
  It leaves the count once none of its versions runs there.
- **Take a project out of production.** Its flows and agents leave the
  count, unless another project in production runs them.
- **A promoted copy leaves** once a newer build without it is promoted and
  nothing holds the older one.
- **Or renew the key on a larger plan**
  ([Renew the license key](../renew-the-license-key/)).

## A busy count

Writes that count take turns. When a write waits too long for its turn, it
is refused with `503 plan-count-busy`, and adds none of the flows and agents
it would: send it again after `Retry-After`
([plan-count-busy](../../../reference/errors/#plan-count-busy)).

## Next

- [Licensing](../../../concepts/licensing/): which key a deployment needs,
  and what each plan covers.
- [Renew the license key](../renew-the-license-key/): renew on a larger
  plan.
