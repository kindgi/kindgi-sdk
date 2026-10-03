// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Human-in-the-loop approval rules a tenant holds every agent to — the
 * spec of a `hitl` tenant policy. Only stricter: the shorter timeout,
 * the higher reviewer role, and, per tool, the stricter of the agent's
 * gate and the tenant's.
 *
 * The tool modes and rules are also an agent's own
 * (`conversationPolicy.hitl.tools` in `@kindgi/agents`).
 */

/** How a tool call is gated, loosest first. */
export const TOOL_HITL_MODES = ['never_ask', 'ask_on_first_use', 'always_ask'] as const;
export type ToolHitlMode = (typeof TOOL_HITL_MODES)[number];

/** Reviewer roles, lowest first. */
export const REVIEWER_ROLES = ['standard', 'senior', 'admin'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

/** A tool's gate, and the reviewer role its approvals need. */
export interface ToolHitlRule {
  readonly mode: ToolHitlMode;
  readonly requiredRole?: ReviewerRole;
}

export interface HitlSpec {
  /** The longest an approval may stay open, in milliseconds. */
  readonly maxTimeoutMs?: number;
  /** The lowest reviewer role an approval may go to. */
  readonly minReviewerRole?: ReviewerRole;
  /** Per tool id, the gate every agent applies at least. */
  readonly tools?: Readonly<Record<string, ToolHitlMode | ToolHitlRule>>;
}

export interface HitlSpecIssue {
  /** JSON Pointer into the spec, e.g. `/tools/acme.pay/mode`. */
  readonly path: string;
  readonly message: string;
}

/** A mode or a rule, as a rule. */
export function toolHitlRule(value: ToolHitlMode | ToolHitlRule): ToolHitlRule {
  return typeof value === 'string' ? { mode: value } : value;
}

/** The stricter of two rules: the stricter mode, the higher required role. */
export function stricterToolHitlRule(a: ToolHitlRule, b: ToolHitlRule): ToolHitlRule {
  const mode = TOOL_HITL_MODES.indexOf(a.mode) >= TOOL_HITL_MODES.indexOf(b.mode) ? a.mode : b.mode;
  const requiredRole = higherRole(a.requiredRole, b.requiredRole);
  return { mode, ...(requiredRole !== undefined && { requiredRole }) };
}

/** The higher of two roles; `undefined` when neither is set. */
export function higherRole(
  a: ReviewerRole | undefined,
  b: ReviewerRole | undefined,
): ReviewerRole | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return REVIEWER_ROLES.indexOf(a) >= REVIEWER_ROLES.indexOf(b) ? a : b;
}

/**
 * One spec from many, at least as strict as each: the shortest timeout,
 * the highest role, and per tool the stricter rule.
 */
export function combineHitlSpecs(specs: readonly HitlSpec[]): HitlSpec {
  let maxTimeoutMs: number | undefined;
  let minReviewerRole: ReviewerRole | undefined;
  const tools = new Map<string, ToolHitlRule>();
  for (const spec of specs) {
    if (spec.maxTimeoutMs !== undefined) {
      maxTimeoutMs =
        maxTimeoutMs === undefined ? spec.maxTimeoutMs : Math.min(maxTimeoutMs, spec.maxTimeoutMs);
    }
    minReviewerRole = higherRole(minReviewerRole, spec.minReviewerRole);
    for (const [toolId, value] of Object.entries(spec.tools ?? {})) {
      const rule = toolHitlRule(value);
      const held = tools.get(toolId);
      tools.set(toolId, held === undefined ? rule : stricterToolHitlRule(held, rule));
    }
  }
  return {
    ...(maxTimeoutMs !== undefined && { maxTimeoutMs }),
    ...(minReviewerRole !== undefined && { minReviewerRole }),
    ...(tools.size > 0 && { tools: Object.fromEntries(tools) }),
  };
}

/**
 * Validate an unknown value as a `HitlSpec`: `maxTimeoutMs` a positive
 * integer, `minReviewerRole` a known role, `tools` an object of known
 * modes or `{ mode, requiredRole? }` rules, nothing else.
 */
export function validateHitlSpec(
  input: unknown,
):
  | { readonly kind: 'ok'; readonly value: HitlSpec }
  | { readonly kind: 'err'; readonly issues: readonly HitlSpecIssue[] } {
  if (!isObject(input))
    return { kind: 'err', issues: [{ path: '', message: 'must be an object' }] };
  const issues: HitlSpecIssue[] = [
    ...Object.keys(input)
      .filter((key) => key !== 'maxTimeoutMs' && key !== 'minReviewerRole' && key !== 'tools')
      .map((key) => ({ path: `/${key}`, message: 'is not a hitl setting' })),
    ...timeoutIssues(input.maxTimeoutMs),
    ...roleIssues(input.minReviewerRole, '/minReviewerRole'),
    ...toolsIssues(input.tools),
  ];
  return issues.length > 0 ? { kind: 'err', issues } : { kind: 'ok', value: input as HitlSpec };
}

function timeoutIssues(value: unknown): HitlSpecIssue[] {
  if (value === undefined) return [];
  return Number.isInteger(value) && (value as number) > 0
    ? []
    : [{ path: '/maxTimeoutMs', message: 'must be a positive integer (milliseconds)' }];
}

function roleIssues(value: unknown, path: string): HitlSpecIssue[] {
  if (value === undefined) return [];
  return (REVIEWER_ROLES as readonly unknown[]).includes(value)
    ? []
    : [{ path, message: `must be one of ${REVIEWER_ROLES.join(', ')}` }];
}

function toolsIssues(value: unknown): HitlSpecIssue[] {
  if (value === undefined) return [];
  if (!isObject(value)) return [{ path: '/tools', message: 'must be an object of tool ids' }];
  return Object.entries(value).flatMap(([toolId, rule]) => {
    const path = `/tools/${escapePointer(toolId)}`;
    return [
      ...(toolId.length === 0 ? [{ path, message: 'a tool id must not be empty' }] : []),
      ...toolRuleIssues(rule, path),
    ];
  });
}

/** One tool's entry: a known mode, or a `{ mode, requiredRole? }` rule. */
function toolRuleIssues(rule: unknown, path: string): HitlSpecIssue[] {
  if (typeof rule === 'string') {
    return (TOOL_HITL_MODES as readonly string[]).includes(rule)
      ? []
      : [{ path, message: `must be one of ${TOOL_HITL_MODES.join(', ')}, or a rule` }];
  }
  if (!isObject(rule)) return [{ path, message: 'must be a mode or { mode, requiredRole? }' }];
  return [
    ...Object.keys(rule)
      .filter((key) => key !== 'mode' && key !== 'requiredRole')
      .map((key) => ({ path: `${path}/${escapePointer(key)}`, message: 'is not a rule setting' })),
    ...((TOOL_HITL_MODES as readonly unknown[]).includes(rule.mode)
      ? []
      : [{ path: `${path}/mode`, message: `must be one of ${TOOL_HITL_MODES.join(', ')}` }]),
    ...roleIssues(rule.requiredRole, `${path}/requiredRole`),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}
