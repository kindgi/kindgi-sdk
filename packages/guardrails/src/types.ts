// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  Capability,
  ModelProvider,
  ProviderRegistry,
  TenantPolicy,
  UsageSink,
} from '@kindgi/capabilities';
import type { ComplianceProvider } from '@kindgi/compliance';
import type {
  AgentId,
  FlowId,
  GuardrailId,
  OrgId,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  ToolId,
} from '@kindgi/types';
import type { GuardrailConfigProblem } from './config-problems.js';

/**
 * How a guardrail is checked. Open string — the engine dispatches
 * on this value through an `ExecutionStrategyRegistry`. Built-in kinds
 * are `'zero-llm' | 'llm-judge' | 'external'` (see
 * `execution-strategy.ts`). Adapter packages register strategies for
 * their own kinds without touching the engine — e.g. `'sandbox-code'`.
 *
 * The `BUILT_IN_GUARDRAIL_KINDS` constant enumerates the well-known values
 * (the schema lists them as `examples`); the schema accepts any non-empty
 * kind. `defineGuardrail` still requires a registered check of the same
 * kind, and runtime dispatch uses the registered strategies, not this
 * union.
 */
export type GuardrailKind = string;

export const BUILT_IN_GUARDRAIL_KINDS = ['zero-llm', 'llm-judge', 'external'] as const;
export type BuiltInGuardrailKind = (typeof BUILT_IN_GUARDRAIL_KINDS)[number];

export type GuardrailSeverity = 'info' | 'warn' | 'error' | 'critical';

/**
 * Actions the engine surfaces when a check fails. Open string — the
 * caller (e.g. the agent runtime) matches on this to decide behavior,
 * and an optional `ActionHandlerRegistry` (see `action-handler.ts`)
 * lets adapters register new actions like `'hitl-review'` or
 * `'redact-then-continue'`. Any non-empty name is accepted when the
 * guardrail is defined; with `EvaluationBindings.actions` set, a name
 * with no registered handler fails with `unknown-action` when the
 * guardrail fires.
 */
export type OnViolation = string;

export const BUILT_IN_ON_VIOLATIONS = [
  'halt',
  'retry',
  'escalate',
  'log-only',
  'compensate',
] as const;
export type BuiltInOnViolation = (typeof BUILT_IN_ON_VIOLATIONS)[number];

export type ScopeWhen = 'always' | 'ci-only' | 'runtime-only';

export interface Action {
  readonly 'on-violation': OnViolation;
  readonly retry?: { readonly maxAttempts: number };
  readonly escalateTo?: string;
  readonly compensateWith?: string;
}

export interface Scope {
  readonly when?: ScopeWhen;
  readonly agents?: readonly AgentId[];
  readonly flows?: readonly FlowId[];
  readonly tenants?: readonly TenantId[];
}

export interface Budget {
  readonly maxCostUsd?: number;
  readonly maxLatencyMs?: number;
}

/**
 * Isolation posture the runtime enforces around a check's handler. Same
 * three tiers as `ToolManifest.sandbox` in `@kindgi/tools`.
 *
 * Duplicated here rather than imported from `@kindgi/tools` to keep
 * this package free of a tools dependency. Keep the shape literally
 * identical.
 */
export type SandboxMode = 'none' | 'context-isolated' | 'strict';

/** Runtime resource caps enforced by the sandbox layer at check dispatch. */
export interface RuntimeLimits {
  readonly memMB: number;
  readonly cpuMs: number;
}

/** Network egress policy honored by the sandbox during a check. */
export type NetworkPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'allowlist'; readonly hosts: readonly string[] }
  | { readonly kind: 'unrestricted' };

/**
 * JSON Schema for a typed `needs` slot. Author-time Zod is compiled to
 * this at build (`z.toJSONSchema()`).
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Discriminated typed-dependency declarations mirroring the Tool
 * manifest's `TypedNeeds` shape (five slots); every slot is optional.
 */
export interface TypedNeeds {
  readonly env?: Readonly<Record<string, JsonSchema>>;
  readonly secrets?: Readonly<Record<string, JsonSchema>>;
  readonly config?: Readonly<Record<string, JsonSchema>>;
  readonly capabilities?: readonly string[];
  readonly bindings?: readonly string[];
}

/**
 * Handler-artifact pointer for the guardrail's CHECK implementation.
 * Same shape as Tool's `CodeArtifactRef` — discriminated on `kind`:
 *
 * - `'oci'`         — production. Populated by the deploy pipeline.
 *                     `modulePath` resolves inside the pinned
 *                     `imageRef`; `artifactVersion` pins one deploy.
 * - `'filesystem'`  — dev-mode. Populated at dev-mode registration.
 *                     `modulePath` is an absolute host path at the
 *                     check module. Production servers SHOULD reject
 *                     this variant.
 *
 * NOTE: `modulePath` points at the check handler bundle (the pack
 * index's `checkModulePath`, see `@kindgi/handler-runtime`); the field
 * name stays `modulePath` for wire symmetry with tools.
 */
export type CodeArtifactRef =
  | {
      readonly kind: 'oci';
      readonly imageRef: string;
      readonly modulePath: string;
      readonly artifactVersion: string;
    }
  | {
      readonly kind: 'filesystem';
      readonly modulePath: string;
    };

/**
 * A guardrail declaration. Same shape at runtime + in CI — one definition,
 * two enforcement paths.
 *
 * `check` references a concrete check implementation:
 *   - For `zero-llm`: id of a check in the CheckRegistry (built-in or custom).
 *   - For `llm-judge`: id of a registered check of kind `llm-judge`
 *     (`defineGuardrail` resolves it); the judge itself is configured by
 *     `config` (`LlmJudgeConfig`) + `judgeCapabilities`.
 *   - For `external` and adapter kinds: an id the kind's strategy understands.
 *
 * `config` is check-specific — the check implementation validates it.
 *
 * ## Additive extensions
 *
 * `sandbox`, `limits`, `network`, `needsSpec`, `codeArtifactRef` are the
 * same runtime-declaration extensions that ToolManifest carries.
 * Guardrails are code-carrying primitives too (a check ships as a
 * bundle at `checkModulePath` + `node_modules`), so every field applies
 * as-is — none are excluded. The dispatch, SDK and deploy layers
 * populate + honor them; consumers that don't know about them ignore the fields.
 */
export interface Guardrail {
  /**
   * Globally-unique guardrail identifier. Convention:
   * `<pack-id>.<guardrail-name>` (kebab-case, dot-namespaced). See the
   * `GuardrailId` brand for the naming rule.
   */
  readonly id: GuardrailId;
  /** Short human-readable label shown in violation UI + audit logs. */
  readonly name?: string;
  /** Prose describing what the guardrail guarantees + what happens on violation. Surfaced to reviewers when the guardrail fires. */
  readonly description?: string;
  /**
   * `'zero-llm'` — pure function over the trace (default, fast,
   * deterministic; the recommended kind for most safety rules).
   * `'llm-judge'` — uses a model to score (opt-in, costs money;
   * declare `budget` + `judgeCapabilities`). `'external'` — evaluated
   * outside the engine by a caller-registered strategy (the built-in
   * `external` strategy returns an `invalid-guardrail` error).
   */
  readonly kind: GuardrailKind;
  /**
   * Reference to the concrete check implementation. String id of a
   * `RegisteredCheck` in the runtime `CheckRegistry` — either a
   * built-in from `@kindgi/guardrails` (`BUILT_IN_CHECK_IDS`: `must-cite`,
   * `never-call-tool`, `max-tool-calls`, `output-matches`, `tool-order`,
   * `required-substring`, `forbidden-substring`) or a pack-authored
   * check registered under its id (see `defineCheck`).
   */
  readonly check: string;
  /**
   * Check-specific configuration. Interpreted by the check
   * implementation (validated by the check's `validateConfig`, e.g.
   * derived from its `configSchema`, when `defineGuardrail` runs).
   * Shape is opaque to the engine; e.g. `must-cite` reads
   * `{minCitations?: number}`, `output-matches` reads `{pattern: string}`.
   */
  readonly config?: Readonly<Record<string, unknown>>;
  /**
   * What the framework does when this guardrail fires — `halt`
   * (fail the run), `retry` (re-execute the step with a
   * `maxAttempts` cap), `escalate` (route to HITL review),
   * `log-only` (record but don't block), `compensate` (invoke a
   * named compensation tool). `BUILT_IN_ON_VIOLATIONS` lists the
   * built-in values; `OnViolation` itself is an open string.
   */
  readonly action: Action;
  /**
   * `'info'` / `'warn'` / `'error'` / `'critical'` — orthogonal to
   * `action`. Severity is what LOGS + DASHBOARDS group by; action is
   * what EXECUTION does. A `log-only` guardrail can still be
   * `'critical'` — just doesn't halt.
   */
  readonly severity?: GuardrailSeverity;
  /**
   * When this guardrail applies. `{when: 'always'}` fires everywhere;
   * `{when: 'ci-only'}` blocks CI but not runtime; `{when: 'runtime-only'}`
   * enforces at runtime but not CI. Per-agent / per-flow selectors
   * narrow further (e.g. `{agents: ['acme.support-agent']}`).
   */
  readonly scope?: Scope;
  /**
   * Cost + latency ceiling per guardrail invocation (relevant for
   * `kind: 'llm-judge'` — zero-llm checks are free): `maxCostUsd` +
   * `maxLatencyMs`. Declarative — not enforced by the runtime.
   */
  readonly budget?: Budget;
  /**
   * For `kind: 'llm-judge'` — capability declaration for the judge
   * model, routed through `@kindgi/capabilities` under the tenant policy
   * the caller passes as `EvaluationBindings.tenantPolicy`. Enables BYO
   * judges. Ignored for zero-llm + external.
   */
  readonly judgeCapabilities?: Capability;
  /** Isolation posture — see `SandboxMode`. */
  readonly sandbox?: SandboxMode;
  /** Memory + CPU caps enforced by the sandbox at check dispatch. */
  readonly limits?: RuntimeLimits;
  /** Network egress policy the sandbox honors while the check runs. */
  readonly network?: NetworkPolicy;
  /**
   * Discriminated typed-dependency declarations (env / secrets / config /
   * capabilities / bindings). See `TypedNeeds` for the shape.
   */
  readonly needsSpec?: TypedNeeds;
  /**
   * Pointer at the deploy-time OCI image + module path carrying the
   * check handler bytes. Absent for in-process declarations.
   */
  readonly codeArtifactRef?: CodeArtifactRef;
  /**
   * JSON Schema of the check's `config`, for a check that is pack code:
   * the pack index's `configSchema`, kept by a deployment on the
   * guardrails it registers. A runtime checks any guardrail naming this
   * check against it at registration (`guardrailConfigProblems`), as the
   * pack service does on every call.
   */
  readonly configSchema?: Readonly<Record<string, unknown>>;
}

/**
 * Recorded events from a run that checks operate on. Callers materialize
 * these from the run's recorded events, memory and provenance —
 * guardrails doesn't read those directly (avoids a hard dep loop; keeps
 * checks pure).
 */
export interface ToolCallRecord {
  readonly toolId: ToolId;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly at: Timestamp;
}

export interface ToolResultRecord {
  readonly toolCallId: string;
  readonly output: unknown;
  readonly at: Timestamp;
}

export interface ModelCallRecord {
  readonly providerId: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly at: Timestamp;
}

/**
 * The materialised run trace a check reads. Callers assemble this at the
 * boundary from the run's events / memory / provenance — the check
 * itself is a pure function over this shape.
 *
 * Adapter checks that need data not typed here use
 * `attributes: Record<string, unknown>` as the escape hatch.
 */
export interface RunTrace {
  readonly runId: RunId;
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. Threaded to
   * `bindings.compliance.emit()` when a violation surfaces so
   * evidence records land under the same project as the run.
   * Optional; when absent, the violation emit is skipped.
   */
  readonly projectId?: ProjectId;
  /**
   * The org of that project, when it belongs to one: resolved by the
   * runtime from the project, never from input. Absent when the project
   * has no org.
   */
  readonly orgId?: OrgId;
  readonly agentId?: AgentId;
  readonly flowId?: FlowId;
  /** Final assistant output text. Present when the run produced text. */
  readonly output?: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly toolResults: readonly ToolResultRecord[];
  readonly modelCalls: readonly ModelCallRecord[];
  /**
   * The user input that opened the turn / flow invocation. Populated
   * by the agent runtime (`@kindgi/agents`); optional for runs that
   * have no user turn.
   */
  readonly userInput?: string;
  /**
   * Facts pulled by the agent's retrieval intents before the model
   * call. Enables consistency guardrails (e.g. "every citation in
   * output appears in retrieved.factIds").
   */
  readonly retrievedFactIds?: readonly string[];
  /**
   * Conversation id for multi-turn context. Undefined for one-shot
   * runs that don't belong to a conversation.
   */
  readonly conversationId?: string;
  /**
   * 1-indexed turn number within the conversation. Undefined outside
   * agent conversations.
   */
  readonly turnNumber?: number;
  /** Cumulative USD cost for the turn / run. */
  readonly totalCostUsd?: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs?: number;
  /**
   * Whether this evaluation is happening in CI or at runtime. Determines
   * which `scope.when` values apply.
   */
  readonly mode: 'ci' | 'runtime';
  /** Free-form attributes checks may consult. Use for niche data not typed above. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Runtime bindings passed alongside the RunTrace so llm-judge guardrails
 * can invoke a model and any guardrail can emit compliance evidence.
 *
 * All fields optional — a `zero-llm` guardrail needs none of them. Callers
 * wire up only what they actually use.
 */
export interface EvaluationBindings {
  /** Required for `kind: 'llm-judge'` guardrails — resolves + invokes the judge. */
  readonly providerRegistry?: ProviderRegistry;
  /**
   * Aborted when the caller stops waiting: the agent turn was
   * cancelled, or ran past its wall-clock budget. A check that calls out
   * (a judge model, a service) passes it on, so a slow call doesn't
   * hold the turn; the llm-judge strategy passes it to the model call.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Optional — when present and the trace carries a `projectId`, every
   * failed check emits a `guardrail-violation` compliance evidence
   * record (passing checks emit nothing).
   */
  readonly compliance?: ComplianceProvider;
  /**
   * Override the judge model directly (bypasses the router). Useful for
   * tests + hermetic pinning; production should route through the registry.
   */
  readonly judgeProvider?: ModelProvider;
  /**
   * Where llm-judge guardrails record their model calls (the runtime's
   * cost ledger), with the run's identity from the trace, before the
   * judgment is used. Absent: judge calls aren't recorded.
   */
  readonly usage?: UsageSink;
  /**
   * The tenant's model-routing policy (provider / model allow and deny
   * lists, `regionAllow`, caps). When present, llm-judge models are
   * routed under it, and an explicit `judgeProvider` must satisfy it too
   * — a judge never sends the run to a model the tenant doesn't allow.
   */
  readonly tenantPolicy?: TenantPolicy;
  /**
   * Optional execution-strategy registry. When present, the engine
   * dispatches `guardrail.kind` through this registry instead of the
   * built-in strategies (zero-llm / llm-judge / external). Callers extend
   * by seeding built-ins + adapter strategies. See execution-strategy.ts.
   */
  readonly strategies?: import('./execution-strategy.js').ExecutionStrategyRegistry;
  /**
   * Optional action-handler registry. When present, the engine invokes
   * the appropriate handler after evaluating each guardrail so custom
   * actions (`'hitl-review'`, `'redact-then-continue'`, etc.) fire.
   * Absent → the engine records the action in EvaluationResult but does
   * not invoke a handler; the caller layer consults the action.
   */
  readonly actions?: import('./action-handler.js').ActionHandlerRegistry;
}

/** Result of a single check evaluation. */
export interface CheckResult {
  readonly passed: boolean;
  readonly reason?: string;
  /** For llm-judge checks: the raw response text from the judge. */
  readonly judgeResponse?: string;
  /** Structured attributes attached to the result (evidence + logs). */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Result of evaluating a guardrail against a trace, including action to take. */
export interface EvaluationResult {
  readonly guardrailId: GuardrailId;
  readonly result: CheckResult;
  /** The action the caller should apply — pre-computed from `guardrail.action`. */
  readonly action: OnViolation | 'noop';
  readonly severity: GuardrailSeverity;
  readonly at: Timestamp;
}

/**
 * The signature checks implement. Pure function — same input yields same
 * result. LLM-judge implementations are async and take bindings for
 * capability routing.
 */
export type CheckFunction = (
  config: Readonly<Record<string, unknown>>,
  trace: RunTrace,
  bindings: EvaluationBindings,
) => Promise<CheckResult>;

/**
 * A registered check — has an id + optional config validator + evaluator.
 * Config validation runs when the guardrail is defined; the evaluator
 * runs at check time.
 */
export interface RegisteredCheck {
  readonly id: string;
  readonly kind: GuardrailKind;
  readonly evaluate: CheckFunction;
  readonly validateConfig?: (config: unknown) => string | undefined;
  /** The check's config as JSON Schema (Draft 2020-12), when it publishes one (the built-ins do). */
  readonly configSchema?: Readonly<Record<string, unknown>>;
  /**
   * Every way a guardrail's `config` doesn't fit this check, as an API answer's issues (paths
   * under `/config`): what registration refuses up front. `validateConfig` words the first.
   */
  readonly configProblems?: (config: unknown) => readonly GuardrailConfigProblem[];
}

/**
 * Registry mapping check id → implementation. Built-in checks are
 * pre-populated; consumers can register custom checks at pack init.
 */
export interface CheckRegistry {
  register(check: RegisteredCheck): void;
  get(id: string): RegisteredCheck | undefined;
  list(): readonly RegisteredCheck[];
}
