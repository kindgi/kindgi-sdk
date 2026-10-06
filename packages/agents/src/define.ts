// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ToolErrorsSpec, validateToolErrorsSpec } from '@kindgi/policy-contract';
import {
  type AnySchema,
  compileInlineSchema,
  isZodSchema,
  loadZodConverterSync,
  toJSONSchemaSync,
} from '@kindgi/schema';
import { pickVersion } from '@kindgi/tools';
import type { Result, Semver } from '@kindgi/types';

import type { InvalidAgentError } from './errors.js';
import type {
  Agent,
  AgentId,
  AgentOutputSpec,
  BlockRef,
  ConversationPolicy,
  PromptParameter,
  PromptRef,
  RetrievalIntent,
  ToolRef,
  TurnBudget,
} from './types.js';

type Issue = { path: string; message: string };

/**
 * Public API to construct an agent definition. Validates every field,
 * brands ids, and returns a `Result` — no throws.
 *
 * ```ts
 * const agent = defineAgent({
 *   id: 'acme.citation-verifier',
 *   version: '1.0.0',
 *   name: 'Citation Verifier',
 *   instructions: 'Verify every citation against the case-law index.',
 *   capabilities: [{ needs: [{ feature: 'structured-output' }] }],
 *   tools: [{ id: 'acme.verify-citation', version: '1.0.0' }],
 *   retrieval: [{ types: ['prior-verification'], scope: 'same-project' }],
 *   guardrails: ['no-hallucinated-citations'],
 * });
 * if (agent.kind === 'err') throw new Error(agent.error.message);
 * registry.register(agent.value);
 * ```
 */
export function defineAgent(spec: DefineAgentSpec): Result<Agent, InvalidAgentError> {
  const issues: Issue[] = [
    ...validateIdentity(spec),
    ...validateContent(spec),
    ...validateBlockRefs(spec),
    ...validateArrays(spec),
    ...validateRetrieval(spec),
    ...validatePromptParameters(spec.parameters),
    ...validateBudget(spec.budget),
    ...validateConversationPolicy(spec.conversationPolicy),
    ...validateToolErrors(spec.toolErrors),
  ];
  const output = resolveOutput(spec.output);
  if (output.kind === 'err') issues.push(...output.issues);

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-agent',
        message: `Agent "${String(spec.id)}" is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
        issues,
      },
    };
  }

  return {
    kind: 'ok',
    value: buildAgent(spec, output.kind === 'ok' ? output.value : undefined),
  };
}

/**
 * Author-facing input shape for `defineAgent`. `id` and `version` are
 * strings (they get branded inside `defineAgent`); array fields are
 * `readonly` so callers can pass literal arrays.
 *
 * ## Field-by-field authoring guide
 *
 * The most common author mistake is treating `tools` as a list of
 * tool ids (strings). It is NOT — it is a list of `{id, version}`
 * refs where `version` is an npm-style semver RANGE (`'^1.0.0'`,
 * `'~1.2.3'`, `'1.0.0'`, `'>=1.0.0 <2.0.0'`). Resolution happens at
 * run start via `semver.maxSatisfying`.
 *
 * @example
 * ```ts
 * const agent = defineAgent({
 *   id: 'my-pack.summarizer',
 *   version: '1.0.0',
 *   name: 'Summarizer',
 *   instructions: 'Summarize the user message in one sentence.',
 *   capabilities: [{ needs: [{ feature: 'tool-use' }] }],
 *   tools: [
 *     { id: 'my-pack.fetch-doc', version: '^0.1.0' },
 *   ],
 *   retrieval: [],
 *   guardrails: [],
 *   budget: { maxSteps: 6, maxCostUsd: 0.1, maxWallMs: 30_000 },
 * });
 * ```
 */
export interface DefineAgentSpec {
  /**
   * Business identifier. Convention: `<pack-id>.<agent-name>` (e.g.
   * `'acme.contract-reviewer'`). Non-empty. Gets branded as
   * `AgentId` inside `defineAgent`.
   */
  readonly id: string;
  /**
   * Exact semver of THIS agent revision (e.g. `'1.0.0'`,
   * `'0.2.1-alpha.3'`). Distinct from tool version RANGES on
   * `tools[]`. Every publish under the same id must bump this.
   */
  readonly version: string;
  /** Human-readable name for UI and logs. */
  readonly name: string;
  /** Optional longer description shown in catalogs / admin surfaces. */
  readonly description?: string;
  /**
   * The system prompt. Sent to the model with every turn as the
   * baseline instructions. Load-bearing — this is where you shape
   * the agent's behavior (persona, output format, tool-use policy).
   *
   * Or a prompt block by range (`{ prompt: 'acme.intake-prompt',
   * version: '^1.0.0' }`), whose template and parameters are used
   * instead; then `parameters` stays unset (the block declares them).
   */
  readonly instructions: string | PromptRef;
  /** Settings blocks the agent reads, by range (see `Agent.settings`). */
  readonly settings?: readonly BlockRef[];
  /** A model-settings block, by range (see `Agent.modelSettings`). */
  readonly modelSettings?: BlockRef;
  /**
   * Required capabilities the agent needs from a `ModelProvider`.
   * Typically one entry: `[{ needs: [{ feature: 'tool-use' }] }]`
   * for a tool-calling agent, `[{ needs: [{ feature: 'structured-output' }] }]`
   * for an agent that returns schema-constrained JSON. The router uses
   * the first entry to pick a compatible provider from the tenant's
   * `ProviderRegistry`.
   */
  readonly capabilities: Agent['capabilities'];
  /**
   * Tools the agent may call. **NOT** a list of tool ids —
   * a list of `{id, version}` refs where `version` is an npm-style
   * semver range. At run start, each ref resolves against the
   * registered versions via `semver.maxSatisfying`; unresolvable
   * refs fail the turn with `tool-version-unresolvable`.
   *
   * The model sees each tool's `id`, `description`, and input
   * schema — write tool descriptions carefully (that's what the
   * LLM reads to decide when to call).
   */
  readonly tools: readonly ToolRef[];
  /**
   * Retrieval intents the agent runs BEFORE calling the model.
   * Each intent names fact types, a scope, and a retrieval mode; the
   * results are injected into the model input as retrieved
   * context. Empty array `[]` = no retrieval, model sees only the
   * conversation history + user message.
   */
  readonly retrieval: readonly RetrievalIntent[];
  /**
   * Guardrail IDs that guard this agent's turns. Each id must
   * resolve among the guardrails bound for the run, or the turn fails
   * with `unresolved-guardrail`. Guardrails are evaluated once per
   * turn, on the final response before it is stored — see
   * `defineCheck` for the checker side.
   *
   * Empty array `[]` = no guarding.
   */
  readonly guardrails: readonly string[];
  /**
   * Optional named prompt parameters. Callers pass values for these
   * in `invokeAgent({parameters: {...}})`; the framework substitutes
   * them into `instructions`. Each parameter declares its type +
   * default. Absent = agent takes no runtime parameters.
   */
  readonly parameters?: readonly PromptParameter[];
  /**
   * Preferred model provider by id. Soft hint — the router prefers
   * this provider when it satisfies `capabilities.needs` + tenant
   * policy, falling back to normal capability-based selection when
   * the preferred provider is unregistered or filtered out. Enables
   * A/B'ing agents across providers without churning registrations:
   * register several, pin the agent to the one you want to test.
   *
   * The value is a `ProviderMetadata.id` string (e.g.
   * `'anthropic-claude-sonnet-4-6'`). Unset = capability-match only.
   */
  readonly preferredProvider?: string;
  /**
   * Preferred model name within the selected provider. Soft hint — see
   * `Agent.preferredModel`.
   */
  readonly preferredModel?: string;
  /**
   * A typed result: the final answer must be JSON matching `schema`
   * (JSON Schema, or a Zod schema converted at definition time). An
   * invalid answer is sent back to the model with the problems listed,
   * up to `maxRepairs` times (default 1). See `AgentOutputSpec`.
   */
  readonly output?: {
    readonly schema: AnySchema;
    readonly name?: string;
    readonly maxRepairs?: number;
  };
  /**
   * What the turn does when a tool call fails: the failure goes back to
   * the model as the call's result, so it can correct the call, up to
   * `maxRetries` times per turn, for the kinds in `retryOn`. Default:
   * one retry, for `invalid-arguments` and `unknown-tool` (nothing ran).
   * A tenant's `tool-errors` policy can lower it. See `ToolErrorsSpec`.
   */
  readonly toolErrors?: ToolErrorsSpec;
  /**
   * Per-conversation behavior — how much history to load, when to
   * gate on HITL, when to auto-close. Every field optional; defaults
   * are "load the full history, no HITL, no auto-close". See
   * `ConversationPolicy` for the full shape including tool-level
   * HITL rules.
   */
  readonly conversationPolicy?: ConversationPolicy;
  /**
   * Turn budget caps. `maxSteps` limits model+tool call loop
   * iterations per turn; `maxCostUsd` caps model spend per turn;
   * `maxWallMs` bounds turn wall-clock time. Exceeding any cap
   * ends the turn with a `budget-exceeded` failure. Sensible dev
   * defaults: `{maxSteps: 6, maxCostUsd: 0.1, maxWallMs: 30_000}`.
   */
  readonly budget?: TurnBudget;
  /** Free-form tags for catalog filtering. Not interpreted by the runtime. */
  readonly tags?: readonly string[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validateIdentity(spec: DefineAgentSpec): Issue[] {
  const out: Issue[] = [];
  if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
    out.push({ path: '/id', message: 'id must be a non-empty string' });
  }
  if (typeof spec.version !== 'string' || !SEMVER_RE.test(spec.version)) {
    out.push({ path: '/version', message: 'version must be a valid semver string' });
  }
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0) {
    out.push({ path: '/name', message: 'name must be a non-empty string' });
  }
  return out;
}

function validateContent(spec: DefineAgentSpec): Issue[] {
  const out: Issue[] = [];
  if (typeof spec.instructions === 'object' && spec.instructions !== null) {
    out.push(...blockRefIssues(spec.instructions, '/instructions', 'prompt'));
    if (spec.parameters !== undefined) {
      out.push({
        path: '/parameters',
        message: 'the prompt block declares the parameters: leave parameters unset',
      });
    }
  } else if (typeof spec.instructions !== 'string' || spec.instructions.trim().length === 0) {
    out.push({
      path: '/instructions',
      message: 'instructions must be a non-empty string, or a prompt block { prompt, version }',
    });
  }
  if (!Array.isArray(spec.capabilities) || spec.capabilities.length === 0) {
    out.push({
      path: '/capabilities',
      message: 'capabilities must be a non-empty array of Capability declarations',
    });
  }
  return out;
}

const BLOCK_ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/** A block reference: a dotted block id and a valid semver range. */
function blockRefIssues(ref: unknown, path: string, idKey: 'prompt' | 'id'): Issue[] {
  if (ref === null || typeof ref !== 'object') {
    return [{ path, message: `must be { ${idKey}, version }` }];
  }
  const r = ref as Record<string, unknown>;
  const out: Issue[] = [];
  if (typeof r[idKey] !== 'string' || !BLOCK_ID.test(r[idKey] as string)) {
    out.push({ path: `${path}/${idKey}`, message: 'must be a dotted lowercase block id, e.g. "acme.weights"' });
  }
  if (typeof r.version !== 'string' || pickVersion([], r.version).kind === 'invalid-range') {
    out.push({ path: `${path}/version`, message: 'must be a semver range, e.g. "^1.0.0" or "1.2.0"' });
  }
  return out;
}

/** Settings and model-settings references: valid, and each block named once. */
function validateBlockRefs(spec: DefineAgentSpec): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const once = (id: unknown, path: string) => {
    if (typeof id !== 'string') return;
    if (seen.has(id)) out.push({ path, message: `settings block "${id}" is referenced twice` });
    seen.add(id);
  };
  if (spec.settings !== undefined) {
    if (!Array.isArray(spec.settings)) {
      out.push({ path: '/settings', message: 'settings must be an array of { id, version }' });
    } else {
      spec.settings.forEach((ref, i) => {
        out.push(...blockRefIssues(ref, `/settings/${i}`, 'id'));
        once((ref as { id?: unknown }).id, `/settings/${i}/id`);
      });
    }
  }
  if (spec.modelSettings !== undefined) {
    out.push(...blockRefIssues(spec.modelSettings, '/modelSettings', 'id'));
    once((spec.modelSettings as { id?: unknown }).id, '/modelSettings/id');
  }
  return out;
}

function validateArrays(spec: DefineAgentSpec): Issue[] {
  const out: Issue[] = [];
  if (!Array.isArray(spec.tools)) {
    out.push({
      path: '/tools',
      message:
        'tools must be an array of { id: string, version: string } refs. No bare-string ids — every tool must carry a semver range.',
    });
  } else {
    spec.tools.forEach((ref, i) => out.push(...validateToolRef(ref, i)));
  }
  if (!Array.isArray(spec.guardrails)) {
    out.push({ path: '/guardrails', message: 'guardrails must be an array of guardrail ids' });
  }
  return out;
}

function validateToolRef(ref: unknown, i: number): Issue[] {
  const out: Issue[] = [];
  if (ref === null || typeof ref !== 'object') {
    out.push({
      path: `/tools/${i}`,
      message: 'each tool must be a { id, version } object; bare-string ids are not allowed',
    });
    return out;
  }
  const obj = ref as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
    out.push({ path: `/tools/${i}/id`, message: 'tool id must be a non-empty string' });
  }
  if (typeof obj.version !== 'string' || obj.version.trim().length === 0) {
    out.push({
      path: `/tools/${i}/version`,
      message:
        'tool version must be a non-empty semver range string (e.g., "1.2.3", "^1.2.3", "~1.2.3"). Deep grammar validation runs at dispatch time via the `semver` library.',
    });
  }
  return out;
}

function validateRetrieval(spec: DefineAgentSpec): Issue[] {
  if (!Array.isArray(spec.retrieval)) {
    return [{ path: '/retrieval', message: 'retrieval must be an array of RetrievalIntents' }];
  }
  const out: Issue[] = [];
  spec.retrieval.forEach((intent, i) => out.push(...validateIntent(intent, i)));
  return out;
}

function validateIntent(intent: RetrievalIntent, i: number): Issue[] {
  const out: Issue[] = [];
  if (!Array.isArray(intent.types) || intent.types.length === 0) {
    out.push({
      path: `/retrieval/${i}/types`,
      message: 'each retrieval intent must declare at least one type',
    });
  }
  if (
    intent.scope !== 'same-conversation' &&
    intent.scope !== 'same-project' &&
    intent.scope !== 'tenant'
  ) {
    out.push({
      path: `/retrieval/${i}/scope`,
      message: 'scope must be same-conversation, same-project, or tenant',
    });
  }
  if (intent.limit !== undefined && (!Number.isInteger(intent.limit) || intent.limit <= 0)) {
    out.push({ path: `/retrieval/${i}/limit`, message: 'limit must be a positive integer' });
  }
  return out;
}

const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean', 'date']);
const AUTO_INJECTED_NAMES = new Set(['today', 'now', 'agent', 'conversation', 'settings']);

/** An agent's or a prompt block's declared parameters: the problems, none when they're valid. */
export function validatePromptParameters(parameters?: readonly PromptParameter[]): Issue[] {
  if (parameters === undefined) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();
  parameters.forEach((p, i) => {
    if (typeof p.name !== 'string' || p.name.trim().length === 0) {
      out.push({ path: `/parameters/${i}/name`, message: 'name must be a non-empty string' });
    }
    if (seen.has(p.name)) {
      out.push({
        path: `/parameters/${i}/name`,
        message: `duplicate parameter name "${p.name}"`,
      });
    }
    seen.add(p.name);
    if (AUTO_INJECTED_NAMES.has(p.name)) {
      out.push({
        path: `/parameters/${i}/name`,
        message: `"${p.name}" is a reserved auto-injected variable — do not declare it as a parameter`,
      });
    }
    if (!VALID_PARAM_TYPES.has(p.type)) {
      out.push({
        path: `/parameters/${i}/type`,
        message: 'type must be string, number, boolean, or date',
      });
    }
  });
  return out;
}

function validateBudget(budget?: TurnBudget): Issue[] {
  if (budget === undefined) return [];
  const out: Issue[] = [];
  if (
    budget.maxSteps !== undefined &&
    (!Number.isInteger(budget.maxSteps) || budget.maxSteps <= 0)
  ) {
    out.push({ path: '/budget/maxSteps', message: 'maxSteps must be a positive integer' });
  }
  if (
    budget.maxCostUsd !== undefined &&
    (typeof budget.maxCostUsd !== 'number' || budget.maxCostUsd < 0)
  ) {
    out.push({
      path: '/budget/maxCostUsd',
      message: 'maxCostUsd must be a non-negative number',
    });
  }
  if (
    budget.maxWallMs !== undefined &&
    (!Number.isInteger(budget.maxWallMs) || budget.maxWallMs <= 0)
  ) {
    out.push({ path: '/budget/maxWallMs', message: 'maxWallMs must be a positive integer' });
  }
  return out;
}

function validateToolErrors(toolErrors: DefineAgentSpec['toolErrors']): Issue[] {
  if (toolErrors === undefined) return [];
  const checked = validateToolErrorsSpec(toolErrors);
  return checked.kind === 'ok'
    ? []
    : checked.issues.map((i) => ({ path: `/toolErrors${i.path}`, message: i.message }));
}

function validateConversationPolicy(policy?: ConversationPolicy): Issue[] {
  if (policy === undefined) return [];
  const out: Issue[] = [];
  if (
    policy.historyLimit !== undefined &&
    (!Number.isInteger(policy.historyLimit) || policy.historyLimit <= 0)
  ) {
    out.push({
      path: '/conversationPolicy/historyLimit',
      message: 'historyLimit must be a positive integer',
    });
  }
  if (
    policy.autoCloseAfterInactiveSeconds !== undefined &&
    (!Number.isInteger(policy.autoCloseAfterInactiveSeconds) ||
      policy.autoCloseAfterInactiveSeconds <= 0)
  ) {
    out.push({
      path: '/conversationPolicy/autoCloseAfterInactiveSeconds',
      message: 'autoCloseAfterInactiveSeconds must be a positive integer',
    });
  }
  if (
    policy.hitlAfterTurns !== undefined &&
    (!Number.isInteger(policy.hitlAfterTurns) || policy.hitlAfterTurns <= 0)
  ) {
    out.push({
      path: '/conversationPolicy/hitlAfterTurns',
      message: 'hitlAfterTurns must be a positive integer',
    });
  }
  // Nested hitl policy.
  if (policy.hitl !== undefined) {
    const h = policy.hitl;
    if (h.afterTurns !== undefined && (!Number.isInteger(h.afterTurns) || h.afterTurns <= 0)) {
      out.push({
        path: '/conversationPolicy/hitl/afterTurns',
        message: 'hitl.afterTurns must be a positive integer',
      });
    }
    if (h.timeoutMs !== undefined && (!Number.isInteger(h.timeoutMs) || h.timeoutMs <= 0)) {
      out.push({
        path: '/conversationPolicy/hitl/timeoutMs',
        message: 'hitl.timeoutMs must be a positive integer (ms)',
      });
    }
    out.push(...validateOnTimeout(h.onTimeout));
    const ROLES: ReadonlySet<string> = new Set(['standard', 'senior', 'admin']);
    if (
      h.defaultReviewerRole !== undefined &&
      !ROLES.has(h.defaultReviewerRole as unknown as string)
    ) {
      out.push({
        path: '/conversationPolicy/hitl/defaultReviewerRole',
        message: 'hitl.defaultReviewerRole must be one of: standard, senior, admin',
      });
    }
    const MODES: ReadonlySet<string> = new Set(['never_ask', 'ask_on_first_use', 'always_ask']);
    if (h.tools?.default !== undefined && !MODES.has(h.tools.default)) {
      out.push({
        path: '/conversationPolicy/hitl/tools/default',
        message: 'hitl.tools.default must be one of: never_ask, ask_on_first_use, always_ask',
      });
    }
    if (h.tools?.overrides !== undefined) {
      for (const [toolId, rule] of Object.entries(h.tools.overrides)) {
        const mode = typeof rule === 'string' ? rule : rule.mode;
        if (!MODES.has(mode)) {
          out.push({
            path: `/conversationPolicy/hitl/tools/overrides/${toolId}`,
            message: 'override mode must be one of: never_ask, ask_on_first_use, always_ask',
          });
        }
        if (
          typeof rule === 'object' &&
          rule.requiredRole !== undefined &&
          !ROLES.has(rule.requiredRole)
        ) {
          out.push({
            path: `/conversationPolicy/hitl/tools/overrides/${toolId}/requiredRole`,
            message: 'override requiredRole must be one of: standard, senior, admin',
          });
        }
      }
    }
  }
  return out;
}

/**
 * `hitl.onTimeout`: only `'escalate'`, what the runtime does when an
 * approval's time runs out. `'auto-approve'` / `'auto-reject'` aren't
 * implemented, so they're refused instead of accepted and ignored.
 */
function validateOnTimeout(onTimeout: unknown): Issue[] {
  if (onTimeout === undefined || onTimeout === 'escalate') return [];
  const path = '/conversationPolicy/hitl/onTimeout';
  if (onTimeout === 'auto-approve' || onTimeout === 'auto-reject') {
    return [
      {
        path,
        message: `hitl.onTimeout '${onTimeout}' isn't supported: an approval that times out escalates one reviewer tier, and at admin it expires (the turn fails with hitl-cancelled). Use 'escalate', or leave it out.`,
      },
    ];
  }
  return [{ path, message: "hitl.onTimeout must be 'escalate'" }];
}

type OutputOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly value: AgentOutputSpec }
  | { readonly kind: 'err'; readonly issues: readonly Issue[] };

/** The output spec in its wire form: JSON Schema that compiles, and a valid repair count. */
function resolveOutput(output: DefineAgentSpec['output']): OutputOutcome {
  if (output === undefined) return { kind: 'none' };
  const issues: Issue[] = [];
  if (
    output.maxRepairs !== undefined &&
    (!Number.isInteger(output.maxRepairs) || output.maxRepairs < 0)
  ) {
    issues.push({
      path: '/output/maxRepairs',
      message: 'maxRepairs must be a non-negative integer',
    });
  }
  if (output.name !== undefined && (typeof output.name !== 'string' || output.name.length === 0)) {
    issues.push({ path: '/output/name', message: 'name must be a non-empty string' });
  }
  let schema: Readonly<Record<string, unknown>>;
  if (isZodSchema(output.schema)) {
    // The output side: downstream steps read every field, defaulted ones included.
    const converted = toJSONSchemaSync(output.schema, loadZodConverterSync(), 'output');
    if (converted.kind === 'err') {
      return {
        kind: 'err',
        issues: [...issues, { path: '/output/schema', message: converted.error.message }],
      };
    }
    schema = converted.value;
  } else {
    schema = output.schema as Readonly<Record<string, unknown>>;
  }
  const compiled = compileInlineSchema(schema);
  if (compiled.kind === 'err') {
    issues.push({ path: '/output/schema', message: compiled.error.message });
  }
  if (issues.length > 0) return { kind: 'err', issues };
  return {
    kind: 'ok',
    value: {
      schema,
      ...(output.name !== undefined && { name: output.name }),
      ...(output.maxRepairs !== undefined && { maxRepairs: output.maxRepairs }),
    },
  };
}

function buildAgent(spec: DefineAgentSpec, output: AgentOutputSpec | undefined): Agent {
  return {
    id: spec.id as AgentId,
    version: spec.version as Semver,
    name: spec.name,
    ...(spec.description !== undefined && { description: spec.description }),
    instructions:
      typeof spec.instructions === 'string' ? spec.instructions : { ...spec.instructions },
    ...(spec.settings !== undefined && { settings: spec.settings.map((r) => ({ ...r })) }),
    ...(spec.modelSettings !== undefined && { modelSettings: { ...spec.modelSettings } }),
    capabilities: spec.capabilities.map((c) => ({ ...c })),
    tools: [...spec.tools],
    retrieval: spec.retrieval.map((r) => ({ ...r })),
    guardrails: [...spec.guardrails],
    ...(spec.parameters !== undefined && {
      parameters: spec.parameters.map((p) => ({ ...p })),
    }),
    ...(spec.preferredProvider !== undefined && { preferredProvider: spec.preferredProvider }),
    ...(spec.preferredModel !== undefined && { preferredModel: spec.preferredModel }),
    ...(spec.conversationPolicy !== undefined && {
      conversationPolicy: { ...spec.conversationPolicy },
    }),
    ...(spec.budget !== undefined && { budget: { ...spec.budget } }),
    ...(spec.tags !== undefined && { tags: [...spec.tags] }),
    ...(output !== undefined && { output }),
    ...(spec.toolErrors !== undefined && {
      toolErrors: {
        ...spec.toolErrors,
        ...(spec.toolErrors.retryOn !== undefined && { retryOn: [...spec.toolErrors.retryOn] }),
      },
    }),
  };
}
