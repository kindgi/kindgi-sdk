---
title: Connect a model you serve
description: Run agents on an open model on your own hardware or in your own network, pass the extra request fields it needs, and keep it as a fallback.
sidebar:
  order: 4
---

An open model you serve yourself (with Ollama, vLLM or llama.cpp's server, on
your machine or on a server in your network) registers like any
[OpenAI-compatible endpoint](../openai-compatible/): no key, and a price of
zero. Two things are specific to it: the request fields your server needs, and
whether it should be a fallback.

## The provider

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": {
    "baseURL": "http://localhost:11434/v1",
    "extraBody.chat_template_kwargs.enable_thinking": false
  },
  "metadata": {
    "id": "acme-llm",
    "region": "on-prem",
    "models": [
      { "name": "llama3.1", "contextWindow": 8192, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }
    ]
  }
}
```

```sh
kindgi providers register --spec=@acme-llm.json
kindgi runs start --agent=acme.order-desk --input='{"userMessage":"Where is my order A-1002?"}'
```

```json
{
  …
  "status": "completed",
  …
  "output": {
    …
    "provider": { "id": "acme-llm", "model": "llama3.1" },
    "response": { "role": "agent", "content": "I have located your order, A-1002. It is currently in the processing stage and no delivery date has been specified yet.", … },
    …
  }
}
```

- **`baseURL`** is your server as the runtime reaches it. Here it's Ollama on
  the same machine as `kindgi dev`; for a server in your network, it's that
  server's address (`http://<host>:<port>/v1`).
- **`region`** is a label of your choosing; agents can require it.
- **`contextWindow`** is the context your server serves the model with, which
  can be less than the model's own.

## Extra request fields

Some servers need fields the OpenAI API doesn't have. A thinking model (Qwen 3,
for one) writes its reasoning before its answer unless it's asked not to, and an
agent with a [typed answer](../../agents/typed-answer/) then gets an answer
that isn't JSON. If you can't change the server's defaults, send the field
with every request.

`adapter_config` is flat: each extra field is one key that starts with
`extraBody.`, and the dots nest. The provider above sends, with every call:

```json
{ "chat_template_kwargs": { "enable_thinking": false } }
```

Fields the adapter sets itself can't be set this way: `model`, `messages`,
`tools`, `response_format`, `temperature`, `max_tokens` and `stream`. An
`extraBody` object, instead of flat keys, is refused when you register:

```text
Error [invalid-request]: `adapter_config` values must be strings, numbers or booleans (extraBody).
```

Your server must also call tools the OpenAI way for an agent that has tools:
turn tool calling on in its settings, and serve a model that supports it.

## Keep it as a fallback

A model of your own can be the one that answers only when nothing else fits,
the way `dev-echo` does. Add `"fallback": true` to `metadata`:

```json
{
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": {
    "baseURL": "http://localhost:11434/v1",
    "extraBody.chat_template_kwargs.enable_thinking": false
  },
  "metadata": {
    "id": "acme-llm",
    "region": "on-prem",
    "fallback": true,
    "models": [
      { "name": "llama3.1", "contextWindow": 8192, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }
    ]
  }
}
```

A turn it answers carries a `fallback-provider` warning:

```text
⚠ Answered by "acme-llm", a fallback provider: no other registered provider satisfies agent "acme.order-desk".
```

When several fallbacks fit, the usual ranking applies: `acme-llm` comes before
`dev-echo` alphabetically.
