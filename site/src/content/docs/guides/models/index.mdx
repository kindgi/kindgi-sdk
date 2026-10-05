---
title: Models
description: Connect the models your agents run on, from a preset or a spec file, and manage the connections.
sidebar:
  order: 0
  label: Overview
---

An agent doesn't name an API. It says what its model must support, and Kindgi
picks a model from the **providers** registered for your tenant. A provider is
one connection, to a vendor's API or to an endpoint you serve, with the models
it offers: each model's features, context window and price.

- [Connect Anthropic](anthropic/): Claude, from a preset.
- [Connect Gemini on Vertex AI](gemini-on-vertex-ai/): Gemini, from a preset,
  with your Google Cloud credentials.
- [Connect an OpenAI-compatible endpoint](openai-compatible/): Ollama or a
  hosted endpoint, from a spec file.
- [Connect a model you serve](serve-your-own-model/): an open model on your own
  hardware or in your own network.

How a turn picks among them is on
[Choose the model an agent uses](../agents/choose-a-model/).

## Before you register one

A new pack's tenant has `dev-echo`, a stand-in that answers without a model
(it calls the agent's first tool and replies with what the tool returned). It's
a **fallback**: it answers only while no other provider fits the agent, so a
provider you register takes over at the next turn, with nothing to switch off
and no restart.

## Presets

```sh
kindgi providers presets
```

```json
[
  {
    "name": "anthropic",
    "description": "Claude on the Anthropic API (key: ANTHROPIC_API_KEY).",
    "adapterId": "@kindgi/adapter-model-anthropic",
    "models": [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5"
    ],
    "secret": "ANTHROPIC_API_KEY",
    "pricesCheckedAt": "2026-10-01"
  },
  {
    "name": "gemini",
    "description": "Gemini on Vertex AI (Google Application Default Credentials; --project=<gcp-project>).",
    "adapterId": "@kindgi/adapter-model-gemini",
    "models": [
      "gemini-2.5-pro",
      "gemini-2.5-flash"
    ],
    "needs": [
      "--project"
    ],
    "pricesCheckedAt": "2026-10-01"
  }
]
```

A preset carries its models' features, context windows and prices.
`pricesCheckedAt` is when the prices were last compared with the vendor's.

## A provider spec

Anything that isn't a preset registers from a spec: a JSON file you pass with
`kindgi providers register --spec=@<file>`.

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "http://localhost:11434/v1" },
  "metadata": {
    "id": "ollama",
    "region": "local",
    "models": [
      { "name": "llama3.1", "contextWindow": 8192, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }
    ]
  }
}
```

- **`adapter_id`** is the adapter's full package name.
- **`adapter_config`** holds the connection's settings, such as the endpoint's
  URL: flat keys with string, number or boolean values. Never a key.
- **`secret_ref`** names the secret that holds the key:
  `{ "envName": "local", "name": "GROQ_API_KEY" }`. Leave it out for an
  endpoint that takes none.
- **`metadata.id`** names the connection; agents prefer it by this id.
  **`metadata.models`** lists the models, by the name the endpoint knows them
  by, each with its `contextWindow`, its `features` (what agents can require)
  and its `cost`.
- **`metadata.attributes`** (optional) are labels agents can rank by, such as
  `"local"`; **`metadata.fallback: true`** makes the provider a fallback, like
  `dev-echo`.

:::caution[Prices are per thousand tokens]
`promptUsdPer1kTokens` and `completionUsdPer1kTokens` are per **thousand**
tokens; vendors quote per million. Divide their price by 1000: "$2 per million
input tokens" is `0.002`. Agents' cost budgets are computed from these prices,
so copy them from the vendor's page when you register.
:::

## Keys

With `kindgi dev`, a provider's key is read from the pack's env files, `.env`
and then `.env.local`, when a turn calls the model. To store one without
echoing it, with `kindgi dev` running:

```sh
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
```

It prompts for the value and writes it to `.env.local`. In a script, pipe it
in with `--from-stdin`. To replace a key that's already set, add
`--write-mode=add-version`.

## List, change and remove

```sh
kindgi providers list                          # every provider, with its models
kindgi providers list --feature=structured-output
kindgi providers get ollama
kindgi providers unregister ollama
```

`list` and `get` show the metadata only, never `adapter_config` or the key. A
registration can't be edited: registering an id that exists is refused, so
unregister it first, then register the new spec.

```text
Error [conflict]: Provider "ollama" is already registered
```
