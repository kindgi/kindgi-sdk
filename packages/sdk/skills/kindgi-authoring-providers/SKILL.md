---
name: kindgi-authoring-providers
description: >
  Wire an LLM model provider so a Kindgi pack's agents call a real model:
  Anthropic, the OpenAI-compatible adapter (OpenAI, Groq, OpenRouter,
  vLLM, Ollama, any OpenAI-compatible endpoint), Gemini on Vertex AI
  (Application Default Credentials, no key), Amazon Bedrock, or a local
  in-process ONNX model. Covers where the key lives (`kindgi secrets
  set`'s no-echo prompt, or the project's `.env` files, read at turn
  time), one provider row with several models under `metadata.models[]`,
  and how the router picks a (provider, model) per turn. Load this when
  the user asks to "register a provider", "use Claude / GPT / Groq / Llama
  / Gemini", "wire Anthropic", "use Vertex", "use Bedrock", "set up an API
  key for the agent", "give the pack on Kindgi Cloud its model key",
  "register the provider on staging", or when an agent's replies come from
  dev-echo because the pack, another worktree or a teammate's `kindgi dev`
  has no provider yet. Authoring agents is kindgi-authoring-agents; first
  steps are kindgi-getting-started.
type: core
library: "@kindgi/sdk"
version: "0.10.1"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
sources:
  - packages/adapters/model-anthropic/src/provider.ts
  - packages/adapters/model-gemini/src/provider.ts
  - packages/adapters/model-openai-compat/src/provider.ts
  - packages/adapters/model-in-process/src/provider.ts
  - packages/adapters/model-bedrock/src/config.ts
  - packages/api/src/routes/providers.ts
  - packages/secrets-dotenv/src/index.ts
---


# Wiring a model provider for a Kindgi pack

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

An **agent** is a versioned declaration; it needs a **provider** to run.
The provider is what turns the agent's messages into an LLM call.
`kindgi dev` ships with a stub `dev-echo` provider that only echoes
canned strings — fine for verifying the harness, useless for a real
agent turn. It is a **fallback** provider: it answers only when no other
registered provider fits the agent, so registering a real one takes over
with nothing else to change. This skill covers wiring a real one.

## How it fits together

1. **The API key** sits in Kindgi's own `.kindgi/secrets.env`
   (`kindgi secrets set NAME --env=local --scope=tenant`, a no-echo prompt)
   or the project's `.env` / `.env.local`. The runtime reads it through the
   dotenv secret binding at turn time. Never put a credential in
   `adapter_config`.
2. **The provider** is declared in the pack's config, committed, and
   registered by `kindgi dev` at each boot. On a runtime `kindgi dev`
   doesn't run, `kindgi providers register` registers it. One row is one
   connection (`metadata.id`, such as `anthropic`), its models under
   `metadata.models[]`.
3. **The agent's `capabilities.needs`** is matched against each
   (provider, model) at turn time.

## Your case: read this file

| Your case | Read |
|---|---|
| Anthropic, or another one-key preset: OpenAI, the Gemini API, Groq, OpenRouter | [path-a-anthropic.md](path-a-anthropic.md) |
| Any OpenAI-compatible endpoint by hand, or a local model through Ollama | [path-b-openai-compat.md](path-b-openai-compat.md) |
| A local in-process ONNX model, with the runtime run from source | [path-c-onnx.md](path-c-onnx.md) |
| Gemini on Vertex AI, signed in with Application Default Credentials | [path-d-vertex.md](path-d-vertex.md) |
| Amazon Bedrock | [bedrock.md](bedrock.md) |
| The pack on Kindgi Cloud: the key and the provider on `prod` | [kindgi-cloud.md](kindgi-cloud.md) |
| Where keys are read from, the registration body, fallbacks | [keys-and-registration.md](keys-and-registration.md) |
| Several providers or models: which one answers | [router.md](router.md) |
| An error, or replies still from dev-echo | [common-mistakes.md](common-mistakes.md) |

## Verifying end-to-end

```sh
# 0. Run the runtime (in its own terminal)
kindgi dev

# 1. Set the key (interactive, no-echo prompt)
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant

# 2. Declare the provider in the pack's config (step 2 of your path),
#    commit it, then restart `kindgi dev`: its boot prints
#    `anthropic: registered`

# 3. Confirm it's there (list shows nested models per provider)
kindgi providers list

# 4. Run an agent that needs `tool-use`
kindgi runs start \
  --agent=my-pack.some-agent \
  --input='{"userMessage": "test"}'
```

On Kindgi Cloud there's no `kindgi dev`, so the declaration doesn't apply
there: set the key with `--env=prod` (step 1), register the provider by
hand (`kindgi providers register --preset=anthropic --env=prod`), deploy
with `kindgi deploy --hosted --env=prod`, then run the agent.

If the run completes with `status: "completed"`, the whole chain works.
`secret-not-found` points at the key, "no provider satisfies capability" at
the model's `features`, and dev-echo's canned reply at mistake 9 in
[common-mistakes.md](common-mistakes.md).

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself
(silent registration failure masking a real error, an unknown adapter
reported as the wrong error, adapter regression, router picking
the wrong provider or wrong model) — not in your pack's provider spec —
load the `kindgi-framework-feedback` skill and file a structured report
with `kindgi feedback write`. That diagnostic is high-signal input the
maintainers can act on; don't let it disappear into the transcript.
