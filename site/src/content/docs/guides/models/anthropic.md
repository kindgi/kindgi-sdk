---
title: Connect Anthropic
description: Register Claude from the Anthropic preset, with your API key stored as a secret instead of in your code.
sidebar:
  order: 1
---

This guide connects Claude to your agents through the `anthropic` preset,
with your API key stored as a secret instead of in your code.

The `anthropic` preset registers Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and
Haiku 4.5 on the Anthropic API, with their features, context windows and
prices. Sonnet 5.5 is its default. You provide the key.

## Before you start

- **A pack** with `kindgi dev` running, from Kindgi 0.2's CLI.
- **An Anthropic API key.**
- **An agent,** to try it. This guide uses `acme.order-desk`.

## 1. Store the key

The preset reads the key from a secret. In the pack, store it:

```sh
pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
```

- `ANTHROPIC_API_KEY` is the secret's name, the one the preset reads.
- `--env=local` is the environment the secret belongs to. Under
  `kindgi dev`, `local` is the pack's env files, `.kindgi/secrets.env` among
  them.
- `--scope=tenant` is where the secret lives: the tenant, rather than one org
  (`org:<orgId>`) or project (`project:<projectId>`).

It prompts for the key without echoing it and writes it to Kindgi's own
`.kindgi/secrets.env`, a file only you can read, which your app doesn't load.
A line `ANTHROPIC_API_KEY=…` in your app's `.env` or `.env.local` works too.
`kindgi secrets copy` gives Kindgi its own copy of it, as
[Keep local values in env files](../../secrets/env-files/#a-key-your-apps-env-files-already-hold)
shows. Keep your env files out of git. `kindgi init` already keeps
`.kindgi/` out.

## 2. Register the preset

Register the preset's models with the runtime. `--preset=anthropic` names
the preset:

```sh
pnpm exec kindgi providers register --preset=anthropic
```

```text
{
  "providerId": "anthropic"
}
✓ Registered anthropic: claude-opus-5-5, claude-sonnet-5-5 (default), claude-haiku-5-5, claude-haiku-4-5 — key ANTHROPIC_API_KEY (env local)
```

- `--models=claude-sonnet-5-5` registers only the models you list,
  separated by commas. The default stays the default when it's among them.
- `--secret=<NAME>` reads the key from another variable than
  `ANTHROPIC_API_KEY`.
- To have `kindgi dev` register it on every boot, in every worktree and after
  `--reset`, declare it in the pack's config instead: `{ preset: 'anthropic' }`
  in `kindgi.config.ts`'s `providers`, or a `[[tool.kindgi.providers]]` table
  with `preset = "anthropic"` in `pyproject.toml`, as
  [Declare them in your pack's config](../#declare-them-in-your-packs-config)
  shows.

The preset checks that the key is there first:

```text
Error: ANTHROPIC_API_KEY (the anthropic key) is not in .env, .env.local, .kindgi/secrets.env. Set it first, then register again:
  pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant   # a no-echo prompt
or add ANTHROPIC_API_KEY=… to .kindgi/secrets.env yourself (Kindgi's own file; your app doesn't load it).
If the runtime already holds ANTHROPIC_API_KEY in another environment (a deployed runtime's, for example), name it: pnpm exec kindgi providers register --preset=anthropic --env=<that environment>. Without --env, the preset reads local, the pack's own env files.
```

## 3. Run an agent

The provider answers from the next turn on, and nothing restarts. Start a
turn. `--agent` is the agent, and `--input` its input:

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
    "usage": { "steps": 2, "durationMs": 3701, "promptTokens": 1119, "totalCostUsd": 0.004328, "completionTokens": 209 },
    …
    "provider": { "id": "anthropic", "model": "claude-sonnet-5-5" },
    "response": { "role": "agent", "content": "Order A-1001 shows as shipped, and its expected delivery date was October 6, 2026. That date has passed and I can't see any newer tracking details, so the order is running late.", … },
    …
  }
}
```

`totalCostUsd` is the turn's cost at the preset's prices.

## Which Claude model answers

| Model | Features | Context window | Per 1K input / output tokens |
| --- | --- | --- | --- |
| `claude-opus-5-5` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.004 / $0.02 |
| `claude-sonnet-5-5` (default) | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.002 / $0.01 |
| `claude-haiku-5-5` | `tool-use`, `parallel-tool-use`, `structured-output`, `long-context` | 1,000,000 | $0.0001 / $0.0005; a prompt over 100,000 tokens: $0.0005 / $0.0025 |
| `claude-haiku-4-5` | `tool-use`, `parallel-tool-use` | 200,000 | $0.001 / $0.005 |

Among the models that meet an agent's needs, Kindgi takes the agent's preferred
one, else the default, `claude-sonnet-5-5`. To choose, set `preferredModel` or
require the model, as
[Choose the model an agent uses](../../agents/choose-a-model/) shows. To
offer only some models, register only those, with `--models`.

The Claude 5.5 models take no `temperature`, and they think before they
answer. [Temperature and thinking](../#temperature-and-thinking) says what
that means for an agent.

Anthropic lists each model's status, and any retirement date, on its
[model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
page. A turn routed to a retired model fails, so an agent that prefers or
requires one needs a new version naming another model. `claude-haiku-5-5` costs a tenth as much as `claude-haiku-4-5` for a
prompt up to 100,000 tokens, with five times the context.

## Prompt caching

Kindgi asks Anthropic to cache the parts of a prompt that repeat: the tool
definitions, the agent's instructions and, during a turn, the conversation so
far. The turn's next call reads them at a fraction of the input price: 5% on
Opus 5.5 and Sonnet 5.5, 10% on Haiku. The call that first writes them pays
125% on what it writes. In a live check, a three-call turn with a
7,700-token prompt on `claude-sonnet-5-5` came to $0.023 by Kindgi's estimate
of the turn's cost, `totalCostUsd`, against $0.048 for the same calls
uncached.

There's nothing to set. A prompt shorter than the model's minimum isn't
cached and costs nothing extra. On the 5.5 models, the minimum is 512
tokens. Anthropic's
[prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
says how it keeps cached prompts, and for how long.
[API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
says whether caching is eligible for zero data retention.

A registration whose models have no `promptCacheReadMultiplier` prices cache
reads at 10% on every model, so it overstates them on Opus 5.5 and Sonnet
5.5. Register the preset again to get the 5% rate, as
[Register the preset again](#register-the-preset-again) shows.

## Register the preset again

A registration with no default model doesn't list Haiku 5.5 either, so an
agent that names no model gets `claude-haiku-4-5`, the first by name.
Register the preset again with an updated CLI. A registration can't be
edited, so unregister it first:

```sh
pnpm exec kindgi providers unregister anthropic
pnpm exec kindgi providers register --preset=anthropic
```

`unregister` prints its answer as JSON. `register` prints the same
`✓ Registered anthropic: …` line as in step 2.

If the pack's config declares the preset, restart `kindgi dev` instead: it
registers the preset's new models in place of the old ones.

## If it doesn't answer

A wrong key fails the turn with Anthropic's own message:

```text
Error [model-invocation-failed]: Model call to anthropic (claude-sonnet-5-5) failed: 401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}
```

To change the key, set it again with `--write-mode=add-version`. The next
turn uses the new one.

If `dev-echo` still answers, the turn has a `fallback-provider` warning. The
agent needs something none of the registered models has, as
[`dev-echo`, the fallback](../../agents/choose-a-model/#dev-echo-the-fallback)
explains.

## Next

- [Choose the model an agent uses](../../agents/choose-a-model/)
- [Models](../)
- [Store a secret](../../secrets/store-a-secret/)
