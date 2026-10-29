---
title: Guardrails
description: Write a check on an agent's answers, give it settings, and choose whether a failure stops the turn.
sidebar:
  order: 0
  label: Overview
---

These guides check what an agent's turn did before its answer is kept, and
choose what happens when a check fails.

A guardrail is a rule an agent's turn must satisfy. It's a **check** and an
**action**. The check is a function over the turn: its answer, its tool calls
and their results. The action is what happens when the check fails. Kindgi
runs an agent's guardrails on its final answer, before the answer is stored.
With a `retry` guardrail, the agent's `halt` and `retry` guardrails judge
each answer the model writes.

## What a guardrail can do in 0.1

- **`halt` and `retry` act.** A failed `halt` guardrail stops the turn with
  `guardrail-violation`. A failed `retry` guardrail sends the answer back to
  the model with the check's reason, for a new one, and stops the turn the
  same way once its answers run out. Any other action is recorded on the
  turn as a violation, and the turn completes: `escalate` and `compensate`
  don't escalate or call a tool.
- **A check sees one turn:** the turn's user message, its tool calls and
  their results, and its answer. Earlier turns aren't in it, so a check
  can't compare an answer with what an earlier turn said or fetched.
- **What a check keeps in memory doesn't last.** It lives in the process
  that runs the pack's code. `kindgi dev` loses it on every reload and
  restart, and a deployment loses it whenever an instance stops. With more
  than one instance, each keeps its own.

For a check on figures, tell the agent in its instructions to call its tools
again in every answer that quotes a figure: the figure is then in that
turn's tool results. That depends on the model following the instruction,
and it doesn't cover figures the user typed in an earlier turn.

## The guides

- [Write a guardrail](write-a-guardrail/): the check, the declaration, and
  wiring it onto an agent.
- [Configure a guardrail](configure-a-guardrail/): settings the check runs
  with, and their schema.
- [Stop a turn or record a violation](halt-or-record/): `halt`, `retry`
  and `log-only`, severity, which agents a guardrail covers, and how a
  guardrail is doing: how often it passed, was violated, blocked a turn or
  couldn't run.
- [Use a built-in check](use-a-built-in-check/): name one of Kindgi's seven
  checks instead of writing your own, and the settings each reads.

The examples use the quickstarts' pack, `my-pack`, whose agent answers with
`dev-echo` until you connect a model.
