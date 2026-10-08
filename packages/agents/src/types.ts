// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Capability } from '@kindgi/capabilities';
import type { Fact, MemoryScope } from '@kindgi/memory';
import type { ToolErrorsSpec, ToolHitlMode, ToolHitlRule } from '@kindgi/policy-contract';
import type { Brand, ConversationId, ProjectId, Semver, TenantId, Timestamp } from '@kindgi/types';

import type { AgentDerivation, AgentPins } from './pins.js';

/**
 * Branded agent id. Convention: dotted namespace under the tenant's
 * pack — e.g. `acme.citation-verifier`, `acme.drafting`.
 */
export type AgentId = Brand<string, 'AgentId'>;

/**
 * `ConversationId` lives in `@kindgi/types` (the single source of
 * truth for branded identifiers) and is re-exported here for
 * convenience; `@kindgi/types` (or `@kindgi/sdk/types`) is the
 * canonical import.
 */
export type { ConversationId };

/**
 * A single message inside a conversation. Persisted as a `Fact` in
 * the memory subsystem scoped to the conversation, so it inherits
 * retention + provenance + supersession from the fact substrate.
 *
 * The `role` discriminates who authored the message:
 *   - `user`      — end-user input to the agent.
 *   - `agent`     — the agent's assistant-role response.
 *   - `tool`      — a tool-call result (the tool's own output).
 *   - `system`    — a system-authored instruction (rare; e.g. HITL
 *                   intervention, out-of-band context injection).
 */
export type MessageRole = 'user' | 'agent' | 'tool' | 'system';

export interface ConversationMessage {
  /**
   * Monotonic index within the conversation. Assigned by the writer.
   * Combined with `conversationId` this gives a stable ordering
   * independent of clock skew.
   */
  readonly sequence: number;
  readonly role: MessageRole;
  /**
   * Free-form text OR structured content. `string` is the common case
   * (a chat message); `Record<string, unknown>` supports tool-result
   * shapes and multi-modal payloads without a v2 bump.
   */
  readonly content: string | Readonly<Record<string, unknown>>;
  /**
   * For `role: 'tool'` messages: the tool id and the invocation id
   * that produced this output. Enables provenance edges from the
   * originating agent turn to the tool's result.
   */
  readonly toolCall?: {
    readonly toolId: string;
    readonly invocationId: string;
  };
  /**
   * Attribution — user id, agent id, tool id, or system source. The
   * literal role-vs-actor split lets the same agent produce many
   * messages while the reviewer sees who was actually authoring.
   */
  readonly actor?: string;
  readonly createdAt: Timestamp;
}

/**
 * A named, typed input to an agent's instructions template. Every
 * `{{ var }}` referenced in `instructions` must correspond to either a
 * declared `PromptParameter` OR a framework-supplied auto-variable
 * (see `AUTO_INJECTED_VARS`).
 *
 * Types are declared so a UI can build a proper form for the caller
 * ("enter firm name", "pick jurisdiction").
 */
export interface PromptParameter {
  readonly name: string;
  readonly description?: string;
  readonly type: 'string' | 'number' | 'boolean' | 'date';
  /** Default true — omit to require the caller supply a value. */
  readonly required?: boolean;
  /** Default value used when the caller omits this parameter. */
  readonly default?: string | number | boolean;
}

/**
 * Declarative statement of what the agent retrieves before each turn.
 * Distinct from tool invocation — retrieval is background reading the
 * agent does silently to ground its response.
 *
 * Scope options, each within what the run may see (its project and org,
 * the user it acts for, its conversation and that conversation's end
 * user, and tenant-wide facts; never another conversation's or another
 * end user's):
 *   - `same-conversation`: this conversation's facts.
 *   - `same-project`:      the run's project's facts; none in a run
 *                          without a project.
 *   - `tenant`:            any fact of the declared type the run may see.
 */
export interface RetrievalIntent {
  readonly types: readonly string[];
  readonly scope: 'same-conversation' | 'same-project' | 'tenant';
  /** Cap on facts loaded per turn to keep the prompt small. Default 10. */
  readonly limit?: number;
  /** If `keyword` or `semantic`, biases which retrieval mode is used. */
  readonly mode?: 'keyword' | 'semantic' | 'both';
}

/**
 * Typed reference to a tool. Every agent tool binding is `{ id, version }`
 * — no bare-id "latest" shortcut. `version` is a semver **range**
 * (npm-style grammar), resolved at run start against the tenant's tool
 * registry via `semver.maxSatisfying`.
 *
 * Range examples:
 *   - `'1.2.3'`        — exact pin (matches only 1.2.3)
 *   - `'^1.2.3'`       — compatible-updates (>=1.2.3 <2.0.0)
 *   - `'~1.2.3'`       — patch-updates-only (>=1.2.3 <1.3.0)
 *   - `'>=1.0.0 <2.0.0'` — explicit range
 */
export interface ToolRef {
  readonly id: string;
  readonly version: string;
}

/**
 * A prompt block an agent's instructions come from: its id and a semver
 * range, resolved like a tool's (`pickVersion`) and pinned when the
 * agent version is published.
 */
export interface PromptRef {
  readonly prompt: string;
  readonly version: string;
}

/** A settings block an agent reads: its id and a semver range, pinned at publish. */
export interface BlockRef {
  readonly id: string;
  readonly version: string;
}

/**
 * Per-agent behavior for multi-turn conversations. The agent chooses:
 *   - How many prior messages to load (`historyLimit`; unset = all).
 *   - Whether to auto-close a conversation after a period of inactivity
 *     (`autoCloseAfterInactiveSeconds` — checked at read time; unset =
 *     never auto-close).
 *   - A turn count after which each new turn waits for HITL approval
 *     before it runs (`hitlAfterTurns`; `hitl.afterTurns` takes
 *     precedence when both are set).
 */
export interface ConversationPolicy {
  readonly historyLimit?: number;
  readonly autoCloseAfterInactiveSeconds?: number;
  readonly hitlAfterTurns?: number;
  /**
   * HITL policy: the session gate (`afterTurns`) and the tool-level
   * gates that decide whether each tool call inside a turn waits for
   * review before dispatch. Absent = no tool gates.
   */
  readonly hitl?: ConversationHitlPolicy;
}

/**
 * Tool-level HITL mode.
 *
 * - `never_ask`   — dispatch straight through, no gate. Read-only tools
 *   (`Tool.mutating: false`) get this default.
 * - `ask_on_first_use` — on the first call to `(toolId, hashOfArgs)`
 *   within a conversation, park + require approval. Approved decisions
 *   cache on the conversation so subsequent identical calls dispatch
 *   without re-parking. Mutating tools default to this.
 * - `always_ask`  — park + require approval on EVERY invocation. No
 *   caching. Highest friction; used for external-effect actions
 *   (email/payment/deploy) where every occurrence is a real event.
 */
/**
 * A tool's gate (`never_ask` | `ask_on_first_use` | `always_ask`), and a
 * per-tool rule — a mode plus the reviewer role its approvals need
 * (deployments that route "always-ask-financial-tools" through senior
 * reviewers use the rule; a mode alone routes through the agent's
 * `defaultReviewerRole`). Shared with the tenant `hitl` policy, so they
 * live in `@kindgi/policy-contract`.
 */
export type { ToolHitlMode, ToolHitlRule } from '@kindgi/policy-contract';

export interface ConversationHitlPolicy {
  /**
   * Session-turn count gate: once the conversation has this many
   * completed turns, each new turn waits for HITL approval before it
   * runs. Same meaning as `ConversationPolicy.hitlAfterTurns`; when both
   * are set, `hitl.afterTurns` wins. Absent in both = no session gate.
   */
  readonly afterTurns?: number;
  /**
   * Tool-level policy. Applies to every tool call inside the turn
   * unless the `tools.overrides` map has a specific rule.
   */
  readonly tools?: {
    /**
     * Mode for every tool without an entry in `overrides`. When absent,
     * the framework falls back to a per-tool default: read-only tools
     * (`mutating: false`) → `never_ask`, other tools →
     * `ask_on_first_use`.
     */
    readonly default?: ToolHitlMode;
    /**
     * Explicit overrides keyed by ToolId. A string value is shorthand
     * for `{ mode: <string> }` — the required-role stays the agent
     * default.
     */
    readonly overrides?: Readonly<Record<string, ToolHitlMode | ToolHitlRule>>;
  };
  /**
   * Reviewer role assigned to approvals materialized by tool + session
   * gates. Absent = `'standard'`.
   */
  readonly defaultReviewerRole?: 'standard' | 'senior' | 'admin';
  /**
   * Timeout the approval carries at enqueue time. Absent = the
   * framework default (24h). A tenant policy's `maxTimeoutMs` caps it
   * (see `resolveEffectiveHitlPolicy`).
   */
  readonly timeoutMs?: number;
  /**
   * What happens when an approval's time runs out: it escalates one
   * reviewer tier, and at `admin` it expires (the turn fails with
   * `hitl-cancelled`). `'escalate'` is the only behavior today, and the
   * default; `'auto-approve'` and `'auto-reject'` are refused rather than
   * accepted and ignored.
   */
  readonly onTimeout?: 'escalate';
}

/**
 * Budgets guard a single agent turn. Every field is optional; unset
 * fields take the defaults below or have no cap. Steps and cost are
 * enforced by the turn's `budget-check` step; wall-clock time by a
 * timer in `invokeAgent`.
 */
export interface TurnBudget {
  /** Maximum model→tool→model iterations per turn. Default 8. */
  readonly maxSteps?: number;
  /** Maximum USD spend per turn, summed over the turn's model calls. */
  readonly maxCostUsd?: number;
  /** Wall-clock cap in ms. Default 120_000 (2 min). */
  readonly maxWallMs?: number;
}

/**
 * A typed result for an agent turn: the agent's final answer must be
 * JSON matching `schema`. When it doesn't parse or doesn't match, the
 * turn tells the model what was wrong and asks again, up to
 * `maxRepairs` times; after that the turn fails with
 * `output-schema-violation`. The parsed value is
 * `AgentTurnResult.output`.
 */
export interface AgentOutputSpec {
  /** JSON Schema (draft 2020-12) the final answer must match. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** A name for the output (shown to the model and in errors). Default `'output'`. */
  readonly name?: string;
  /** How many times the model is asked to repair an invalid answer. Default 1. */
  readonly maxRepairs?: number;
}

/**
 * An agent definition. Declarative: no runtime state, no closures. The
 * same definition can be serialized, versioned, and reloaded — every
 * field is either a primitive or a reference to a registered
 * substrate object (tool id, guardrail id, capability declaration).
 *
 * The `version` field is authoritative for the agent's identity — an
 * agent at a different version is a different agent for provenance
 * and audit purposes. Callers pin agents by `{ id, version }` the way
 * kernel runs pin flows.
 */
export interface Agent {
  /**
   * Globally-unique agent identifier. Convention:
   * `<pack-id>.<agent-name>` (kebab-case, dot-namespaced). See the
   * `AgentId` brand for the naming rule.
   */
  readonly id: AgentId;
  /**
   * Semver — REQUIRED. Distinct from tools' `version` in that agents
   * are versioned per-tenant (rotate + rollout independently of tool
   * versions). `agent_conversations.agentVersion` pins each thread to
   * a specific version; resume-across-version bumps rejects with
   * `agent-version-mismatch`.
   */
  readonly version: Semver;
  /**
   * Human-readable name shown in UI. Doesn't affect execution.
   */
  readonly name: string;
  /**
   * Optional prose describing what the agent does. Shows up in the
   * agent catalog and in provenance metadata.
   */
  readonly description?: string;
  /**
   * System prompt rendered at the top of every turn. LiquidJS template
   * syntax: `{{ variable }}` for substitution, `{% if %}` / `{% for %}`
   * for control flow, filters via `{{ value | filter }}`. Every
   * referenced variable must be either a declared `PromptParameter`
   * or a framework-supplied auto-var (see `AUTO_INJECTED_VARS`).
   *
   * Templates are rendered with `strictVariables: true` — an
   * unresolved reference fails the turn at invoke time
   * (`model-invocation-failed` whose `cause` is the `missing-parameter`
   * render error), never a silent empty string.
   *
   * Or a prompt block, by range (`{ prompt: 'acme.intake-prompt',
   * version: '^1.0.0' }`): its template renders here instead, with the
   * parameters it declares, and the version that runs is pinned when the
   * agent version is published (`pins.prompts`).
   */
  readonly instructions: string | PromptRef;
  /**
   * Typed parameters the caller supplies at invoke time. The UI reads
   * this to build a "configure agent" form; the runtime validates each
   * required parameter is provided before the model call.
   *
   * Framework auto-vars (`today`, `now`, `agent.*`, `conversation.*`)
   * do not need to be declared here — they're supplied by the runtime.
   */
  readonly parameters?: readonly PromptParameter[];
  /**
   * Capability declarations the agent needs at runtime. Each entry is
   * a separate resource-kind request (LLM inference, embedding, ...,
   * distinguished by `Capability.kind`). The router picks providers at
   * turn time; the agent definition doesn't hard-bind.
   *
   * The agent turn routes the first entry to pick its model; further
   * entries are part of the definition but are not routed by the turn.
   */
  readonly capabilities: readonly Capability[];
  /**
   * Typed tool references. Each entry declares the tool id AND the
   * semver range (or exact pin) the agent expects to invoke — the
   * dispatch resolver uses `semver.maxSatisfying` to pick the highest
   * active version matching the range at run start. Follows the
   * "docker-tag pin vs latest" discipline npm/docker take: no implicit
   * `:latest`, ever.
   *
   * `version` is a semver **range** in the wire shape:
   * `'1.2.3'` = exact pin, `'^1.2.3'` = compatible-updates, `'~1.2.3'`
   * = patch-updates-only, `'>=1.0.0 <2.0.0'` = explicit range. Full
   * npm-compatible grammar (grammar handled by the `semver` library
   * in the resolver — validation of the range shape lives there).
   *
   * An empty list means the agent is chat-only.
   */
  readonly tools: readonly ToolRef[];
  /**
   * Fact-retrieval intents. Zero or more; each triggers an independent
   * retrieval pass before the model call.
   */
  readonly retrieval: readonly RetrievalIntent[];
  /**
   * Guardrail ids the agent is subject to. Resolved at turn start
   * against the guardrail definitions bound for the run
   * (`GuardrailsBindings.guardrails`, evaluated through its `checks`
   * registry from `@kindgi/guardrails`); an unknown id fails the turn
   * with `unresolved-guardrail`. Evaluated once per turn, on the final
   * response before it is stored.
   */
  readonly guardrails: readonly string[];
  /**
   * Preferred model provider by id. Soft hint — the router prefers
   * this provider when it satisfies the agent's `capabilities.needs`,
   * falling back to normal capability-based selection when the
   * preferred provider is unregistered or filtered out by tenant
   * policy. Enables A/B'ing agents across providers without
   * churning provider registrations: register several, pin the agent
   * to the one you want to test.
   *
   * The value is a `ProviderMetadata.id` string (e.g. `'anthropic'`).
   * Use in combination with `preferredModel` for `(provider, model)`
   * tuple pinning. Unset = capability-match only.
   */
  readonly preferredProvider?: string;
  /**
   * Preferred model NAME within the selected provider. Soft hint —
   * the router prefers `(provider, model)` tuples matching this
   * name, falling back to capability-based ranking when no tuple
   * matches. Combined semantics with `preferredProvider`:
   *
   *   - Both set → promote the exact `(provider, model)` tuple.
   *   - Only `preferredModel` set → promote any provider exposing
   *     that model.
   *   - Only `preferredProvider` set → any model of that provider is
   *     promoted.
   *
   * The value is a `ModelInfo.name` string (e.g. `'claude-sonnet-4-6'`).
   * Enables model-level A/B'ing under one connection: register
   * Anthropic once with `models: [sonnet, opus, haiku]`, then pin
   * per-agent.
   */
  readonly preferredModel?: string;
  /**
   * Multi-turn behavior. Optional — when unset, each turn loads the
   * full conversation history and no HITL gates apply.
   */
  readonly conversationPolicy?: ConversationPolicy;
  /**
   * Per-turn budget. Enforced by `invokeAgent`. Missing fields default
   * (see `TurnBudget`).
   */
  readonly budget?: TurnBudget;
  /**
   * Free-form tags for filtering in the agent catalog (UI + admin).
   * Not consumed by execution.
   */
  readonly tags?: readonly string[];
  /**
   * A typed result: the final answer is JSON matching this schema,
   * validated (and repaired, see `AgentOutputSpec`) before the turn
   * completes. Absent = the answer is free text.
   */
  readonly output?: AgentOutputSpec;
  /**
   * What the turn does when a tool call fails: the failure goes back to
   * the model as the call's result, so it can correct the call, up to
   * `maxRetries` times per turn, for the kinds in `retryOn`. Default:
   * one retry, for `invalid-arguments` and `unknown-tool` (nothing ran).
   * A tenant's `tool-errors` policy can lower it. See `ToolErrorsSpec`.
   */
  readonly toolErrors?: ToolErrorsSpec;
  /**
   * The exact block versions this agent version runs, resolved by the
   * runtime when the version was published (see `AgentPins`). Never
   * authored: `defineAgent` doesn't take it. Absent on an agent defined
   * in code and on a version published before pins existed; its tool
   * ranges then resolve per run.
   */
  readonly pins?: AgentPins;
  /**
   * Settings blocks the agent reads, by range. Each block's values reach
   * its tools as `ToolContext.settings[<block id>]` and its templates as
   * `settings.<block id>.<key>`; the versions are pinned at publish
   * (`pins.settings`).
   */
  readonly settings?: readonly BlockRef[];
  /**
   * A settings block of model settings (`MODEL_SETTINGS_SCHEMA`:
   * `temperature`, `maxOutputTokens`) the turn's model calls use. Pinned
   * at publish with the other settings.
   */
  readonly modelSettings?: BlockRef;
  /** `pinsDigest(pins)`, recorded when the version was published. */
  readonly pinsDigest?: string;
  /**
   * Set by the runtime on a version it registered under another number
   * than the definition's, when a deploy couldn't register that number
   * as it was (see `AgentDerivation`). Never authored.
   */
  readonly derivedFrom?: AgentDerivation;
}

/**
 * A conversation record (the `agent_conversations` table in this
 * package's Postgres schema). Messages are stored separately, as memory
 * facts scoped to this conversation's id.
 */
export interface Conversation {
  readonly id: ConversationId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly agentVersion: Semver;
  /**
   * Auto-generated on first turn or explicitly set. Shown in the UI
   * conversation list.
   */
  readonly title: string;
  /** UUID or free-form identifier for the human participant. */
  readonly participantId?: string;
  /**
   * The project the conversation is in, set when it is opened (by a run,
   * from the run's project). Absent on conversations opened without one,
   * and on those from before it was stored.
   */
  readonly projectId?: ProjectId;
  /** Additional attributes (project id, matter id, etc.). */
  readonly scope: MemoryScope;
  readonly openedAt: Timestamp;
  /** Set when the conversation is closed. Reopening is not supported. */
  readonly closedAt?: Timestamp;
  /**
   * Denormalized turn counter — one +1 per completed agent turn.
   * Incremented by the conversation binding when a turn's final
   * (non-intermediate) agent message is appended.
   */
  readonly turnCount: number;
  readonly lastMessageAt?: Timestamp;
  /**
   * Free-form metadata. Persisted via the versioning envelope, so a
   * schema change can be migrated on read.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Optional bindings for agent operations. Not read by `invokeAgent`,
 * which takes `InvokeAgentBindings`.
 */
export interface AgentBindings {
  /** A retrieval-policy registry from the memory implementation (untyped here). */
  readonly memoryPolicyRegistry?: unknown;
}

/** A retrieved fact + the retrieval intent that pulled it. */
export interface RetrievedFact {
  readonly fact: Fact<unknown>;
  readonly intent: RetrievalIntent;
  /** Similarity or keyword-rank score, if the retrieval mode produced one. */
  readonly score?: number;
}
