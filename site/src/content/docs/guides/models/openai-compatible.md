---
title: Connect an OpenAI-compatible endpoint
description: Register any endpoint that speaks the OpenAI Chat Completions API, such as Ollama on your machine or a hosted one with a key.
sidebar:
  order: 3
---

This guide connects a model behind an OpenAI-compatible endpoint to your
agents: Ollama on your machine, then a gateway that takes a key.

Many servers and services answer the OpenAI Chat Completions API: Ollama,
vLLM, LiteLLM and OpenRouter among them. Kindgi reaches them with one adapter,
`@kindgi/adapter-model-openai-compat`, pointed at the endpoint's base URL.

## Before you start

- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.
- **Ollama running, with the model pulled:** `ollama pull llama3.1`.
- **An agent,** to try it. This guide uses `acme.order-desk`.

## Ollama on your machine

Ask your coding agent to write the provider. Kindgi's skills in your pack
tell it how ([How it knows Kindgi](../../../start/coding-agents/)):

```text
I want to use llama3.1 with Ollama on this machine as a model provider.
```

For reference, the spec it writes looks like this. This guide calls the
provider `ollama`, and saves its spec in the pack as `ollama.json`:

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

Register it. `--spec=@ollama.json` reads the spec from that file:

```sh
pnpm exec kindgi providers register --spec=@ollama.json
```

```text
{
  "providerId": "ollama"
}
```

To have `kindgi dev` register it on every boot, ask your coding agent to put
the spec in the pack's config instead. It goes there as `{ spec: { … } }` in
`kindgi.config.ts`'s `providers`, or `spec = { … }` in a
`[[tool.kindgi.providers]]` table in `pyproject.toml`.
[Declare them in your pack's config](../#declare-them-in-your-packs-config)
shows how.

Then run an agent. With no other provider registered, Ollama answers.
`--agent` is the agent, and `--input` its input:

```sh
pnpm exec kindgi runs start --agent=acme.order-desk --input='{"userMessage":"Where is my order A-1001?"}'
```

```json
{
  …
  "status": "completed",
  …
  "output": {
    …
    "usage": { "steps": 2, "durationMs": 16282, "promptTokens": 398, "totalCostUsd": 0, "completionTokens": 65 },
    …
    "provider": { "id": "ollama", "model": "llama3.1" },
    "response": { "role": "agent", "content": "Your order, A-1001, has been shipped and is expected to arrive on 2026-10-06. …", … },
    …
  }
}
```

- **`baseURL`** is the endpoint, up to and including `/v1`. `kindgi dev` runs
  the runtime in Docker and points `localhost`, `127.0.0.1` and `::1` at your
  machine, and says so when it starts. So `http://localhost:11434/v1` reaches
  your Ollama.
- **`name`** is the model as the endpoint knows it.
- **`features`**: list only what the model does. An agent that calls tools
  needs `tool-use`, and the model must support tool calling.
- **`cost`**: zero for a model you run yourself.

There's no `secret_ref`: Ollama takes no key.

## An endpoint with a key

A hosted endpoint takes a key. The spec names the secret that holds it in
`secret_ref`. The key itself stays with you: store it as a secret, as
[Keys](../#keys) shows. The endpoint's documentation gives its base URL and
its model names. Ask your coding agent to write the spec:

```text
I want to use llama3.1 through our LLM gateway. It takes an API key.
```

For reference, the spec it writes looks like this. Its `secret_ref` names
the secret, `ACME_GATEWAY_KEY`:

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "https://llm-gateway.acme.example/v1" },
  "secret_ref": { "envName": "local", "name": "ACME_GATEWAY_KEY" },
  "metadata": {
    "id": "acme-gateway",
    "region": "us-east-1",
    "models": [
      { "name": "llama3.1", "contextWindow": 8192, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0.0002, "completionUsdPer1kTokens": 0.0006 } }
    ]
  }
}
```

The key is sent as `Authorization: Bearer <key>` on every call, and read when
the call is made: a key you change is used from the next turn on. A key that
isn't set fails the turn when the model is called, not when you register:

```text
Error [model-invocation-failed]: Model call to acme-gateway (llama3.1) failed: provider-runtime-bridge: failed to resolve secret local/ACME_GATEWAY_KEY for tenant …: No secret "ACME_GATEWAY_KEY" for env "local" in .env, .env.local, .kindgi/secrets.env at /pack
```

Copy each model's prices from the vendor's page, divided by 1000: Kindgi's
prices are per thousand tokens, as
[A provider spec](../#a-provider-spec) explains. A turn's `totalCostUsd`,
and the agent's cost budget, come from them.

## OpenAI's own API

An endpoint on `api.openai.com`, or on one of its data-residency hosts such as
`eu.api.openai.com`, is called through OpenAI's Responses API: GPT-6 models
call tools only there. Every other endpoint, such as Ollama, vLLM, Groq or
OpenRouter, gets Chat Completions. `adapter_config.api` chooses for a registration of
your own: `"responses"` or `"chat-completions"`. The `openai` preset sets
`"responses"`.

On the Responses API:

- every call sends `store: false`, so OpenAI keeps no conversation state for
  Kindgi's calls;
- the agent's instructions go as a `developer` message;
- a reasoning model's reasoning between tool calls goes back to it with the
  calls;
- `extraBody` can't set `model`, `input`, `tools`, `text`, `temperature`,
  `max_output_tokens`, `stream` or `store`.

To keep an OpenAI registration on Chat Completions, set
`"api": "chat-completions"`: GPT-6.1 Sol and Astra then can't call tools. Its
`extraBody` fields written for Chat Completions either stay on that API or
move to the Responses names.

A model's reasoning effort follows its thinking level: an agent's `thinking`,
or else the model's `thinking.default`, as
[Temperature and thinking](../#temperature-and-thinking) shows. It goes as
`reasoning.effort` on the Responses API and `reasoning_effort` on Chat
Completions, and wins over the same field in `extraBody`. An effort in
`extraBody`, such as `"extraBody.reasoning.effort": "low"`, still goes out
when the model has no `thinking` in its entry, or when the call asks no
level and the model has no `default`. The call's cost record then names no
level, since Kindgi didn't set one. Other `extraBody.reasoning` fields go
out beside the level's effort.

Another value of `api` is refused when you register:

```text
Error [invalid-request]: Provider "ollama" doesn't fit adapter @kindgi/adapter-model-openai-compat: adapter_config.api must be one of responses, chat-completions.
  ✗ /adapter_config/api: adapter_config.api must be one of responses, chat-completions.
```

If a stored registration has another value, the runtime can't build the
provider. Turns then go to another registered model, or to `dev-echo` with a
`fallback-provider` warning. `kindgi doctor` names it, as
[Check a registration](../#check-a-registration) shows.

## Cached prompts, long prompts and data residency

A model's `cost` can say more than its two base rates, for a vendor that
bills that way. The `openai` preset fills them in:

- **`cachedPromptMultiplier`**: cached prompt tokens' share of the prompt
  rate: `0.1` is a tenth;
- **`promptCacheCreationMultiplier`**: prompt tokens written to the cache, as
  a multiple of the prompt rate;
- **`longContext`**: `{ "thresholdTokens", "promptUsdPer1kTokens",
  "completionUsdPer1kTokens" }`. A call whose input passes the threshold,
  counting cached and cache-write tokens, bills entirely at these rates, and
  the multipliers apply to the long prompt rate;
- **`dataResidencyMultiplier`**: applied to every rate when `baseURL` is a
  data-residency host such as `eu.api.openai.com`.

Ask your coding agent, for example: "Add my vendor's cached-prompt and
long-prompt prices to the model." For reference, the model's `cost` then
looks like this:

```json excerpt
"cost": {
  "promptUsdPer1kTokens": 0.002, "completionUsdPer1kTokens": 0.01,
  "cachedPromptMultiplier": 0.05, "promptCacheCreationMultiplier": 1.25,
  "longContext": { "thresholdTokens": 272000, "promptUsdPer1kTokens": 0.004, "completionUsdPer1kTokens": 0.015 },
  "dataResidencyMultiplier": 1.1
}
```

Each extra rate must be a non-negative number, or an object of them one level
deep, as `longContext` is. Anything else is refused when you register:

```text
Error [invalid-request]: provider "ollama" model "llama3.1" cost table's other rates must be non-negative numbers, or objects of them (e.g. longContext: { thresholdTokens, promptUsdPer1kTokens, completionUsdPer1kTokens })
```

## More than one model

One provider can list several models of the same endpoint. Each one is
matched and ranked on its own. Each endpoint, meaning each base URL and key,
is its own provider, with its own `metadata.id`.

## Next

- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Connect a model you serve](../serve-your-own-model/)
- [Models](../)
