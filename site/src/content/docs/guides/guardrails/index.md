---
title: Guardrails
description: Write a check on an agent's answers, give it settings, and choose whether a failure stops the turn.
sidebar:
  order: 0
  label: Overview
---

A guardrail is a rule an agent's turn must satisfy. It's a **check**, a
function you write over the turn (its answer, its tool calls and their
results), and an **action**: what happens when the check fails. Kindgi runs
an agent's guardrails once per turn, on its final answer, before the answer
is stored.

- [Write a guardrail](write-a-guardrail/): the check, the declaration, and
  wiring it onto an agent.
- [Configure a guardrail](configure-a-guardrail/): settings the check runs
  with, and their schema.
- [Stop a turn or record a violation](halt-or-record/): `halt` versus
  `log-only`, severity, and which agents a guardrail covers.

The examples use the quickstarts' pack, `my-pack`, whose agent answers with
`dev-echo` until you connect a model.
