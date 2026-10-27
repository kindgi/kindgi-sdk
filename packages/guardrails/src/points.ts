// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a guardrail runs in an agent's turn (`Guardrail.at`), and what
 * its declaration may ask for there. `guardrailPointIssues` finds an
 * action or a scope the point can't take, and `validateGuardrail` and
 * `validateGuardrailSpec` refuse it. `guardrailCheckPointProblems` finds
 * a point its check doesn't run at: `validateGuardrail` refuses it, and
 * so do the API's deploy route and its register route for a built-in
 * check. For a pack check, registering leaves it to the runtime's
 * `GuardrailConfigCheck`.
 */

import type { GuardrailConfigProblem } from './config-problems.js';
import {
  ESCALATION_ROLES,
  GUARDRAIL_POINTS,
  type Guardrail,
  type GuardrailPoint,
  type RegisteredCheck,
  type Scope,
} from './types.js';

/** The points a check runs at when it names none. */
export const DEFAULT_CHECK_POINTS: readonly GuardrailPoint[] = ['final-answer'];

/** The point a guardrail runs at: its `at`, or the final answer. */
export function guardrailPoint(guardrail: Pick<Guardrail, 'at'>): GuardrailPoint {
  return guardrail.at ?? 'final-answer';
}

/** The points a check supports: its `points`, or the final answer only. */
export function checkPoints(check: Pick<RegisteredCheck, 'points'>): readonly GuardrailPoint[] {
  return check.points ?? DEFAULT_CHECK_POINTS;
}

/** Whether `value` is a point. */
export function isGuardrailPoint(value: unknown): value is GuardrailPoint {
  return typeof value === 'string' && (GUARDRAIL_POINTS as readonly string[]).includes(value);
}

const TOOL_POINTS: readonly GuardrailPoint[] = ['before-tool', 'after-tool'];

/**
 * What the declaration asks for that its point can't do, as issues
 * (paths into the declaration). Nothing at the final answer, which takes
 * every action it takes today.
 * - `'escalate'` runs only before a tool call, where a person decides
 *   whether the call runs, and there it names one of `ESCALATION_ROLES`.
 * - `'compensate'` is recorded at the final answer only.
 * - `scope.tools` is for the tool points.
 *
 * Any other action, a custom one included, is taken as at the final answer.
 */
export function guardrailPointIssues(
  guardrail: Pick<Guardrail, 'at' | 'action' | 'scope'>,
): readonly { readonly path: string; readonly message: string }[] {
  const at = guardrailPoint(guardrail);
  const issues: { path: string; message: string }[] = [];
  const action = guardrail.action['on-violation'];
  if (action === 'escalate' && at !== 'final-answer') {
    if (at !== 'before-tool') {
      issues.push({
        path: '/action/on-violation',
        message: `"escalate" runs only before a tool call ("before-tool"), not at "${at}"`,
      });
    } else if (!(ESCALATION_ROLES as readonly string[]).includes(guardrail.action.escalateTo ?? '')) {
      issues.push({
        path: '/action/escalateTo',
        message: `before a tool call, "escalate" names the role that decides: ${ESCALATION_ROLES.join(', ')}`,
      });
    }
  }
  if (action === 'compensate' && at !== 'final-answer') {
    issues.push({
      path: '/action/on-violation',
      message: `"compensate" is recorded at the final answer only, not at "${at}"`,
    });
  }
  if (guardrail.scope?.tools !== undefined && !TOOL_POINTS.includes(at)) {
    issues.push({
      path: '/scope/tools',
      message: `scope.tools is for "before-tool" and "after-tool", not "${at}"`,
    });
  }
  return issues;
}

/**
 * A problem when the guardrail's point isn't one its check supports
 * (`points`: the check's, or `DEFAULT_CHECK_POINTS`), as
 * `describeGuardrailConfigProblems` words a check's problems.
 */
export function guardrailCheckPointProblems(
  guardrail: Pick<Guardrail, 'at'>,
  points: readonly GuardrailPoint[],
): readonly GuardrailConfigProblem[] {
  const at = guardrailPoint(guardrail);
  if (points.includes(at)) return [];
  return [{ path: '/at', message: `at "${at}" isn't one of the check's points (${points.join(', ')}).` }];
}

/**
 * Whether a guardrail scoped by `scope.tools` checks a call to `toolId`:
 * an exact id, or a trailing `*` that matches every id with its prefix.
 * Without `scope.tools`, every tool.
 */
export function guardrailCoversTool(scope: Scope | undefined, toolId: string): boolean {
  const tools = scope?.tools;
  if (tools === undefined) return true;
  return tools.some((entry) =>
    entry.endsWith('*') ? toolId.startsWith(entry.slice(0, -1)) : entry === toolId,
  );
}
