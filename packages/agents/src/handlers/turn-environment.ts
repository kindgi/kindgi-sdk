// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a turn runs against: its conversation, and the guardrails, tools,
 * policies and model it resolves at the start. `setup` resolves them
 * once per turn; a resumed turn resolves them again (see
 * `rehydrateTurnContext`), pinned to the model `setup` routed to, since
 * the kernel doesn't re-run a step that already completed and these live
 * on the in-memory `TurnContext`.
 */

import { TenantBudgetError } from '@kindgi/bounds';
import { route } from '@kindgi/capabilities';
import type { ProviderRegistry, RouteInput, TenantPolicy } from '@kindgi/capabilities';
import type { HitlSpec, ToolErrorsSpec } from '@kindgi/policy-contract';
import type { ToolRegistry } from '@kindgi/tools';
import type { TenantId } from '@kindgi/types';

import type { ConversationClosedError } from '../errors.js';
import { resolveGuardrails } from '../guardrails-gate.js';
import { type EffectiveHitlPolicy, resolveEffectiveHitlPolicy } from '../hitl-policy.js';
import { mergeTenantPolicies } from '../tenant-policy.js';
import type { Conversation } from '../types.js';
import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { withRememberTool } from './remember-tool.js';
import { type PinnedBlockVersions, resolveTurnBlocks } from './resolve-blocks.js';
import { resolveTurnTools } from './resolve-tools.js';
import { type ToolErrorPolicy, effectiveToolErrorPolicy } from './tool-errors.js';

/** The conversation the turn runs in: open, and opened with this agent version. */
export async function loadTurnConversation(ctx: TurnContext): Promise<Conversation> {
  const conv = await ctx.bindings.conversationBinding.getConversation(
    ctx.input.tenantId,
    ctx.input.conversationId,
  );
  if (conv.kind === 'err') throwAgentTurnFailure(conv.error);
  if (conv.value.closedAt !== undefined) {
    const err: ConversationClosedError = {
      code: 'conversation-closed',
      message: `Conversation "${ctx.input.conversationId}" is closed`,
      conversationId: ctx.input.conversationId,
    };
    throwAgentTurnFailure(err);
  }
  if (
    conv.value.agentId !== ctx.input.agent.id ||
    conv.value.agentVersion !== ctx.input.agent.version
  ) {
    throwAgentTurnFailure({
      code: 'agent-version-mismatch',
      message: `Conversation opened with ${conv.value.agentId}@${conv.value.agentVersion}; invoked with ${ctx.input.agent.id}@${ctx.input.agent.version}`,
      conversationId: ctx.input.conversationId,
      expectedVersion: conv.value.agentVersion,
      actualVersion: ctx.input.agent.version,
    });
  }
  ctx.conversation = conv.value;
  return conv.value;
}

/** The model a turn was routed to, as `setup` journals it. */
export interface PinnedRoute {
  readonly providerId: string;
  readonly model: string;
}

/**
 * The tool version each of the agent's tool references resolved to, by
 * tool id, as `setup` journals it: a resumed turn runs these versions,
 * whatever the registry holds by then.
 */
export type PinnedToolVersions = Readonly<Record<string, string>>;

/**
 * Resolve the turn's guardrails, tools, tenant policy, tool-error policy
 * and model onto `ctx`. With `pinned`, the route is that provider and
 * model, still under the tenant's current policy; one no longer
 * registered or allowed fails the turn. With `pinnedTools`, each tool is
 * that exact version, not its range resolved again; one no longer
 * registered fails the turn.
 */
export async function resolveTurnEnvironment(
  ctx: TurnContext,
  pinned?: PinnedRoute,
  pinnedTools?: PinnedToolVersions,
  pinnedBlocks?: PinnedBlockVersions,
): Promise<
  PinnedRoute & {
    readonly toolCount: number;
    readonly toolVersions: PinnedToolVersions;
    readonly blockVersions?: PinnedBlockVersions;
  }
> {
  const invResolution = resolveGuardrails(ctx.input.agent, ctx.bindings);
  if (invResolution.missing.length > 0) {
    throwAgentTurnFailure({
      code: 'unresolved-guardrail',
      message: `Agent "${ctx.input.agent.id}" references guardrails not in the registry: ${invResolution.missing.join(', ')}`,
      guardrailIds: invResolution.missing,
    });
  }
  ctx.guardrails = invResolution.resolved;

  const turnTools = await turnToolRegistry(ctx);
  ctx.tools = withRememberTool(ctx, resolveTurnTools(turnTools, ctx.input.agent, pinnedTools));
  // The data blocks, at the versions pinned (the turn's own on resume).
  const blocks = await resolveTurnBlocks(ctx, pinnedBlocks);
  if (blocks !== undefined) ctx.blocks = blocks;

  const capability = ctx.input.agent.capabilities[0];
  if (capability === undefined) {
    throwAgentTurnFailure({
      code: 'capability-routing-failed',
      message: `Agent "${ctx.input.agent.id}" has no capabilities declared`,
      cause: null,
    });
  }
  // Merge the static tenant policy with the one derived from the
  // policy registry (if wired); the result is at least as strict as
  // each (see `mergeTenantPolicies`).
  const derivedPolicy = await evaluateTurnPolicy<TenantPolicy>(ctx, 'model-routing');
  const effectivePolicy = mergeTenantPolicies(ctx.bindings.tenantPolicy, derivedPolicy);
  if (effectivePolicy !== undefined) ctx.tenantPolicy = effectivePolicy;
  ctx.toolErrorPolicy = await resolveToolErrorPolicy(ctx);
  // Storage-backed registries need an async hydration
  // step before the sync `list(tenantId)` call — they read persisted
  // providers from `ProviderRegistryBinding` and instantiate each via
  // its adapter factory. In-memory implementations (dev-echo,
  // tests) leave `hydrate` undefined and this is a no-op.
  if (ctx.bindings.providerRegistry.hydrate !== undefined) {
    await ctx.bindings.providerRegistry.hydrate(ctx.input.tenantId);
  }
  // A pinned route narrows the policy to exactly that provider and model.
  const routingPolicy =
    pinned === undefined
      ? effectivePolicy
      : mergeTenantPolicies(effectivePolicy, {
          tenantId: ctx.input.tenantId,
          providers: { allow: [pinned.providerId] },
          models: { allow: [pinned.model] },
        });
  const routed = route({
    capability,
    providers: ctx.bindings.providerRegistry.list(ctx.input.tenantId),
    ...setupFailuresOf(ctx.bindings.providerRegistry, ctx.input.tenantId),
    ...(routingPolicy !== undefined && { tenantPolicy: routingPolicy }),
    ...(ctx.input.agent.preferredProvider !== undefined && {
      preferredProvider: ctx.input.agent.preferredProvider,
    }),
    ...(ctx.input.agent.preferredModel !== undefined && {
      preferredModel: ctx.input.agent.preferredModel,
    }),
  });
  if (routed.kind === 'err') {
    throwAgentTurnFailure({
      code: 'capability-routing-failed',
      message:
        pinned === undefined
          ? routed.error.message
          : `The turn was routed to ${pinned.providerId}/${pinned.model}, which is no longer registered or allowed: ${routed.error.message}`,
      cause: routed.error,
    });
  }
  ctx.provider = routed.value.provider;
  ctx.model = routed.value.model;
  return {
    providerId: routed.value.provider.metadata.id,
    model: routed.value.model.name,
    toolCount: ctx.tools.definitions.length,
    toolVersions: Object.fromEntries(
      [...ctx.tools.byName].map(([id, binding]) => [id, binding.resolvedVersion]),
    ),
    ...(blocks !== undefined && { blockVersions: blocks.versions }),
  };
}

/**
 * The tenant's registered providers the registry couldn't set up, for
 * `route`: `list` leaves them out, so a turn that can't route names them
 * and why only when the router is told.
 */
function setupFailuresOf(
  registry: ProviderRegistry,
  tenantId: TenantId,
): Pick<RouteInput, 'setupFailures'> {
  const failures = registry.setupFailures?.(tenantId) ?? [];
  return failures.length > 0 ? { setupFailures: failures } : {};
}

/**
 * The registry a turn resolves its tools on: its project's reach when the
 * registry knows projects (`forProject`), else the tenant's own registry;
 * never one shared across concurrent turns of other tenants.
 */
export async function turnToolRegistry(ctx: TurnContext): Promise<ToolRegistry> {
  const registry = ctx.bindings.toolRegistry;
  return registry.forProject !== undefined
    ? registry.forProject({
        tenantId: ctx.input.tenantId,
        projectId: ctx.input.projectId,
        ...(ctx.input.orgId !== undefined && { orgId: ctx.input.orgId }),
      })
    : registry.forTenant(ctx.input.tenantId);
}

/**
 * The tenant's `kind` policy for the turn, or `undefined` without a
 * policy registry. A policy that can't be evaluated fails the turn with
 * `tenant-policy-unavailable`, its cause's message in the failure's:
 * running without it would skip the tenant's rules (its approvals, its
 * model routing, its cap on tool errors).
 */
async function evaluateTurnPolicy<Spec>(
  ctx: TurnContext,
  kind: 'hitl' | 'model-routing' | 'tool-errors',
): Promise<Spec | undefined> {
  if (ctx.bindings.policyRegistry === undefined) return undefined;
  try {
    return await ctx.bindings.policyRegistry.evaluate<
      { readonly tenantId: typeof ctx.input.tenantId },
      Spec | undefined
    >(kind, { tenantId: ctx.input.tenantId });
  } catch (cause) {
    // Work a budget kept per tenant refused isn't the policy's failure: the turn answers for it.
    if (cause instanceof TenantBudgetError) throw cause;
    throwAgentTurnFailure({
      code: 'tenant-policy-unavailable',
      message: `The tenant's ${kind} policy could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
      policyKind: kind,
    });
  }
}

/** The turn's approval rules: the agent's, held to the tenant's `hitl` policy. */
export async function resolveTurnHitlPolicy(ctx: TurnContext): Promise<EffectiveHitlPolicy> {
  const tenant = await evaluateTurnPolicy<HitlSpec>(ctx, 'hitl');
  return resolveEffectiveHitlPolicy({ tenant, agent: ctx.input.agent });
}

/** The agent's `toolErrors`, capped by the tenant's `tool-errors` policy. */
async function resolveToolErrorPolicy(ctx: TurnContext): Promise<ToolErrorPolicy> {
  const cap = await evaluateTurnPolicy<ToolErrorsSpec>(ctx, 'tool-errors');
  return effectiveToolErrorPolicy(ctx.input.agent.toolErrors, cap);
}
