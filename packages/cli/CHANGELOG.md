# @kindgi/cli

## 0.1.4

### Patch Changes

- 3f55467: `kindgi dev` runs runtime 0.1.4.
- ea1f668: **An unknown subcommand is an error, as an unknown command is.**
  - **Before:** `kindgi agents register` (the subcommand is `publish`) printed the `kindgi agents` help and exited 0, so a script or a coding agent went on.
  - **Now:** it exits 2, with the group's help on stderr after this line:
    `Unknown subcommand "register" for kindgi agents. Did you mean "publish"?`
  - **The hint** names the group's subcommand a typo away (`lsit` → `list`), or the one another group spells this way (`register` → `publish`, `delete` → `unregister`). It never suggests the opposite of what was typed.
  - **Unchanged:** a group with no subcommand, or only flags (`kindgi agents`, `kindgi agents --help`), still prints its help and exits 0.
- c43a6b4: `kindgi doctor` warns when a provider registered from a preset sends agents that name no model somewhere the preset no longer would: to a model the preset no longer lists (re-register for its current models), or, for a registration with no default model, not to the preset's default (re-register, or name a model on your agents). A warning is the new `status: "warn"`: it never fails, so `ok` stays `true` and the exit code `0`. Text output marks it `!`.
- 68da079: The providers skill and the `kindgi init` READMEs name each preset's default model and `claude-haiku-5-5`, and the skill says how ties now break (the provider's default model before its others), that the Claude 5.5 and GPT-6 models take no `temperature`, and how thinking counts. The guardrails README describes the `llm-judge` strategy, including its answer's token budget on a model that thinks.
- 6263b4b: Examples name models that aren't retiring. Anthropic retires `claude-haiku-4-5` on or after 2026-10-15 and Vertex AI retires `gemini-2.5-pro` and `gemini-2.5-flash` on 2026-10-20, so the `kindgi init` READMEs, the CLI README, the Gemini adapter's README and the providers and authoring-agents skills (TypeScript and Python) now use `claude-sonnet-5-5` and `gemini-3.8-flash`. The providers skill's Vertex `provider.json` registers `gemini-3.8-flash` and `gemini-3.5-flash-lite`, as the `gemini` preset does, and says not to pin the retiring models. It also says what a model's `structured-output` feature means: the model can follow a JSON schema natively, while Kindgi's typed outputs use instructions, then parse, check and repair, on every provider.
- 1c0252c: **A model that rejects `temperature` no longer fails the call.** Anthropic's Claude 4.7 and later (Opus 5.5, Sonnet 5.5, Haiku 5.5) answer a non-default `temperature` with a 400, and OpenAI's GPT-6 models take none at their reasoning efforts. A model's `ModelInfo` now says so with `sampling: false`. For such a model, every adapter sends the call without the temperature and says so in the answer's `warnings`, code `sampling-unsupported`. That covers a model-settings block, a guardrail judge and an eval judge alike.
  - `@kindgi/capabilities`: `ModelInfo.sampling`, and `samplingFor(model, input)`, the one place an adapter asks what to send.
  - The HTTP API keeps a model's `sampling` (it must be a boolean; otherwise 400, reason `invalid-sampling`) and returns it. The Python client's `ModelInfo` has it too.
  - The `anthropic`, `openai` and `openrouter` presets mark those models. A registration made from an older preset keeps sending the temperature: re-register to pick up the marks.
  - `kindgi providers register --preset` reads the provider back, and on a runtime that drops these rules (older than 0.1.4) says so in one line, naming the models whose temperature may be refused.
- 1c0252c: **A guardrail judge on a model that thinks still gets its verdict.** Claude Sonnet 5.5 and Opus 5.5, Haiku 5.5, Gemini 3.8 Flash and OpenAI's GPT-6 models think by default, and their thinking counts against the output cap. A judge's 256 tokens could be gone before the verdict.
  - `ModelInfo.thinking` (`{ mode: 'adaptive' | 'always', lowest }`) says how a model thinks and its vendor's setting for the least thinking. The HTTP API validates it (otherwise 400, reason `invalid-thinking`) and returns it; the Python client has `ModelThinking`.
  - `ModelCallInput.thinking: 'lowest'` asks for that least. The anthropic adapter sends Sonnet 5.5's `between_tools` or Haiku 5.5's `disabled` with effort `low`, and Opus 5.5's effort `low` alone. The gemini adapter sends the thinking level (`LOW` on 3.8 Flash, which refuses `MINIMAL`; `MINIMAL` on 3.5 Flash-Lite). openai-compat sends `reasoning_effort`. A model without `thinking` gets nothing extra.
  - A guardrail judge asks for it, and on a thinking model its cap is 256 + 2048 tokens (`JUDGE_VERDICT_TOKENS`, `JUDGE_THINKING_TOKENS`).
  - The presets mark the models: anthropic's Opus, Sonnet and Haiku 5.5, gemini and gemini-api's 3.8 Flash and 3.5 Flash-Lite, openai's gpt-6.1-sol and gpt-6-luna. Re-register to pick the marks up.
- 4f90882: The OpenAI-compatible adapter prices a call the way OpenAI bills it, so a run's cost and its cost budget are right on GPT-6. Before, every prompt token billed at the base input rate: cached prompts were overcharged 10–20 times, and a prompt past 272,000 tokens was undercharged (OpenAI bills those at twice the input and 1.5 times the output rate).
  - **A model's cost table** takes the rates the Gemini and Anthropic adapters already price with: `cachedPromptMultiplier`, `promptCacheCreationMultiplier`, `longContext` (the whole call at its rates past `thresholdTokens`), and `dataResidencyMultiplier` (applied only on a data-residency host such as `eu.api.openai.com`). Both APIs (Responses and Chat Completions) price with them.
  - **The `openai` preset** carries OpenAI's published GPT-6 rates (checked 2026-10-07): cached input at 10% of input (5% on GPT-6.1 Sol), cache writes at 1.25 times, twice the input and 1.5 times the output past 272,000 input tokens, and +10% on a data-residency host. Past 272,000 means per call, counting all of its input tokens (cached and cache-write ones included), as we read OpenAI's pricing. A registration can't be edited, so one made from an earlier preset keeps its base rates: unregister it (`kindgi providers unregister openai`), then register the preset again; one your pack's config declares updates when `kindgi dev` restarts.
- bcdc637: OpenAI's GPT-6 models can call tools: the OpenAI-compatible adapter now speaks OpenAI's Responses API to OpenAI itself. GPT-6 Astra and Sol can't call tools through Chat Completions, and Luna only without reasoning, so an agent with tools on the `openai` preset failed.
  - **Which API:** a provider's `adapter_config.api` picks it, `responses` or `chat-completions`. Without one, a `baseURL` on `api.openai.com` (or a data-residency host such as `eu.api.openai.com`) speaks Responses, and every other endpoint (Ollama, vLLM, Groq, OpenRouter, …) keeps Chat Completions. **An existing OpenAI registration moves to Responses on upgrade, with no re-registration:** set `adapter_config.api` to `chat-completions` to keep the old path. A registration whose `extraBody.*` fields were written for Chat Completions (such as `extraBody.reasoning_effort`) either keeps that path the same way, or moves them to their Responses names (`extraBody.reasoning.effort`).
  - **The `openai` preset** sets `api: responses`.
  - **Stateless:** every Responses call sends `store: false`, so OpenAI keeps no conversation state for Kindgi's calls. A reasoning model's reasoning between tool calls goes back to it with the calls (in the tool call's `signature`), for the same model only.
  - **`extraBody`** on Responses refuses the fields the adapter sets there (`EXTRA_BODY_RESERVED_RESPONSES`); `extraBody.reasoning.effort` sets a reasoning model's effort.
  - **The model data applies on Responses too:** a temperature the model doesn't take (`sampling: false`) isn't sent and the answer carries a `sampling-unsupported` warning; a call asking for `thinking: 'lowest'` (a guardrail judge) sends the model's lowest `reasoning.effort` (`gpt-6-astra` now has one: `low`, checked live; `none` is refused); and the system prompt names the call's tools as they're sent.
- 812aa0b: OpenRouter is described as what it is: a hosted service in front of several vendors that your prompts pass through, one option among the providers, not a way to reach every model. The `openrouter` preset's description, the `kindgi init` READMEs and the providers skill say so; the skill lists the direct vendors and self-hosted servers first.
- b9d3c01: A provider can name its **default model** (`metadata.defaultModel`, one of its models). When the router's candidates rank equally (an agent with no preference and no `preferredModel`), the provider's default comes before its other models. Without one, ties break by model name, so the "default" was whichever name sorted first: for the `openai` preset that was its flagship (`gpt-6-astra`), and for `gemini-api` a preview model.
  
  Each preset now names a mid-priced default: `anthropic` claude-sonnet-5-5, `openai` gpt-6.1-sol, `gemini-api` and `gemini` gemini-3.8-flash, `groq` openai/gpt-oss-120b, `openrouter` anthropic/claude-sonnet-5.5. `kindgi providers register --preset` marks it `(default)`; registering only some of a preset's models keeps the default only when it's among them. A runtime that predates default models drops the field, and the CLI then says what an agent that chooses no model gets instead. The API refuses a `defaultModel` that isn't one of the provider's models (400, reason `unknown-default-model`).
  
  The `anthropic` preset adds `claude-haiku-5-5`, Anthropic's newer Haiku: the cheap option once `claude-haiku-4-5` retires (on or after 2026-10-15). It has a 1M-token context window and costs $0.10 / $0.50 per 1M tokens, or $0.50 / $2.50 for a prompt over 100,000 tokens. It rejects a non-default `temperature`.
- 6eb47c1: Agent instructions name tools by what they do, not by their dotted id. A model sees a tool's id in its provider's form (`my-pack__greet` for Anthropic and OpenAI-compatible models), so `my-pack.greet` in the instructions could make it call a name it wasn't given. The `kindgi init` echo agent (TypeScript and Python) now says "greet them with the greet tool … echo their message with the echo tool", and the authoring-agents skills say to name tools this way.
- 9a7f43b: A comparison's live baseline names its segments as a path, the way live versions resolve them: `baseline: { live: { projectId, segments: [{ key, value }, …] } }`, coarse to fine. It was an unordered object (`{ tier: 'gold' }`), so a path's order was lost. `segments` follows the rules of a run's and a pin's segment path (lowercase keys, each key once, at most 8), needs `projectId`, and anything else is `400 bad-input`. The CLI's `eval-runs start --baseline-segment` takes `<key>:<value>` (it took `<key>=<value>`), once per step in order, and needs `--baseline-project`. A live baseline is still refused when the run starts (only `recorded` runs today).
- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- 3255928: `kindgi artifacts` and `kindgi capabilities` say why they aren't available: the Kindgi runtime doesn't serve `/v1/artifacts` (no blob storage wired) or `/v1/capabilities` (no capability catalog wired) yet. Before, they said only "not yet wired".
- 0f413b2: `kindgi conversations get <conversation-id>`, `open <agent-id> <version> [--title] [--project] [--participant]`, `close <conversation-id>` and `messages <conversation-id> [--limit] [--cursor]` work, and are in `--help` and the reference. Before, they failed with "not yet wired". A turn joins a conversation through its input: `kindgi runs start --agent=<agent-id> --input='{"userMessage": "…", "conversationId": "<conversation-id>"}'`.
- 51ee8e6: `kindgi doctor` checks whether this machine and folder are ready to run Kindgi. Each check says what it found and, when it fails, the exact command or step that fixes it, as the folder runs it (`pnpm exec kindgi …`, `npx --no kindgi …`, or `npx @kindgi/cli@<version> …` outside a project). Any failed check exits 1.
  
  The checks, in order:
  - Node (22.12 or later) and npm;
  - Python (3.11 or later) and uv, required in a Python project and otherwise reported as installed or not;
  - Docker running, and pull access to the pinned runtime image;
  - the project (`kindgi.config.ts`, or a `pyproject.toml` with `[tool.kindgi]`; `.kindgirc.json`) and its dependencies;
  - a model key in `.env` or `.env.local`, named with its file and never its value;
  - the runtime `kindgi dev` runs, answering `/health`;
  - a model provider registered there (`dev-echo` alone fails, since it isn't a model).
  
  Outside a project the project's checks are skipped, saying why. `--json` prints `{ ok, cliVersion, project, checks: [{ id, status: 'pass' | 'fail' | 'skip', message, fix? }] }` for a coding agent. `--path` checks another folder. A malformed `.kindgirc.json` no longer stops `doctor` from running; it reports it.
- 86538d0: `kindgi flows list [--name] [--limit] [--cursor]` (with `--table`), `get <flow-id> [<version>]`, `publish --spec=<json-or-@file> [--project]`, `versions <flow-id>`, `unregister <flow-id> <version>` and `reinstate <flow-id> <version>` work; before, they failed with "not yet wired". `publish` prints the flow's id and version, the pair `kindgi runs start --flow=<id> --flow-version=<v>` takes.
- 1328f5c: `kindgi memory facts list [--type] [--scope=<json>] [--limit] [--cursor]` (with `--table`), `get <fact-id>` and `write --input=<json-or-@file>` work; before, they failed with "not yet wired". `write` fills in the scope's `tenantId` with yours when the input leaves it out. `supersede` and `retrieve` say why they aren't available. A nested group's `--help` names its whole path (`Usage: kindgi memory facts <subcommand>`).
- 3694313: `kindgi projects list`, `kindgi projects get-default` and `kindgi projects get <project-id>`: find the project ids that `--project=<id>` takes (blocks, eval suites and runs, judge classes, agents derive), as the clients' `projects.list`, `getDefault` and `get` do.
- 09d71f7: `kindgi agents promotions list --table` has a STATUS column, so a refused or pending promotion no longer reads like one that went live. It shows the promotion's `status` (`promoted`, `pending-approval`, `refused`, `superseded`, `rejected`, `expired`). A promotion made before gates shows `promoted`, and a rollback or unpin, which take effect at once, shows `done`.
- 769444e: `kindgi provenance list [--run] [--agent] [--created-after] [--project | --org] [--limit] [--cursor]` (with `--table`), `get <run-id>` and `export <run-id> --signing-key=<key-id> [--include-messages]` work; before, they failed with "not yet wired". A deployment without a signing key answers `export` with that refusal.
- 4271bfd: **The CLI knows when it runs as `kindgi-cli`**, the PyPI build for Python developers, with Node from a wheel. Its launcher sets `KINDGI_CLI_INSTALL=pypi`, and then:
  - **its hints for a Python pack say `uv run kindgi …`**, or `poetry run kindgi …` in a Poetry project, instead of `npx --yes @kindgi/cli@0.x …`, which needs Node;
  - **`kindgi init --template=python`** lists `kindgi-cli` in the pack's dev group next to pytest, in the same minor range as `kindgi`, so `uv sync` brings the CLI too;
  - **in an existing Python app**, `kindgi init`'s next steps add the line that installs it (`uv add --dev`, `poetry add --group dev`, or `pip install`);
  - **a TypeScript pack is refused before anything starts:** the PyPI build has no bundler. The message names the npm CLI (`npm install --save-dev @kindgi/cli`).
  
  Every `esbuild` load goes through one loader, which gives the same message.
  
  **`kindgi doctor` under kindgi-cli** passes Node as the one the wheel brings, skips npm (a Python pack doesn't need it), and its fixes say `uv run kindgi …`, or `uvx --from kindgi-cli kindgi …` outside a project.
  
  From the npm CLI, nothing changes.
- 22ab7e6: `kindgi runs list` takes `--agent=<agent-id>`: only that agent's turns, at any version, including the turns its steps start inside flows (`GET /v1/runs?agentId=`, which the clients already take as `agentId` / `agent_id`). It combines with `--replays`, `--eval-run`, `--limit` and `--cursor`.
- 08341ff: `kindgi dev` runs runtime 0.1.4-rc.0.
- eec9748: `kindgi dev` runs runtime 0.1.4-rc.1.
- cf2b8c8: `kindgi dev` runs runtime 0.1.4-rc.2.
- b2ac856: `kindgi dev` runs runtime 0.1.4-rc.3.
- dc2250a: `kindgi dev` runs runtime 0.1.4-rc.4.
- 082f469: `kindgi dev` runs runtime 0.1.4-rc.5.
- 29fbd56: `kindgi` shows the server's own code for any server-class error that carries one: `Error [gate-failed]: …`, `Error [budget-exceeded]: …`, `Error [secret-store-error]: …`, instead of `Error [server]: …`. A conflict still shows its reason, a typed family (`not-found`, `auth`, `invalid-request`) its family, and a body with no code `server`.
  
  `tool-version-unresolvable` (a tool the agent names has no version in its range) is now `422`, as its sibling turn failures (`model-invocation-failed`, `budget-exceeded`) are. It answered `500` before. `capability-unsatisfiable` (no registered provider satisfies the `needs`) gets a `422` entry too; a turn reports it as the cause of `capability-routing-failed`, which was already `422`.
- 4f08024: `kindgi tokens create` and `revoke` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't serve `/v1/tokens` yet, so it has no API keys to mint or revoke; it authenticates with the token it starts with (`KINDGI_API_TOKEN`, or the one `kindgi dev` prints).
- 4287798: `kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]` registers a tool manifest (the tool minus its handler, which the runtime must already have) at its version, in the tenant's Default project or the one named. Before, it failed with "not yet wired". The TypeScript client gains `client.tools.register(manifest, { projectId })` (`POST /v1/tools`), as the Python client has.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- e97958c: Conversation lists leave a comparison's replay conversations out, as run lists leave out replay runs. `GET /v1/conversations` takes `replays=exclude|include|only` (default `exclude`); a replay conversation is one whose `metadata` has `replayOf`. `ListConversationsPageInput.replays` passes it to the binding (absent: include, for internal callers).
  
  The TypeScript client's `conversations.list` and the Python client take `replays`. `kindgi conversations list` now lists, with `--status`, `--replays`, `--limit` and `--cursor` (the other `conversations` commands stay unwired).
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
- fa6680c: **A deploy pins its agents and never keeps a version's old pins.** `POST /v1/deployments` pins each agent as `POST /v1/agents` does. A deploy registers an agent under the version its definition names. When that version is already registered with other pins or content (versions never change), the deploy registers the next free version in its line instead (`1.4.0` → `1.4.1`, `1.4.0-rc.1` → `1.4.0-rc.2`). A deploy never refuses a routine deploy over this.
  
  - **Why a new version:**
    - `pins-changed`: a tool the agent uses has a new version in range.
    - `unpinned`: the version was published before pins existed.
    - `version-taken`: the number is registered with another definition.
  - **Redeploys are idempotent.** A redeploy finds the version an earlier deploy registered for the same definition and pins.
  - **The record:**
    - The registered version records `derivedFrom: {version, reason}`.
    - The deployment's `contents.agents` names each agent's registered `version`. Where it differs from the definition's, it also gives `authoredVersion`, `reason`, `newVersion` and `pinChanges`.
  - **`kindgi deploy` prints one line per such agent:** `agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match`.
  - **A range that matches no published version refuses the deploy:** `400 validation-failed`, with one issue per tool (`/agents/<i>/tools/<j>/version`), and the deploy's tools are rolled back.
  - **New exports:**
    - `@kindgi/agents`: `pinChanges()` and the `AgentDerivation` and `PinChange` types.
    - `@kindgi/tools`: `nextVersion()`.
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- 261ef7f: `kindgi dev`'s banner names every LLM provider when only dev-echo can answer: "for a real model: set an LLM provider key, then `kindgi providers register --preset=<anthropic|gemini-api|groq|openai|openrouter>`". It named Anthropic only, while dev-echo's answer, its warning and `kindgi doctor` offer them all. The list comes from the presets the CLI ships.
- f96bd58: **One Ctrl+C stops `kindgi dev` cleanly, the runtime container included.**
  
  - **Under a package manager** (`pnpm exec kindgi dev`, `npx kindgi dev`, a `pnpm run` script), `kindgi dev` no longer exits at once with code 130 and leaves the runtime container running. A terminal's Ctrl+C signals the whole process group, and the wrapper signals its child too: `npx` and `pnpm run` forward SIGINT; `pnpm exec` sends SIGTERM. So one Ctrl+C arrived twice and was read as the second, forced one.
    - A signal that comes with the first is now the same Ctrl+C. That holds even when it's handled late because the stop held the event loop: closing the file watcher takes over a second on macOS.
    - A SIGTERM never forces the exit.
    - Pressing Ctrl+C again later still forces it.
    - `pnpm exec` itself exits at once, so the prompt returns while `kindgi dev` finishes stopping and prints "stopped.".
  - **The pack service isn't restarted mid-shutdown.** Its child gets the same Ctrl+C and exits. `kindgi dev` printed "pack service exited (SIGINT) — restarting" and started a new one. It now marks the pack service as closing the moment the stop arrives.
  - **Every shutdown step runs**, even after one fails, so the runtime container is removed either way.
  - **`@kindgi/handler-runtime`**: the pack service supervisor has `beginClose()`. From then on a child that exits is expected, not restarted, and `start()` is refused. `close()` does this too.
- f999acd: **dev-echo says it isn't a model, and there are presets for more LLM provider keys.**
  
  - **dev-echo's text answers start with one line:** "⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers." So a developer can't mistake it for a model wherever the answer shows, their own app included. An answer that is JSON (what a typed-output agent parses) stays bare, as does one asked for with `structuredOutput`.
  - **Every dev-echo result carries a warning, `dev-echo-not-a-model`,** with the commands that add a model. `ModelCallResult.warnings` (new, optional) lets any provider warn about its answers. An agent turn collects them into its result's `warnings`, a resumed turn too, and `kindgi runs start` prints them on stderr. dev-echo's own warning stands in for the `fallback-provider` one there.
  - **New presets for key-based LLM providers:**
    - `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`, many vendors' models with one key), on the OpenAI-compatible adapter;
    - `gemini-api` (`GEMINI_API_KEY`), Gemini with a Google AI Studio key.
  
    A preset can now fix adapter settings itself (`adapterConfigValues`, such as the `baseURL`).
  - **`@kindgi/adapter-model-gemini` takes a Gemini Developer API key** (`apiKey`, or `adapter_config.api: "developer"` with the key as `secret_ref`), next to Vertex AI. Vertex stays the default and the `gemini` preset, the route for a regulated deployment.
  - **`kindgi doctor`** looks for every preset's key, and its fixes offer any one of them: the key to set, and the preset to register.
  - **The init templates** ask for "an LLM provider key" (Anthropic, OpenAI, Gemini, Groq or OpenRouter), not Claude's alone.
- 0bfd27b: `kindgi dev` checks the runtime's port before it starts anything. When `4000` is taken (another `kindgi dev`, in another worktree say), it takes the next free port and says so; `.kindgirc.json` records the URL, so clients follow. A `--port` that's taken is refused at once: "port 4301 is in use. Pick another with --port, or stop what's using it." Before, the boot created the database and bundled the pack, then failed on Docker's "port is already allocated".
- 5a64700: **`kindgi dev` names the `unregister` for every declared provider it leaves.** When a provider with a declared id is registered already, but not by `kindgi dev`, it is still left as it is. Each such line now names the `kindgi providers unregister <id>` that lets the config's version apply. Before, only a provider with another region or models got that hint (the ⚠ line). The runtime lists a provider's metadata, not its adapter, the adapter's settings or the key's name. So a provider registered by hand against another endpoint, with the config's models, looked the same and got no hint. The line now says those can't be compared.
- 49c5921: `kindgi dev` keeps track of the providers it registered from `kindgi.config.ts` across restarts of the bundled Postgres. Its record of them (`.kindgi/dev/providers.json`) was keyed on the database's host port, which changes when the bundled Postgres's container comes back. After that, those providers read as someone else's: a change to one in the config wasn't applied ("registered already, not from kindgi.config.ts; left as it is"), and one removed from the config stayed registered. The record is now keyed on the project's database for the bundled Postgres, and on the runtime's origin with `--runtime-url`; a database you pass with `--database-url` is keyed as before. A record written by 0.1.3 is taken over on the next boot.
- e272d62: **`kindgi dev` stops in about a second on macOS.** It watched a pack with one file watcher per discovery folder, plus one for the env files and one for a Python pack's sources. On macOS those all join one FSEvents stream, which is rebuilt on every close but the last. Closing them took seconds, sometimes over 30, before `stopped.` and the exit. On macOS a pack's watchers now share one watch on its folder, each filtering the events itself, and the stop takes about a second. Linux and Windows keep a watcher per folder. The once-a-second scan behind the watchers is unchanged. When a watch fails (its folder removed, too many open files), `kindgi dev` now says so once: `⚠ file watch failed (…): changes are picked up by the once-a-second scan`.
- 00a4dca: **`kindgi dev` stops its runtime container about a second after Ctrl+C, without waiting on its file watchers.** On macOS, closing `kindgi dev`'s recursive file watchers holds the process for a second or more (FSEvents), and it was the stop's first step. The runtime container kept serving and holding its port and database connections until that was done. The watchers now close while `docker stop` runs. File changes seen once the stop has begun start no reload.
- f4592c4: **`kindgi dev` stops at once when you press Ctrl+C (or send SIGTERM) while it waits for the runtime.**
  
  Before, the wait for the runtime never looked at the stop. That covers the wait at `--runtime-url` (up to 10 minutes) and the wait for the runtime container to start serving. A single Ctrl+C was then ignored until the wait ended, and only a second signal, or SIGKILL, stopped it.
  
  Now it stops at once, prints `kindgi dev stopped before the Kindgi runtime served.`, and exits with 130. A runtime container it was starting is removed right away, since it hadn't served anything. Stopping a running session is unchanged.
- 81eb352: **Closing the terminal stops `kindgi dev` cleanly, its runtime container included.** Before, closing the terminal (SIGHUP) ended `kindgi dev` at once. With no Ctrl+C first, its runtime container kept running, holding its port and database connections. Right after a Ctrl+C, the stop was cut short and the container was left behind. A hangup now starts the same stop as Ctrl+C, and it never forces the exit. Output to the closed terminal is dropped instead of ending the process mid-stop.
- b169c3f: **`kindgi dev` no longer misses an edit when the file system drops its event.**
  
  On macOS, `fs.watch` (FSEvents) can drop or delay events under load. On one busy machine, 18 of 40 edits got no event within 2 s. A Python pack's code edits could then go unseen until a restart, and so could:
  - an env file's changes;
  - a primitive file added or removed.
  
  The watchers now also scan what they watch (paths, mtimes and sizes) about once a second, so a missed event costs about a second. `fs.watch` stays the fast path.
  
  The scan skips what the watchers never count: dependencies, virtualenvs, build output, VCS and dot folders. On a large tree it scans less often, at most every 5 s. A pack with 2,000 Python files (and 50,000 skipped) costs about 2% of one core; a typical pack, 0.3%. TypeScript code edits were never affected: esbuild's watch polls.
- fa131f0: The CLI's printed commands name a package manager this machine has. A project from `kindgi init` declares pnpm, but on a machine without pnpm (after `npm install`) the CLI used to print `pnpm install` and `pnpm exec kindgi …`. Now, when the declared manager (pnpm, yarn or bun) doesn't run here (`<pm> --version`), the CLI uses npm: `npm install` and `npx --no kindgi …`. This applies to `init`'s next steps and its dependency specs, `kindgi dev`'s banner, the `providers` hints, `.mcp.json`'s launch command, and `kindgi doctor`'s fixes. doctor's install fix also says which manager the project names. `usablePackageManager` is the shared check, probed once per manager per run.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- 4d58f1b: `kindgi init` decides esbuild's install script for npm too: a new TypeScript pack's `package.json` has `"allowScripts": { "esbuild": false }`, and `init` in an existing npm app adds it, as it adds `allowBuilds.esbuild: false` for pnpm. npm 11 no longer warns on the first install that esbuild's script is "not yet covered by allowScripts". esbuild works without its script; npm 10 and pnpm ignore the field. An app's own decision for esbuild is kept.
- 263afd1: **`kindgi init <pack-name>` pins the pnpm that installs the pack.** A new TypeScript pack that stands alone, with no `packageManager` field or lockfile in the folders above it, gets `"packageManager": "pnpm@<version>"` with the version `pnpm --version` gives in its folder. `kindgi build`'s image, CI and teammates then install with that same pnpm; pnpm 10+ switches to it on its own. A pnpm 12 image refuses a lockfile an older pnpm wrote when it has entries less than a day old, so a mismatch can break a build right after a release.
  
  Inside an existing project, nothing is written: that project's own setup governs. Adding Kindgi to an app and Python packs are unchanged. When pnpm's version can't be read, the next steps say so and how to set the field.
- 8491dd8: A judge class can be restricted to some judges. `assertableBy` on `POST /v1/judge-classes` and `PATCH /v1/judge-classes/{judgeClassId}` (`null` on the PATCH lifts it) takes `minReviewerRole`, `principalKinds` and `principalIds`, and a caller must meet each one given. A judgment that names a restricted class its caller doesn't meet is `403 judge-class-not-allowed`, and the message says why. A judgment recorded under a restricted class carries `restricted: true`; adding or lifting a restriction later doesn't change it. A test set's items carry `restricted`: the yes and total weight of those judgments alone.
  
  A comparison takes `classWeights`: `as-recorded` (the default, every judgment at its class's weight) or `restricted-only` (only judgments carrying `restricted` count; an item with none counts as unjudged). The summary records which one it used. A gate policy's spec takes `onlyRestrictedClasses`: the promotion's comparison must be `restricted-only` (check `classWeights.restrictedOnly`), so a class anyone may assert can't move the gate.
  
  `@kindgi/api` exports `whyNotAssertable`, `JudgeClassAssertableBy`, `JudgeClassAsserter` and `EvalClassWeights`. The TypeScript client's judge-class types take `assertableBy`, and `evalRuns.start` takes `classWeights`. The Python client sends both (`assertable_by=None` lifts a restriction). The CLI's `judge-classes add` and `set` take `--min-reviewer-role`, `--principal-kind` and `--principal-id`, `set --unrestricted` lifts the restriction, and `eval-runs start` takes `--class-weights`.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ba2f212: `GET /v1/observations`'s `agentVersion`, `conversationId`, `since` and `until` filters, which the route already read, are in the OpenAPI spec, so the Python client's `observations.list` takes them. `kindgi observations` and `kindgi proposals` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't record supervisor observations or draft fix proposals yet. A reason given for a group covers each of its commands.
- a8e148a: Provider presets follow the providers' model lifecycles:
  - **`gemini` (Vertex AI):** `gemini-3.8-flash` and `gemini-3.5-flash-lite`, in place of `gemini-2.5-pro` and `gemini-2.5-flash`, which Vertex AI retires on 2026-10-20 (Google names 3.8 Flash as their replacement). Region `global`, as before.
  - **`gemini` and `gemini-api`:** `gemini-3.8-flash` and `gemini-3.5-flash-lite` declare `structured-output`, so an agent that needs it (`capabilities: [{ needs: [{ feature: 'structured-output' }] }]`) can route to them. Both were checked with typed output on Vertex AI.
  - **`anthropic`:** `claude-haiku-4-5` is marked as retiring on or after 2026-10-15. Pin another model before then.
  
  A registration from an older preset keeps its models: re-register (`kindgi providers register --preset=gemini --project=<id>`) to move to the new ones.
- 42a2e66: Promotions go through a gate (evals step 4b). A **gate policy** says what a promotion of an agent for a scope must show: a recent comparison of that exact version against the one live there, with enough judged evidence, metrics that reach a floor or drop no more than allowed, clean replays, and optionally a reviewer's approval.
  
  - **`/v1/gate-policies`**: publish (`{id, version, agentId, scope, spec}`), list, get, `versions` list / get / unregister / reinstate. One policy per agent and scope (`409 gate-policy-scope-taken`, `details.heldBy`); the most specific scope with a policy applies. The `spec` is checked strictly. Writes need `admin` on the tenant.
  - **`POST /v1/agents/{id}/promotions`** checks the scope's policy against the comparison named by `evalRunId`. It answers `201` (`status: 'promoted'`), `202` (`status: 'pending-approval'`, with `approvalId`: a reviewer approves it, and the version goes live if nothing changed meanwhile), or `422 gate-failed` with every check in `details.checks`. The refusal is recorded too. A promotion now carries `status`, `policy`, `checks`, `approvalId` and `resolvedAt`. With no policy for the scope, nothing changes.
  - **`POST /v1/agents/{id}/promotions/check`** answers what the gate would say (`would-promote`, `needs-approval`, `gate-failed`), recording nothing. **`GET /v1/agents/{id}/gate-policy`** answers the policy that applies to a scope.
  - **A comparison's summary records the candidate's `pinsDigest`**, so the gate can tell the promoted version ran exactly what was compared. A comparison recorded before this has none, and the gate asks for it to be re-run.
  - The TypeScript client has `gatePolicies.*`, `agents.promotions.check` and `agents.gatePolicy.resolve`; the Python client has `gate_policies`, `agents.promotions.check` and `agents.gate_policy.resolve`. The CLI has `kindgi gate-policies list | show | versions | publish | unregister | reinstate`, `kindgi agents gate-policy` and `kindgi agents promote --check`.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.
- 8b2e3a3: A release candidate of the CLI keeps to its own release. Its hints run `npx --yes @kindgi/cli@<its exact version>`, since a `0.1`-style range never matches a pre-release and would run the last release. A Python pack it creates requires `kindgi>=<its version>,<…>` in PEP 440 (`kindgi>=0.1.4rc0,<0.2`), so pip and uv install the matching Python SDK, and the same requirement takes the release once it's out. A release CLI is unchanged.
- 4671396: Docker's access to the runtime image says what's wrong in two more cases, in `kindgi doctor`, `kindgi auth registry` (login and `--check`) and `kindgi dev`'s pull:
  - **A credential helper Docker can't run** (`credsStore` or `credHelpers` naming, for example, `docker-credential-desktop` that isn't on PATH) used to read as a network problem. Now the helper is named, with the fix: put it on PATH (Docker Desktop on macOS keeps it in `/Applications/Docker.app/Contents/Resources/bin`) or remove that entry from Docker's config.
  - **Without docker buildx**, the `docker manifest inspect` fallback says "no such manifest" both for a missing image and for no access. The message now says it can be either, and gives the login command.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
- d0ebeb6: Replay turns: an agent turn can re-run a past run for an eval run without doing anything the past run didn't do.
  
  - `@kindgi/agents`:
    - `InvokeAgentInput.replay` (`{ of, evalRunId }`) marks a turn as a replay. It is kept on the turn's run and in its run snapshot (new nullable `agent_run_snapshots.replay` column), so a resumed turn stays a replay.
    - The new optional `InvokeAgentBindings.replay` (`ReplayBinding`) decides each tool call:
      - `live`: the tool runs;
      - `recorded`: the past run's result is used;
      - `refused`: the model gets the given result.
    - Whatever the binding says, only a tool declared read-only (`mutating: false`, no writing effect, see `isReadOnlyTool`) with no approval to wait for runs. A replay with no binding refuses every call.
    - Each decision is journaled, and `AgentTurnResult.replay` lists them. A refused call shows what the turn would have done.
    - `retrievals` can supply the past run's retrieved facts. `sessionApproval` gives the past run's decision at the session approval gate, which the replay follows (a recorded rejection fails the turn with `hitl-rejected`). Without a recorded decision the gate is skipped, and the result says so.
    - `tool.completed` events carry `replay: 'live' | 'recorded' | 'refused'`.
  - `@kindgi/runtime`: `RunReplayRef`; `replay` on `runGraph` and `startRun`; `replayOf` and `evalRunId` on `KernelRunRecord`; `replays` and `evalRunId` on `ListRunsInput`.
  - `@kindgi/capabilities`: `ModelUsageRecord.replay` tags a replay's model calls with the past run and the eval run.
  - `@kindgi/api`:
    - A run carries `replayOf` and `evalRunId`.
    - `GET /v1/runs` leaves replay runs out unless `replays=include|only`; `evalRunId` lists one eval run's replays.
    - A judged agent turn's captured `context` also keeps `sessionApproval`, the decision at its session approval gate.
  - `@kindgi/client`: `runs.list({ replays, evalRunId })`; the Python client too.
  - `@kindgi/cli`: `kindgi runs list --replays=<exclude|include|only> --eval-run=<id>`.
- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
- 3e427c5: `kindgi runs resume <run-id>` says what a run waits for before it resumes, with an exit code per answer:
  - **0:** the run isn't waiting (running, or finished).
  - **3:** it waits for an approval. The command names the approval and the command that decides it (`kindgi approvals complete <id> --decision=approve` or `--decision=reject`).
  - **4:** it waits on the runtime: a queued start, a child run, a scheduled retry and when, or a lease another run holds. A wait no approval matches is also 4, with a line pointing to `kindgi approvals list --status=pending`.
  - **5:** reserved for a held run.
  
  It reads the run, its journal's open waits, and the approvals linked to them. The never-wired `--waitpoint` and `--value` flags are gone.
  
  `GET /v1/approvals` takes `waitTokenId`, repeatable and at most 50: only approvals linked to those run waits. `ListApprovalsBindingInput.waitTokenIds` carries it to the binding. The TypeScript client's `approvals.list({ waitTokenIds })` and the Python client's `approvals.list(wait_token_id=[…])` send it.
- add6a1a: `kindgi runs start` exits `1` when the run it waited for fails, agent or flow. It still prints the run on stdout, and stderr says why. An agent turn's failure shows its own code and message (`Error [budget-exceeded]: Agent turn cost budget exceeded (…)`, `Error [capability-routing-failed]: No registered provider satisfies the capability declaration`). Any other failure shows `Error [run-failed]: <the run's failure message>`. Since `runs start` began following runs, a failed run exited `0` with nothing on stderr, so a script couldn't tell. `--quiet` prints nothing and still exits `1`.
- 1a9b8e3: `kindgi runs start --agent-version=<v>` and `--flow-version=<v>` run that version instead of the latest. A turn in a conversation needs the version the conversation was opened with: before, a CLI turn in a conversation opened at an older version failed with `agent-version-mismatch`. A version for the other kind (`--flow-version` with `--agent`) is refused. `--project=<project-id>` runs it in that project instead of the tenant's Default one.
- eb60481: **When the runtime container stops while `kindgi dev` starts it, the message always says why.**
  - It names the container's exit code and what the code means: 137 killed or out of memory, 139 a crash, 126/127 a command that couldn't run. Docker's own error is included when there is one.
  - It gives the container's last log lines, read whole.
  - A container that stopped before printing anything is said to have done so. Before, the message could end with an empty reason.
  
  The container no longer runs with `--rm`, so a fast exit's logs and exit state can still be read; `kindgi dev` removes it itself, when it stops and after a failed start. `docker logs`' own errors (such as "can not get logs from container which is dead…") are no longer shown as the runtime's output.
- e0c1f42: `kindgi tools get-version`, `kindgi tools unregister` and `kindgi tools reinstate` take the version as an argument: `kindgi tools get-version acme.echo 1.2.0`. Their `--version=<semver>` never worked, since the global `--version` flag (print the CLI's version) took it first and refused a value. `kindgi flows unregister` takes it the same way. A test over every command now refuses a command option that shares a global flag's name or short flag.
- Updated dependencies [9564887]
- Updated dependencies [68da079]
- Updated dependencies [6263b4b]
- Updated dependencies [812aa0b]
- Updated dependencies [b9d3c01]
- Updated dependencies [82f3dec]
- Updated dependencies [366c31a]
- Updated dependencies [814af63]
- Updated dependencies [6eb47c1]
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [0b1f48d]
- Updated dependencies [9a7f43b]
- Updated dependencies [6260a59]
- Updated dependencies [0359caf]
- Updated dependencies [4287798]
- Updated dependencies [fcc6a97]
- Updated dependencies [c7e27fb]
- Updated dependencies [fd011d4]
- Updated dependencies [d0ebeb6]
- Updated dependencies [149a8c9]
- Updated dependencies [e97958c]
- Updated dependencies [a311b81]
- Updated dependencies [f8deed1]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [f96bd58]
- Updated dependencies [f999acd]
- Updated dependencies [17f552d]
- Updated dependencies [52c8f98]
- Updated dependencies [e197294]
- Updated dependencies [846dd9c]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [b8ff156]
- Updated dependencies [5608264]
- Updated dependencies [7a8e764]
- Updated dependencies [8491dd8]
- Updated dependencies [a0921a1]
- Updated dependencies [dde7fdb]
- Updated dependencies [ba55da0]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [06b5fc0]
- Updated dependencies [e17b230]
- Updated dependencies [b52d890]
- Updated dependencies [fe0ad36]
- Updated dependencies [e7e2f86]
- Updated dependencies [3d23304]
- Updated dependencies [42a2e66]
- Updated dependencies [2923703]
- Updated dependencies [dd9e856]
- Updated dependencies [c0f1b56]
- Updated dependencies [d69c8e9]
- Updated dependencies [f56432f]
- Updated dependencies [bfeabfd]
- Updated dependencies [8861bf8]
- Updated dependencies [d0ebeb6]
- Updated dependencies [9801f64]
- Updated dependencies [dc5cfb1]
- Updated dependencies [a5560d7]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [7c084e1]
- Updated dependencies [62608e3]
- Updated dependencies [3e427c5]
- Updated dependencies [53f87a6]
- Updated dependencies [c744326]
- Updated dependencies [376d9e4]
- Updated dependencies [f90c285]
- Updated dependencies [cfba46a]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/client@0.1.4
  - @kindgi/sdk@0.1.4
  - @kindgi/handler-runtime@0.1.4
  - @kindgi/agents@0.1.4
  - @kindgi/env-schema@0.1.4
  - @kindgi/types@0.1.4
  - @kindgi/secrets-dotenv@0.1.4
  - @kindgi/flow@0.1.4
  - @kindgi/platform@0.1.4
  - @kindgi/crypto@0.1.4
  - @kindgi/dotenv-file@0.1.4

## 0.1.4-rc.5

### Patch Changes

- 6eb47c1: Agent instructions name tools by what they do, not by their dotted id. A model sees a tool's id in its provider's form (`my-pack__greet` for Anthropic and OpenAI-compatible models), so `my-pack.greet` in the instructions could make it call a name it wasn't given. The `kindgi init` echo agent (TypeScript and Python) now says "greet them with the greet tool … echo their message with the echo tool", and the authoring-agents skills say to name tools this way.
- 082f469: `kindgi dev` runs runtime 0.1.4-rc.5.
- 29fbd56: `kindgi` shows the server's own code for any server-class error that carries one: `Error [gate-failed]: …`, `Error [budget-exceeded]: …`, `Error [secret-store-error]: …`, instead of `Error [server]: …`. A conflict still shows its reason, a typed family (`not-found`, `auth`, `invalid-request`) its family, and a body with no code `server`.
  
  `tool-version-unresolvable` (a tool the agent names has no version in its range) is now `422`, as its sibling turn failures (`model-invocation-failed`, `budget-exceeded`) are. It answered `500` before. `capability-unsatisfiable` (no registered provider satisfies the `needs`) gets a `422` entry too; a turn reports it as the cause of `capability-routing-failed`, which was already `422`.
- 261ef7f: `kindgi dev`'s banner names every LLM provider when only dev-echo can answer: "for a real model: set an LLM provider key, then `kindgi providers register --preset=<anthropic|gemini-api|groq|openai|openrouter>`". It named Anthropic only, while dev-echo's answer, its warning and `kindgi doctor` offer them all. The list comes from the presets the CLI ships.
- a8e148a: Provider presets follow the providers' model lifecycles:
  - **`gemini` (Vertex AI):** `gemini-3.8-flash` and `gemini-3.5-flash-lite`, in place of `gemini-2.5-pro` and `gemini-2.5-flash`, which Vertex AI retires on 2026-10-20 (Google names 3.8 Flash as their replacement). Region `global`, as before.
  - **`gemini` and `gemini-api`:** `gemini-3.8-flash` and `gemini-3.5-flash-lite` declare `structured-output`, so an agent that needs it (`capabilities: [{ needs: [{ feature: 'structured-output' }] }]`) can route to them. Both were checked with typed output on Vertex AI.
  - **`anthropic`:** `claude-haiku-4-5` is marked as retiring on or after 2026-10-15. Pin another model before then.
  
  A registration from an older preset keeps its models: re-register (`kindgi providers register --preset=gemini --project=<id>`) to move to the new ones.
- 9801f64: **Request logs and trace context.**
  
  - **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
    - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
    - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
  - **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
    - Writes and 4xx are logged at `info`, 5xx at `error`.
    - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
    - A 500 also logs the error itself, redacted.
  - **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
  - **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
  - **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
  - **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
- add6a1a: `kindgi runs start` exits `1` when the run it waited for fails, agent or flow. It still prints the run on stdout, and stderr says why. An agent turn's failure shows its own code and message (`Error [budget-exceeded]: Agent turn cost budget exceeded (…)`, `Error [capability-routing-failed]: No registered provider satisfies the capability declaration`). Any other failure shows `Error [run-failed]: <the run's failure message>`. Since `runs start` began following runs, a failed run exited `0` with nothing on stderr, so a script couldn't tell. `--quiet` prints nothing and still exits `1`.
- Updated dependencies [6eb47c1]
- Updated dependencies [17f552d]
- Updated dependencies [52c8f98]
- Updated dependencies [d69c8e9]
- Updated dependencies [9801f64]
- Updated dependencies [c744326]
  - @kindgi/sdk@0.1.4-rc.5
  - @kindgi/secrets-dotenv@0.1.4-rc.5
  - @kindgi/client@0.1.4-rc.5
  - @kindgi/handler-runtime@0.1.4-rc.5
  - @kindgi/env-schema@0.1.4-rc.5
  - @kindgi/agents@0.1.4-rc.5
  - @kindgi/flow@0.1.4-rc.5
  - @kindgi/crypto@0.1.4-rc.5
  - @kindgi/dotenv-file@0.1.4-rc.5
  - @kindgi/platform@0.1.4-rc.5
  - @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- dc2250a: `kindgi dev` runs runtime 0.1.4-rc.4.
- f999acd: **dev-echo says it isn't a model, and there are presets for more LLM provider keys.**
  
  - **dev-echo's text answers start with one line:** "⚠ dev-echo isn't a real model: it only repeats what it's given. Add an LLM provider key (Anthropic, OpenAI, Gemini, Groq, OpenRouter…) to get real answers." So a developer can't mistake it for a model wherever the answer shows, their own app included. An answer that is JSON (what a typed-output agent parses) stays bare, as does one asked for with `structuredOutput`.
  - **Every dev-echo result carries a warning, `dev-echo-not-a-model`,** with the commands that add a model. `ModelCallResult.warnings` (new, optional) lets any provider warn about its answers. An agent turn collects them into its result's `warnings`, a resumed turn too, and `kindgi runs start` prints them on stderr. dev-echo's own warning stands in for the `fallback-provider` one there.
  - **New presets for key-based LLM providers:**
    - `openai` (`OPENAI_API_KEY`), `groq` (`GROQ_API_KEY`) and `openrouter` (`OPENROUTER_API_KEY`, many vendors' models with one key), on the OpenAI-compatible adapter;
    - `gemini-api` (`GEMINI_API_KEY`), Gemini with a Google AI Studio key.
  
    A preset can now fix adapter settings itself (`adapterConfigValues`, such as the `baseURL`).
  - **`@kindgi/adapter-model-gemini` takes a Gemini Developer API key** (`apiKey`, or `adapter_config.api: "developer"` with the key as `secret_ref`), next to Vertex AI. Vertex stays the default and the `gemini` preset, the route for a regulated deployment.
  - **`kindgi doctor`** looks for every preset's key, and its fixes offer any one of them: the key to set, and the preset to register.
  - **The init templates** ask for "an LLM provider key" (Anthropic, OpenAI, Gemini, Groq or OpenRouter), not Claude's alone.
- Updated dependencies [5608264]
- Updated dependencies [dd9e856]
- Updated dependencies [f56432f]
  - @kindgi/client@0.1.4-rc.4
  - @kindgi/sdk@0.1.4-rc.4
  - @kindgi/secrets-dotenv@0.1.4-rc.4
  - @kindgi/crypto@0.1.4-rc.4
  - @kindgi/dotenv-file@0.1.4-rc.4
  - @kindgi/env-schema@0.1.4-rc.4
  - @kindgi/flow@0.1.4-rc.4
  - @kindgi/handler-runtime@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- 51ee8e6: `kindgi doctor` checks whether this machine and folder are ready to run Kindgi. Each check says what it found and, when it fails, the exact command or step that fixes it, as the folder runs it (`pnpm exec kindgi …`, `npx --no kindgi …`, or `npx @kindgi/cli@<version> …` outside a project). Any failed check exits 1.
  
  The checks, in order:
  - Node (22.12 or later) and npm;
  - Python (3.11 or later) and uv, required in a Python project and otherwise reported as installed or not;
  - Docker running, and pull access to the pinned runtime image;
  - the project (`kindgi.config.ts`, or a `pyproject.toml` with `[tool.kindgi]`; `.kindgirc.json`) and its dependencies;
  - a model key in `.env` or `.env.local`, named with its file and never its value;
  - the runtime `kindgi dev` runs, answering `/health`;
  - a model provider registered there (`dev-echo` alone fails, since it isn't a model).
  
  Outside a project the project's checks are skipped, saying why. `--json` prints `{ ok, cliVersion, project, checks: [{ id, status: 'pass' | 'fail' | 'skip', message, fix? }] }` for a coding agent. `--path` checks another folder. A malformed `.kindgirc.json` no longer stops `doctor` from running; it reports it.
- 4271bfd: **The CLI knows when it runs as `kindgi-cli`**, the PyPI build for Python developers, with Node from a wheel. Its launcher sets `KINDGI_CLI_INSTALL=pypi`, and then:
  - **its hints for a Python pack say `uv run kindgi …`**, or `poetry run kindgi …` in a Poetry project, instead of `npx --yes @kindgi/cli@0.x …`, which needs Node;
  - **`kindgi init --template=python`** lists `kindgi-cli` in the pack's dev group next to pytest, in the same minor range as `kindgi`, so `uv sync` brings the CLI too;
  - **in an existing Python app**, `kindgi init`'s next steps add the line that installs it (`uv add --dev`, `poetry add --group dev`, or `pip install`);
  - **a TypeScript pack is refused before anything starts:** the PyPI build has no bundler. The message names the npm CLI (`npm install --save-dev @kindgi/cli`).
  
  Every `esbuild` load goes through one loader, which gives the same message.
  
  **`kindgi doctor` under kindgi-cli** passes Node as the one the wheel brings, skips npm (a Python pack doesn't need it), and its fixes say `uv run kindgi …`, or `uvx --from kindgi-cli kindgi …` outside a project.
  
  From the npm CLI, nothing changes.
- b2ac856: `kindgi dev` runs runtime 0.1.4-rc.3.
- fa131f0: The CLI's printed commands name a package manager this machine has. A project from `kindgi init` declares pnpm, but on a machine without pnpm (after `npm install`) the CLI used to print `pnpm install` and `pnpm exec kindgi …`. Now, when the declared manager (pnpm, yarn or bun) doesn't run here (`<pm> --version`), the CLI uses npm: `npm install` and `npx --no kindgi …`. This applies to `init`'s next steps and its dependency specs, `kindgi dev`'s banner, the `providers` hints, `.mcp.json`'s launch command, and `kindgi doctor`'s fixes. doctor's install fix also says which manager the project names. `usablePackageManager` is the shared check, probed once per manager per run.
- 4d58f1b: `kindgi init` decides esbuild's install script for npm too: a new TypeScript pack's `package.json` has `"allowScripts": { "esbuild": false }`, and `init` in an existing npm app adds it, as it adds `allowBuilds.esbuild: false` for pnpm. npm 11 no longer warns on the first install that esbuild's script is "not yet covered by allowScripts". esbuild works without its script; npm 10 and pnpm ignore the field. An app's own decision for esbuild is kept.
- 4671396: Docker's access to the runtime image says what's wrong in two more cases, in `kindgi doctor`, `kindgi auth registry` (login and `--check`) and `kindgi dev`'s pull:
  - **A credential helper Docker can't run** (`credsStore` or `credHelpers` naming, for example, `docker-credential-desktop` that isn't on PATH) used to read as a network problem. Now the helper is named, with the fix: put it on PATH (Docker Desktop on macOS keeps it in `/Applications/Docker.app/Contents/Resources/bin`) or remove that entry from Docker's config.
  - **Without docker buildx**, the `docker manifest inspect` fallback says "no such manifest" both for a missing image and for no access. The message now says it can be either, and gives the login command.
- 3e427c5: `kindgi runs resume <run-id>` says what a run waits for before it resumes, with an exit code per answer:
  - **0:** the run isn't waiting (running, or finished).
  - **3:** it waits for an approval. The command names the approval and the command that decides it (`kindgi approvals complete <id> --decision=approve` or `--decision=reject`).
  - **4:** it waits on the runtime: a queued start, a child run, a scheduled retry and when, or a lease another run holds. A wait no approval matches is also 4, with a line pointing to `kindgi approvals list --status=pending`.
  - **5:** reserved for a held run.
  
  It reads the run, its journal's open waits, and the approvals linked to them. The never-wired `--waitpoint` and `--value` flags are gone.
  
  `GET /v1/approvals` takes `waitTokenId`, repeatable and at most 50: only approvals linked to those run waits. `ListApprovalsBindingInput.waitTokenIds` carries it to the binding. The TypeScript client's `approvals.list({ waitTokenIds })` and the Python client's `approvals.list(wait_token_id=[…])` send it.
- Updated dependencies [3e427c5]
  - @kindgi/client@0.1.4-rc.3
  - @kindgi/secrets-dotenv@0.1.4-rc.3
  - @kindgi/sdk@0.1.4-rc.3
  - @kindgi/crypto@0.1.4-rc.3
  - @kindgi/dotenv-file@0.1.4-rc.3
  - @kindgi/env-schema@0.1.4-rc.3
  - @kindgi/flow@0.1.4-rc.3
  - @kindgi/handler-runtime@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- 9a7f43b: A comparison's live baseline names its segments as a path, the way live versions resolve them: `baseline: { live: { projectId, segments: [{ key, value }, …] } }`, coarse to fine. It was an unordered object (`{ tier: 'gold' }`), so a path's order was lost. `segments` follows the rules of a run's and a pin's segment path (lowercase keys, each key once, at most 8), needs `projectId`, and anything else is `400 bad-input`. The CLI's `eval-runs start --baseline-segment` takes `<key>:<value>` (it took `<key>=<value>`), once per step in order, and needs `--baseline-project`. A live baseline is still refused when the run starts (only `recorded` runs today).
- 3255928: `kindgi artifacts` and `kindgi capabilities` say why they aren't available: the Kindgi runtime doesn't serve `/v1/artifacts` (no blob storage wired) or `/v1/capabilities` (no capability catalog wired) yet. Before, they said only "not yet wired".
- 0f413b2: `kindgi conversations get <conversation-id>`, `open <agent-id> <version> [--title] [--project] [--participant]`, `close <conversation-id>` and `messages <conversation-id> [--limit] [--cursor]` work, and are in `--help` and the reference. Before, they failed with "not yet wired". A turn joins a conversation through its input: `kindgi runs start --agent=<agent-id> --input='{"userMessage": "…", "conversationId": "<conversation-id>"}'`.
- 86538d0: `kindgi flows list [--name] [--limit] [--cursor]` (with `--table`), `get <flow-id> [<version>]`, `publish --spec=<json-or-@file> [--project]`, `versions <flow-id>`, `unregister <flow-id> <version>` and `reinstate <flow-id> <version>` work; before, they failed with "not yet wired". `publish` prints the flow's id and version, the pair `kindgi runs start --flow=<id> --flow-version=<v>` takes.
- 1328f5c: `kindgi memory facts list [--type] [--scope=<json>] [--limit] [--cursor]` (with `--table`), `get <fact-id>` and `write --input=<json-or-@file>` work; before, they failed with "not yet wired". `write` fills in the scope's `tenantId` with yours when the input leaves it out. `supersede` and `retrieve` say why they aren't available. A nested group's `--help` names its whole path (`Usage: kindgi memory facts <subcommand>`).
- 09d71f7: `kindgi agents promotions list --table` has a STATUS column, so a refused or pending promotion no longer reads like one that went live. It shows the promotion's `status` (`promoted`, `pending-approval`, `refused`, `superseded`, `rejected`, `expired`). A promotion made before gates shows `promoted`, and a rollback or unpin, which take effect at once, shows `done`.
- 769444e: `kindgi provenance list [--run] [--agent] [--created-after] [--project | --org] [--limit] [--cursor]` (with `--table`), `get <run-id>` and `export <run-id> --signing-key=<key-id> [--include-messages]` work; before, they failed with "not yet wired". A deployment without a signing key answers `export` with that refusal.
- 22ab7e6: `kindgi runs list` takes `--agent=<agent-id>`: only that agent's turns, at any version, including the turns its steps start inside flows (`GET /v1/runs?agentId=`, which the clients already take as `agentId` / `agent_id`). It combines with `--replays`, `--eval-run`, `--limit` and `--cursor`.
- cf2b8c8: `kindgi dev` runs runtime 0.1.4-rc.2.
- 4f08024: `kindgi tokens create` and `revoke` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't serve `/v1/tokens` yet, so it has no API keys to mint or revoke; it authenticates with the token it starts with (`KINDGI_API_TOKEN`, or the one `kindgi dev` prints).
- 4287798: `kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]` registers a tool manifest (the tool minus its handler, which the runtime must already have) at its version, in the tenant's Default project or the one named. Before, it failed with "not yet wired". The TypeScript client gains `client.tools.register(manifest, { projectId })` (`POST /v1/tools`), as the Python client has.
- e97958c: Conversation lists leave a comparison's replay conversations out, as run lists leave out replay runs. `GET /v1/conversations` takes `replays=exclude|include|only` (default `exclude`); a replay conversation is one whose `metadata` has `replayOf`. `ListConversationsPageInput.replays` passes it to the binding (absent: include, for internal callers).
  
  The TypeScript client's `conversations.list` and the Python client take `replays`. `kindgi conversations list` now lists, with `--status`, `--replays`, `--limit` and `--cursor` (the other `conversations` commands stay unwired).
- f96bd58: **One Ctrl+C stops `kindgi dev` cleanly, the runtime container included.**
  
  - **Under a package manager** (`pnpm exec kindgi dev`, `npx kindgi dev`, a `pnpm run` script), `kindgi dev` no longer exits at once with code 130 and leaves the runtime container running. A terminal's Ctrl+C signals the whole process group, and the wrapper signals its child too: `npx` and `pnpm run` forward SIGINT; `pnpm exec` sends SIGTERM. So one Ctrl+C arrived twice and was read as the second, forced one.
    - A signal that comes with the first is now the same Ctrl+C. That holds even when it's handled late because the stop held the event loop: closing the file watcher takes over a second on macOS.
    - A SIGTERM never forces the exit.
    - Pressing Ctrl+C again later still forces it.
    - `pnpm exec` itself exits at once, so the prompt returns while `kindgi dev` finishes stopping and prints "stopped.".
  - **The pack service isn't restarted mid-shutdown.** Its child gets the same Ctrl+C and exits. `kindgi dev` printed "pack service exited (SIGINT) — restarting" and started a new one. It now marks the pack service as closing the moment the stop arrives.
  - **Every shutdown step runs**, even after one fails, so the runtime container is removed either way.
  - **`@kindgi/handler-runtime`**: the pack service supervisor has `beginClose()`. From then on a child that exits is expected, not restarted, and `start()` is refused. `close()` does this too.
- e272d62: **`kindgi dev` stops in about a second on macOS.** It watched a pack with one file watcher per discovery folder, plus one for the env files and one for a Python pack's sources. On macOS those all join one FSEvents stream, which is rebuilt on every close but the last. Closing them took seconds, sometimes over 30, before `stopped.` and the exit. On macOS a pack's watchers now share one watch on its folder, each filtering the events itself, and the stop takes about a second. Linux and Windows keep a watcher per folder. The once-a-second scan behind the watchers is unchanged. When a watch fails (its folder removed, too many open files), `kindgi dev` now says so once: `⚠ file watch failed (…): changes are picked up by the once-a-second scan`.
- 00a4dca: **`kindgi dev` stops its runtime container about a second after Ctrl+C, without waiting on its file watchers.** On macOS, closing `kindgi dev`'s recursive file watchers holds the process for a second or more (FSEvents), and it was the stop's first step. The runtime container kept serving and holding its port and database connections until that was done. The watchers now close while `docker stop` runs. File changes seen once the stop has begun start no reload.
- 81eb352: **Closing the terminal stops `kindgi dev` cleanly, its runtime container included.** Before, closing the terminal (SIGHUP) ended `kindgi dev` at once. With no Ctrl+C first, its runtime container kept running, holding its port and database connections. Right after a Ctrl+C, the stop was cut short and the container was left behind. A hangup now starts the same stop as Ctrl+C, and it never forces the exit. Output to the closed terminal is dropped instead of ending the process mid-stop.
- 8491dd8: A judge class can be restricted to some judges. `assertableBy` on `POST /v1/judge-classes` and `PATCH /v1/judge-classes/{judgeClassId}` (`null` on the PATCH lifts it) takes `minReviewerRole`, `principalKinds` and `principalIds`, and a caller must meet each one given. A judgment that names a restricted class its caller doesn't meet is `403 judge-class-not-allowed`, and the message says why. A judgment recorded under a restricted class carries `restricted: true`; adding or lifting a restriction later doesn't change it. A test set's items carry `restricted`: the yes and total weight of those judgments alone.
  
  A comparison takes `classWeights`: `as-recorded` (the default, every judgment at its class's weight) or `restricted-only` (only judgments carrying `restricted` count; an item with none counts as unjudged). The summary records which one it used. A gate policy's spec takes `onlyRestrictedClasses`: the promotion's comparison must be `restricted-only` (check `classWeights.restrictedOnly`), so a class anyone may assert can't move the gate.
  
  `@kindgi/api` exports `whyNotAssertable`, `JudgeClassAssertableBy`, `JudgeClassAsserter` and `EvalClassWeights`. The TypeScript client's judge-class types take `assertableBy`, and `evalRuns.start` takes `classWeights`. The Python client sends both (`assertable_by=None` lifts a restriction). The CLI's `judge-classes add` and `set` take `--min-reviewer-role`, `--principal-kind` and `--principal-id`, `set --unrestricted` lifts the restriction, and `eval-runs start` takes `--class-weights`.
- 2040daf: Live versions and promotions. An agent version can be made live for a scope: the tenant, an org, a project, or a segment path inside a project (an ordered list of `key:value` steps, coarse to fine, such as company then role). A run that doesn't name its version uses the live version of the most specific scope that has one, else the latest registered version, and records how its version was chosen.
  
  `@kindgi/api` adds `GET /v1/agents/{agentId}/live` (the version a run would use for a project and segment path, and why), `GET /v1/agents/{agentId}/live-versions` (every pin), `POST /v1/agents/{agentId}/promotions`, `GET /v1/agents/{agentId}/promotions[/{promotionId}]` (the history), and `POST /v1/agents/{agentId}/live/rollback` and `/live/unpin`. They're mounted when `createApp` gets `agentReleases` (`AgentReleaseBindings`: a `LiveVersionBinding` and a `PromotionBinding`). Promoting, rolling back and unpinning need the new `promote` action on the agent (`@kindgi/authz`). `POST /v1/runs` takes `segments`; a run carries them (`segments`, a child run has its parent's), and a run's `agent` carries `via` (`explicit`, `conversation`, `live` or `latest`) and, for a live version, `liveScope`. `@kindgi/types` adds `LiveScope`, `ScopeSegment` and `AgentVersionVia`; `@kindgi/runtime`'s `RunAgentRef` and `@kindgi/agents`' `InvokeAgentInput` carry `via` and `liveScope`, and `InvokeAgentInput` the turn's `segments`; `RunFlowInput`, `StartRunParams` and `KernelRunRecord` carry the run's `segments`, so a flow's agent steps resolve with them after a resume too. `@kindgi/compliance` and `@kindgi/specs` list the evidence kinds `agent-promotion`, `agent-rollback`, `agent-live-unpinned` and `agent-live-pin-inactive` (a live version that was unregistered: runs use the scope above).
  
  `@kindgi/client` adds `client.agents.live` (`resolve`, `list`, `rollback`, `unpin`), `client.agents.promotions` (`create`, `list`, `get`) and `segments` on `runs.start`; an array query value now repeats its key; `agent-version-not-found` and `promotion-not-found` read as not-found, `nothing-to-roll-back` and `not-pinned` as conflicts, `scope-invalid` as an invalid request. The Python client has the same resources and errors. `@kindgi/cli` adds `kindgi agents live | live-versions | promote | rollback | unpin` and `kindgi agents promotions list | get`, and wires `kindgi agents list | get | versions | unregister`; `kindgi runs start` takes `--project` and `--segment=key:value` (repeated); `get` and `unregister` take the version as an argument (`kindgi agents unregister <agent-id> <version>`). A command's repeatable flag (`--segment=company:acme --segment=role:counsel`) keeps every value.
- ba2f212: `GET /v1/observations`'s `agentVersion`, `conversationId`, `since` and `until` filters, which the route already read, are in the OpenAPI spec, so the Python client's `observations.list` takes them. `kindgi observations` and `kindgi proposals` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't record supervisor observations or draft fix proposals yet. A reason given for a group covers each of its commands.
- 42a2e66: Promotions go through a gate (evals step 4b). A **gate policy** says what a promotion of an agent for a scope must show: a recent comparison of that exact version against the one live there, with enough judged evidence, metrics that reach a floor or drop no more than allowed, clean replays, and optionally a reviewer's approval.
  
  - **`/v1/gate-policies`**: publish (`{id, version, agentId, scope, spec}`), list, get, `versions` list / get / unregister / reinstate. One policy per agent and scope (`409 gate-policy-scope-taken`, `details.heldBy`); the most specific scope with a policy applies. The `spec` is checked strictly. Writes need `admin` on the tenant.
  - **`POST /v1/agents/{id}/promotions`** checks the scope's policy against the comparison named by `evalRunId`. It answers `201` (`status: 'promoted'`), `202` (`status: 'pending-approval'`, with `approvalId`: a reviewer approves it, and the version goes live if nothing changed meanwhile), or `422 gate-failed` with every check in `details.checks`. The refusal is recorded too. A promotion now carries `status`, `policy`, `checks`, `approvalId` and `resolvedAt`. With no policy for the scope, nothing changes.
  - **`POST /v1/agents/{id}/promotions/check`** answers what the gate would say (`would-promote`, `needs-approval`, `gate-failed`), recording nothing. **`GET /v1/agents/{id}/gate-policy`** answers the policy that applies to a scope.
  - **A comparison's summary records the candidate's `pinsDigest`**, so the gate can tell the promoted version ran exactly what was compared. A comparison recorded before this has none, and the gate asks for it to be re-run.
  - The TypeScript client has `gatePolicies.*`, `agents.promotions.check` and `agents.gatePolicy.resolve`; the Python client has `gate_policies`, `agents.promotions.check` and `agents.gate_policy.resolve`. The CLI has `kindgi gate-policies list | show | versions | publish | unregister | reinstate`, `kindgi agents gate-policy` and `kindgi agents promote --check`.
- 1a9b8e3: `kindgi runs start --agent-version=<v>` and `--flow-version=<v>` run that version instead of the latest. A turn in a conversation needs the version the conversation was opened with: before, a CLI turn in a conversation opened at an older version failed with `agent-version-mismatch`. A version for the other kind (`--flow-version` with `--agent`) is refused. `--project=<project-id>` runs it in that project instead of the tenant's Default one.
- e0c1f42: `kindgi tools get-version`, `kindgi tools unregister` and `kindgi tools reinstate` take the version as an argument: `kindgi tools get-version acme.echo 1.2.0`. Their `--version=<semver>` never worked, since the global `--version` flag (print the CLI's version) took it first and refused a value. `kindgi flows unregister` takes it the same way. A test over every command now refuses a command option that shares a global flag's name or short flag.
- Updated dependencies [0b1f48d]
- Updated dependencies [9a7f43b]
- Updated dependencies [4287798]
- Updated dependencies [fcc6a97]
- Updated dependencies [c7e27fb]
- Updated dependencies [fd011d4]
- Updated dependencies [149a8c9]
- Updated dependencies [e97958c]
- Updated dependencies [f8deed1]
- Updated dependencies [f96bd58]
- Updated dependencies [8491dd8]
- Updated dependencies [ba55da0]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [fe0ad36]
- Updated dependencies [e7e2f86]
- Updated dependencies [42a2e66]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [7c084e1]
- Updated dependencies [53f87a6]
- Updated dependencies [cfba46a]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/client@0.1.4-rc.2
  - @kindgi/env-schema@0.1.4-rc.2
  - @kindgi/handler-runtime@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2
  - @kindgi/sdk@0.1.4-rc.2
  - @kindgi/secrets-dotenv@0.1.4-rc.2
  - @kindgi/crypto@0.1.4-rc.2
  - @kindgi/flow@0.1.4-rc.2
  - @kindgi/dotenv-file@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- 3694313: `kindgi projects list`, `kindgi projects get-default` and `kindgi projects get <project-id>`: find the project ids that `--project=<id>` takes (blocks, eval suites and runs, judge classes, agents derive), as the clients' `projects.list`, `getDefault` and `get` do.
- eec9748: `kindgi dev` runs runtime 0.1.4-rc.1.
- 0bfd27b: `kindgi dev` checks the runtime's port before it starts anything. When `4000` is taken (another `kindgi dev`, in another worktree say), it takes the next free port and says so; `.kindgirc.json` records the URL, so clients follow. A `--port` that's taken is refused at once: "port 4301 is in use. Pick another with --port, or stop what's using it." Before, the boot created the database and bundled the pack, then failed on Docker's "port is already allocated".
- b8ff156: A flow comparison can run some of the flow's agents or tools at other versions, without publishing a new flow version ("this flow, with `acme.scorer` at 0.4.0"). `POST /v1/eval-suites/{suiteId}/runs` takes `versions: { agents?, tools? }` (id → exact version) with `flowRef`. The run keeps them in `comparison.versions`, each replay runs with them, and the summary's flow `candidate` names them (`versions`).
  
  They're checked when the run starts. An id the flow doesn't use, a version that isn't published, or an unregistered agent version is refused with `400 validation-failed`, each one under `details.issues` (for example `{ path: '/versions/agents/acme.x', message: "flow acme.f 1.2.0 doesn't use agent acme.x" }`). `versions` with `agentRef` is refused.
  
  A run that ran some blocks at other versions says which: `versions` on `GET /v1/runs/{runId}` (`KernelRunRecord.versions`, set from `RunFlowInput.versions` or `StartRunParams.versions`; `InvokeFlowBindingInput.versions` passes them to a runtime). `@kindgi/flow` adds `overridableRefs(flow)`: every tool and agent the flow runs, including agent steps with a version of their own.
  
  The CLI's `kindgi eval-runs start --flow=<id> --flow-version=<v> --with=<id>@<version>` (repeatable) tells agents from tools by the flow version's steps.
- c0f1b56: `KINDGI_PUBLIC_URL`: the URL clients reach the runtime at, when it isn't the address the server binds (behind a proxy, or a container whose port is published on another one). The runtime's startup banner names it, with its docs and console links. `kindgi dev` sets it, so the banner shows the port `kindgi dev` chose, e.g. 4001 when 4000 was taken, not the container's 4000. `parsePublicUrl` validates it; a runtime that doesn't read it keeps working.
- 8861bf8: **A registry that takes no writes says so: `409 registry-read-only`.** Under `kindgi dev` the pack's files are the source of agents, tools, flows and guardrails. Writing to them used to answer a misleading `already-registered` (for an agent, even naming a "next free version") or `not found`.
  
  - **The marker:** `AgentRegistryBinding`, `ToolRegistryBinding`, `FlowRegistryBinding` and `GuardrailRegistryBinding` take an optional `readOnly: { reason }` (`RegistryReadOnly`).
  - **What's refused:** every write to a registry that sets it, before the binding is called:
    - publish, unregister and reinstate;
    - deriving an agent version;
    - a deployment that would publish into it.
  - **The refusal:** `409 registry-read-only`, with the binding's reason as the message, e.g. "Under kindgi dev, the pack is the source of agents: edit the pack's file and kindgi dev reloads it." Reads are unchanged.
  - **Clients:** both read `registry-read-only` as a conflict, its code the reason.
  - **CLI:** an error line now shows a conflict's own code, so `kindgi agents publish` prints `Error [registry-read-only]: Under kindgi dev, …`.
- Updated dependencies [846dd9c]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [c0f1b56]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/env-schema@0.1.4-rc.1
  - @kindgi/flow@0.1.4-rc.1
  - @kindgi/client@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/sdk@0.1.4-rc.1
  - @kindgi/secrets-dotenv@0.1.4-rc.1
  - @kindgi/handler-runtime@0.1.4-rc.1
  - @kindgi/crypto@0.1.4-rc.1
  - @kindgi/dotenv-file@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- 6260a59: **`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.
  
  - `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
  - TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
  - Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
  - `kindgi blocks list --project=<id>` is unchanged.
- 08341ff: `kindgi dev` runs runtime 0.1.4-rc.0.
- d0ebeb6: Comparison eval runs: an agent version run on a test set, beside the recorded runs.
  
  - **`@kindgi/api`:**
    - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
    - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
    - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
    - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
      - the baseline (the versions behind the recorded runs) and the candidate;
      - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
      - the models that answered;
      - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.
  
      `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
    - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
  - **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
  - **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
- a0652ac: **Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.
  
  - **Kinds:**
    - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
    - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
  - **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
  - **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
  - **Refusals:**
    - a block's kind never changes;
    - a block's versions stay in its first version's project (`409 block-project-mismatch`);
    - a taken version is `409 block-already-registered`.
  - **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
  - **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
  - **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
- fa6680c: **A deploy pins its agents and never keeps a version's old pins.** `POST /v1/deployments` pins each agent as `POST /v1/agents` does. A deploy registers an agent under the version its definition names. When that version is already registered with other pins or content (versions never change), the deploy registers the next free version in its line instead (`1.4.0` → `1.4.1`, `1.4.0-rc.1` → `1.4.0-rc.2`). A deploy never refuses a routine deploy over this.
  
  - **Why a new version:**
    - `pins-changed`: a tool the agent uses has a new version in range.
    - `unpinned`: the version was published before pins existed.
    - `version-taken`: the number is registered with another definition.
  - **Redeploys are idempotent.** A redeploy finds the version an earlier deploy registered for the same definition and pins.
  - **The record:**
    - The registered version records `derivedFrom: {version, reason}`.
    - The deployment's `contents.agents` names each agent's registered `version`. Where it differs from the definition's, it also gives `authoredVersion`, `reason`, `newVersion` and `pinChanges`.
  - **`kindgi deploy` prints one line per such agent:** `agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match`.
  - **A range that matches no published version refuses the deploy:** `400 validation-failed`, with one issue per tool (`/agents/<i>/tools/<j>/version`), and the deploy's tools are rolled back.
  - **New exports:**
    - `@kindgi/agents`: `pinChanges()` and the `AgentDerivation` and `PinChange` types.
    - `@kindgi/tools`: `nextVersion()`.
- fac7472: **Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.
  
  - **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
    - The new version is `from` with the named pins swapped, everything else kept.
    - It's numbered the next free patch after the agent's highest version (versions never change).
    - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
    - Answers `201` with the new agent version.
    - Needs `publish` on the agent.
  - **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
    - a version published before pins;
    - a block the version doesn't already reference (adding one is a code change);
    - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
    - swaps that change nothing.
    - Tool pins can't be swapped: they come from code.
    - An unknown version answers `404 agent-not-found`.
  - **Clients:**
    - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
    - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
    - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
  - **A taken number is never overwritten.** `POST /v1/agents` with a version that's already registered (a derived version may hold it) still answers `409 agent-already-registered`. It now names the next free version in the message and as `nextFreeVersion`: `… is already registered, and versions never change; publish it as 1.4.2, the next free version`.
  - **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
  - **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
- 5a64700: **`kindgi dev` names the `unregister` for every declared provider it leaves.** When a provider with a declared id is registered already, but not by `kindgi dev`, it is still left as it is. Each such line now names the `kindgi providers unregister <id>` that lets the config's version apply. Before, only a provider with another region or models got that hint (the ⚠ line). The runtime lists a provider's metadata, not its adapter, the adapter's settings or the key's name. So a provider registered by hand against another endpoint, with the config's models, looked the same and got no hint. The line now says those can't be compared.
- 49c5921: `kindgi dev` keeps track of the providers it registered from `kindgi.config.ts` across restarts of the bundled Postgres. Its record of them (`.kindgi/dev/providers.json`) was keyed on the database's host port, which changes when the bundled Postgres's container comes back. After that, those providers read as someone else's: a change to one in the config wasn't applied ("registered already, not from kindgi.config.ts; left as it is"), and one removed from the config stayed registered. The record is now keyed on the project's database for the bundled Postgres, and on the runtime's origin with `--runtime-url`; a database you pass with `--database-url` is keyed as before. A record written by 0.1.3 is taken over on the next boot.
- f4592c4: **`kindgi dev` stops at once when you press Ctrl+C (or send SIGTERM) while it waits for the runtime.**
  
  Before, the wait for the runtime never looked at the stop. That covers the wait at `--runtime-url` (up to 10 minutes) and the wait for the runtime container to start serving. A single Ctrl+C was then ignored until the wait ended, and only a second signal, or SIGKILL, stopped it.
  
  Now it stops at once, prints `kindgi dev stopped before the Kindgi runtime served.`, and exits with 130. A runtime container it was starting is removed right away, since it hadn't served anything. Stopping a running session is unchanged.
- b169c3f: **`kindgi dev` no longer misses an edit when the file system drops its event.**
  
  On macOS, `fs.watch` (FSEvents) can drop or delay events under load. On one busy machine, 18 of 40 edits got no event within 2 s. A Python pack's code edits could then go unseen until a restart, and so could:
  - an env file's changes;
  - a primitive file added or removed.
  
  The watchers now also scan what they watch (paths, mtimes and sizes) about once a second, so a missed event costs about a second. `fs.watch` stays the fast path.
  
  The scan skips what the watchers never count: dependencies, virtualenvs, build output, VCS and dot folders. On a large tree it scans less often, at most every 5 s. A pack with 2,000 Python files (and 50,000 skipped) costs about 2% of one core; a typical pack, 0.3%. TypeScript code edits were never affected: esbuild's watch polls.
- 26b2a23: **A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.
  
  - **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
  - **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
  - **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
  - **New exports:**
    - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
    - `@kindgi/types`: `VersionDerivation`.
    - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
- 263afd1: **`kindgi init <pack-name>` pins the pnpm that installs the pack.** A new TypeScript pack that stands alone, with no `packageManager` field or lockfile in the folders above it, gets `"packageManager": "pnpm@<version>"` with the version `pnpm --version` gives in its folder. `kindgi build`'s image, CI and teammates then install with that same pnpm; pnpm 10+ switches to it on its own. A pnpm 12 image refuses a lockfile an older pnpm wrote when it has entries less than a day old, so a mismatch can break a build right after a release.
  
  Inside an existing project, nothing is written: that project's own setup governs. Adding Kindgi to an app and Python packs are unchanged. When pnpm's version can't be read, the next steps say so and how to set the field.
- a0921a1: Test sets built from judgments, and context captured when a run is first judged. `@kindgi/api` adds the `judged` eval kind, `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (publishes a version whose cases are copies of an agent's or flow's judged runs, each item's judgments summed and weighted by judge class) and `GET /v1/eval-suites/{suiteId}/versions/{version}/cases`, mounted when `createApp` gets an `evalCaseStore` (`EvalCaseStoreBinding`) beside `evalSuiteRegistry` and `judgmentRegistry`; a `JudgmentRegistryBinding` adds `listJudgedRuns` to support it. The first judgment of an agent turn also stores `context` on the run copy: the conversation before the turn and what its retrievals returned. `@kindgi/client` adds `evalSuites.buildFromJudgments` and `evalSuites.listCases`; the Python client has the same methods. `@kindgi/cli` adds `kindgi eval-suites list | show | from-judgments | cases`.
- dde7fdb: Judgments and judge classes. A judgment is a yes or no, with an optional reason, about one item of a finished run's output, optionally recorded under a judge class that carries a weight. `@kindgi/api` adds `/v1/judgments` (create, list, get, unregister) and `/v1/judge-classes` (create, list, get, update, unregister), mounted when `createApp` gets a `judgmentRegistry` (`JudgmentRegistryBinding`). A judgment keeps copies of the run's input and output and of the judged item, takes who judged from the caller's token, and judging an item again as the same caller supersedes the earlier judgment. `@kindgi/authz` adds the `judge` action on `run`. `@kindgi/policy-contract` adds the `judgment` and `judge_class` retention domains. `@kindgi/client` adds `client.judgments` and `client.judgeClasses`; the Python client has the same resources. `@kindgi/cli` adds `kindgi judgments add | list | show | remove` and `kindgi judge-classes list | add | set | remove`.
- 8b2e3a3: A release candidate of the CLI keeps to its own release. Its hints run `npx --yes @kindgi/cli@<its exact version>`, since a `0.1`-style range never matches a pre-release and would run the last release. A Python pack it creates requires `kindgi>=<its version>,<…>` in PEP 440 (`kindgi>=0.1.4rc0,<0.2`), so pip and uv install the matching Python SDK, and the same requirement takes the release once it's out. A release CLI is unchanged.
- d0ebeb6: Replay turns: an agent turn can re-run a past run for an eval run without doing anything the past run didn't do.
  
  - `@kindgi/agents`:
    - `InvokeAgentInput.replay` (`{ of, evalRunId }`) marks a turn as a replay. It is kept on the turn's run and in its run snapshot (new nullable `agent_run_snapshots.replay` column), so a resumed turn stays a replay.
    - The new optional `InvokeAgentBindings.replay` (`ReplayBinding`) decides each tool call:
      - `live`: the tool runs;
      - `recorded`: the past run's result is used;
      - `refused`: the model gets the given result.
    - Whatever the binding says, only a tool declared read-only (`mutating: false`, no writing effect, see `isReadOnlyTool`) with no approval to wait for runs. A replay with no binding refuses every call.
    - Each decision is journaled, and `AgentTurnResult.replay` lists them. A refused call shows what the turn would have done.
    - `retrievals` can supply the past run's retrieved facts. `sessionApproval` gives the past run's decision at the session approval gate, which the replay follows (a recorded rejection fails the turn with `hitl-rejected`). Without a recorded decision the gate is skipped, and the result says so.
    - `tool.completed` events carry `replay: 'live' | 'recorded' | 'refused'`.
  - `@kindgi/runtime`: `RunReplayRef`; `replay` on `runGraph` and `startRun`; `replayOf` and `evalRunId` on `KernelRunRecord`; `replays` and `evalRunId` on `ListRunsInput`.
  - `@kindgi/capabilities`: `ModelUsageRecord.replay` tags a replay's model calls with the past run and the eval run.
  - `@kindgi/api`:
    - A run carries `replayOf` and `evalRunId`.
    - `GET /v1/runs` leaves replay runs out unless `replays=include|only`; `evalRunId` lists one eval run's replays.
    - A judged agent turn's captured `context` also keeps `sessionApproval`, the decision at its session approval gate.
  - `@kindgi/client`: `runs.list({ replays, evalRunId })`; the Python client too.
  - `@kindgi/cli`: `kindgi runs list --replays=<exclude|include|only> --eval-run=<id>`.
- eb60481: **When the runtime container stops while `kindgi dev` starts it, the message always says why.**
  - It names the container's exit code and what the code means: 137 killed or out of memory, 139 a crash, 126/127 a command that couldn't run. Docker's own error is included when there is one.
  - It gives the container's last log lines, read whole.
  - A container that stopped before printing anything is said to have done so. Before, the message could end with an empty reason.
  
  The container no longer runs with `--rm`, so a fast exit's logs and exit state can still be read; `kindgi dev` removes it itself, when it stops and after a failed start. `docker logs`' own errors (such as "can not get logs from container which is dead…") are no longer shown as the runtime's output.
- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [e197294]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [dde7fdb]
- Updated dependencies [e17b230]
- Updated dependencies [b52d890]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [62608e3]
  - @kindgi/client@0.1.4-rc.0
  - @kindgi/handler-runtime@0.1.4-rc.0
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/sdk@0.1.4-rc.0
  - @kindgi/secrets-dotenv@0.1.4-rc.0
  - @kindgi/crypto@0.1.4-rc.0
  - @kindgi/dotenv-file@0.1.4-rc.0
  - @kindgi/env-schema@0.1.4-rc.0

## 0.1.3

### Patch Changes

- **`kindgi build` installs with the pnpm that wrote the lockfile.** For a pnpm pack whose `package.json` has no `packageManager`, the image used to take the newest pnpm through corepack. pnpm 12 refuses packages published less than a day ago (`minimumReleaseAge`) when it installs from a lockfile an older pnpm wrote. So, for anyone on pnpm 10 or 11, a build failed for a day after any of the pack's dependencies was released, a new Kindgi version included, and the image's pnpm changed with every pnpm release. The image now installs the host's pnpm version, the one `pnpm --version` gives in the install root. When that can't be read, `kindgi build` refuses and says to add `packageManager`. A `packageManager` in `package.json` still wins, and pnpm's own policies are left as they are.
- ddea933: `kindgi dev` gives each project its own database in the bundled Postgres, `kindgi_<project>`, with its own dev tenant and user. A linked git worktree gets `kindgi_<project>__<worktree>`, so branches on different Kindgi versions never share a schema.
  
  - **The project's name:** `project` in the Kindgi config (`kindgi.config.ts`, or `project` under `[tool.kindgi]` in `pyproject.toml`), else the git repository's, the workspace root's or the pack folder's. The boot log names it.
  - **A database belongs to the folder that made it:** another folder whose project has the same name is refused until it sets its own `project`. A moved folder takes its database with it.
  - **`--reset` drops the project's database** after asking. `--yes` skips the question, and with no terminal to ask on it refuses. A database passed with `--database-url` is never dropped.
  - **Shared:** every pack of one project shares the database and the tenant. Each keeps its own tools, pack service and env files.
  - **The shared `kindgi` database** earlier releases used is left as it is. The first boot says so, once.
- d4dcbd7: **`kindgi dev` registers the model providers the config declares.** List them as `providers` in `kindgi.config.ts`, or as `[[tool.kindgi.providers]]` tables in `pyproject.toml`. Each one is a preset (`{ preset: 'gemini', project: 'acme-gcp', models: [...] }`, the choices `providers register --preset` takes) or a `{ spec: … }` registration body. They are then registered in every worktree's database, after `--reset`, and on a teammate's machine, with no `providers register` to repeat.
  
  On each boot, `kindgi dev` keeps the runtime in step with the list:
  - it registers a missing provider;
  - it re-registers one it registered whose declaration changed;
  - it unregisters one the config no longer declares.
  
  It leaves alone any provider it didn't register. One registered differently gets a warning naming the `unregister` that lets the config's version apply. A provider whose key isn't in the env files is skipped, with one line naming the secret.
  
  A key is always a secret's name: a `spec` with a credential in `adapter_config` is refused. Which providers `kindgi dev` registered is recorded in `.kindgi/dev/providers.json`, per database and tenant.
- fceb277: `kindgi dev` no longer misses a save that lands while a rebuild is running. The bundler skipped a rebuild that read the same files as the last one it reported, and told them apart by each file's size and modification time, read once the build had ended. A file saved during a build (an editor's save landing mid-build, or one caught half written, as when watching starts) was read before the save but stamped after it, so the rebuild the save triggered looked unchanged and was dropped: the dev index stayed on the stale build, a half-written file's "refresh failed" included, until the next save. A build during which an input changed (or changed within 3 s of its start, too close to tell) is now never taken for a later one.
  
  The pack conformance fixture has a new tool, `conformance.hold`: it prints `hold: <release>` on stdout and waits until the file `release` exists. The suite's drain, concurrency-cap and disconnect cases hold a call open with it, so each acts once the service has taken the call, and for exactly as long as it needs, rather than after a fixed wait. A pack service in another language implements it in its fixture pack (see `FIXTURE.md`).
- 4ed3d2f: CLI fixes from a pilot's feedback, and the runtime's port order.
  
  - **`kindgi runs start` never loses the run.** It starts the run in the background and follows it, rather than holding the start request open. A long agent turn no longer times out the CLI with no run id to look it up by. It still waits until the run finishes or waits on an approval, and prints the same record. A stopped wait (Ctrl+C) prints `Stopped waiting. Run <id> goes on: kindgi runs get <id>`.
  - **The Gemini preset uses the models' real output limit:** 65,536 tokens for Gemini 2.5 Pro and Flash, thinking included. It used to cap Pro at 8192. `kindgi providers register --preset=<name> --max-output-tokens=<n>` sets another cap.
  - **`kindgi env plan --format=gcloud` emits `--update-env-vars` / `--update-secrets`.** They add or replace the names listed and leave the service's other variables alone. `--set-*` replaced the whole env.
  - **`KINDGI_API_PORT`'s description states the port order.** The runtime takes the first that's set: the `--port` flag, `KINDGI_API_PORT`, the platform's `PORT` (Cloud Run, Render, Heroku and Fly set it), the config file's `port`, then 4000.
- 2c185d8: Fixes from the first Cloud Run deployment.
  
  - **The pack service token is read the same way on both sides.** `parsePackServiceToken` (new in `@kindgi/env-schema`) drops surrounding whitespace, so a secret stored with a trailing newline no longer makes every pack call answer 401. A token with whitespace or a control character inside is refused at startup, since an HTTP header can't carry it. The Node pack service and the Python one (`kindgi.pack.serve`) both use the rule, and the pack conformance suite checks it.
  - **Refusals aren't replayed.** The idempotency middleware stores a response only when the request took effect (a status below 400). A request retried with the same `Idempotency-Key` after a refusal (4xx) or a failure (5xx) runs again, so a deploy retried after trusting its key now goes through.
  - **`kindgi deploy` says when an answer is a replay** (`X-Idempotent-Replay`) and how to retry: `--idempotency-key <new value>` for a replayed refusal from an older runtime. A refused signing key's hint gives the `kindgi key trust <keyId> --url <endpoint>` command on a line of its own. The retry advice for server errors and network failures is reworded.
- 024582b: The getting-started and providers skills, and the templates' AGENTS.md, teach declaring model providers in the pack's config (`providers` in `kindgi.config.ts`, `[[tool.kindgi.providers]]` in `pyproject.toml`), which `kindgi dev` registers on every boot. The providers skill's Gemini example has the models' real output limit, 65,536 tokens.
- Updated dependencies [2544717]
- Updated dependencies [629057d]
- Updated dependencies [38935d3]
- Updated dependencies [1463b77]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [4ed3d2f]
- Updated dependencies [2c185d8]
- Updated dependencies [66e7ac2]
  - @kindgi/client@0.1.3
  - @kindgi/handler-runtime@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/env-schema@0.1.3
  - @kindgi/sdk@0.1.3
  - @kindgi/secrets-dotenv@0.1.3
  - @kindgi/crypto@0.1.3
  - @kindgi/platform@0.1.3
  - @kindgi/dotenv-file@0.1.3

## 0.1.2

### Patch Changes

- 9dbb491: `kindgi build --local` builds Python packs. It refused them ("build a Python pack with the build service"), and a self-hosted runtime has no build service, so a Python pack couldn't be deployed to one. A Python pack's image now builds with this machine's Docker from the same Containerfile and context as the build service's (its lockfile, frozen; the indexer stage's `/app/index.json` byte-identical to the local index), behind the same integrity gate; with `--push` it's pushed, signed, and written into the envelope for `kindgi deploy`. A Python pack's build context is now written as a directory and tarred the way a TypeScript pack's is, so the build service gets the same bytes as before.
- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- c84139c: `kindgi key trust <keyId>` adds a local key's public key to the runtime's trust list in one step, and `kindgi key revoke <keyId> [--reason]` removes it. Trusting no longer takes a shell pipeline: the runtime wants the 32 raw bytes, which `trust` sends, not the SPKI form `kindgi key export --format=base64` prints (unchanged). A refusal because the id is bound to another key, or was revoked, says to trust a key under a new id.
- Updated dependencies [966a615]
- Updated dependencies [fde369b]
- Updated dependencies [afd259f]
- Updated dependencies [80210cb]
- Updated dependencies [5c9594b]
- Updated dependencies [da1a8da]
  - @kindgi/client@0.1.2
  - @kindgi/crypto@0.1.2
  - @kindgi/dotenv-file@0.1.2
  - @kindgi/env-schema@0.1.2
  - @kindgi/handler-runtime@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/sdk@0.1.2
  - @kindgi/secrets-dotenv@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- 799aaaa: **`kindgi auth registry` logs Docker in to the runtime image's registry.** The Kindgi runtime image `kindgi dev` runs is in private preview. With the pull credentials you receive, `kindgi auth registry --username <robot name>` asks for the token without echoing it (or reads it from stdin with `--password-stdin`), runs `docker login` with the token on its stdin, then checks that Docker can pull the exact image this CLI runs (with `docker buildx imagetools inspect`, or `docker manifest inspect` by digest where buildx isn't installed). Kindgi stores nothing: the credential lives in Docker's own credential store. `--check` only checks access, and a failure says whether it's access (request it at contact@kindgi.com) or the image or the network. When a pull is refused, `kindgi dev` now points to `kindgi auth registry`.
  
  **Ctrl+C at a hidden prompt cancels.** At the value prompt of `kindgi secrets set` and `rotate`, Ctrl+C (or Ctrl+D) ended the CLI silently with exit code 0. It now prints `Cancelled.` and exits 1, like the other prompts.
- a3070fa: Fixes for adding Kindgi to an existing app, and for `kindgi dev` output:
  - **`pnpm install` works right after `kindgi init`** in a pnpm app. pnpm 11+ stopped the first install with `ERR_PNPM_IGNORED_BUILDS` for esbuild, which `@kindgi/cli` uses to bundle the pack. `init` now records a decision for esbuild's install script, `allowBuilds.esbuild: false`, in the `pnpm-workspace.yaml` pnpm reads (the workspace root's, or a new one in the app). esbuild works without the script: its native binary comes from its `@esbuild/<platform>` package. `init` keeps the file's other keys and comments, replaces pnpm's `set this to true or false` placeholder, and keeps a decision the app already has (`true` or `false`). New packs' templates also switch from `true` to `false`.
  - **`init` adds `zod`** (`^4.0.0`, the new-pack range) to an existing app, since every tool's schemas use it. An app's own zod is kept; if it is older than zod 4, `init` says so.
  - **Ctrl+C on `kindgi dev` prints one line**, `Stopping kindgi dev... stopped.`, not the startup banner and a JSON summary. The JSON summary now goes to stdout only with `--json` or `--raw`, and reports an empty pack as `ok`, not as an indexer error.
  - **An empty pack says so at startup.** The startup output says there are no primitives yet and where to add the first one, and shows an indexer error at startup instead of at exit.
  - **`--table` works** for `runs list`, `tools list` and `providers list`. When there is a next page, its `--cursor` goes to stderr.
  - **The sample pack type-checks under pnpm.** `tsc --noEmit` failed with TS2742 on the sample guardrail. Its inline check is now typed with `DefinedCheck` from `@kindgi/sdk/define`.
- ca66617: `kindgi runs start --no-wait` describes what it does: an agent run returns as soon as it exists, like a flow run (follow it with `kindgi runs stream` or `kindgi runs get`). The `--path` help of `kindgi dev` and `kindgi test` names `kindgi.config.mts` too.
- e184714: **A new pack gets its `.gitignore` again.** `npx @kindgi/cli init` wrote no `.gitignore`: npm renames a package's `.gitignore` to `.npmignore` when it installs it, so the templates' file never reached the new pack, and `.env` (model keys) and `.kindgirc.json` (the dev token) weren't ignored by git. The templates now store it as `gitignore`, and `init` writes it as `.gitignore`. If you created a pack with 0.1.0, add a `.gitignore` with at least `.env`, `.env.local`, `.kindgirc.json` and `.kindgi/`. Adding Kindgi to an existing app was not affected.
- 811d030: **`kindgi dev` starts its Postgres without `docker compose`.** On a Docker engine without the compose plugin (common on a bare Linux engine), `kindgi dev` no longer stops and asks for `KINDGI_DATABASE_URL`: it starts the bundled Postgres with plain `docker`, and says so (`Postgres: started with docker (docker compose isn't available)`).
  - **The same Postgres either way:** the image, settings, healthcheck and random host port the bundled compose file defines, and the same container (`kindgi-dev_postgres`), volume (`kindgi-dev_postgres-data`) and network (`kindgi-dev`), so the data is shared whichever way it was started. What plain `docker` creates carries the `kindgi-dev` compose project's labels, so once compose is installed, `kindgi dev` and `docker compose -p kindgi-dev down -v` take it as their own.
  - **An existing container is reused as it is**, started if it's stopped, never recreated or removed. `--recreate-services` needs compose: without it, `kindgi dev` says the container was reused and how to recreate it by hand. `--reset` behaves as before: it starts one pack fresh and leaves the shared Postgres alone.
  - **The bundled Postgres listens on `127.0.0.1` only** (a random port), in both ways of starting it: its password is a fixed dev one, so it must not be reachable from the LAN. The runtime container still reaches it, through `host.docker.internal` on Docker Desktop and directly with Linux host networking. A `kindgi-dev_postgres` an earlier CLI started keeps its old binding (every address) until it's recreated: `kindgi dev --recreate-services` with compose, or `docker rm -f kindgi-dev_postgres` without it (the data stays in its volume), then `kindgi dev`.
  - **Without Docker,** the error names the two options: install Docker, or pass `--database-url` (or set `KINDGI_DATABASE_URL`) for your own Postgres 16 with pgvector.
- 3699f29: **`kindgi dev` warns about an import `kindgi build` would refuse:** a package the pack imports that `package.json` lists only in `devDependencies`. It loads on your machine, but a deployed pack installs production dependencies only, so it's missing there. The warning names the package and the files importing it, at startup and when a save adds one, once per package; after you move it to `dependencies`, the next reload says it's resolved. It checks what a pack image would load from `node_modules`, including what `kindgi.config.ts` imports. `--json` and `--raw` list them as `devOnlyImports`. Python packs aren't checked.
- faf19ec: A pack image never runs the app's own install scripts.
  
  - **The bug:** `kindgi build` installs the app's dependencies with scripts off, then rebuilds so the dependencies the app allows can build. The rebuild also ran the app's own pending scripts: pnpm and npm treat the project itself as pending. So a `postinstall: prisma generate` or a `prepare: husky` ran in the image and failed the build, since the image holds no schema and no `.git`.
  - **The fix:** the build context's copies of the app's project manifests (the root's, each workspace member's, the pack's) leave out their install lifecycle scripts: `preinstall`, `install`, `postinstall`, `prepare` and its pre/post, `prepublish`, `dependencies`. Every other field and script stays. The lockfile, the dependencies' own scripts and the allowlist are untouched. What the image needs from such a script comes from a build extension: `prisma()` runs `prisma generate`.
  - **`kindgi build` says what it left out:** "The app's own install scripts don't run in the image: postinstall (`prisma generate`), prepare (`husky`)".
  - **A skipped script that runs `patch-package` gets a warning:** its patches wouldn't be applied in the image. To apply them, add a build step: `defineBuildExtension({ name: 'patch-package', contextFiles: [<the patch files>], postInstall: [{ bin: 'patch-package' }] })`. Or, with pnpm, use `pnpm patch`, which the install applies itself.
- 319a134: A pack module that wouldn't load in the image now fails the build, saying why, not as a vague integrity-gate mismatch later.
  
  - **`@kindgi/cli`:**
    - `kindgi build` refuses a pack that imports a package its project lists only in `devDependencies`, before the image is built. The image keeps production dependencies only, so such an import loads locally but not in the image. The message names the package and says to move it to `dependencies`.
    - A Node pack's local index fails the build on file errors (a module that throws on import), as a Python pack's already did.
    - The image's indexer stage runs `kindgi-index --strict`.
  - **`@kindgi/handler-runtime`:** `kindgi-index --strict` exits 1 when a module fails to load, printing each file error. Before, the index was written without that module, and only the CLI's integrity gate noticed: "indexHash mismatch".
- 324aba4: **`POST /v1/runs/{runId}/resume` is not available in this release.** It now answers `422 run-resume-not-supported` and completes nothing. Every waitpoint a run can wait at belongs to an approval or to the runtime itself. A run waiting for an approval continues when a reviewer decides it, through `POST /v1/approvals/{approvalId}/complete` (`kindgi approvals complete`), which checks the reviewer and records the decision. `kindgi runs resume` says the same and is left out of `--help`.
- Updated dependencies [0fe5626]
- Updated dependencies [5ef3129]
- Updated dependencies [319a134]
- Updated dependencies [d00fc1b]
- Updated dependencies [d28e1fd]
- Updated dependencies [ca66617]
- Updated dependencies [bbe0bc9]
  - @kindgi/sdk@0.1.1
  - @kindgi/handler-runtime@0.1.1
  - @kindgi/env-schema@0.1.1
  - @kindgi/secrets-dotenv@0.1.1
  - @kindgi/client@0.1.1
  - @kindgi/crypto@0.1.1
  - @kindgi/dotenv-file@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: `kindgi build --local --push [<repository>]` publishes from your machine:
  - **builds** for the deployment's platform: `linux/amd64` by default, as Cloud Run runs; `--platform` overrides it;
  - **pushes** to the repository: `--push`'s value, else `environments.<env>.registry` + `/<packId>`;
  - **checks** the pushed image's index against the local one, by digest;
  - **signs** as the build service path does, and writes `deploy-envelope.json` for `kindgi deploy`.
  
  It uses your own Docker credentials for the registry; Kindgi holds none. A command-line option can now take an optional value (`--push`, or `--push=<repository>`).
- aec851d: `describeCommands()` and `describeGlobalFlags()`: the CLI described as data (every command with its usage, its flags and its subcommands, and the global flags), with no handlers. The CLI reference on the documentation site is generated from them.
- aec851d: `@kindgi/cli`, the `kindgi` command, now lives in this repository: create a pack (`kindgi init`), run it on your machine against the Kindgi runtime image (`kindgi dev`), build, sign and deploy it, and work with a running Kindgi API from the terminal. It depends only on `@kindgi/*` packages and joins the fixed version group. The README is rewritten for how the CLI works today.
- aec851d: Build extensions for a TypeScript pack image: `image` in `kindgi.config.*`, with `@kindgi/sdk/build`.
  
  ```ts
  import { prisma } from '@kindgi/sdk/build';
  
  export default {
    pack: { id: 'acme.app', version: '1.0.0' },
    image: {
      systemPackages: ['tesseract-ocr'],
      extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
    },
  };
  ```
  
  - **`@kindgi/handler-runtime/build-extensions`**, re-exported as **`@kindgi/sdk/build`**:
    - `ImageConfig` and `BuildExtension` (`contextFiles`, `systemPackages`, `postInstall` steps, `buildEnv`);
    - `prisma({ schema, config? })`: copies the schema in and runs `prisma generate` after the install, before the prune. An app's `postinstall` doesn't run in the image;
    - `defineBuildExtension()`.
  - **`kindgi build`** reads and checks `image`, naming any field that's wrong, then renders it:
    - system packages in the base stage;
    - `buildEnv` in the install stage only, never the final image;
    - each step after the install, through the app's package manager (`pnpm exec`, `npx --no`, `yarn`).
- aec851d: A TypeScript pack image that works: it runs the pack's bundles, installs the app the way the app does, and `kindgi build --local` builds it with this machine's Docker.
  
  `@kindgi/handler-runtime`:
  - `runIndexer({ bundleMap, moduleRoot })` indexes a build. The map's source paths are the file list, classified by the discovery patterns, so the source tree needn't be there. Each file is imported from its bundle, and the index records the source path. `kindgi-index` takes `--bundle-map` and `--module-root`.
  - `kindgi-index-main`: the indexer as a process entry. Before, the image's indexer stage loaded `kindgi-index` and exited without writing an index.
  - The pack service's `--bundle-map`: the modules the index names load from their bundles.
  
  `@kindgi/cli`, `kindgi build`:
  - **Bundles:**
    - the pack's code is bundled, and its installed dependencies stay external, imported by name from the image's `node_modules`;
    - the indexer and the pack service are self-contained bundles;
    - every bundle is `.mjs` with sourcemaps, plus `dist/bundle-map.json` and the bundled `kindgi.config`;
    - the local index runs the same bundled indexer over the same bundles as the image, so the integrity gate compares like with like.
  - **Install:** the app's own package manager from its own lockfile, frozen with scripts off, then the build scripts the app allows, then a prune to production. pnpm and yarn come through corepack and the `packageManager` field. A pack in a workspace member sits at its own path.
    - `.npmrc` and `.yarnrc*` are build secrets, never in the context.
    - A dependency linked from outside the project is refused, with what to do instead.
    - The synthesized `package.json` is gone.
  - **Base image:** `node:22` or `node:24-bookworm-slim`, pinned by image index digest, picked from `engines.node` (`scripts/refresh-node-digests.mjs`).
  - **The Containerfile:** tini, `USER node`, `HEALTHCHECK`, `EXPOSE 8080`, `NODE_ENV=production`.
  - **The context:** the install's files, the bundles and `bundle.include`. The pack's source never ships.
  - **`--local`:** `docker buildx build --load` into the local image store as `kindgi-pack/<packId>:<artifactVersion>`, with the same integrity gate. No build service, no signing.

### Patch Changes

- 5fdc80b: Every flag says what it does: `kindgi <command> --help` lists the command's flags with a description, the global flags in `kindgi --help` come from the same definitions, and `describeCommands()` / `describeGlobalFlags()` carry the descriptions (the docs' CLI reference shows them). The help's config precedence now names `.kindgirc.json`. The README's `--template` row matches the templates (`minimal` is the folders, no examples).
- aec851d: Launch fixes:
  - **Unwired commands are hidden.** The commands this release doesn't wire (memory, artifacts, provenance, proposals, observations, tokens, capabilities, conversations, flows, and agents list/get/unregister/versions, tools publish) no longer appear in `--help` or the generated reference. Calling one still says it's not wired yet.
  - **`env list --reveal`** refuses unless stdout, where the values go, is a terminal. Before, `--reveal > file` typed in a terminal wrote the values unredacted.
  - **`auth whoami`** checks the token on an authenticated route (`/v1/identity/whoami`) and shows the identity. A wrong token now fails.
  - **`secrets`:** a version conflict suggests `--write-mode=add-version`; `--limit` and `--if-version` must be integers; no internal wording in the missing `--scope` error.
  - The `kindgi dev` banner's feedback hint uses `--body-stdin`, so a coding agent running it doesn't wait on `$EDITOR`.
  - The README matches: published packages, the private-preview runtime image, and only the wired commands.
- 56e3453: A Python pack has no npm project to install the CLI into, so its hints (`init`'s next steps, the `kindgi dev` banner, `providers`' secret hint) and the `.mcp.json` entries `kindgi mcp add` writes now run the published CLI through npx, within the running CLI's minor: `npx --yes @kindgi/cli@0.1 <command>`. Before, they said `kindgi …`, which fails without a global install. Node 22 is needed.
- be597c4: `kindgi dev` runs the Kindgi runtime 0.1.0 by default, pinned by digest (`quay.io/kindgi/runtime:0.1.0@sha256:…`). Docker doesn't re-pull a tag it already has, so a tag could leave you on an older runtime. When the pull is refused, the message says the image is in private preview and how to request access.
- aec851d: `kindgi --version` and `kindgi version` report the versions in the CLI's and the SDK's `package.json` (as `kindgi init` already did), not a constant that read `0.0.0`.
- aec851d: `kindgi build`, a pack image's install:
  - **Overrides' tarballs ship:** a `file:`/`link:` target that pnpm `overrides` (in `pnpm-workspace.yaml` or `package.json`), npm's nested `overrides`, or yarn's `resolutions` point at is in the build context. Before, a vendored package only an override named was missing in the image, and the install failed. One outside the project is refused, with what to do instead.
  - **Only the pack's project, in a pnpm workspace:** the image installs `--filter '{./<pack>}...'` (the pack's project and what it depends on), and prunes with the same filtered install plus `--prod`. `pnpm prune` ignores a filter and installs the whole workspace. npm and yarn still install the whole workspace.
  - **pnpm's metadata cache** is a BuildKit cache mount too, and `~/.cache` belongs to `node`. Otherwise corepack can't write its own cache beside the mount.
- aec851d: A pnpm pack image's rebuild reuses the packages it already downloaded.
  
  - **The bug:** the install stage's pnpm store was never the cache mount. BuildKit creates a mount's parent folders as root, so pnpm skipped `~/.local/share/pnpm` and kept its store in the layer. Every rebuild with a changed lockfile downloaded everything again.
  - **The fix:** the store is a cache mount at `/home/node/.cache/pnpm-store`, under the `~/.cache` the stage gives `node`. The stage names it for pnpm explicitly (`pnpm_config_store_dir` for pnpm 11, `npm_config_store_dir` before it), in the install stage only.
- aec851d: The Python SDK, `kindgi`, publishes to PyPI with the npm packages, at `0.1.0`.
  
  - **`kindgi init` for a Python pack, from a published CLI**, writes `kindgi` from PyPI within the CLI's own minor: `kindgi>=0.1,<0.2` for a 0.1 CLI. That covers the new template, an existing app's `pyproject.toml`, and the install line it prints, quoted for the shell. A CLI run from a Kindgi checkout keeps using the checkout's `sdks/python`.
  - **`check:publish`** fails when `sdks/python` and the npm packages don't share a major.minor.
  - **`release.yml`** publishes `kindgi` to PyPI on the same dispatch, in its own `pypi-publish` environment, with trusted publishing and attestations. A version PyPI already has is skipped.
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [1f81d37]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/client@0.1.0
  - @kindgi/sdk@0.1.0
  - @kindgi/env-schema@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/handler-runtime@0.1.0
  - @kindgi/dotenv-file@0.1.0
  - @kindgi/secrets-dotenv@0.1.0
  - @kindgi/crypto@0.1.0
  - @kindgi/platform@0.1.0
