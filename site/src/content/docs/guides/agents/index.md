---
title: Agents
description: Write an agent, give it input, get a typed answer, choose its model, hold a conversation and cap what a turn may spend.
sidebar:
  order: 0
  label: Overview
---

An agent is data: instructions, the tools it may call, the guardrails on its
answer, what its model must support, and a budget. Each run of an agent is one
**turn**: the model reads the instructions and the user's message, calls tools
until it has an answer, and the answer is checked and stored. A turn is a run
like any other, with a journal of every model call and tool call.

- [Write an agent](write-an-agent/): the agent file, its instructions, tools
  and guardrails.
- [Give an agent its input](give-an-agent-input/): the user message,
  parameters for its instructions, and the input of a flow step.
- [Give an agent a typed answer](typed-answer/): an answer your code can read
  as fields, checked against a schema.
- [Choose the model an agent uses](choose-a-model/): capabilities,
  preferences, and the `dev-echo` fallback.
- [Hold a conversation](conversations/): continue a conversation turn by turn,
  read its history, close it.
- [Set an agent's budget](budgets/): steps, cost and time per turn, and what
  happens when a turn runs out.

The examples use a pack named `acme` (from the `sample` template) with one more
tool, `acme.lookup-order`, shown on [Write an agent](write-an-agent/). Where a
real model matters, the output is from Claude Sonnet 5.5, or on older
captures Claude Haiku 4.5 (outputs on newer models differ in wording, not
shape), registered with
`kindgi providers register --preset=anthropic` (see
[Connect Anthropic](../models/anthropic/)). Without a model, `dev-echo`
answers.
