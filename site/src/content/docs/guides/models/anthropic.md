---
title: Connect Anthropic
description: Register Claude from the Anthropic preset, with your API key in the pack's env files instead of your code.
sidebar:
  order: 1
---

The `anthropic` preset registers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and
Haiku 4.5 on the Anthropic API, with their features, context windows and
prices. Sonnet 5.5 is its default. You provide the key.

## 1. Store the key

With `kindgi dev` running, in the pack:

```sh
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
```

It prompts for the key without echoing it and writes it to the pack's
`.env.local`. A line `ANTHROPIC_API_KEY=…` in the pack's `.env` works too, so a
pack inside an app whose `.env` already has the key needs nothing more. Keep
both files out of git.

## 2. Register the preset

```sh
kindgi providers register --preset=anthropic
```

```text
{
  "providerId": "anthropic"
}
✓ Registered anthropic: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5 — key ANTHROPIC_API_KEY (env local)
```

- `--models=claude-sonnet-5-5` registers only the models you list
  (comma-separated). The default stays the default when it's among them.
- `--secret=<NAME>` reads the key from another variable than
  `ANTHROPIC_API_KEY`.
- To have `kindgi dev` register it on every boot, in every worktree and after
  `--reset`, declare it in the pack's config instead: `{ preset: 'anthropic' }`
  in `kindgi.config.ts`'s `providers`, or a `[[tool.kindgi.providers]]` table
  with `preset = "anthropic"` in `pyproject.toml`. See [Declare them in your pack's config](../#declare-them-in-your-packs-config).

The preset checks that the key is there first:

```text
Error: ANTHROPIC_API_KEY (the anthropic key) is not in .env, .env.local. Set it first, then register again:
  pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # a no-echo prompt
or add ANTHROPIC_API_KEY=… to .env yourself.
```

## 3. Run an agent

The provider answers from the next turn on; nothing restarts.

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
    "usage": { "steps": 2, "durationMs": 2291, "promptTokens": 1449, "totalCostUsd": 0.001889, "completionTokens": 88 },
    …
    "provider": { "id": "anthropic", "model": "claude-haiku-4-5" },
    "response": { "role": "agent", "content": "Your order A-1001 has been shipped and is expected to arrive on October 6, 2026.", … },
    …
  }
}
```

`totalCostUsd` is the turn's cost at the preset's prices. This answer was
captured on `claude-haiku-4-5` (retiring on or after 2026-10-15); outputs on
newer models differ in wording, not shape.

## Which Claude model answers

| Model | Features | Context window | Per 1K input / output tokens |
| --- | --- | --- | --- |
| `claude-opus-5-5` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.004 / $0.02 |
| `claude-sonnet-5-5` (default) | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.002 / $0.01 |
| `claude-haiku-5-5` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.0001 / $0.0005; a prompt over 100,000 tokens: $0.0005 / $0.0025 |
| `claude-haiku-4-5` | `tool-use`, `parallel-tool-use` | 200,000 | $0.001 / $0.005 |

Among the models that meet an agent's needs, Kindgi takes the agent's preferred
one, else the default, `claude-sonnet-5-5`. To choose, set `preferredModel` or
require the model: see
[Choose the model an agent uses](../../agents/choose-a-model/). To offer only
some models, register only those (`--models`).

The Claude 5.5 models take no `temperature`, and they think before they
answer: see [Temperature and thinking](../#temperature-and-thinking).

Anthropic retires `claude-haiku-4-5` on or after **2026-10-15**; from then, a
turn routed to it fails. Its replacement is `claude-haiku-5-5`, which costs a
tenth as much for a prompt up to 100,000 tokens, with five times the context. An agent that prefers or requires
Haiku 4.5 needs a new version naming another model.

## If you registered it before 0.1.4

A registration from an earlier release has no default and doesn't list Haiku
5.5, so an agent that names no model gets `claude-haiku-4-5`, the first by
name. Register the preset again with this release's CLI. A registration can't
be edited, so unregister it first:

```sh
kindgi providers unregister anthropic
kindgi providers register --preset=anthropic
```

If the pack's config declares the preset, restart `kindgi dev` instead: it
registers the preset's new models in place of the old ones.

## If it doesn't answer

A wrong key fails the turn with Anthropic's own message:

```text
Error [model-invocation-failed]: Model call to anthropic (claude-sonnet-5-5) failed: 401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}
```

To change the key, set it again with `--write-mode=add-version`;
the next turn uses the new one.

If `dev-echo` still answers (the turn has a `fallback-provider` warning), the
agent needs something none of the registered models has: see
[`dev-echo`, the fallback](../../agents/choose-a-model/#dev-echo-the-fallback).
