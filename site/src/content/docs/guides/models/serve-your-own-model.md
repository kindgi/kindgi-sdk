---
title: Connect a model you serve
description: Run agents on an open model on your own hardware or in your own network, pass the extra request fields it needs, and keep it as a fallback.
sidebar:
  order: 4
---

This guide connects an open model you serve yourself to your agents, sends
the request fields your server needs, and, if you want, keeps it as a
fallback.

You can serve it with Ollama, vLLM or llama.cpp's server, on your machine or
on a server in your network. It registers like any
[OpenAI-compatible endpoint](../openai-compatible/): no key, and a price of
zero. Two things are specific to it: the request fields your server needs, and
whether it should be a fallback.

## Before you start

- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.
- **A server that answers the OpenAI Chat Completions API,** with tool
  calling on and a model that supports it.
- **An agent,** to try it. This guide uses `acme.order-desk`.

## The provider

Ask your coding agent to write the provider. Kindgi's skills in your pack
tell it how ([How it knows Kindgi](../../../start/coding-agents/)):

```text
I want to use llama3.1 with Ollama on this machine as a model provider.
```

For reference, the spec it writes looks like this. This guide calls the
provider `acme-llm`, and saves its spec in the pack as `acme-llm.json`. Its
`extraBody.` line turns thinking off, as
[Extra request fields](#extra-request-fields) explains:

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

Register it, then start a turn. `--spec=@acme-llm.json` reads the spec from
that file. `--agent` is the agent, and `--input` its input:

```sh
pnpm exec kindgi providers register --spec=@acme-llm.json
pnpm exec kindgi runs start --agent=acme.order-desk --input='{"userMessage":"Where is my order A-1002?"}'
```

`register` prints the provider's id, as JSON. The turn's run shows which
provider answered:

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
  the same machine as `kindgi dev`. For a server in your network, it's that
  server's address, such as `http://<host>:<port>/v1`.
- **`region`** is a label of your choosing. Agents can require it.
- **`contextWindow`** is the context your server serves the model with, which
  can be less than the model's own.

To have `kindgi dev` register it on every boot, ask your coding agent to put
the spec in the pack's config instead. It goes there as `{ spec: { … } }` in
`providers`.
[Declare them in your pack's config](../#declare-them-in-your-packs-config)
shows how.

## Extra request fields

Some servers need fields the OpenAI API doesn't have. A thinking model, such
as Qwen 3, writes its reasoning before its answer unless it's asked not to.
An agent with a [typed answer](../../agents/typed-answer/) then gets an
answer that isn't JSON. If you can't change the server's defaults, send the field
with every request. Ask your coding agent, for example: "Turn thinking off for my Ollama model."

For reference, `adapter_config` is flat: each extra field is one key that starts with
`extraBody.`, and the dots nest. The provider in
[The provider](#the-provider) sends, with every call:

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
the way `dev-echo` does. Ask your coding agent: "Use my Ollama model only
when no other model fits." For reference, it adds `"fallback": true` to `metadata`:

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

## Next

- [Connect an OpenAI-compatible endpoint](../openai-compatible/)
- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Give an agent a typed answer](../../agents/typed-answer/)
