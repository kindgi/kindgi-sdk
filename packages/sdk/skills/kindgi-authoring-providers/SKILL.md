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
  `kindgi dev` the key lives in the project's env files — `.env`, then
  `.env.local` — added by hand or with `kindgi secrets set`'s no-echo
  prompt; the Kindgi runtime reads it through the dotenv secret binding
  at agent-turn time). One provider row exposes one
  connection with one or more models under `metadata.models[]`; the
  router picks the (provider, model) tuple per invocation. Load this
  when the user asks to "register a provider", "use Claude / GPT /
  Groq / Llama / Gemini", "wire Anthropic", "use Vertex", "set up an API key for the agent",
  or when an agent has been authored but the pack has no provider
  registered yet. Authoring agents themselves is covered by
  kindgi-authoring-agents; getting-started is covered by
  kindgi-getting-started.
type: core
library: "@kindgi/sdk"
version: "0.9.9"
sdk_version: "0.0.0"
pack_languages: [node, python]
sources:
  - packages/adapters/model-anthropic/src/provider.ts
  - packages/adapters/model-gemini/src/provider.ts
  - packages/adapters/model-openai-compat/src/provider.ts
  - packages/adapters/model-in-process/src/provider.ts
  - packages/api/src/routes/providers.ts
  - packages/secrets-dotenv/src/index.ts
---

# Wiring a model provider for a Kindgi pack

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`.
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
   `kindgi.config.ts`, or `envFiles` under `[tool.kindgi.dev]` in a Python
   pack's `pyproject.toml`). A key already in the app's `.env` just works.
   `kindgi secrets set` (interactive, no-echo) writes `.env.local`. For
   non-sensitive values (log levels, region names, feature flags),
   `kindgi env set NAME VALUE --env=local` writes the same file with a
   positional value — never route real secrets through it. `KINDGI_*`
   names configure Kindgi itself and are never resolvable as secrets.
2. **Provider registration** — `kindgi providers register --spec=@provider.json` (`POST /v1/providers`)
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

## Path A — Hosted, native Anthropic

Best fidelity to Anthropic's API (prompt caching, latest models, tool
use). Requires an `ANTHROPIC_API_KEY`.

A model's `structured-output` feature is a routing label: the model can
follow a JSON schema natively, but Kindgi's typed outputs use instructions,
then parse, check against the schema and repair, on every provider.

**Step 1 — set the key:**
```sh
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
# Prompts interactively (echo disabled). Paste the key, press enter.
```
Writes to `.env.local` at the pack root via the dotenv secret binding —
or add `ANTHROPIC_API_KEY=…` to `.env` / `.env.local` yourself; `kindgi
dev` reads both. If the pack lives inside an app whose `.env` already
has the key, there is nothing to do. Keep env files gitignored. For pipelines/CI, pipe the value with
`echo -n "$KEY" | kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant --from-stdin`,
or read from a mode-0600 file with `--from-file <path>`. Never pass a
credential on argv.

**Step 2 — register it, from the preset:**
```sh
kindgi providers register --preset=anthropic                          # Opus 5.5, Sonnet 5.5 (default), Haiku 5.5, Haiku 4.5
kindgi providers register --preset=anthropic --models=claude-sonnet-5-5  # just one
```
Don't pin `claude-haiku-4-5`: Anthropic retires it on or after 2026-10-15,
and a turn routed to it then fails; `claude-haiku-5-5` replaces it. Each
preset names a default model (`metadata.defaultModel`, marked `(default)`
when it registers), which an agent with no preference gets. A preset
registered before 0.1.4 has none: unregister it and register it again.
The Claude 5.5 and GPT-6 models take no `temperature` (`"sampling": false`:
the call goes without it, with a `sampling-unsupported` warning), and a
model's `thinking` says how it thinks; thinking counts against
`maxOutputTokens` and bills as output.
The preset carries the models, context windows, output limits and current
prices (`kindgi providers presets` lists the presets and when their prices
were checked); `--max-output-tokens=<n>` sets another output limit. In a pack it refuses until the key is in the pack's env files —
step 1. That's all for Anthropic; go to step 4. The rest of this path is
the same registration by hand, for a spec of your own.

**Or declare it in the pack's config**, and `kindgi dev` registers it on
every boot: in every git worktree (each has its own dev database), after
`--reset`, and on a teammate's machine. Prefer this for any provider the pack
needs under `kindgi dev`:
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
- A preset entry takes `models`, `project`, `secret` (the key's name, in place
  of the preset's) and `maxOutputTokens`, spelled the same in `pyproject.toml`;
  a `spec` entry is a `--spec` body. A
  key is always a secret's name (`secret_ref`); a credential in
  `adapter_config` is refused.
- Each boot prints `Providers from kindgi.config.ts:` with one line each:
  `registered`, `unchanged`, `registered again (changed in kindgi.config.ts)`,
  `unregistered (no longer in kindgi.config.ts)`, or ⚠ `not registered: <KEY>
  is not in .env, .env.local` (set the key, then restart: the config isn't
  watched).
- A provider with that id that `kindgi dev` didn't register is left as it is;
  if its region or models differ, a ⚠ line names the
  `kindgi providers unregister` that lets the config's version apply.
- A runtime `kindgi dev` doesn't run (staging, production) still gets its
  providers with `kindgi providers register`.

**Step 2 (by hand) — write `provider.json`** at the pack root. One connection,
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
`"secret_ref": { "envName": "local", "name": "GEMINI_SA_KEY" }`.

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
        "cost": { "promptUsdPer1kTokens": 0.00075, "completionUsdPer1kTokens": 0.00375 }
      },
      {
        "name": "gemini-3.5-flash-lite",
        "contextWindow": 1048576,
        "features": ["tool-use", "structured-output", "long-context"],
        "maxOutputTokens": 65536,
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

**Step 3 — register and check:**
```sh
kindgi providers register --spec=@provider.json
kindgi providers list
```
Or skip step 2: `kindgi providers register --preset=gemini --project=<your-gcp-project-id>`
registers both models above.
Then pin it from an agent with `preferredProvider: 'gemini'` (and a model
with `preferredModel`; in Python, `preferred_provider="gemini"` and
`preferred_model=…`), or let the router pick by capability.

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
   so does a Python `Agent` (`preferred_provider=`, `preferred_model=`).
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
   `@kindgi/adapter-model-openai-compat` and
   `@kindgi/adapter-model-in-process`; `kindgi providers presets` shows
   the id each preset uses.

1. **`envName` mismatch between the setter (`kindgi secrets set` or `env set`) and `provider.json`.**
   Both writers use `--env=<name>` (default `local`): `local` is the
   project's env files (`.env`, `.env.local`), any other name is
   `.env.<envName>`. If your `provider.json` has
   `"secret_ref": {"envName": "production", ...}`, the SecretBinding
   refuses to cross-resolve — you get `secret-not-found` at agent-turn
   time. Match them.

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
   at the PACK ROOT (the directory with `kindgi.config.ts`, or a Python
   pack's `pyproject.toml` with `[tool.kindgi]`) — `.env` and
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
    the endpoint answers, isn't (the first turn finds out). A
    registration stored before 0.1.5 wasn't checked: `kindgi doctor`
    names its problems (`GET /v1/providers/<id>/check`); unregister it
    and register it again.

## Verifying end-to-end

```sh
# 0. Run the runtime (in its own terminal)
kindgi dev

# 1. Set the key (interactive, no-echo prompt)
kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant

# 2. Register the provider (one row, all models)
kindgi providers register --preset=anthropic   # or --spec=@provider.json

# 3. Confirm it's there (list shows nested models per provider)
kindgi providers list

# 4. Run an agent that needs `tool-use`
kindgi runs start \
  --agent=my-pack.some-agent \
  --input='{"userMessage": "test"}'
```

If the run completes with `status: "completed"`, the whole chain works
end-to-end. If it fails with `secret-not-found`, check point (1). If it
fails with "no provider satisfies capability", check point (2). If it
completes with dev-echo's canned reply, see mistake 9.

## References

- `packages/adapters/model-anthropic/src/provider.ts` — Anthropic adapter
- `packages/adapters/model-openai-compat/src/provider.ts` — Universal adapter, full list of tested endpoints in header comment
- `packages/adapters/model-in-process/src/provider.ts` — Local ONNX adapter
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
