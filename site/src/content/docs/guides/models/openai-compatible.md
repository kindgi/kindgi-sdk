---
title: Connect an OpenAI-compatible endpoint
description: Register any endpoint that speaks the OpenAI Chat Completions API, such as Ollama on your machine or a hosted one with a key.
sidebar:
  order: 3
---

Many servers and services answer the OpenAI Chat Completions API: Ollama,
vLLM, LiteLLM and OpenRouter among them. Kindgi reaches them with one adapter,
`@kindgi/adapter-model-openai-compat`, pointed at the endpoint's base URL. This
page uses Ollama on your machine, then a gateway that takes a key.

## Ollama on your machine

With Ollama running and the model pulled (`ollama pull llama3.1`), write the
provider as a spec in the pack:

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

```sh
kindgi providers register --spec=@ollama.json
```

```text
{
  "providerId": "ollama"
}
```

To have `kindgi dev` register it on every boot, put the spec in the pack's
config instead: `{ spec: { … } }` in `kindgi.config.ts`'s `providers`, or
`spec = { … }` in a `[[tool.kindgi.providers]]` table in `pyproject.toml`. See
[Declare them in your pack's config](../#declare-them-in-your-packs-config).

Then run an agent. With no other provider registered, Ollama answers:

```sh
kindgi runs start --agent=acme.order-desk --input='{"userMessage":"Where is my order A-1001?"}'
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
  machine (it says so when it starts), so `http://localhost:11434/v1` reaches
  your Ollama.
- **`name`** is the model as the endpoint knows it.
- **`features`**: list only what the model does. An agent that calls tools
  needs `tool-use`, and the model must support tool calling.
- **`cost`**: zero for a model you run yourself.

There's no `secret_ref`: Ollama takes no key.

## An endpoint with a key

A hosted endpoint takes a key. Name the secret that holds it in `secret_ref`,
and store the key in the pack's env files (see [Keys](../#keys)). The
endpoint's documentation gives its base URL and its model names:

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
Error [server]: Model call to acme-gateway (llama3.1) failed: provider-runtime-bridge: failed to resolve secret local/ACME_GATEWAY_KEY for tenant d4414be3-755c-4293-9972-dbadf18b2a50: No secret "ACME_GATEWAY_KEY" for env "local" in .env, .env.local at /pack
```

Copy each model's prices from the vendor's page, divided by 1000: Kindgi's
prices are per thousand tokens (see
[Prices are per thousand tokens](../#a-provider-spec)). A turn's
`totalCostUsd`, and the agent's cost budget, come from them.

## More than one model

One provider can list several models of the same endpoint; each one is
matched and ranked on its own. Each endpoint (each base URL and key) is its own
provider, with its own `metadata.id`.
