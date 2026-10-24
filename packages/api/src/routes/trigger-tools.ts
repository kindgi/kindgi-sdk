// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Agent } from '@kindgi/agents';
import { emitAuditEvent } from '@kindgi/compliance';
import { type Flow, type FlowNode, isFanoutNode, isLoopNode, isSubflowNode } from '@kindgi/flow';
import type { AgentId, FlowId, ProjectId, Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import type { TriggerTarget } from '../trigger-binding.js';

type EmitAuditEventArgs = Parameters<typeof emitAuditEvent>[0];

/**
 * A webhook's or a schedule's `toolsAllowedUnattended`: the tools, by id,
 * whose calls in its runs don't wait for a person's yes though no person
 * started them (a tool's `needsApprovalWhenUnattended`). The routes share
 * these rules:
 *
 * - each tool by its id, no wildcard or pattern, each once;
 * - setting or changing it, at register too, takes `admin` on the
 *   trigger's project (a body that names it, `[]` included);
 * - each id must be one the target can call (`toolsTargetCanCall`), so a
 *   typo is refused rather than lifting nothing; an improvement pass calls
 *   no tools, so its list can only be empty;
 * - every change is audited (`trigger-tools-allowed-unattended-set`).
 *
 * It lifts only that wait: the tenant's approval floor, the agent's own
 * rules, the permission check (as the trigger's owner) and the tool's own
 * limits all still apply. Never on a take-over (`/owner`), which keeps it.
 */
export const TOOLS_ALLOWED_UNATTENDED_FIELD = 'toolsAllowedUnattended';

/** The most ids one list takes. */
export const TOOLS_ALLOWED_UNATTENDED_MAX = 100;

/** What isn't a tool id: a wildcard or a pattern's characters, whitespace and control characters. */
const NOT_A_TOOL_ID = /[*?[\]{}\s\p{Cc}]/u;

/** The field as a body names it: absent, a list, or why it's refused. */
export type ParsedToolsAllowed =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly value: readonly string[] }
  | { readonly kind: 'err'; readonly message: string };

/** Reads `toolsAllowedUnattended` from a request body. */
export function parseToolsAllowedUnattended(body: Record<string, unknown>): ParsedToolsAllowed {
  if (!(TOOLS_ALLOWED_UNATTENDED_FIELD in body)) return { kind: 'absent' };
  const raw = body[TOOLS_ALLOWED_UNATTENDED_FIELD];
  if (!Array.isArray(raw)) {
    return { kind: 'err', message: '`toolsAllowedUnattended` must be a list of tool ids' };
  }
  if (raw.length > TOOLS_ALLOWED_UNATTENDED_MAX) {
    return {
      kind: 'err',
      message: `\`toolsAllowedUnattended\` takes at most ${TOOLS_ALLOWED_UNATTENDED_MAX} tool ids`,
    };
  }
  const seen = new Set<string>();
  for (const [i, id] of raw.entries()) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      return { kind: 'err', message: `\`toolsAllowedUnattended[${i}]\` must be a tool id` };
    }
    if (NOT_A_TOOL_ID.test(id)) {
      return {
        kind: 'err',
        message: `\`toolsAllowedUnattended[${i}]\` ("${id}") isn't a tool id: name each tool by its id, with no wildcard or pattern`,
      };
    }
    if (seen.has(id)) {
      return {
        kind: 'err',
        message: `\`toolsAllowedUnattended[${i}]\` ("${id}") is named twice`,
      };
    }
    seen.add(id);
  }
  return { kind: 'ok', value: raw as string[] };
}

/** Where a target's agents and flows are read, to tell which tools it calls. */
export interface TargetToolsDeps {
  readonly agents?: Pick<AgentRegistryBinding, 'get' | 'getVersion'>;
  readonly flows?: Pick<FlowRegistryBinding, 'getVersion'>;
}

/** Subflows followed from one target, at most: a guard against a cycle the loader missed. */
const MAX_FLOWS = 64;

/**
 * Every tool `target` can call, by id: an agent's tools (at its version,
 * else its latest); a flow's tool nodes and fan-out branches, in loop
 * bodies too, its agent nodes' agents' tools (at the node's version, else
 * the flow version's pin, else the latest) and its subflows', at their
 * versions. `undefined` when the target can't be read (no registry, or no
 * such agent or flow version). An improvement pass calls none.
 */
export async function toolsTargetCanCall(
  deps: TargetToolsDeps | undefined,
  tenantId: TenantId,
  target: TriggerTarget,
): Promise<ReadonlySet<string> | undefined> {
  if (target.kind === 'improve') return new Set();
  if (target.kind === 'agent') {
    const agent = await agentAt(
      deps,
      tenantId,
      target.agentId as unknown as string,
      target.agentVersion,
    );
    return agent === undefined ? undefined : new Set(agentToolIds(agent));
  }
  const root = await flowAt(deps, tenantId, target.flowId as unknown as string, target.flowVersion);
  if (root === undefined) return undefined;
  const walk: FlowWalk = {
    tools: new Set(),
    seen: new Set([`${target.flowId as unknown as string}@${target.flowVersion}`]),
  };
  const pending: Flow[] = [root];
  while (pending.length > 0) {
    const flow = pending.shift() as Flow;
    for (const leaf of leaves(flow.nodes)) {
      const sub = await visitLeaf(deps, tenantId, flow, leaf, walk);
      if (sub !== undefined) pending.push(sub);
    }
  }
  return walk.tools;
}

/** The tools a flow walk has found, and the subflow versions it has followed (`id@version`). */
interface FlowWalk {
  readonly tools: Set<string>;
  readonly seen: Set<string>;
}

/** Adds what one leaf of `flow` calls to the walk; a subflow version not followed yet comes back, to walk. */
async function visitLeaf(
  deps: TargetToolsDeps | undefined,
  tenantId: TenantId,
  flow: Flow,
  leaf: Leaf,
  walk: FlowWalk,
): Promise<Flow | undefined> {
  if (leaf.kind === 'tool') {
    walk.tools.add(leaf.id);
    return undefined;
  }
  if (leaf.kind === 'agent') {
    const version = leaf.version ?? flow.pins?.agents[leaf.id];
    const agent = await agentAt(deps, tenantId, leaf.id, version);
    for (const id of agent === undefined ? [] : agentToolIds(agent)) walk.tools.add(id);
    return undefined;
  }
  const key = `${leaf.id}@${leaf.version}`;
  if (walk.seen.has(key) || walk.seen.size >= MAX_FLOWS) return undefined;
  walk.seen.add(key);
  return flowAt(deps, tenantId, leaf.id, leaf.version);
}

type Leaf =
  | { readonly kind: 'tool'; readonly id: string }
  | { readonly kind: 'agent'; readonly id: string; readonly version?: string }
  | { readonly kind: 'subflow'; readonly id: string; readonly version: string };

/** A flow's tools, agents and subflows, in loop bodies too. */
function leaves(nodes: readonly FlowNode[]): Leaf[] {
  const found: Leaf[] = [];
  for (const node of nodes) {
    if (isLoopNode(node)) found.push(...leaves(node.body.nodes));
    else if (isFanoutNode(node)) {
      for (const branch of node.branches) found.push({ kind: 'tool', id: branch.handler });
    } else if (isSubflowNode(node)) {
      found.push({ kind: 'subflow', id: node.flowRef.flowId, version: node.flowRef.version });
    } else if (node.kind === 'tool') found.push({ kind: 'tool', id: node.ref });
    else {
      const version = node.config?.version;
      found.push({
        kind: 'agent',
        id: node.ref,
        ...(typeof version === 'string' && { version }),
      });
    }
  }
  return found;
}

/** An agent's tool ids: a deployment's index carries agents as authored, so `tools` may be absent. */
function agentToolIds(agent: Agent): string[] {
  return (agent.tools ?? []).map((tool) => tool.id as unknown as string);
}

async function agentAt(
  deps: TargetToolsDeps | undefined,
  tenantId: TenantId,
  agentId: string,
  version: string | undefined,
): Promise<Agent | undefined> {
  if (deps?.agents === undefined) return undefined;
  const found =
    version === undefined
      ? await deps.agents.get({ tenantId, agentId: agentId as AgentId })
      : await deps.agents.getVersion({
          tenantId,
          agentId: agentId as AgentId,
          version: version as Semver,
        });
  return found ?? undefined;
}

async function flowAt(
  deps: TargetToolsDeps | undefined,
  tenantId: TenantId,
  flowId: string,
  version: string,
): Promise<Flow | undefined> {
  if (deps?.flows === undefined) return undefined;
  const found = await deps.flows.getVersion({ tenantId, flowId: flowId as FlowId, version });
  return found ?? undefined;
}

/** A target as a message names it. */
function targetName(target: TriggerTarget): string {
  switch (target.kind) {
    case 'flow':
      return `flow "${target.flowId as unknown as string}" at ${target.flowVersion}`;
    case 'agent':
      return target.agentVersion === undefined
        ? `agent "${target.agentId as unknown as string}"`
        : `agent "${target.agentId as unknown as string}" at ${target.agentVersion}`;
    case 'improve':
      return 'an improvement pass';
  }
}

/**
 * Why `tools` can't be the list of a trigger that runs `target` (a
 * `bad-input` message), or `undefined` when it can: an improvement pass
 * calls no tools, so only `[]`; else each id must be one the target can
 * call. An empty list is always fine.
 */
export async function toolsAllowedUnattendedProblem(
  deps: TargetToolsDeps | undefined,
  tenantId: TenantId,
  target: TriggerTarget,
  tools: readonly string[],
): Promise<string | undefined> {
  if (tools.length === 0) return undefined;
  if (target.kind === 'improve') {
    return 'an improvement pass calls no tools: its `toolsAllowedUnattended` can only be empty';
  }
  const callable = await toolsTargetCanCall(deps, tenantId, target);
  if (callable === undefined) {
    return `\`toolsAllowedUnattended\`: can't read ${targetName(target)} to check the tools it calls`;
  }
  const uncallable = tools.filter((id) => !callable.has(id));
  return uncallable.length === 0
    ? undefined
    : `\`toolsAllowedUnattended\`: ${targetName(target)} doesn't call ${uncallable.map((id) => `"${id}"`).join(', ')}`;
}

/** Whether two lists name the same tools (order aside). */
export function sameToolList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Whether `next` runs another item than `current` (another kind or id; a version alone isn't). */
export function retargets(current: TriggerTarget, next: TriggerTarget): boolean {
  if (current.kind !== next.kind) return true;
  if (current.kind === 'flow' && next.kind === 'flow') return current.flowId !== next.flowId;
  return (current as { agentId: unknown }).agentId !== (next as { agentId: unknown }).agentId;
}

/** A target as the audit names it. */
function targetDoc(target: TriggerTarget): Record<string, string> {
  switch (target.kind) {
    case 'flow':
      return {
        kind: 'flow',
        id: target.flowId as unknown as string,
        version: target.flowVersion,
      };
    case 'agent':
      return {
        kind: 'agent',
        id: target.agentId as unknown as string,
        ...(target.agentVersion !== undefined && { version: target.agentVersion }),
      };
    case 'improve':
      return { kind: 'improve', id: target.agentId as unknown as string };
  }
}

/**
 * Records a trigger's `toolsAllowedUnattended` being set: at register
 * (no `from`), and at every update that changes it or, with a non-empty
 * list, its target. The one place the `trigger-tools-allowed-unattended-set`
 * evidence is shaped.
 */
export async function recordToolsAllowedUnattendedSet(args: {
  readonly auditEvents: EmitAuditEventArgs['auditEvents'];
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly triggerId: string;
  readonly triggerKind: 'webhook' | 'cron';
  readonly target: TriggerTarget;
  readonly from?: readonly string[];
  readonly to: readonly string[];
  readonly by: string | undefined;
  readonly correlationId: string;
  readonly log: EmitAuditEventArgs['log'];
}): Promise<void> {
  const { auditEvents, tenantId, projectId, triggerId, triggerKind, target, from, to, by } = args;
  await emitAuditEvent({
    auditEvents,
    tenantId,
    ...(projectId !== undefined && { projectId }),
    kind: 'trigger-tools-allowed-unattended-set',
    ...(by !== undefined && { actor: by }),
    correlationId: args.correlationId,
    doc: {
      triggerId,
      triggerKind,
      target: targetDoc(target),
      ...(projectId !== undefined && { projectId }),
      ...(from !== undefined && { from: [...from] }),
      to: [...to],
      ...(by !== undefined && { by }),
    },
    ...(args.log !== undefined && { log: args.log }),
  });
}
