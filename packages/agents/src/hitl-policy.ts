// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Effective HITL policy resolver — computes the runtime policy that
// gates + timeouts consult, merging in this order:
//
//   1. Framework defaults (session gate off, no tool gates, 24h timeout,
//      standard reviewer, `escalate` on timeout).
//   2. Agent's `conversationPolicy.hitl` (and `hitlAfterTurns`).
//   3. The tenant's `hitl` policy (`HitlSpec`) — only stricter: it can
//      shorten the timeout, raise the reviewer role, and set a floor
//      under a tool's gate, never loosen.
//
// The agent turn resolves it once, at the start (see
// `resolveTurnHitlPolicy`), instead of reading
// `agent.conversationPolicy.hitl` directly.
//

import { type HitlSpec, higherRole, toolHitlRule } from '@kindgi/policy-contract';

import type { Agent, ConversationHitlPolicy, ToolHitlMode, ToolHitlRule } from './types.js';

export interface EffectiveHitlPolicy {
  /**
   * Session-turn count gate. Absent = no session gate.
   * Merged from `agent.conversationPolicy.hitl.afterTurns` and
   * `agent.conversationPolicy.hitlAfterTurns` (either fires;
   * `hitl.afterTurns` wins when both are set).
   */
  readonly turn?: { readonly afterTurns: number };
  /**
   * Tool-level policy. Absent = no tool gates (agents opt in
   * explicitly). Same shape as `agent.conversationPolicy.hitl.tools`,
   * with string overrides normalized to rules and tenant overrides
   * applied; the per-tool default (from `Tool.mutating`) is applied at
   * dispatch time.
   */
  readonly tools?: {
    readonly default?: ToolHitlMode;
    readonly overrides: ReadonlyMap<string, ToolHitlRule>;
  };
  /**
   * The tenant's per-tool rules: a floor under the agent's gate for
   * that tool. A tool's gate is the stricter of the two; tools the
   * tenant names nothing for keep the agent's.
   */
  readonly toolFloors?: ReadonlyMap<string, ToolHitlRule>;
  readonly defaultReviewerRole: 'standard' | 'senior' | 'admin';
  /** Millisecond timeout used at enqueue time. */
  readonly timeoutMs: number;
  readonly onTimeout: 'auto-approve' | 'auto-reject' | 'escalate';
}

/**
 * Framework defaults. Every field non-optional so the resolver's
 * return type is fully-populated regardless of caller policy state.
 */
const FRAMEWORK_DEFAULTS = {
  defaultReviewerRole: 'standard' as const,
  timeoutMs: 24 * 60 * 60 * 1000,
  onTimeout: 'escalate' as const,
} as const;

/**
 * Compute the effective HITL policy for a given (tenant, agent) pair:
 * framework defaults overlaid with the agent's policy, then held to the
 * tenant's `hitl` policy (only stricter). `tenant: undefined` — the
 * tenant has none.
 */
export function resolveEffectiveHitlPolicy(input: {
  readonly tenant: HitlSpec | undefined;
  readonly agent: Agent;
}): EffectiveHitlPolicy {
  const agentHitl: ConversationHitlPolicy | undefined = input.agent.conversationPolicy?.hitl;
  const legacyAfterTurns = input.agent.conversationPolicy?.hitlAfterTurns;
  const agentAfterTurns = agentHitl?.afterTurns ?? legacyAfterTurns;

  const merged: {
    turn?: { afterTurns: number };
    tools?: {
      default?: ToolHitlMode;
      overrides: ReadonlyMap<string, ToolHitlRule>;
    };
    toolFloors?: ReadonlyMap<string, ToolHitlRule>;
    defaultReviewerRole: 'standard' | 'senior' | 'admin';
    timeoutMs: number;
    onTimeout: 'auto-approve' | 'auto-reject' | 'escalate';
  } = {
    defaultReviewerRole: agentHitl?.defaultReviewerRole ?? FRAMEWORK_DEFAULTS.defaultReviewerRole,
    timeoutMs: agentHitl?.timeoutMs ?? FRAMEWORK_DEFAULTS.timeoutMs,
    onTimeout: FRAMEWORK_DEFAULTS.onTimeout,
  };

  if (agentAfterTurns !== undefined) {
    merged.turn = { afterTurns: agentAfterTurns };
  }

  const agentToolsPolicy = agentHitl?.tools;
  if (agentToolsPolicy !== undefined) {
    const overrides = new Map<string, ToolHitlRule>();
    if (agentToolsPolicy.overrides !== undefined) {
      for (const [k, v] of Object.entries(agentToolsPolicy.overrides)) {
        overrides.set(k, typeof v === 'string' ? { mode: v } : v);
      }
    }
    merged.tools = {
      ...(agentToolsPolicy.default !== undefined && { default: agentToolsPolicy.default }),
      overrides,
    };
  }

  // The tenant's policy — only stricter.
  const tenant = input.tenant;
  if (tenant !== undefined) {
    if (tenant.maxTimeoutMs !== undefined && merged.timeoutMs > tenant.maxTimeoutMs) {
      merged.timeoutMs = tenant.maxTimeoutMs;
    }
    merged.defaultReviewerRole =
      higherRole(merged.defaultReviewerRole, tenant.minReviewerRole) ?? merged.defaultReviewerRole;
    const floors = Object.entries(tenant.tools ?? {});
    if (floors.length > 0) {
      merged.toolFloors = new Map(floors.map(([toolId, value]) => [toolId, toolHitlRule(value)]));
    }
  }

  return merged as EffectiveHitlPolicy;
}
