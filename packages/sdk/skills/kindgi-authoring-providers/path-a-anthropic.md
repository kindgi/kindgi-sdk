# Path A — Hosted, native Anthropic

## Contents

- Step 1 — set the key
- Step 2 — declare it in the pack's config, and commit it
- Staging and production: register by hand, once per runtime
- Step 2 (by hand) — write `provider.json`
- Step 3 — register
- Step 4 — verify
- Step 5 — run
- The other one-key presets

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
workspace's runtime, not to a file (`kindgi-cloud.md`).

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
a `thinking-level-adjusted` warning. A call that asks none is sent the
model's `thinking.default`, which no preset sets, so it thinks as the
vendor sets unless your own spec gives one (runtime 0.3.0 or later).
Thinking counts against `maxOutputTokens` and bills as output.
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
  (`kindgi-cloud.md`; mistake 1 in `common-mistakes.md`). `--max-output-tokens=<n>` sets
  another output cap.
- To change a provider there, unregister it first (mistake 5 in `common-mistakes.md`), then
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
capability requirement (`router.md`).

Nothing to switch off: `dev-echo` is a fallback, so the new provider
answers every agent it satisfies. A turn that still lands on dev-echo
carries the `fallback-provider` and `dev-echo-not-a-model` warnings — see
mistake 9 in `common-mistakes.md`.

**The other one-key presets** work the same way, with their own key:
`--preset=openai` (`OPENAI_API_KEY`), `--preset=gemini-api` (`GEMINI_API_KEY`,
a Google AI Studio key; `gemini` is Vertex AI), `--preset=groq`
(`GROQ_API_KEY`) and `--preset=openrouter` (`OPENROUTER_API_KEY`).
`kindgi providers presets` lists them with their models.
