---
title: Connect OpenAI, Gemini, Groq or OpenRouter
description: Register GPT, Gemini on the Developer API, Groq or OpenRouter from a preset, with the provider's API key stored as a secret.
sidebar:
  order: 2
---

This guide connects GPT, Gemini, Groq's models or OpenRouter to your agents
with one API key, stored as a secret.

Four presets connect a provider with one API key, the way
[Connect Anthropic](../anthropic/) does for Claude:

| Preset | Provider | Key |
| --- | --- | --- |
| `openai` | GPT on the OpenAI API | `OPENAI_API_KEY` |
| `gemini-api` | Gemini on the Gemini Developer API, with an API key from Google AI Studio | `GEMINI_API_KEY` |
| `groq` | Open-weight models on Groq's fast inference | `GROQ_API_KEY` |
| `openrouter` | A hosted service in front of several vendors: your prompts pass through OpenRouter | `OPENROUTER_API_KEY` |

`azure-openai` takes a key too, `AZURE_OPENAI_API_KEY`, with your resource
and deployments: [Presets](../#presets) explains its flags.

For Gemini with your Google Cloud credentials instead of a key, use
[Gemini on Vertex AI](../gemini-on-vertex-ai/), the `gemini` preset.

OpenRouter is an option if you choose it. It's one more hosted service your
prompts pass through: for data that must stay in your environment, use a
direct vendor's preset, or [a model you serve yourself](../serve-your-own-model/).

## Before you start

- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.
- **The provider's API key.**

## 1. Store the key

The preset reads the key from a secret named in the table. In the pack,
store it. Here it's OpenAI's:

```sh
pnpm exec kindgi secrets set OPENAI_API_KEY --env=local --scope=tenant
```

- `OPENAI_API_KEY` is the secret's name, the one the preset reads.
- `--env=local` is the environment the secret belongs to. Under
  `kindgi dev`, `local` is the pack's env files, `.kindgi/secrets.env` among
  them.
- `--scope=tenant` is where the secret lives: the tenant, rather than one org
  (`org:<orgId>`) or project (`project:<projectId>`).

It prompts for the key without echoing it and writes it to Kindgi's own
`.kindgi/secrets.env`, a file only you can read, which your app doesn't load.
A line `OPENAI_API_KEY=…` in your app's `.env` or `.env.local` works too, as
[Keep local values in env files](../../secrets/env-files/) shows. Keep your
env files out of git. `kindgi init` already keeps `.kindgi/` out.

## 2. Register the preset

Register the preset's models with the runtime. `--preset` names the preset:

```sh
pnpm exec kindgi providers register --preset=openai
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

As with Anthropic, which
[Connect Anthropic](../anthropic/#2-register-the-preset) shows:

- the preset checks that its key is there first;
- `--models` registers only the models you list;
- `--secret=<NAME>` reads the key from another variable;
- `{ preset: 'openai' }` in the pack's config registers it on every boot.

The provider answers from the next turn on, and nothing restarts.

## Their models

Among the models that meet an agent's needs, Kindgi takes the agent's
preferred one, else the preset's default, marked "(default)" in the table: a
mid-priced model, not the dearest. Register only the model you want, with
`--models=gpt-6-luna`, or set the agent's `preferredModel`, as
[Choose the model an agent uses](../../agents/choose-a-model/) shows.

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

The prices are the presets' own, checked against the providers on
2026-10-07. `kindgi providers presets` shows that date as `pricesCheckedAt`.
A turn's `totalCostUsd` uses them. A prompt over a model's long-context
threshold prices the whole call at the higher rates.
[Temperature and thinking](../#temperature-and-thinking) says which of these
models take a temperature, and which think.

A provider registered from a preset that had no default model has none, so
an agent that names no model gets the first by name, and it keeps only the
two base rates. Register it again: unregister it, then register the preset. For one
the pack's config declares, restart `kindgi dev` instead.

## OpenAI

The `openai` preset calls OpenAI through its Responses API, which GPT-6
models need to call tools. An agent with tools works on any of them, and so
do typed answers. Every call sends `store: false`, so OpenAI keeps no
conversation state for Kindgi's calls. A GPT-6 model takes no `temperature`:
the call goes without it, with a `sampling-unsupported` warning, as
[Temperature and thinking](../#temperature-and-thinking) describes.

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
which doesn't spell it out. On a data-residency host, such as
`eu.api.openai.com`, every rate is 10% higher. The OpenAI registration's settings are on
[Connect an OpenAI-compatible endpoint](../openai-compatible/#openais-own-api).

## If it doesn't answer

A wrong key fails the turn with the provider's own message. To change the key,
set it again with `--write-mode=add-version`. The next turn uses the new one.

A key a header can't carry, such as one pasted with a line break inside it,
fails the turn before anything is sent, naming the provider, never the key:

```text
@kindgi/adapter-model-anthropic: provider "acme": its API key has a line break, which a header can't carry: store the secret without it
```

If `dev-echo` still answers, its answer starts with
`⚠ dev-echo isn't a real model`. The agent needs something none of the
registered models has, as
[`dev-echo`, the fallback](../../agents/choose-a-model/#dev-echo-the-fallback)
explains.

## Next

- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Connect an OpenAI-compatible endpoint](../openai-compatible/)
- [Models](../)
