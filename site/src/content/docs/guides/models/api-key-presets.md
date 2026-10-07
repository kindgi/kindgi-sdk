---
title: Connect OpenAI, Gemini, Groq or OpenRouter
description: Register GPT, Gemini on the Developer API, Groq or OpenRouter from a preset, with the provider's API key in the pack's env files.
sidebar:
  order: 2
---

Four presets connect a provider with one API key, the way
[Connect Anthropic](../anthropic/) does for Claude:

| Preset | Provider | Key |
| --- | --- | --- |
| `openai` | GPT on the OpenAI API | `OPENAI_API_KEY` |
| `gemini-api` | Gemini on the Gemini Developer API, with an API key from Google AI Studio | `GEMINI_API_KEY` |
| `groq` | Open-weight models on Groq's fast inference | `GROQ_API_KEY` |
| `openrouter` | Many vendors' models through OpenRouter, with one key | `OPENROUTER_API_KEY` |

For Gemini with your Google Cloud credentials instead of a key, use
[Gemini on Vertex AI](../gemini-on-vertex-ai/) (the `gemini` preset).

## 1. Store the key

With `kindgi dev` running, in the pack, store the key under the preset's name
(OpenAI here):

```sh
kindgi secrets set OPENAI_API_KEY --env=local --scope=tenant
```

It prompts for the key without echoing it and writes it to the pack's
`.env.local`. A line `OPENAI_API_KEY=…` in the pack's `.env` works too. Keep
both files out of git.

## 2. Register the preset

```sh
kindgi providers register --preset=openai
```

```text
{
  "providerId": "openai"
}
✓ Registered openai: gpt-6.1-sol (default), gpt-6-astra, gpt-6-luna — key OPENAI_API_KEY (env local)
```

The others answer the same way:

```text
✓ Registered gemini-api: gemini-3.8-flash (default), gemini-3.1-pro-preview, gemini-3.5-flash-lite — key GEMINI_API_KEY (env local)
✓ Registered groq: openai/gpt-oss-120b (default), openai/gpt-oss-20b — key GROQ_API_KEY (env local)
✓ Registered openrouter: anthropic/claude-sonnet-5.5 (default), openai/gpt-6.1-sol, google/gemini-3.8-flash, openai/gpt-6-luna — key OPENROUTER_API_KEY (env local)
```

As with Anthropic, the preset checks that its key is there first, `--models`
registers only the models you list, `--secret=<NAME>` reads the key from
another variable, and `{ preset: 'openai' }` in the pack's config registers it
on every boot: see [Connect Anthropic](../anthropic/#2-register-the-preset).

The provider answers from the next turn on; nothing restarts.

## Their models

Among the models that meet an agent's needs, Kindgi takes the agent's
preferred one, else the preset's default, marked below: a mid-priced model, not
the dearest. Register only the model you want (`--models=gpt-6-luna`) or set
the agent's `preferredModel`: see
[Choose the model an agent uses](../../agents/choose-a-model/).

| Preset | Model | Features | Context window | Per 1K input / output tokens |
| --- | --- | --- | --- | --- |
| `openai` | `gpt-6.1-sol` (default) | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,050,000 | $0.002 / $0.01 |
| | `gpt-6-astra` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,050,000 | $0.01 / $0.05 |
| | `gpt-6-luna` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,050,000 | $0.0001 / $0.0005 |
| `gemini-api` | `gemini-3.8-flash` (default) | `tool-use`, `structured-output`, `long-context` | 1,048,576 | $0.00075 / $0.00375 |
| | `gemini-3.1-pro-preview` | `tool-use`, `long-context` | 1,048,576 | $0.002 / $0.012; a prompt over 200,000 tokens: $0.004 / $0.018 |
| | `gemini-3.5-flash-lite` | `tool-use`, `structured-output`, `long-context` | 1,048,576 | $0.0003 / $0.0025 |
| `groq` | `openai/gpt-oss-120b` (default) | `tool-use` | 131,072 | $0.00015 / $0.0006 |
| | `openai/gpt-oss-20b` | `tool-use` | 131,072 | $0.000075 / $0.0003 |
| `openrouter` | `anthropic/claude-sonnet-5.5` (default) | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.002 / $0.01 |
| | `openai/gpt-6.1-sol` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,050,000 | $0.002 / $0.01 |
| | `google/gemini-3.8-flash` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,048,576 | $0.00075 / $0.00375 |
| | `openai/gpt-6-luna` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,050,000 | $0.0001 / $0.0005 |

The prices are the presets' own, checked against the providers on 2026-10-07
(`pricesCheckedAt` in `kindgi providers presets`); a turn's `totalCostUsd` uses
them. A prompt over a model's long-context threshold prices the whole call at
the higher rates. Which of these models take a temperature, and which think:
see [Temperature and thinking](../#temperature-and-thinking).

A provider registered from a preset before 0.1.4 has no default, so an agent
that names no model gets the first by name, and it keeps only the two base
rates. Register it again: unregister it, then register the preset (or restart
`kindgi dev` for one the pack's config declares).

## OpenAI

The `openai` preset calls OpenAI through its Responses API, which GPT-6
models need to call tools. An agent with tools works on any of them, and so
do typed answers. Every call sends `store: false`, so OpenAI keeps no
conversation state for Kindgi's calls. A GPT-6 model takes no `temperature`:
the call goes without it, with a `sampling-unsupported` warning (see
[Temperature and thinking](../#temperature-and-thinking)).

OpenAI bills cached prompt tokens at a fraction of the input price, writes
to its prompt cache at more, and a prompt over 272,000 input tokens at higher
rates for the whole call. The preset's prices follow, per 1K tokens:

| Model | Input | Cached input | Cache write | Output | Past 272,000 input tokens (input / output) |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | $0.002 | $0.0001 | $0.0025 | $0.01 | $0.004 / $0.015 |
| `gpt-6-astra` | $0.01 | $0.001 | $0.0125 | $0.05 | $0.02 / $0.075 |
| `gpt-6-luna` | $0.0001 | $0.00001 | $0.000125 | $0.0005 | $0.0002 / $0.00075 |

Past 272,000 tokens, cached input and cache writes keep their share of the
higher input rate. Kindgi counts every input token of a call toward the
272,000, cached ones included: that's its reading of OpenAI's pricing page,
which doesn't spell it out. On a data-residency host (`eu.api.openai.com`),
every rate is 10% higher. The OpenAI registration's settings are on
[Connect an OpenAI-compatible endpoint](../openai-compatible/#openais-own-api).

## If it doesn't answer

A wrong key fails the turn with the provider's own message. To change the key,
set it again with `--write-mode=add-version`; the next turn uses the new one.

If `dev-echo` still answers (its answer starts with
`⚠ dev-echo isn't a real model`), the agent needs something none of the
registered models has: see
[`dev-echo`, the fallback](../../agents/choose-a-model/#dev-echo-the-fallback).
