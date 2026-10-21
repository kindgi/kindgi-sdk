# `@kindgi/agents`

Agent definitions and the agent-turn executor for Kindgi. `defineAgent` validates a declarative agent (instructions template, required model capabilities, versioned tool references, retrieval intents, guardrail ids, budgets, conversation and HITL policy) into a plain, serializable `Agent`. `invokeAgent` runs one turn of a conversation as a run of a built-in flow. Storage, model providers, tools, and the flow runtime are all supplied through binding interfaces, which a runtime adapter implements.

## Purpose

Keep an agent a piece of data that can be versioned, stored, and pinned by `{ id, version }`, and keep every side effect behind an interface. Because a turn is a journaled flow run, it can park on a human approval and resume later with the same run id, conversation, and provenance record.

## Exports

- **Defining agents**
  - **`defineAgent(spec: DefineAgentSpec)`** — returns `Result<Agent, InvalidAgentError>`, collecting every validation issue with a `path` and `message`. Instructions given as a template must pass `templateProblem`. `DefineAgentSpec` has the fields of `Agent` except `preferredModel`, with `id` and `version` as plain strings.
  - **`Agent`** — `id` (`AgentId`), `version` (exact semver), `name`, `description?`, `instructions` (a LiquidJS template), `parameters?` (`PromptParameter[]`), `capabilities` (`Capability[]` from [`@kindgi/capabilities`](../capabilities/); a turn routes on the first entry), `tools`, `retrieval`, `guardrails` (guardrail ids), `preferredProvider?`, `preferredModel?`, `conversationPolicy?`, `budget?`, `tags?`.
    - **`ToolRef`** — `{ id, version }`, where `version` is an npm-style semver range (`'1.2.3'`, `'^1.2.3'`, `'~1.2.3'`, `'>=1.0.0 <2.0.0'`) resolved at run start against the tenant's tool registry (`ToolRegistry.forTenant`). Bare tool ids are rejected.
    - **`RetrievalIntent`** — `types`, `scope` (`same-conversation`, `same-project`, `tenant`), `limit?` (default 10), `mode?` (`keyword`, `semantic`, `both`; omitted lists the latest facts of each type).
    - **`ConversationPolicy`** — `historyLimit?` (prior messages loaded into the prompt), `hitlAfterTurns?`, and `hitl?`: a session gate (`afterTurns`), per-tool gates (`tools.default` and `tools.overrides` with modes `never_ask`, `ask_on_first_use`, `always_ask` and an optional `requiredRole`), `defaultReviewerRole`, and `timeoutMs`. Tool gates apply only when `hitl.tools` is set.
    - **`TurnBudget`** — `maxSteps` (default 8), `maxCostUsd`, `maxWallMs` (default 120 000).
  - **`PromptParameter`**, **`AgentId`**, **`ConversationId`** (re-exported from [`@kindgi/types`](../types/)).
  - **`createAgentRegistry(seed?)`** — an in-memory **`AgentRegistry`** keyed by `(id, version)`: `register`, `get(id, version?)`, `getLatest`, `list`, `listVersions`, `unregister`.
- **Prompt rendering**
  - **`renderInstructions(agent, context: RenderContext)`** — renders `instructions` in LiquidJS strict mode under [`@kindgi/bounds`](../bounds/)' `liquid` limits, and returns `{ ok: true, value: RenderResult }` or `{ ok: false, error: PromptRenderError }`. A missing required parameter or unresolved variable is a `missing-parameter` error (`MissingParameterError`), never an empty string; other failures are `render-failure` (`RenderFailureError`), and a render past one of the bounds' limits says which: its length, its time, or its memory, which counts what its filters, ranges and captures make and its output. A template resolves no partials. `RenderResult.context` holds every value the template saw.
  - **`TemplateRenderer`** — `render({ tenantId, template, scope })`, a `Promise` of the rendered instructions: where a turn renders them when `InvokeAgentBindings.templateRenderer` is set, off the thread that runs the turn. The turn checks the required parameters first, as `renderInstructions` does, then awaits it. Without one, the turn renders in-process.
    - It rejects with **`TemplateRenderError`** for the template's own failure (`code`: `missing-parameter` or `render-failure`; `message`; `parameterName` for a missing one), which the turn reports as it would an in-process render's.
    - It rejects with `TemplateRenderBudgetError` when the tenant has spent its render budget, which ends the turn as `rate-limit-exceeded`.
    - Any other rejection fails the render with its message.
  - **`AUTO_INJECTED_VARS`** — `today`, `now`, `agent` (`id`, `name`, `version`), `conversation` (`id`, `turn`), `input` (the turn's structured input), `settings` (the settings blocks' values). These names are reserved and cannot be declared as parameters.
  - **`templateProblem(template)`** — the one check a template passes wherever it comes in: an agent's instructions (`defineAgent`, and a deployment's agents), a prompt block's publish (`validateBlock`), and a drafted template (`checkDraftedTemplate`). It returns what's wrong, or `undefined`. A template is refused if it is longer than the bounds' `liquid.parseLimit`, if it uses a partial (`{% include %}`, `{% render %}` or `{% layout %}`: "templates can't use include, render or layout"), or if it's Liquid the renderer won't parse (an unknown filter included).
- **Running turns**
  - **`invokeAgent(input: InvokeAgentInput, bindings: InvokeAgentBindings)`** — returns `Promise<Result<AgentTurnResult, InvokeAgentError>>`.
    - `InvokeAgentInput` — `tenantId`, `projectId`, `agent`, `conversationId` (of a conversation opened with the same agent version), `userMessage`, and optional `parameters`, `participantId`, `abortSignal`, `dryRun` (no conversation, memory or provenance writes; the model call is skipped), `principal` and `authz` (from runtime 0.1.8, set on every turn a person or a key starts: each tool call is checked against the principal before it runs).
    - `InvokeAgentBindings` — `providerRegistry`, `toolRegistry` (the turn resolves tools on `toolRegistry.forTenant(tenantId)`, so it never sees another tenant's tools), `memoryBinding` (a `MemoryQueryBinding` from [`@kindgi/memory`](../memory/)), `conversationBinding`, `runSnapshotBinding`, and `runBinding` (a `RunBinding` from [`@kindgi/runtime`](../runtime/); optional in the type, required at call time); optionally `tenantPolicy`, `policyRegistry`, `embeddingRegistry`, `embeddingModel`, `onEvent`, `provenance`, `hitl`, `resolveSecret`, `templateRenderer` (a `TemplateRenderer`, below), and the `GuardrailsBindings` fields (`guardrails`, `checks`, `compliance`). `tenantPolicy` and the policy derived from `policyRegistry` are merged so the result is at least as strict as each (allow lists intersect, deny lists union, the smaller cap wins); the merged policy governs model routing and the models llm-judge guardrails may use. As the turn sets up, it evaluates the tenant's `model-routing`, `tool-errors` and `hitl` policies through `policyRegistry`; an evaluation that throws fails the turn with `tenant-policy-unavailable`, naming the policy's kind, rather than run it without the policy.
    - `AgentTurnResult` — `conversationId`, `turnNumber`, `appended`, `response`, `retrieved`, `violations` (failed guardrails whose action is not `halt` — reported, not carried out), `usage` (`AgentTurnUsage`), `provider`, and optional `provenance`, `dryRun`, `status`. `status: 'suspended'` means the run parked on a HITL approval; the response fields are placeholders until it resumes.
  - **`resumeAgentTurn(input: ResumeAgentTurnInput, bindings)`** — continues a suspended turn after its approval resolves. The caller passes the `Agent` at the version the run started with.
    - It rebuilds the turn input from the run snapshot, and the turn's state from the run's journal and the conversation. That state is the environment `setup` resolved, routed to the same provider and model, plus the messages the turn stored, its retrieved facts and its usage.
    - The turn goes on from the step it parked in. Calls that ran before the park keep their stored results.
    - Provenance recorded before the park isn't rebuilt.
    - Errors:
      - `run-snapshot-missing` when no snapshot was stored;
      - `run-journal-unavailable` when the journal can't be read;
      - `capability-routing-failed` when the turn's provider or model is no longer registered or allowed.
  - **`InvokeAgentError`** — the `AgentError` variants plus `UnresolvedToolError`, `tool-version-unresolvable`, `CapabilityRoutingError`, `ModelInvocationError`, `ToolInvocationError`, `BudgetExceededError` (`kind`: `steps` or `cost`), `AgentTurnAbortedError` (`reason`: `external`, or `timeout` when `maxWallMs` elapses), `HitlRequiredError`, `GuardrailViolationError`, `UnresolvedGuardrailError`, `TenantPolicyUnavailableError` (`code: 'tenant-policy-unavailable'`, with the `policyKind`: a tenant policy the turn must apply could not be evaluated, so the turn fails rather than run without it).
  - **Streaming** — `bindings.onEvent` (`OnTurnEvent`, sync or async) receives each `TurnEvent`: `turn.started`, `retrieval.completed`, `model.call.started`, `model.call.completed`, `tool.started`, `tool.completed`, `tool.failed`, `agent.message`, `guardrail.violated`, `guardrail.error` (a guardrail whose check couldn't run), `turn.completed`, `turn.failed`. Each has an exported type (`TurnStartedEvent`, `ToolStartedEvent`, …). Exceptions thrown by the handler are swallowed.
- **Turn flow**
  - **`AGENT_TURN_FLOW`** — the [`@kindgi/flow`](../flow/) `Flow` every turn runs, with **`AGENT_TURN_FLOW_ID`** (`'agent.turn'`), **`AGENT_TURN_FLOW_VERSION`** (`'1.1.0'`), **`AGENT_TURN_LOOP_MAX_ITERATIONS`** (32), and one `*_NODE` constant per node id as it appears in run journals: `setup` → `render-prompt` → `persist-user-message` → `run-retrievals` → `build-initial-messages` → `agent-loop` (`model-call` → `dispatch-tools` → `budget-check`) → `evaluate-guardrails` → `persist-final-message` → `persist-provenance` → `compose-result`. Guardrails are evaluated once per turn, on the final response before it is stored; a failed check whose action is `halt` fails the turn with `guardrail-violation`, and the response is never written to the conversation. Failures with any other action (`log-only`, `retry`, `escalate`, `compensate`, or a custom action — guardrail kinds and actions are open strings) are reported in `violations` and as `guardrail.violated` events; the turn does not carry them out.
  - Steps usable on their own: **`runRetrievals`** with **`RetrievalBindings`** and **`formatRetrievedForPrompt`** (`RetrievedFact` pairs a fact with the intent that fetched it); **`resolveGuardrails`**, **`buildRunTrace`**, **`evaluateGate`** (takes the turn's tenant policy, under which llm-judge guardrails route), **`categorizeOutcomes`**, **`evaluateSessionGate`** (`SessionGateResult`) with **`GuardrailsBindings`**; **`persistProvenance`** with **`ProvenanceBindings`** (`newBuilder`, `emit`, `emitBinding`, `keyProvider`).
  - **`resolveEffectiveHitlPolicy({ tenant, agent })`** — returns an `EffectiveHitlPolicy`: framework defaults (24 h timeout, `standard` reviewer, `escalate` on timeout) overlaid with the agent's policy, then held to the tenant's `hitl` policy (`tenant`: a `HitlSpec` from [`@kindgi/policy-contract`](../policy-contract/), or `undefined`), which can only tighten: it caps the timeout, raises the reviewer role, and sets `toolFloors` — per tool, a gate is the stricter of the agent's and the tenant's. Each turn resolves it once, evaluating `hitl` through `policyRegistry`; an evaluation that throws fails the turn with `tenant-policy-unavailable`.
- **Bindings**, implemented by a runtime adapter
  - **`ConversationBinding`** — `openConversation`, `getConversation`, `listConversations`, `listConversationsPage` (keyset pagination by `openedAt DESC, id DESC` with a `ConversationPageCursor`), `closeConversation`, `deleteConversation`, `appendMessage`, `readMessages`. Inputs: `OpenConversationInput`, `ListConversationsInput`, `ListConversationsPageInput`, `AppendMessageInput`, `ReadMessagesInput`; results: `Conversation`, `ConversationPage`, `ConversationMessage` (`MessageRole`: `user`, `agent`, `tool`, `system`).
  - **`RunSnapshotBinding`** — `write(RunSnapshotWriteInput)` and `read(tenantId, runId)` of the `RunSnapshotRecord` that `resumeAgentTurn` needs. Writes must be idempotent per run id.
  - **Postgres support** — Drizzle tables `agentConversations` and `agentRunSnapshots` with their row types (`AgentConversationRow`, `NewAgentConversationRow`, `AgentRunSnapshotRow`, `NewAgentRunSnapshotRow`), `AGENTS_TENANT_SCOPED_TABLES`, and the `{ v, doc }` JSONB envelope helpers `wrap`, `unwrap`, `unwrapOrThrow`, `CURRENT_AGENTS_PAYLOAD_VERSION` with `EnvelopeError`, `MalformedEnvelopeError`, `UnsupportedPayloadVersionError`.
  - **`@kindgi/agents/migrations`** — `AGENTS_MIGRATIONS_DIR`, the absolute path to the bundled SQL migrations, for a host's migration runner. It's a subpath of its own, kept out of the main entry: it resolves a folder on disk from its module's URL, which an app's bundler (Next.js) can't follow, and an app that imports `@kindgi/sdk/define` never needs it.
  - **`@kindgi/agents/render-worker`** — `createWorkerTemplateRenderer({ workers, maxOldSpaceMb? })`, a `WorkerTemplateRenderer` that renders turns' instructions in `workers` child processes, for a server that runs many tenants' agents.
    - A render past the bounds' `liquid.renderLimitMs`, plus `STOP_MARGIN_MS` (100 ms), has its worker stopped wherever the render is, and fails with the limit's message. A render past the worker's heap cap (`maxOldSpaceMb`, Node's `--max-old-space-size`) fails with the memory limit's message. A new worker takes the next render.
    - A child process, not a worker thread: a thread would share the server's heap, so a template that exhausts it would take the whole server down. The fork is explicit — the child gets an empty environment (never the server's database URLs, KMS settings or tokens), its flags are the heap cap alone (not an inherited `--inspect`), and no file descriptors beyond the IPC channel.
    - Each render gives what it gives in-process: the same output, or the same failure.
    - Waiting tenants take turns, and each render counts toward its tenant's render budget from when a worker takes it.
    - Make it after `configureTenantInputBounds`: its workers render under the bounds set then.
    - `close()` lets the renders it took finish, then stops the workers; a later render is refused (`RENDERER_CLOSED`). Idle workers don't keep the process running.
    - It's a subpath of its own, kept out of the main entry: it's for Node only, and it starts its workers from a file next to its module, which an app's bundler can't follow.
- **Errors** — **`AgentError`**: `InvalidAgentError`, `AgentNotFoundError`, `AgentAlreadyRegisteredError`, `AgentVersionMismatchError`, `ConversationNotFoundError`, `ConversationClosedError`, `InvalidMessageError`, `PersistenceError`. Every error carries a `code`.

## Example

```ts
import { defineAgent, invokeAgent } from '@kindgi/agents';
import type { InvokeAgentBindings } from '@kindgi/agents';
import type { ProjectId, TenantId } from '@kindgi/types';

const drafter = defineAgent({
  id: 'acme.contract-drafter',
  version: '1.0.0',
  name: 'Contract Drafter',
  instructions: 'You draft contract clauses for {{ firmName }}. Today is {{ today }}.',
  parameters: [{ name: 'firmName', type: 'string' }],
  capabilities: [{ needs: [{ feature: 'tool-use' }] }],
  tools: [
    { id: 'acme.clause-search', version: '^1.0.0' },
    { id: 'acme.send-email', version: '~2.1.0' },
  ],
  retrieval: [{ types: ['acme.clause'], scope: 'same-project', mode: 'keyword', limit: 5 }],
  guardrails: ['acme.no-pii'],
  conversationPolicy: {
    historyLimit: 20,
    hitl: { tools: { overrides: { 'acme.send-email': 'always_ask' } } },
  },
  budget: { maxSteps: 6, maxCostUsd: 0.25, maxWallMs: 60_000 },
});
if (drafter.kind === 'err') throw new Error(JSON.stringify(drafter.error.issues));
const agent = drafter.value;

// `bindings` come from the runtime that hosts the agent, or from your own implementations.
export async function firstTurn(
  bindings: InvokeAgentBindings,
  tenantId: TenantId,
  projectId: ProjectId,
  userMessage: string,
): Promise<string | undefined> {
  const conversation = await bindings.conversationBinding.openConversation({
    tenantId,
    agentId: agent.id,
    agentVersion: agent.version,
    title: 'NDA for globex',
    scope: { tenantId, projectId },
  });
  if (conversation.kind === 'err') throw new Error(conversation.error.message);

  const result = await invokeAgent(
    {
      tenantId,
      projectId,
      agent,
      conversationId: conversation.value.id,
      userMessage,
      parameters: { firmName: 'Acme LLP' },
    },
    {
      ...bindings,
      onEvent: (event) => {
        if (event.kind === 'tool.started') console.log(`calling ${event.toolId}@${event.toolVersion}`);
      },
    },
  );

  if (result.kind === 'err') {
    if (result.error.code === 'budget-exceeded') return `Stopped: ${result.error.kind} budget exceeded`;
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  if (result.value.status === 'suspended') return undefined; // waiting for a reviewer; see resumeAgentTurn
  const { content } = result.value.response;
  return typeof content === 'string' ? content : JSON.stringify(content);
}
```

## Non-goals

- **No storage or model access of its own.** Conversations, messages, run snapshots, memory, provenance, providers, tools, and flow execution all go through the bindings; the package ships Drizzle tables and migrations for Postgres implementations but never opens a database connection.
- **No tenancy in the agent registry.** `AgentRegistry` is a plain in-memory catalog; multi-tenant deployments keep one registry per tenant or layer isolation on top.
- **No moving a conversation to a new agent version.** A conversation stays pinned to the agent version it was opened with; invoking it with another version fails with `agent-version-mismatch`, and a closed conversation cannot be reopened.

## Related

- [`@kindgi/sdk`](../sdk/) — re-exports `defineAgent`, `Agent`, and `DefineAgentSpec` from `@kindgi/sdk/define`.
- [`@kindgi/capabilities`](../capabilities/) — capability declarations and the router that picks a model for each turn.
- [`@kindgi/tools`](../tools/) and [`@kindgi/guardrails`](../guardrails/) — tool and check definitions referenced by `tools` and `guardrails`.
- [`@kindgi/memory`](../memory/) and [`@kindgi/provenance`](../provenance/) — the memory binding used for retrieval, and the provenance record built for each turn.
- [`@kindgi/flow`](../flow/) and [`@kindgi/runtime`](../runtime/) — the flow model and the `RunBinding` that executes the agent-turn flow.
