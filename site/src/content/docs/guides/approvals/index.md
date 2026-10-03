---
title: Approvals
description: Have a person approve what an agent does before it happens.
sidebar:
  order: 0
  label: Overview
---

An agent can stop and wait for a person: before it calls a tool that changes
something, or once a conversation runs long. The run waits (its status is
`suspended`) until a reviewer decides, then carries on from where it stopped.
A flow with that agent as a step waits with it.

- [Ask before a tool runs](ask-before-a-tool-runs/): turn approval gates on in
  an agent.
- [Decide an approval](decide-an-approval/): reviewers and their roles, the
  four decisions, and deciding from your app.
- [Ask before a long conversation continues](ask-after-n-turns/): a gate on
  the number of turns.
- [Set approval rules for every agent](approval-rules-for-every-agent/): a
  tenant policy that agents can't loosen.

The examples use a pack named `acme-ops` with the sample template's agent and
tools, plus `acme-ops.post-update`, a tool that posts to a status page. They
run on `kindgi dev` with no model key: `dev-echo` answers, and it calls the
agent's first tool.
