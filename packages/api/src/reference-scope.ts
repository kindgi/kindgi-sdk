// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a project's flows, agents, triggers and runs may reference: an
 * item the deployment says the project reaches. The deployment decides
 * the rule (the Kindgi runtime: an item of the same project, or an MCP
 * endpoint scoped to it, its org or the tenant); the routes ask it before
 * they write, and refuse a reference it doesn't reach with
 * `reference-out-of-scope` (400), naming each one.
 *
 * One answer for an item that doesn't exist and one that isn't reachable,
 * so a refusal never tells a caller what other projects hold.
 *
 * Absent from `CreateAppInput`: every reference is taken as it is today
 * (for a deployment without projects).
 */

import type { Agent } from '@kindgi/agents';
import { type Flow, type FlowNode, isFanoutNode, isLoopNode, isSubflowNode } from '@kindgi/flow';
import type { AgentPinScope, ProjectId, TenantId } from '@kindgi/types';

import type { TriggerTarget } from '@kindgi/runtime';
import type { Context } from 'hono';

import { blockRefs } from './block-pins.js';
import { statusFor, toWireError } from './errors.js';

/** The kinds of item a flow, agent, trigger or run can reference. */
export type ReferenceKind =
  | 'tool'
  | 'agent'
  | 'flow'
  | 'guardrail'
  | 'block'
  | 'check'
  | 'test-set';

export interface ItemReference {
  readonly kind: ReferenceKind;
  readonly id: string;
  /**
   * One version of an agent, flow or test set, when the reference is to
   * that version: reached when a run in the project may run that version
   * (where it was made, or what reached the project with a build). Absent:
   * the item itself, by its id.
   */
  readonly version?: string;
}

export interface ReferenceScopeBinding {
  /** Whether a run in `fromProjectId` may reach `ref`. */
  reachable(input: {
    readonly tenantId: TenantId;
    readonly fromProjectId: ProjectId;
    readonly ref: ItemReference;
  }): Promise<boolean>;
}

/** The `reference-out-of-scope` refusal: each reference, at the path it was named. */
export interface ReferenceOutOfScopeError {
  readonly code: 'reference-out-of-scope';
  readonly message: string;
  readonly issues: readonly {
    readonly path: string;
    readonly kind: ReferenceKind;
    readonly id: string;
    readonly message: string;
  }[];
}

const NOUN: Readonly<Record<ReferenceKind, string>> = {
  tool: 'tool',
  agent: 'agent',
  flow: 'flow',
  guardrail: 'guardrail',
  block: 'data block',
  check: 'check',
  'test-set': 'test set',
};

/**
 * The references `scope` doesn't reach from `fromProjectId`, as the
 * refusal to send, or `undefined` when it reaches them all (or there's no
 * `scope`). Each distinct reference is asked once.
 */
export async function referencesOutOfScope(
  scope: ReferenceScopeBinding | undefined,
  tenantId: TenantId,
  fromProjectId: ProjectId,
  refs: readonly (ItemReference & { readonly path: string })[],
): Promise<ReferenceOutOfScopeError | undefined> {
  if (scope === undefined || refs.length === 0) return undefined;
  const answers = new Map<string, Promise<boolean>>();
  const issues: ReferenceOutOfScopeError['issues'][number][] = [];
  const refused: ItemReference[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}@${ref.version ?? ''}`;
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = scope.reachable({
        tenantId,
        fromProjectId,
        ref: {
          kind: ref.kind,
          id: ref.id,
          ...(ref.version !== undefined && { version: ref.version }),
        },
      });
      answers.set(key, answer);
    }
    if (!(await answer)) {
      issues.push({
        path: ref.path,
        kind: ref.kind,
        id: ref.id,
        message: `${named(ref)} ${refusedBecause(ref)}`,
      });
      refused.push(ref);
    }
  }
  if (issues.length === 0) return undefined;
  const first = refused[0] as ItemReference;
  return {
    code: 'reference-out-of-scope',
    message:
      issues.length === 1
        ? `This project can't reference ${named(first)}: it ${refusedBecause(first)}`
        : `This project can't reference ${issues.length} of the items named (${refused.map(named).join(', ')}): none is ${REGISTERED}${refused.some((r) => r.version !== undefined) ? ', and no version named is deployed to it' : ''}`,
    issues,
  };
}

/** `agent "acme.desk"`, with its version when the reference is to one (`agent "acme.desk" 1.1.0`). */
function named(ref: ItemReference): string {
  return `${NOUN[ref.kind]} "${ref.id}"${ref.version !== undefined ? ` ${ref.version}` : ''}`;
}

const REGISTERED = 'registered in this project, its org or the tenant';

/**
 * Why a reference is refused. A version may be of an item the project has
 * elsewhere in its environment order (made in an earlier environment, not
 * yet promoted), so it says the version is what the project doesn't run.
 */
function refusedBecause(ref: ItemReference): string {
  return ref.version === undefined
    ? `isn't ${REGISTERED}`
    : `isn't a version this project runs (not ${REGISTERED}, nor deployed to it)`;
}

/**
 * Every item a flow names, at the path it's named: tool nodes and fanout
 * branches (tools), agent nodes, subflows, in loop bodies too.
 */
export function flowReferences(flow: Flow): (ItemReference & { readonly path: string })[] {
  const refs: (ItemReference & { readonly path: string })[] = [];
  const walk = (nodes: readonly FlowNode[], at: string): void => {
    for (const node of nodes) {
      const path = `${at}nodes/${node.id as unknown as string}`;
      if (isLoopNode(node)) walk(node.body.nodes, `${path}/body/`);
      else if (isFanoutNode(node)) {
        for (const branch of node.branches) {
          refs.push({
            path: `${path}/branches/${branch.branchId}`,
            kind: 'tool',
            id: branch.handler,
          });
        }
      } else if (isSubflowNode(node)) {
        refs.push({ path, kind: 'flow', id: node.flowRef.flowId });
      } else if (node.kind === 'tool') refs.push({ path, kind: 'tool', id: node.ref });
      else if (node.kind === 'agent') refs.push({ path, kind: 'agent', id: node.ref });
    }
  };
  walk(flow.nodes, '/');
  return refs;
}

/** Every item an agent names, at the path it's named: its tools, guardrails and data blocks. */
export function agentReferences(agent: Agent): (ItemReference & { readonly path: string })[] {
  return [
    // A deployment's index carries agents as authored: either list may be absent.
    ...(agent.tools ?? []).map((tool, i) => ({
      path: `/tools/${i}`,
      kind: 'tool' as const,
      id: tool.id,
    })),
    ...(agent.guardrails ?? []).map((id, i) => ({
      path: `/guardrails/${i}`,
      kind: 'guardrail' as const,
      id,
    })),
    ...blockRefs(agent).map((ref) => ({ path: ref.path, kind: 'block' as const, id: ref.id })),
  ];
}

/**
 * A tool's `metadata` keys under `kindgi.`: the runtime's own (its MCP
 * catalog writes them), never a published tool's. The tool and
 * deployment routes refuse a manifest that sets one.
 */
export function reservedToolMetadataKeys(metadata: unknown): string[] {
  if (metadata === null || typeof metadata !== 'object') return [];
  return Object.keys(metadata).filter((key) => key.startsWith('kindgi.'));
}

/** The message for a reserved metadata key, the same from every route. */
export function reservedToolMetadataMessage(key: string): string {
  return `metadata "${key}": keys under "kindgi." are the runtime's own; a published tool can't set them`;
}

/**
 * What a trigger (a schedule, a webhook, an event trigger) runs, as a
 * reference: a flow at its version, an agent at the version it names (none:
 * whichever its project runs), an Improve run's agent by its id.
 */
export function triggerTargetReference(target: TriggerTarget): ItemReference {
  if (target.kind === 'flow') {
    return { kind: 'flow', id: target.flowId as unknown as string, version: target.flowVersion };
  }
  return {
    kind: 'agent',
    id: target.agentId as unknown as string,
    ...(target.kind === 'agent' &&
      target.agentVersion !== undefined && { version: target.agentVersion }),
  };
}

/** The `reference-out-of-scope` answer (400), the same from every route. */
export function outOfScopeResponse(
  c: Context,
  requestId: string,
  err: ReferenceOutOfScopeError,
): Response {
  c.status(statusFor(err.code) as never);
  return c.json(
    toWireError(
      {
        code: err.code,
        message: err.message,
        issues: err.issues as unknown as Record<string, unknown>[],
      },
      requestId,
    ),
  );
}

/**
 * Whether pinning `agentId` for `scope` stays within the scope's
 * project: a project or segment scope must reach the agent. A tenant or
 * org scope isn't checked (other projects can't name the agent anyway).
 */
export async function agentPinScopeOutOfScope(
  scope: ReferenceScopeBinding | undefined,
  tenantId: TenantId,
  agentId: string,
  pinScope: AgentPinScope,
): Promise<ReferenceOutOfScopeError | undefined> {
  if (pinScope.kind !== 'project' && pinScope.kind !== 'segment') return undefined;
  return referencesOutOfScope(scope, tenantId, pinScope.projectId, [
    { path: '/scope', kind: 'agent', id: agentId },
  ]);
}
