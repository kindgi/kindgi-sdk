---
name: kindgi-authoring-providers
description: >
  Wire an LLM model provider so a Kindgi pack's agents
  can actually call a real model. Covers four paths — hosted via
  Anthropic native adapter, Gemini on Vertex AI (Google Application
  Default Credentials, no API key), hosted via the OpenAI-compat adapter
  (works with OpenAI, Groq, self-hosted vLLM and Ollama, and any other
  OpenAI-compatible endpoint, a hosted gateway such as OpenRouter
  included), and local
  via the in-process ONNX adapter — plus the credential flow (in
  `kindgi dev` the key lives in Kindgi's own `.kindgi/secrets.env`, set
  with `kindgi secrets set`'s no-echo prompt, or in the project's env files
  (`.env`, `.env.local`); the Kindgi runtime reads it through the dotenv
  secret binding at agent-turn time). One provider row exposes one
  connection with one or more models under `metadata.models[]`; the
  router picks the (provider, model) tuple per invocation. Load this
  when the user asks to "register a provider", "use Claude / GPT /
  Groq / Llama / Gemini", "wire Anthropic", "use Vertex", "use Bedrock", "set up an API key for the agent",
  "give the pack on Kindgi Cloud its model key",
  "register the provider on staging",
  or when an agent has been authored but the pack has no provider
  registered yet, or another worktree or a teammate's `kindgi dev` has
  none. Authoring agents themselves is covered by
  kindgi-authoring-agents; getting-started is covered by
  kindgi-getting-started.
type: core
library: "@kindgi/sdk"
version: "0.9.17"
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

## Mental model

```
Project .env / .env.local    dotenv SecretBinding       runtime ProviderRegistry
─────────────────────────    ─────────────────────       ────────────────────────
ANTHROPIC_API_KEY=sk-...  →  resolve('local',            hydrated per tenant on first
                                'ANTHROPIC_API_KEY')     access; each row =
                                                          { metadata, adapter_id,
                                                            secret_ref?,
                                                            adapter_config? }
                                     │                          │
                                     ▼                          ▼
                             adapter factory ──── resolves apiKey lazily via closure
                                     │
                                     ▼
                             ModelProvider ────── router picks a (provider, model)
                                                   tuple when an agent's
                                                   capabilities.needs matches
```

Three moving parts:
1. **API key on disk** — in `kindgi dev` (environment `local`) the dotenv
   secret binding reads the project's own env files: `.env`, then
   `.env.local` on top (change the list with `dev.envFiles` in
   `kindgi.config.ts`, `envFiles` under `[tool.kindgi.dev]` in a Python
   pack's `pyproject.toml`, or `dev.envFiles` in a Java or Scala pack's
   `kindgi.config.json`), then Kindgi's own `.kindgi/secrets.env` on top.
   A key already in the app's `.env` just works. `kindgi secrets set`
   (interactive, no-echo) writes `.kindgi/secrets.env`, a file the app
   doesn't load (a framework loads `.env.local` into every route); `--app`
   writes the app's file instead, for a value the app reads too (a webhook
   signing secret). For non-sensitive values (log levels, region names,
   feature flags), `kindgi env set NAME VALUE --env=local` writes the app's
   `.env.local` with a positional value — never route real secrets
   through it. `KINDGI_*`
   names configure Kindgi itself and are never resolvable as secrets.
2. **Provider registration** — declared in the pack's config, which is
   committed, and registered by `kindgi dev` at each boot; on a runtime
   `kindgi dev` doesn't run, `kindgi providers register` (`POST /v1/providers`)
3. **Agent's `capabilities.needs`** — matched at the (provider, model) tuple level at turn time

**Registration body:** `{ metadata, adapter_id, secret_ref?, adapter_config? }`.
`secret_ref` points at the credential; `adapter_config` holds the adapter's
non-secret connection settings (a cloud project, a base URL) as flat string,
number or boolean values. Both are stored with the provider and handed to the
runtime; `kindgi providers list` / `get` show only `metadata`. Never put a
credential in `adapter_config`.

**Shape rule:** `ProviderMetadata.id` names the CONNECTION (e.g. `anthropic`,
`groq`, `local-onnx`); per-model fields (`name`, `contextWindow`, `cost`,
`features`) live inside `metadata.models[]`. One row can expose many models
under the same API key.

**Fallbacks:** `"fallback": true` in `metadata` makes a provider a
fallback — the router considers it only when no other provider satisfies
the agent's capability, and the turn's result then carries a
`fallback-provider` warning. `dev-echo` is one; a cheap local model can be
yours.

## On Kindgi Cloud: the key and its provider go under `prod`

A pack deployed with `kindgi deploy --hosted` runs on your workspace's
runtime on Kindgi Cloud, and that runtime serves the `prod` environment,
before and after you go live. The examples below use `--env=local`, for
`kindgi dev`. For Kindgi Cloud, name `prod` instead:

```sh
kindgi secrets set ANTHROPIC_API_KEY --env=prod --scope=tenant   # a no-echo prompt
kindgi providers register --preset=anthropic --env=prod
kindgi deploy --hosted --env=prod
```

- The runtime reads a provider's key in the environment its
  `secret_ref.envName` names, at tenant scope. Keep the key and the
  provider both on `prod`. A provider registered without `--env` reads
  `local`, not the `prod` key: `register` refuses when the pack's own env
  files lack the key (its message names `--env`), and otherwise the first
  turn can't find the key (mistake 1). By hand, `provider.json` has
  `"secret_ref": { "envName": "prod", … }`.
- `kindgi secrets set` has no default environment: name `--env` every time.
- The deployment `kindgi deploy` sends names no environment. Its
  `--env=prod` picks the pack's own `prod` settings, such as its signing
  key.
- `kindgi deploy` doesn't register providers, and the providers declared in
  the pack's config are `kindgi dev`'s only. Register once on `prod`, by
  hand, and again when you add a provider or change one.
- OpenAI, the Gemini API, Groq and OpenRouter take the same two lines,
  with their preset and key: `openai` and `OPENAI_API_KEY`, `gemini-api`
  and `GEMINI_API_KEY`, `groq` and `GROQ_API_KEY`, `openrouter` and
  `OPENROUTER_API_KEY`. Bedrock, Vertex AI and Azure OpenAI don't fit
  them: see Amazon Bedrock and Path D below, and `kindgi providers
  presets` for `azure-openai`'s settings.

The whole flow, from signing the CLI in to going live:
https://docs.kindgi.com/v0.1/hosted/deploy-your-agent/#your-model-key-and-its-provider

## Path A — Hosted, native Anthropic

Best fidelity to Anthropic's API (prompt caching, latest models, tool
use). Requires an `ANTHROPIC_API_KEY`.

A model's `structured-output` feature is a routing label: the model can
follow a JSON schema natively, but Kindgi's typed outputs use instructions,
then parse, check against the schema and repair, on every provider.

**Step 1 — set the key:**
```sh
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
# Prompts twice, echo disabled: paste the key, then again to confirm.
```
Under `kindgi dev`, this writes to `.kindgi/secrets.env` at the pack root
via the dotenv secret binding — or add `ANTHROPIC_API_KEY=…` to that file yourself; `kindgi dev`
also reads the app's `.env` / `.env.local`. If the pack lives inside an app
whose env file already has the key, it works as it is; `kindgi secrets copy`
gives Kindgi its own copy and never edits the app's files (the app may use
the key itself: leave removing it to the person). Keep env files gitignored. For pipelines/CI, pipe the value with
`echo -n "$KEY" | kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant --from-stdin`,
or read from a mode-0600 file with `--from-file <path>`. Never pass a
credential on argv.

For a pack on Kindgi Cloud, `--env=prod` instead: the key goes to your
workspace's runtime, not to a file (On Kindgi Cloud, above).

**Step 2 — declare it in the pack's config, and commit it.** `kindgi dev`
registers what the config declares on every boot: in every git worktree
(each has its own dev database), after `--reset`, and on a teammate's
machine. The declaration holds a key's name, never the key, so it goes in
git with the rest of the config. Committing it is how a teammate's
`kindgi dev`, or another worktree's, gets the same provider:
```ts
// in kindgi.config.ts
providers: [
  { preset: 'anthropic', models: ['claude-sonnet-5-5'] },  // key ANTHROPIC_API_KEY, from the env files
  { preset: 'gemini', project: 'acme-gcp', models: ['gemini-3.8-flash'] },
  { spec: { /* the provider.json body below */ } },
],
```
```toml
# in pyproject.toml: one table per provider, same keys
[[tool.kindgi.providers]]
preset = "anthropic"
models = ["claude-sonnet-5-5"]
```
In a Java or Scala pack's `kindgi.config.json`, the same keys:
`"providers": [{"preset": "anthropic", "models": ["claude-sonnet-5-5"]}]`.
- A preset entry takes `models`, the settings its preset asks for (`project`
  for `gemini`; `resourceName` and `deployments` for `azure-openai`; `region`
  for `bedrock`), `secret` (the key's name, in place of the preset's) and
  `maxOutputTokens`, spelled the same in `pyproject.toml` and
  `kindgi.config.json`. Its own settings are required and another preset's
  are refused. `deployments` is a map of model to deployment
  (`{ "gpt-6.1-sol": "gpt-6-1-sol" }`, a `[tool.kindgi.providers.deployments]`
  table in `pyproject.toml`, model names quoted), not the `--deployments` flag's
  `model=deployment,…`, and it names exactly the models the entry registers;
  a `spec` entry is a `--spec` body. A
  key is always a secret's name (`secret_ref`); a credential in
  `adapter_config` is refused.
- Each boot prints `Providers from kindgi.config.ts:` (the pack's config file) with one line each:
  `registered`, `unchanged`, `registered again (changed in kindgi.config.ts)`,
  `unregistered (no longer in kindgi.config.ts)`, or ⚠ `not registered: <KEY>
  is not in .env, .env.local, .kindgi/secrets.env` (set the key, then
  restart: the config isn't watched).
- A declaration applies at the next boot: the config isn't watched, so
  restart `kindgi dev` after changing it. Each person, and each worktree,
  sets the key in its own env files (step 1).
- A provider with that id that `kindgi dev` didn't register is left as it is;
  if its region or models differ, a ⚠ line names the
  `kindgi providers unregister` that lets the config's version apply.
- `.kindgi/dev/providers.json` is `kindgi dev`'s own record of what it
  registered. `.kindgi/` is gitignored, so that record stays in this
  worktree, and it isn't where a provider is declared.

Before pinning a Claude model, check its status on Anthropic's model
deprecations page (https://platform.claude.com/docs/en/about-claude/model-deprecations): a turn routed to a retired model fails. Prefer the
preset's default model. `anthropic` without `models` registers Opus 5.5,
Sonnet 5.5 (the default), Haiku 5.5 and Haiku 4.5. Each
preset names a default model (`metadata.defaultModel`, marked `(default)`
when it registers), which an agent with no preference gets. A preset
registered before 0.1.4 has none: unregister it and register it again.
The Claude 5.5 and GPT-6 models take no `temperature` (`"sampling": false`:
the call goes without it, with a `sampling-unsupported` warning), and a
model's `thinking` says how it thinks and the levels it takes (the presets
list each model's). An agent asks for a level with `thinking` in its model
settings; one the model doesn't take is rounded up, or to its highest, with
a `thinking-level-adjusted` warning. Thinking counts against
`maxOutputTokens` and bills as output.
The preset carries the models, context windows, default output caps (what
a call asks for when its agent sets no `maxOutputTokens`; not the model's own
limit) and current prices (`kindgi providers presets` lists the presets and
when their prices were checked); an entry's `maxOutputTokens` sets another cap. That's
all for Anthropic; go to step 4. The rest of this path is a spec of your
own, by hand.

**Staging and production: register by hand, once per runtime.** The
declaration drives `kindgi dev` only. A runtime `kindgi dev` doesn't run
(staging, production, Kindgi Cloud) gets its providers from
`kindgi providers register` against that runtime, once, and again when you
add a provider or change one. A registration is the runtime's, shared by
every environment it serves: register once in all when one runtime serves
both staging and prod, and once on each when they're separate runtimes. The
key isn't shared: set it first in each environment that runs the pack
(`kindgi secrets set ANTHROPIC_API_KEY --env=<environment>`), then:
```sh
kindgi providers register --preset=anthropic --env=<env>                          # the preset's models
kindgi providers register --preset=anthropic --models=claude-sonnet-5-5 --env=<env>  # just one
```
- `--env` names one of the pack's environments. On a runtime that keeps
  its values under one env, the key goes in that environment's project, and
  `register` with it prints the `kindgi secrets set` line, to run again with
  each other environment's name. On a runtime that serves several
  environments, or with an `--env` that isn't one of the pack's,
  `kindgi secrets set` asks for a `--scope`. On Kindgi Cloud, it's `prod`
  (On Kindgi Cloud, above; mistake 1). `--max-output-tokens=<n>` sets
  another output cap.
- To change a provider there, unregister it first (mistake 5), then
  register it again.
- `kindgi deploy` doesn't register providers. `kindgi promote` checks the
  target first and stops (exit 1) while it has no provider, naming
  `kindgi providers register --preset=<name>`.
- Nothing in git records what a runtime has registered:
  `kindgi providers list` against it shows it.
- Under `kindgi dev`, `kindgi providers register` puts a provider in this
  worktree's dev database only, and leaves nothing to commit. Use it to try a
  provider, then declare it.

**Step 2 (by hand) — write `provider.json`** at the pack root, and commit it:
like the declaration, it names its key (`secret_ref`) and never holds it.
Under `kindgi dev`, declare its body as a `spec` entry; on another runtime,
register it with `--spec` (step 3). One connection,
two models — matches how the Anthropic SDK actually works (the API
key is per-vendor; the model is per-call):
```json
{
  "metadata": {
    "id": "anthropic",
    "region": "us-east-1",
    "models": [
      {
        "name": "claude-opus-5-5",
        "contextWindow": 1000000,
        "features": ["tool-use", "structured-output"],
        "cost": {
          "promptUsdPer1kTokens": 0.004,
          "completionUsdPer1kTokens": 0.02
        },
        "description": "Most capable Opus — long-running agentic and knowledge work."
      },
      {
        "name": "claude-sonnet-5-5",
        "contextWindow": 1000000,
        "features": ["tool-use", "structured-output"],
        "cost": {
          "promptUsdPer1kTokens": 0.002,
          "completionUsdPer1kTokens": 0.01
        },
        "description": "Balanced performance/cost."
      }
    ],
    "description": "Anthropic Claude via native adapter."
  },
  "adapter_id": "@kindgi/adapter-model-anthropic",
  "secret_ref": { "envName": "local", "name": "ANTHROPIC_API_KEY" }
}
```

> ⚠ **Units gotcha:** the field is `promptUsdPer1kTokens` (per THOUSAND
> tokens), but every vendor pricing page (Anthropic, OpenAI, Groq)
> advertises rates PER MILLION. Divide by 1000 before you paste. Sonnet
> 5.5 is "$2 / MTok input" → `0.002`, "$10 / MTok output" → `0.01`. A
> misplaced factor makes real cost look 1000× real; a $0.15 budget
> blows in the first turn.

**Step 3 — register:**
```sh
kindgi providers register --spec=@provider.json
```
Returns `{providerId: "anthropic"}` on success. Idempotent in the sense
that re-registering the same id returns `provider-already-registered`;
unregister first if the config actually changed.

**Step 4 — verify:**
```sh
kindgi providers list
```

**Step 5 — run:** any agent whose `capabilities: [{needs: [{feature:
'tool-use'}]}]` is now routed to a (`anthropic`, `<one of the models>`)
tuple. The router picks by score; prefer a provider with
`preferredProvider` and pin a model with a `models: { allow: [...] }`
capability requirement (see "How the router picks…" below).

Nothing to switch off: `dev-echo` is a fallback, so the new provider
answers every agent it satisfies. A turn that still lands on dev-echo
carries the `fallback-provider` and `dev-echo-not-a-model` warnings — see
mistake 9.

**The other one-key presets** work the same way, with their own key:
`--preset=openai` (`OPENAI_API_KEY`), `--preset=gemini-api` (`GEMINI_API_KEY`,
a Google AI Studio key; `gemini` is Vertex AI), `--preset=groq`
(`GROQ_API_KEY`) and `--preset=openrouter` (`OPENROUTER_API_KEY`).
`kindgi providers presets` lists them with their models.

## Path B — Hosted via OpenAI-compat

Works with **any** OpenAI-compatible endpoint. Same adapter, different
`baseURL`:

| Provider | baseURL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| LiteLLM proxy | `http://localhost:4000/v1` |
| OpenRouter (a hosted gateway) | `https://openrouter.ai/api/v1` |

The connection carries the `baseURL` (in `adapter_config`);
each endpoint is a separate provider row because each has its own API
key + region. Within one row, list every model that endpoint exposes.

**Step 1 — set the key:**
```sh
kindgi secrets set GROQ_API_KEY --env=local --scope=tenant
# Interactive prompt; paste and enter.
```

**Step 2 — `provider.json`** (Groq, exposing two Llama variants):
```json
{
  "metadata": {
    "id": "groq",
    "region": "us-central-1",
    "models": [
      {
        "name": "llama-3.3-70b-versatile",
        "contextWindow": 128000,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0.00059,
          "completionUsdPer1kTokens": 0.00079
        }
      },
      {
        "name": "llama-3.1-8b-instant",
        "contextWindow": 128000,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0.00005,
          "completionUsdPer1kTokens": 0.00008
        },
        "description": "Fast + cheap tier — routing, classification."
      }
    ],
    "description": "Groq-hosted Llama via OpenAI-compat."
  },
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "secret_ref": { "envName": "local", "name": "GROQ_API_KEY" },
  "adapter_config": { "baseURL": "https://api.groq.com/openai/v1" }
}
```

**Steps 3–5** same as Path A.

## Path C — Local via in-process ONNX (runtime from source only)

> ⚠️ **Not in the runtime image, so not under `kindgi dev`.** The adapter
> runs ONNX through `onnxruntime-node`, which ships glibc binaries only,
> and the Kindgi runtime image is Alpine (musl): the adapter can't load
> there (`Error loading shared library ld-linux-…`). `kindgi dev` runs
> that image, so this path fails under it. It works only when the
> runtime itself runs from source on macOS or a glibc Linux. **For a
> local model under `kindgi dev`, use Ollama** ([Local via Ollama](#local-via-ollama-via-path-b)).

> ⚠️ **Dev-only.** The in-process ONNX adapter writes weights to
> `~/.cache/huggingface/hub/` — a per-machine cache with no production
> recipe (no volume-mount recipe, no image-bake pattern, no offline
> mode, no SHA pinning). Good for smoke tests and CI runners that run
> the runtime from source and keep the same disk between runs. **Do not
> ship packs that rely on this adapter to production.** Use hosted
> providers (Path A) or Ollama (Path B) instead.

No API key. No network. Bundled with the framework — the adapter ships
`smollm2-360m` by default (~273 MB weights, cached at
`~/.cache/huggingface/hub/models--HuggingFaceTB--SmolLM2-360M-Instruct/`
after `kindgi adapters prepare`).

**Not for reasoning-heavy agents.** SmolLM 360M is fine for smoke
tests, canary agents, dev/CI. Real work needs a hosted model or a
larger local model via Ollama (Path B).

**`provider.json`** (single-model):
```json
{
  "metadata": {
    "id": "local-onnx",
    "region": "in-process",
    "models": [
      {
        "name": "smollm2-360m",
        "contextWindow": 2048,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0,
          "completionUsdPer1kTokens": 0
        }
      }
    ],
    "description": "Local ONNX smollm2-360m — dev + smoke tests."
  },
  "adapter_id": "@kindgi/adapter-model-in-process"
}
```

Multi-model variant — the in-process adapter loads each pipeline lazily,
so listing several models keeps memory low until they're actually
invoked:

```json
{
  "metadata": {
    "id": "local-onnx",
    "region": "in-process",
    "models": [
      { "name": "smollm2-135m", "contextWindow": 2048, "features": [],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } },
      { "name": "smollm2-360m", "contextWindow": 2048, "features": ["tool-use"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } },
      { "name": "qwen3-0.6b", "contextWindow": 32768, "features": ["tool-use", "long-context"],
        "cost": { "promptUsdPer1kTokens": 0, "completionUsdPer1kTokens": 0 } }
    ]
  },
  "adapter_id": "@kindgi/adapter-model-in-process"
}
```

No `secret_ref` needed. Register + **prepare** + run:
```sh
kindgi providers register --spec=@provider.json
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-360m
kindgi runs start --agent=<agent-id> --input='{...}'
```

**Always `prepare` before `runs start`.** It downloads the ONNX weights
(~273 MB for smollm2-360m, ~30s on a typical connection) and streams
per-file progress. Skipping it works — the first model call downloads
lazily — but that stalls a request path on a multi-hundred-MB
fetch with no observability, which is bad in dev and unacceptable in
production. Skip only for scripted teardown where the model is already
cached (`~/.cache/huggingface/hub/models--HuggingFaceTB--SmolLM2-360M-Instruct/`).

`prepare` is idempotent: subsequent invocations are cache hits and
return almost instantly, so put it in the script that boots your
from-source runtime.

Multi-model providers: prepare each model separately.
```sh
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-135m
kindgi adapters prepare @kindgi/adapter-model-in-process --model=smollm2-360m
kindgi adapters prepare @kindgi/adapter-model-in-process --model=qwen3-0.6b
```

## Local via Ollama (via Path B)

For bigger local models — Ollama runs them, we point at the OpenAI-compat
endpoint it exposes:

```json
{
  "metadata": {
    "id": "ollama",
    "region": "local",
    "models": [
      {
        "name": "llama3",
        "contextWindow": 8192,
        "features": ["tool-use"],
        "cost": {
          "promptUsdPer1kTokens": 0,
          "completionUsdPer1kTokens": 0
        }
      }
    ],
    "description": "Local Ollama Llama 3 8B."
  },
  "adapter_id": "@kindgi/adapter-model-openai-compat",
  "adapter_config": { "baseURL": "http://localhost:11434/v1" }
}
```

Ollama doesn't check a key, so the row has no `secret_ref`: without one,
the adapter sends a placeholder key, as local servers expect.

**Any model you serve yourself** (Ollama, vLLM, llama.cpp's
`llama-server`, LM Studio) must do two things for an agent:
- **Call tools in the OpenAI format.** Serve it with tool calling on
  (vLLM `--enable-auto-tool-choice --tool-call-parser <the model's>`,
  `llama-server --jinja`), and pick a model that supports tools.
- **Answer without its thinking.** A thinking model (Qwen and others)
  writes its reasoning first unless asked not to, and a typed answer then
  isn't JSON (`output-schema-violation`). Turn thinking off on the server
  (vLLM `--default-chat-template-kwargs '{"enable_thinking": false}'`,
  `llama-server --reasoning off`), or, for a shared server you can't
  reconfigure, per request from the provider row:
  `"extraBody.chat_template_kwargs.enable_thinking": false` in
  `adapter_config`. `adapter_config` is flat: one key per request field,
  dots nest.

Assumes Ollama is installed + the model is pulled (`ollama pull llama3`).
See ollama.com for install / hardware requirements — Llama 3 8B needs
~8GB RAM, Llama 3 70B needs ~48GB VRAM or ~140GB RAM.

## Path D — Gemini on Vertex AI

Gemini through Google Cloud's Vertex AI. No API key: the adapter uses
**Google Application Default Credentials** — your `gcloud` login on a
laptop, the attached service account on Cloud Run (and other Google Cloud
runtimes). The same registration works in both.

**Step 1 — credentials:**
```sh
gcloud auth application-default login     # once per laptop
```
The account (locally) or the service account (deployed) needs the
**Vertex AI User** role (`roles/aiplatform.user`) in the project. Running
outside Google Cloud: put a service-account key (its JSON) in a secret
(`kindgi secrets set GEMINI_SA_KEY --env=local --scope=tenant`) and add
`"secret_ref": { "envName": "local", "name": "GEMINI_SA_KEY" }`. A runtime
with `KINDGI_TENANT_HOST_ACCESS=isolated` requires that key: it doesn't lend
its own credentials to tenant configuration.

**Step 2 — `provider.json`:**
```json
{
  "metadata": {
    "id": "gemini",
    "region": "global",
    "models": [
      {
        "name": "gemini-3.8-flash",
        "contextWindow": 1048576,
        "features": ["tool-use", "structured-output", "long-context"],
        "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "low" },
        "cost": { "promptUsdPer1kTokens": 0.00075, "completionUsdPer1kTokens": 0.00375 }
      },
      {
        "name": "gemini-3.5-flash-lite",
        "contextWindow": 1048576,
        "features": ["tool-use", "structured-output", "long-context"],
        "maxOutputTokens": 65536,
        "thinking": { "mode": "adaptive", "lowest": "minimal" },
        "cost": { "promptUsdPer1kTokens": 0.0003, "completionUsdPer1kTokens": 0.0025 }
      }
    ]
  },
  "adapter_id": "@kindgi/adapter-model-gemini",
  "adapter_config": { "project": "<your-gcp-project-id>" }
}
```
- `adapter_config.project` is required: the Google Cloud project Vertex
  bills and authorises against.
- `metadata.region` is the Vertex location: `global`, or a region such as
  `us-central1` or `northamerica-northeast1` when data must stay in one
  place. `unspecified` means `global`. Different locations are different
  provider rows. Check that the location serves the model: Gemini 3.8 Flash
  isn't served from `us-central1`.
- Don't register `gemini-2.5-pro` or `gemini-2.5-flash`: Vertex AI retires
  both on 2026-10-20.
- Rates are per 1K tokens, from Google's published pricing; check them
  before relying on budgets. Thinking tokens bill as output, and Gemini 3.8
  Flash thinks by default. `gemini-3.8-flash`'s rates above are Google's
  launch price, through 2026-12-31 ($0.0015 / $0.0075 from 2027-01-01).
  `longContext` (`{ thresholdTokens, promptUsdPer1kTokens,
  completionUsdPer1kTokens }` in a model's `cost`) switches the whole call
  to the higher rates past the threshold; `cachedPromptMultiplier` (default 0.25) prices cached
  prompt tokens.
- `thinking` is how the model thinks, as the preset has it. `lowest` is
  the least level it takes, which a judge's call asks for. `levels`
  (optional) are the levels it takes besides `lowest`, least first; without
  them it takes `low`, `medium` and `high` (plus `minimal` when `lowest` is
  `minimal`, and none below `lowest` when that's `medium` or `high`).
- To make a model think less, the agent sets `thinking` in its model
  settings (`lowest`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
  For calls that ask none, set the model's `thinking.default`:
  `"thinking": { "mode": "adaptive", "lowest": "low", "default": "low" }`.
  A `default` the model doesn't take is refused, naming the ones it takes.
  A model without one thinks as Google sets. It needs runtime 0.3.0 or
  later; an older one refuses a `thinking` with `default`.
- `adapter_config.thinkingLevels` is no longer read. A new registration
  with it is refused (`adapter_config.thinkingLevels isn't read here: its
  setting is metadata.models[].thinking.default.`); a stored one builds,
  thinking at Google's default, and `kindgi doctor` warns. Move each
  `model=level` pair into that model's `thinking.default`, unregister the
  provider and register it again.

**Step 3 — register and check:**
```sh
kindgi providers register --spec=@provider.json
kindgi providers list
```
Or skip step 2: `kindgi providers register --preset=gemini --project=<your-gcp-project-id>`
registers both models above.
Then pin it from an agent with `preferredProvider: 'gemini'` (and a model
with `preferredModel`; in Python, `preferred_provider="gemini"` and
`preferred_model=…`; in Java, `.set("preferredProvider", "gemini")`), or let
the router pick by capability.

## Amazon Bedrock

Nova, Claude and GPT on Amazon Bedrock. The `bedrock` preset signs in as the
runtime's own AWS identity (`KINDGI_AWS_IDENTITY` says where it comes from),
so it takes no key:
```sh
kindgi providers register --preset=bedrock --region=us-east-2
kindgi providers register --preset=bedrock --region=us-east-2 \
  --models=us.anthropic.claude-haiku-4-5-20251001-v1:0   # Claude, not Nova Pro
```
`--region` is the US Region the account uses Bedrock in: the preset's models
are US cross-region inference profiles. Its default model is Amazon Nova Pro
(`us.amazon.nova-pro-v1:0`). Claude and GPT also need the AWS account's
access to their vendor's models
(https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

**On a runtime with `KINDGI_TENANT_HOST_ACCESS=isolated`, use a Bedrock API
key.** That runtime doesn't lend its own credentials to tenant configuration,
so it refuses the preset at registration and stores nothing:
```text
  ✗ /adapter_config/auth: adapter_config.auth = aws-identity (the default) signs in as the runtime's own AWS identity, which this deployment doesn't let tenant configuration use (KINDGI_TENANT_HOST_ACCESS). Set auth = api-key, with secret_ref naming a Bedrock API key.
```
`--secret` doesn't change that: the preset still signs in as the runtime.
Register from a spec whose `adapter_config.auth` is `api-key` and whose
`secret_ref` names the key:

1. **A long-term Bedrock API key**, made in the Region the provider uses. A
   short-term key lasts 12 hours at most, so a registration can't keep one,
   and a key works only in the Region it was made in. AWS recommends
   long-term keys for exploration only: tell the person so, with AWS's page
   (https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).
2. **Stored as a tenant secret**, with the no-echo prompt:
   `kindgi secrets set BEDROCK_API_KEY --env=production --scope=tenant`.
3. **Registered:** `kindgi providers register --spec=@bedrock.json`, with
   ```json
   {
     "adapter_id": "@kindgi/adapter-model-bedrock",
     "adapter_config": { "auth": "api-key" },
     "secret_ref": { "envName": "production", "name": "BEDROCK_API_KEY" },
     "metadata": {
       "id": "bedrock",
       "region": "us-east-2",
       "models": [
         { "name": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "contextWindow": 200000,
           "maxOutputTokens": 16000, "features": ["tool-use", "parallel-tool-use"],
           "cost": { "promptUsdPer1kTokens": 0.0011, "completionUsdPer1kTokens": 0.0055 } }
       ]
     }
   }
   ```

One provider is one Region and one key: another Region is another provider,
with a key made there. The key is read when a turn calls the model, not at
registration.

The same holds for the other providers that can sign in as the runtime on
`isolated`. Gemini on Vertex AI takes a service-account key in `secret_ref`
(Path D). Azure OpenAI's `auth: entra` is refused: use the `azure-openai`
preset, with the resource's key. A provider registered before the runtime
moved to `isolated` that signs in as the runtime isn't used there: a turn
that needs it fails with `422 capability-routing-failed`. Unregister it, and
register it again with a key.

Docs: https://docs.kindgi.com/v0.1/guides/models/#with-a-bedrock-api-key

## How the router picks between multiple providers + models

When an agent turn fires, the router expands each registered provider
into one entry per model (`metadata.models[]`), filters the resulting
(provider, model) tuples against the agent's `capabilities.needs` (and
tenant policy), then sorts survivors in this order:

1. **Preferred provider / model.** Tuples matching the agent's
   `preferredProvider` and `preferredModel` are promoted to the front.
     - Both set → promote the exact tuple.
     - Only `preferredModel` set → promote any provider exposing that model.
     - Only `preferredProvider` set → promote every model of that provider.
   `defineAgent` takes both (`preferredProvider`, `preferredModel`), and
   so does a Python `Agent` (`preferred_provider=`, `preferred_model=`) and
   a Java `Agent.define(…)` (`set("preferredProvider", …)`).
2. **`capability.prefer[]` weights.** If the agent's capability
   declares `prefer: [{feature: 'thinking', weight: 3}, ...]`, tuples
   with matching model features (or provider attributes) get higher
   scores. Sorted by summed score, descending.
3. **Deterministic tiebreak.** When scores tie, tuples sort by provider
   id, then the provider's `defaultModel` before its other models, then
   model name — replay-safe and stable. A provider without a
   `defaultModel` falls back to its first model by name.

**Practical rule:** preferences are soft — they rank, they don't
exclude. To guarantee which model runs, make it a hard requirement in
the capability: `{ models: { allow: ['claude-sonnet-5-5'] } }` (and
`{ providers: { allow: ['anthropic'] } }` to pin the connection). If no
registered tuple satisfies it, the turn fails with
`capability-routing-failed` instead of silently using another model.

**A/B testing a specific agent across models within one Anthropic
registration:**

```ts
// agents/weather-agent-sonnet/index.ts
defineAgent({
  id: 'my-pack.weather-agent-sonnet',
  // …same name, instructions, tools, retrieval and guardrails as the opus variant
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-sonnet-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});

// agents/weather-agent-opus/index.ts
defineAgent({
  id: 'my-pack.weather-agent-opus',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-opus-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});
```

The same pair in a Python pack (`kindgi.Agent`; module-level, one file each):

```python
# agents/weather_agent_sonnet.py
weather_agent_sonnet = Agent(
    id="my-pack.weather-agent-sonnet",
    # …same version, name, instructions, tools and guardrails as the opus variant
    capabilities=[
        {"needs": [{"feature": "tool-use"}, {"models": {"allow": ["claude-sonnet-5-5"]}}]},
    ],
    preferred_provider="anthropic",
)

# agents/weather_agent_opus.py
weather_agent_opus = Agent(
    id="my-pack.weather-agent-opus",
    # …
    capabilities=[
        {"needs": [{"feature": "tool-use"}, {"models": {"allow": ["claude-opus-5-5"]}}]},
    ],
    preferred_provider="anthropic",
)
```

Both agents share the tool + instructions; only the pinned model
differs. One Anthropic provider registration + one API key covers
both. Register the provider once, then invoke each agent to compare
outputs on the same inputs.

**A/B testing across vendors:**

```ts
defineAgent({
  id: 'my-pack.weather-agent-groq',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['llama-3.3-70b-versatile'] } }] },
  ],
  preferredProvider: 'groq',
});

defineAgent({
  id: 'my-pack.weather-agent-anthropic',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-sonnet-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});
```

## Common mistakes

0. **`adapter_id` uses the short name.** The `adapter_id` field must
   be the FULL npm package name of the adapter — `"@kindgi/adapter-model-anthropic"`,
   NOT `"anthropic"`. Adapters are registered with the runtime under
   their full package names, and a short name matches none of them, so
   registering is refused: the runtime has no adapter by that name
   (`✗ /adapter_id: …`). The model adapters are
   `@kindgi/adapter-model-anthropic`, `@kindgi/adapter-model-gemini`,
   `@kindgi/adapter-model-openai-compat`,
   `@kindgi/adapter-model-azure-openai`, `@kindgi/adapter-model-bedrock` and
   `@kindgi/adapter-model-in-process`; `kindgi providers presets` shows
   the id each preset uses.

1. **`envName` mismatch between the key and the provider's `secret_ref`.**
   The runtime reads a provider's key in the environment its
   `secret_ref.envName` names, at tenant scope. The SecretBinding refuses
   to cross-resolve, so a key held under another environment gives
   `secret-not-found` at agent-turn time. Where each one lands:
   `kindgi secrets set` needs `--env=<name>`; `kindgi providers register
   --preset` writes `--env`'s name, or `local` without it; a `--spec` file
   names its own (`"secret_ref": {"envName": "production", ...}`). Under
   `kindgi dev`, `local` is the project's env files (`.env`, `.env.local`)
   and `.kindgi/secrets.env`; any other name is `.env.<envName>`. Match
   them. On Kindgi Cloud, both are `prod`.

2. **Missing `features` on the model.** Agent declares
   `capabilities: [{needs: [{feature: 'tool-use'}]}]`; at least one
   model inside `metadata.models[]` must list `"features":
   ["tool-use"]` or the router filters every tuple out. If `kindgi
   runs start` returns "no provider satisfies capability", check the
   per-model `features` list — not a provider-level field anymore.

3. **Empty `models[]`.** Registration rejects with `empty-models`. Every
   provider row must expose at least one model. Duplicate `name` within
   the same array is also rejected (`duplicate-model-name`).

4. **Setting `secret_ref` for the in-process adapter.** `in-process`
   ignores `secret_ref` — no key needed. Leaving it in is harmless but
   noisy.

5. **Registering the same provider id twice with different config.**
   Returns `409 provider-already-registered`. Unregister first:
   ```sh
   kindgi providers unregister <provider-id>
   ```
   Then re-register.

6. **Key not found by the runtime.** `kindgi dev` reads the env files
   at the PACK ROOT (the directory with `kindgi.config.ts`, a Python
   pack's `pyproject.toml` with `[tool.kindgi]`, or a Java or Scala pack's
   `kindgi.config.json`) — `.env` and
   `.env.local`, or whatever `dev.envFiles` lists; the boot log prints
   which files it found. A `KINDGI_`-prefixed name is Kindgi runtime
   config and never resolves as a secret. Outside `kindgi dev`, the
   runtime resolves secrets through the deployment's `SecretBinding`
   (a KMS- or database-backed store, for example).

7. **Forgetting to restart `kindgi dev` after registering a provider.**
   You don't need to — provider registrations go to the running runtime
   over HTTP (`POST /v1/providers`), which invalidates the tenant's
   cached provider set. The next `kindgi runs start` sees the new
   provider.

8. **Compound `preferredProvider` strings.** `preferredProvider` is a
   provider (connection) id such as `'anthropic'`; the model is a
   separate choice. A value like `'anthropic-claude-sonnet-5-5'`
   (vendor + model baked together) matches no provider id, so the hint
   does nothing. Pin the model with a `models: { allow: [...] }`
   requirement instead.

9. **Replies still come from dev-echo** (`⚠ dev-echo isn't a real model: …`
   then `Tool responded: …`; the turn's result has the `fallback-provider`
   and `dev-echo-not-a-model` warnings). dev-echo is a fallback: it
   answers only when no registered provider satisfies the agent. So your
   provider doesn't — check its models' `features` against the agent's
   `capabilities.needs` (mistake 2), a `models` / `providers` allow-list
   that names nothing registered, and the tenant's policy. `kindgi
   providers list` shows what is registered.

10. **A setting the adapter can't use.** Registering checks the spec
    against its adapter (no network call, no key read) and refuses what
    it can't use: `422 provider-config-invalid`, nothing stored, one line
    per problem with its JSON-pointer path:
    ```text
    Error [invalid-request]: Provider "ollama" doesn't fit adapter @kindgi/adapter-model-openai-compat: adapter_config.api must be one of responses, chat-completions.
      ✗ /adapter_config/api: adapter_config.api must be one of responses, chat-completions.
    ```
    Fix each `✗` line's setting and register again. A key the adapter
    needs is checked too (`✗ /secret_ref: …`); whether the key works, or
    the endpoint answers, isn't (the first turn finds out). So is each
    `adapter_config` key: one the adapter doesn't take is refused, naming
    the ones it takes (`✗ /adapter_config/timeout: adapter_config.timeout
    isn't a setting of this adapter: it takes baseURL, api,
    extraBody.<field>.`), and one that moved names its new place. A
    registration stored before 0.1.5 wasn't checked: `kindgi doctor`
    names its problems (`GET /v1/providers/<id>/check`); unregister it
    and register it again. A stored registration with a key its adapter
    doesn't take still builds, without reading it: the check lists it in
    `warnings`, apart from `issues`, and `kindgi doctor` shows it as a
    warning.

11. **A provider registered by hand under `kindgi dev`, with nothing
    committed.** `kindgi providers register` puts it in this worktree's dev
    database only. Another worktree, a `kindgi dev --reset`, or a
    teammate's `kindgi dev` has no provider, and its turns land on
    dev-echo (mistake 9). Declare the provider in the pack's config and
    commit it (step 2). `.kindgi/dev/providers.json` isn't the file to
    commit: it's `kindgi dev`'s local record of what it registered, and
    `.kindgi/` is gitignored.

## Verifying end-to-end

```sh
# 0. Run the runtime (in its own terminal)
kindgi dev

# 1. Set the key (interactive, no-echo prompt)
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant

# 2. Declare the provider in the pack's config (step 2), commit it, then
#    restart `kindgi dev`: its boot prints `anthropic: registered`

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

If the run completes with `status: "completed"`, the whole chain works
end-to-end. If it fails with `secret-not-found`, check point (1). If it
fails with "no provider satisfies capability", check point (2). If it
completes with dev-echo's canned reply, see mistake 9.

## References

- `packages/adapters/model-anthropic/src/provider.ts` — Anthropic adapter
- `packages/adapters/model-openai-compat/src/provider.ts` — Universal adapter, full list of tested endpoints in header comment
- `packages/adapters/model-in-process/src/provider.ts` — Local ONNX adapter
- `packages/adapters/model-bedrock/src/config.ts` — Amazon Bedrock's settings, and how it signs in
- `packages/api/src/routes/providers.ts` — `POST /v1/providers` route
- `packages/secrets-dotenv/src/index.ts` — Dev-mode secret binding

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself
(silent registration failure masking a real error, an unknown adapter
reported as the wrong error, adapter regression, router picking
the wrong provider or wrong model) — not in your pack's provider spec —
load the `kindgi-framework-feedback` skill and file a structured report
with `kindgi feedback write`. That diagnostic is high-signal input the
maintainers can act on; don't let it disappear into the transcript.
