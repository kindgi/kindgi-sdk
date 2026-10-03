// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Tool-level HITL — resolves the effective `ToolHitlMode` for a given
// (agent, tool) pair. Consumed by `dispatch-tools.ts` to
// decide whether a tool call parks the run on a kernel waitpoint before
// dispatch.
//
// Resolution order (narrower wins, framework default is fail-open):
//   1. `agent.conversationPolicy.hitl.tools.overrides[toolId]` — exact match
//   2. `agent.conversationPolicy.hitl.tools.default` — agent-wide default
//   3. per-tool default from `Tool.mutating` — safe fallback
//        - `mutating: false`  → `never_ask`
//        - `mutating: true` or absent → `ask_on_first_use` (defaults safer)
//
// The effective-policy resolver (`hitl-policy.ts`) layers the tenant
// cap on top.
//

import { createHash } from 'node:crypto';

import type { Tool } from '@kindgi/tools';

import type { Agent, ToolHitlMode, ToolHitlRule } from '../types.js';

export interface ResolvedToolHitl {
  readonly mode: ToolHitlMode;
  readonly requiredRole: 'standard' | 'senior' | 'admin';
}

export function resolveToolHitl(agent: Agent, tool: Tool): ResolvedToolHitl {
  const hitl = agent.conversationPolicy?.hitl;
  const toolsPolicy = hitl?.tools;
  const defaultRole = hitl?.defaultReviewerRole ?? 'standard';

  // Opt-in: agents that don't declare `hitl.tools` get no tool-level
  // gates. Matches the design's "fail-open" default — HITL is opt-in
  // at the agent level, not implicit.
  if (toolsPolicy === undefined) {
    return { mode: 'never_ask', requiredRole: defaultRole };
  }

  // 1. Explicit override for this toolId.
  const rawOverride = toolsPolicy.overrides?.[tool.id as unknown as string];
  if (rawOverride !== undefined) {
    const rule: ToolHitlRule =
      typeof rawOverride === 'string' ? { mode: rawOverride } : rawOverride;
    return {
      mode: rule.mode,
      requiredRole: rule.requiredRole ?? defaultRole,
    };
  }

  // 2. Agent-wide default.
  if (toolsPolicy.default !== undefined) {
    return { mode: toolsPolicy.default, requiredRole: defaultRole };
  }

  // 3. Per-tool default from Tool.mutating — only reached when
  // `hitl.tools` is present (opt-in) but neither an override nor a
  // default matches. Read-only tools skip the gate; mutating tools
  // ask on first use.
  const mode: ToolHitlMode = tool.mutating === false ? 'never_ask' : 'ask_on_first_use';
  return { mode, requiredRole: defaultRole };
}

/**
 * Deterministic hash of tool arguments — used as the cache key for
 * `ask_on_first_use`. Sorted-key JSON so reordered args don't produce
 * a different hash.
 */
export function hashToolArgs(args: unknown): string {
  return createHash('sha256').update(canonicalStringify(args)).digest('hex').slice(0, 40);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}

/**
 * Deterministic waitpoint token for a tool-call gate. Includes both
 * the model-generated call id (unique per iteration) AND the args hash
 * so kernel flow replay lands on the same token, and a re-issued
 * tool-call in a later iteration gets its own gate.
 */
export function computeToolCallWaitToken(input: {
  readonly runId: string;
  readonly callId: string;
  readonly argsHash: string;
}): string {
  return createHash('sha256')
    .update(`tool-call:${input.runId}:${input.callId}:${input.argsHash}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Shape the tool-level waitpoint resolves to when the reviewer decides.
 * Same shape as session-gate decisions — the approvals-complete route
 * materializes it identically.
 */
export interface ToolHitlDecision {
  readonly decided: 'approve' | 'reject';
  readonly rationale?: string;
}

/**
 * In-conversation cache of decisions for `ask_on_first_use`. Persisted
 * on `agent_conversations.metadata.hitlToolDecisions` — a flat map of
 * `${toolId}:${argsHash}` → decision. Read/write goes through the
 * conversation row's metadata via the standard update path.
 */
export interface ToolDecisionCacheKey {
  readonly toolId: string;
  readonly argsHash: string;
}

export function cacheKeyFor(key: ToolDecisionCacheKey): string {
  return `${key.toolId}:${key.argsHash}`;
}
