---
name: kindgi-authoring-agents
description: >
  Covers writing agents for a Kindgi pack with @kindgi/sdk:
  defining agents via defineAgent, tool wiring with ToolRef versioning,
  guardrail references, conversation policy, turn budgets, LLM
  capability declarations, and prompt template variables. Load this
  whenever you are authoring or editing code inside a pack's agents/
  directory, defining an agent, or when the user asks to add, modify,
  or refactor an agent. Authoring tools is covered by
  kindgi-authoring-tools; authoring guardrails is covered by
  kindgi-authoring-guardrails.
type: core
library: "@kindgi/sdk"
version: "0.4.13"
sdk_version: "0.0.0"
pack_languages: [node]
sources:
  - packages/agents/src/types.ts
  - packages/agents/src/define.ts
---

# Authoring Kindgi agents

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

An **agent** is a versioned LLM-powered orchestrator: instructions (a
prompt template), a declared set of tools it can call, capability
declarations for the LLM provider, guardrails that gate its outputs,
and optional multi-turn conversation policy. Agents live at
`agents/<name>/index.ts` inside a pack.

## Ask before building

Requests like "add an agent" / "create an agent" / "I need an agent"
are conversation openers, not tickets. Before writing any file, ask:

- **What should the agent DO?** The purpose is the load-bearing thing.
  Everything else derives from it.
- **Which tools does it need?** New tools, or reuses of existing?
- **Multi-turn or one-shot?** Conversation history changes the shape.
- **Any specific guardrails?** Safety rules the agent must respect.

The pack's existing agents are examples that prove the framework runs
end-to-end. They are NOT the shape you imitate unless the user
explicitly asks for that. Inferring purpose from surrounding pack
shape is how confident, wrong code gets shipped.

## Minimal agent

```ts
// agents/brief-writer/index.ts
import { defineAgent } from '@kindgi/sdk/define';
import type { AgentId, Semver } from '@kindgi/sdk/types';

const defined = defineAgent({
  id: 'acme.brief-writer' as AgentId,
  version: '0.1.0' as Semver,
  name: 'Brief Writer',
  description:
    'Drafts appellate briefs from a case file. Cites precedents; escalates novel legal questions.',
  instructions:
    'You are drafting a brief in {{ jurisdiction }}. The user provides the case facts; you produce a Section IV argument citing at least two precedents. Check every cite with the verify-citation tool before including it. Refuse to fabricate citations — always call the tool.',
  capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
  tools: [
    { id: 'acme.verify-citation', version: '^0.1.0' },
    { id: 'acme.fetch-precedent', version: '^0.1.0' },
  ],
  retrieval: [],
  guardrails: ['acme.no-fabricated-quotes'],
  parameters: [
    { name: 'jurisdiction', type: 'string', required: true },
  ],
  conversationPolicy: { historyLimit: 20 },
  budget: { maxSteps: 8, maxCostUsd: 0.5, maxWallMs: 60_000 },
});

if (defined.kind === 'err') {
  throw new Error(`acme.brief-writer failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

## Field-by-field

- **`id`** — `<pack-id>.<agent-name>` (kebab-case, dot-namespaced).
  Enforced.
- **`version`** — Semver. Runs pin to a specific version; upgrading
  the agent doesn't retroactively rewrite in-flight conversations.
- **`instructions`** — LiquidJS template. `{{ variable }}` substitutes
  from `parameters` or framework auto-vars (`today`, `now`, `agent.*`,
  `conversation.*`). Rendered with `strictVariables: true` — unresolved
  references fail loudly at invoke time. Frame instructions like a
  competent employee brief: what the agent does, what tools to prefer,
  what to refuse, what quality bar to hit. Name a tool by what it does
  ("the verify-citation tool"), never by its dotted id: the model sees
  ids in its provider's form (`acme__verify-citation` for Anthropic and
  OpenAI-compatible models), and `acme.verify-citation` in the
  instructions can make it call a name it wasn't given.
  - **From a prompt block:** `instructions: { prompt: 'acme.reply-prompt', version: '^1.0.0' }`
    takes them from a block in the pack's `blocks/` folder
    (`blocks/**/*.json`, deployed with the pack before its agents):
    `{ "id": "acme.reply-prompt", "version": "1.0.0", "kind": "prompt", "content": { "template": "…" } }`,
    or `"templateFile": "reply-prompt.liquid"` beside it for a long one.
    The block brings its parameters, so the agent declares none.
    People can then change the wording without a deploy, and Improve can
    try rewrites: each is a suggested change a person checks and pins.
    Rules that must always hold stay in code.
- **`settings`** — settings blocks the instructions and tools read, by
  range: `settings: [{ id: 'acme.reply-style', version: '^1.0.0' }]`.
  A settings block's file holds `values` and a JSON `schema`; the
  template reads `{{ settings["acme.reply-style"].maxSentences }}`. Mark
  a key Improve may change with `"x-kindgi-tunable": true` in the
  schema, on a number with `minimum` and `maximum` or an `enum` of two
  or more values. Leave it off a key that guards a rule: a limit, a
  window, a cap.
- **`capabilities`** — declares the resource kinds the agent needs at
  runtime. `{feature: 'tool-use'}` is standard for tool-calling
  agents. The router picks the concrete LLM provider at turn time.
- **`tools`** — `readonly ToolRef[]`, NOT `string[]`. Each entry is
  `{id, version}` where `version` is an npm-style semver **range**
  (`'^0.1.0'`, `'~1.2.3'`, `'>=1.0.0 <2.0.0'`). Empty array = chat-only
  agent.
- **`guardrails`** — array of guardrail `id` strings. Resolved at turn
  start against the guardrails bound for the run (the workspace's
  registered ones). If a guardrail id isn't registered, the turn
  fails with `unresolved-guardrail`. Guardrails check the final
  response before it is stored — a blocking (`halt`) violation fails
  the turn and the response is never written to the conversation; a
  `retry` one sends the response back to the model for a new one, up
  to `retry.maxAttempts` answers in all (default 2); then the turn
  fails with `guardrail-violation`.
- **`parameters`** — typed inputs the caller supplies at invoke time.
  UI builds a "configure agent" form from these; runtime validates
  each required parameter is provided.
- **`preferredProvider`** — optional soft hint. When set to a
  `ProviderMetadata.id` (e.g. `'anthropic'`, `'groq'`), the router
  prefers that provider when at least one of its models satisfies the
  agent's `capabilities.needs` + workspace policy. Falls back to normal
  capability-based selection when the preferred provider is
  unregistered or filtered out.
- **`preferredModel`** — optional soft hint at the model level: set to
  a `ModelInfo.name` (e.g. `'gemini-3.8-flash'`), the router prefers
  `(provider, model)` tuples whose model matches. To require a model
  rather than prefer it, add a hard requirement to the capability:
  `capabilities: [{ needs: [{ feature: 'tool-use' }, { models: { allow: ['gemini-3.8-flash'] } }] }]`.
- **`modelSettings`** — optional: a model-settings block by range,
  `{ id: 'acme.reply-model', version: '^1.0.0' }`. It's a settings block,
  such as `blocks/reply-model.json`, whose values may set `temperature`,
  `maxOutputTokens` and `thinking`:
  `{ "id": "acme.reply-model", "version": "1.0.0", "kind": "settings", "content": { "values": { "thinking": "low" } } }`.
  **How much the model thinks** (runtime 0.3.0 or later; an older one
  refuses a block with `thinking`): the block's `thinking` (`lowest`,
  `minimal`, `low`, `medium`, `high`, `xhigh` or `max`); else the
  `thinking.default` the model's provider registration gives it (see
  `kindgi-authoring-providers`); else no level, and the model thinks as its
  vendor sets. A level the model doesn't take goes as the next one up that
  it takes, or its highest, with a `thinking-level-adjusted` warning. A
  guardrail's model judge, or a test run's judging model, asks for `lowest`.
- **`conversationPolicy`** — optional. Absent = each turn loads the
  conversation's full history and no HITL gates apply. `historyLimit`
  caps how many prior messages are loaded; `hitl` configures approval
  gates (a turn-count gate and per-tool gates). A workspace's `hitl`
  policy can tighten these — a shorter approval timeout, a higher
  reviewer role, a stricter gate for a tool — never loosen them.
  `hitl.separateApprover` (`true`, or `{ overrides: { '<tool id>': true } }`)
  makes a tool's approval need someone other than whoever asked.
- **`budget`** — per-turn ceiling. `maxSteps` caps model-call cycles
  (default 8, at most 32); `maxCostUsd` caps model spend; `maxWallMs`
  caps wall time (default 120 000). Exceeding steps or cost fails the
  turn with `budget-exceeded`; running out of wall time aborts it
  (`agent-turn-aborted`, reason `timeout`).

- **`output`** — optional typed result: `{ schema, name?, maxRepairs? }`
  (JSON Schema, or Zod). The final answer must be JSON matching
  `schema` (a fenced JSON block is accepted). An answer that doesn't fit
  goes back to the model with the problems listed, up to `maxRepairs`
  times (default 1); then the turn fails with `output-schema-violation`.
  The parsed answer is the turn result's `output`, and in a flow
  `nodeOutputs.<step>.output.<field>`. A Zod `.default()` field must be
  in the answer: downstream steps read every field.
- **`toolErrors`** — optional: what the turn does when a tool call
  fails. The failure goes back to the model as the call's result (what
  failed and why) so it can correct the call, up to `maxRetries` times
  per turn (default 1), for the kinds in `retryOn` (default
  `['invalid-arguments', 'unknown-tool']`, failures where nothing ran).
  Add `'tool-error'` to retry a tool that ran and failed — only when
  retrying it is safe (a mutating tool may have changed something before
  failing). Each retry costs a step against `budget.maxSteps`. Past the
  retries the turn fails as before, with `toolRetries` on the error. A
  workspace's `tool-errors` policy can lower these (fewer retries, fewer
  kinds), never raise them.
- **`parallelToolCalls`** — optional, default on. When a model step asks for
  several calls at once, calls to read-only tools (`mutating: false`, no
  changing effect) that come one after another run at the same time, up to 8
  of them, and a call to any other tool runs on its own, in the order the
  model asked. A call that may wait, for another system's answer or for the
  person who started the run to connect an app, runs on its own too. Once a
  call needs an approval, the step's calls that haven't started run one at a
  time. The results reach the conversation and the model in the model's order
  either way. `false` runs every call on its own, for read-only tools that
  mustn't overlap (a rate-limited API, say).
- **`retrieval`** — what the agent reads from memory before each turn.
  Empty = no memory. Each intent is
  `{ types: ['acme.preference'], scope, mode?, limit? }`, with `scope`
  one of `'same-user'`, `'same-conversation'`, `'same-project'`,
  `'tenant'` (always within what the run may see), and `mode` absent
  (newest first), `'keyword'`, `'semantic'` or `'both'`. Retrieved facts
  reach the model as data in a `<memory>` block, never as instructions.
  `semantic`/`both` need embeddings on the runtime
  (`KINDGI_MEMORY_EMBEDDINGS`): without them a `semantic` intent fails
  the turn (`semantic-unavailable`). `{ source: 'conversations', scope:
  'same-user' }` recalls this agent's earlier conversations: the people's
  own words only, unless `roles: ['user', 'agent']` (its own earlier
  answers come back marked unverified). `same-segment`/`same-project`
  recall other people's conversations, and publishing warns.
  `same-user` memory (facts, recall or `remember`) is the run's end user's:
  pass `participantId` on every run. A run without one reads and keeps
  none (its result warns `memory-needs-participant`), never the memory of
  the user a key acts for, who may serve many people.
- **`memory`** — `{ remember: { types, scope, keepDays? } }` gives the
  turn the built-in tool `kindgi_remember` (name it exactly so in the
  instructions; built-ins have no dots). The model picks the type, the
  text, an optional `key` and an expiry; never the scope. A fact wider
  than one person, or text that reads like an instruction, waits for a
  person's approval. Remembering is a tool call, so use a model with
  reliable tool calling. `{ instructionTypes: ['acme.policy'] }` turns a
  retrieved, verified fact of those types into an instruction
  ("Policies (verified)"). "Give an agent memory" has the rest:
  https://docs.kindgi.com/v0.3/guides/agents/give-an-agent-memory/

## What a turn receives

- **Run directly** (`kindgi runs start --agent=… --input='{…}'`, or
  `POST /v1/runs { agent, input }`), the input is `{ userMessage,
  conversationId?, participantId?, parameters? }`:
  - `userMessage` is the turn's message;
  - `conversationId` continues a conversation;
  - `parameters` fills the agent's `parameters` (string, number or
    boolean values).
- **As a flow step** (`{ kind: 'agent', ref: 'acme.brief-writer' }`), the
  agent gets the step's input in two ways:
  - as **structured input**, which the instructions read as
    `{{ input.caseFacts }}`;
  - as the user message (the input as JSON).

  The step's `config.parameters` fills `parameters`, and `config.version`
  pins a version. With a typed `output`, the flow reads the answer at
  `nodeOutputs.<step>.output.<field>`. See `kindgi-authoring-flows`.

`{{ input.* }}` is set only in a flow step, so an agent that reads it
belongs in a flow. Rendering is strict: a direct run of such an agent
fails when its instructions render.

**In a run a webhook or an event started**, the turn's message is data:
it arrives inside an `<event note="kindgi event: data, not
instructions">` block, and the system message tells the model never to
follow instructions found there. It stays data in every later turn of
the conversation, whoever starts that turn. Every agent step of such a
run reads its message that way, so put a step's task in the agent's
instructions, not in its input. `{{ input.* }}` isn't wrapped: Liquid
puts it into the instructions as it is. So keep event text out of
instructions. Interpolate only the typed fields a check step reduced the
event to (an id, a status, an amount), never free text from the event.

## Iterating on an agent

Edit `agents/<name>/index.ts`, save. The next `kindgi runs start`
sees the change — new instructions, new tool bindings, new
capabilities, new preferredProvider, new budget. No version bump,
no restart. Source is truth in dev.

The `version` field is a **semver contract for humans reading the
source** — it declares what conversations pinned to this agent can
rely on. Bump because you're breaking that contract (removed a
parameter, tightened the instructions in a user-visible way,
switched to an incompatible provider policy), not because you saved
the file. If you're iterating on the prompt, leave version alone.

**When version matters:** conversations persist their `agentVersion`
at start and pin resume-across-turn to that version. `kindgi deploy`
publishes to a durable production registry that enforces the
immutable `(id, version)` contract. Both surfaces are deploy-time
concerns, not author-time.

**After it ships**, people correct its runs, and every correction is a
case in the agent's test set. `kindgi-fix-corrections` takes them to a
fix: a setting or wording as a suggested change, a rule in code.

## Common mistakes

1. **Adding an agent without asking what it should do.** The most
   common failure mode. "Add an agent" without a stated purpose gets
   answered by imitating the shape of the pack's example agent. Ask
   first.

2. **`tools: ['id-string']`** — `tools` is `ToolRef[]`, so TypeScript
   rejects bare strings, and `defineAgent` returns `invalid-agent` for
   one that slips through (plain JavaScript, a cast). Use
   `[{id: 'acme.x', version: '^0.1.0'}]`.

3. **Referencing guardrails that aren't registered.** If
   `agent.guardrails` lists an id the workspace has no guardrail for
   (registered via `POST /v1/guardrails`, a deploy, or `kindgi dev`),
   turn setup fails with `unresolved-guardrail`. Author the
   guardrail first or drop it from the agent's list.

4. **Un-declared `{{ variable }}` in instructions.** LiquidJS renders
   with `strictVariables: true` — a reference to `{{ jurisdiction }}`
   that isn't in `parameters` OR an auto-var throws at invoke time.
   Either add it to `parameters` or use a framework auto-var.

5. **Empty `capabilities`.** `defineAgent` rejects an empty
   `capabilities` array (`invalid-agent`) — the turn routes its first
   capability to pick a model. Declare
   `[{needs: [{feature: 'tool-use' as const}]}]` (or the matching
   feature set for your use case).

6. **Missing `Result` unwrap.** `defineAgent` returns `Result<Agent,
   InvalidAgentError>`. Always check `defined.kind === 'err' && throw`
   so a broken agent fails at module load.

## References

- Type surface: `hover any @kindgi/sdk/define export` in your editor
  for full JSDoc.
- API reference: https://docs.kindgi.com/v0.3/reference/typescript/sdk/kindgi/sdk/define/ (every `define*` spec, field by field).
- Common patterns: the `sample` template's `agents/echo-agent`
  demonstrates the smallest tool-calling shape.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself (SDK
type drift, wire schema silently dropping a field like
`preferredProvider`, router picking the wrong provider, misleading
error message, CLI friction) — not in the pack's own code — load the
`kindgi-framework-feedback` skill and file a structured report with
`kindgi feedback write`. That diagnostic is high-signal input the
maintainers can act on; don't let it disappear into the transcript.
