// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a judged flow run did, kept when it's first judged so it can be
 * replayed faithfully later: every tool call it made, with its result,
 * at its tool nodes, in its agent steps' turns, and in its sub-flows.
 * A replay of the run uses these as the past run's results. Best effort
 * and read-only: a part that can't be read is left out, and the judgment
 * never fails over it.
 */

import type { Flow, FlowNode } from '@kindgi/flow';
import { isFanoutNode, isLoopNode } from '@kindgi/flow';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { FlowId, RunId, TenantId } from '@kindgi/types';

import type { FlowRegistryBinding } from '../flow-binding.js';
import type {
  JudgedFlowContext,
  JudgedFlowStep,
  JudgedRunContext,
  JudgedToolCall,
} from '../judgment-binding.js';

/** The most tool calls a judged flow run keeps. */
export const MAX_JUDGED_FLOW_CALLS = 500;
/** How deep into sub-flows the capture goes. */
const MAX_FLOW_DEPTH = 3;
/** The most child runs read per run. */
const MAX_CHILDREN = 100;

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The tool each tool node runs, by node id: in loop bodies and fanout branches too. */
function toolNodes(flow: Flow | null): ReadonlyMap<string, string> {
  const tools = new Map<string, string>();
  const walk = (nodes: readonly FlowNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'tool') tools.set(node.id as unknown as string, node.ref);
      else if (isLoopNode(node)) walk(node.body.nodes);
      else if (isFanoutNode(node)) {
        for (const b of node.branches) tools.set(b.handler as unknown as string, b.handler);
      }
    }
  };
  if (flow !== null) walk(flow.nodes);
  return tools;
}

/**
 * The tool calls an agent turn made, with their results, from its
 * output's `appended` messages: each agent message's `toolCalls`, paired
 * with the `tool` message that answered it.
 */
export function turnToolCalls(
  output: unknown,
): readonly { readonly toolId: string; readonly arguments: unknown; readonly result: unknown }[] {
  const appended = obj(output)?.appended;
  if (!Array.isArray(appended)) return [];
  const args = new Map<string, unknown>();
  for (const m of appended) {
    const calls = obj(obj(m)?.content)?.toolCalls;
    if (obj(m)?.role !== 'agent' || !Array.isArray(calls)) continue;
    for (const call of calls) {
      const id = obj(call)?.id;
      if (typeof id === 'string') args.set(id, obj(call)?.arguments);
    }
  }
  return appended.flatMap((m) => {
    const toolCall = obj(obj(m)?.toolCall);
    const toolId = toolCall?.toolId;
    const invocationId = toolCall?.invocationId;
    if (obj(m)?.role !== 'tool' || typeof toolId !== 'string' || typeof invocationId !== 'string') {
      return [];
    }
    return args.has(invocationId)
      ? [{ toolId, arguments: args.get(invocationId), result: obj(m)?.content }]
      : [];
  });
}

/** Where a step sits: its loop iteration, when it's in a loop body. */
function scopeOf(loopContext: unknown): string | undefined {
  return loopContext === undefined || loopContext === null
    ? undefined
    : JSON.stringify(loopContext);
}

class Collector {
  readonly calls: JudgedToolCall[] = [];
  readonly steps: JudgedFlowStep[] = [];
  truncated = false;

  add(call: JudgedToolCall): void {
    if (this.calls.length >= MAX_JUDGED_FLOW_CALLS) {
      this.truncated = true;
      return;
    }
    this.calls.push(call);
  }
}

interface Reader {
  readonly tenantId: TenantId;
  readonly runBinding: RunBinding;
  readonly flows: FlowRegistryBinding | undefined;
}

/** A flow run's tool nodes' calls: each `step.completed` of a tool node, with its `step.started` input. */
async function nodeCalls(
  r: Reader,
  c: Collector,
  run: { readonly runId: string; readonly flowId: string; readonly flowVersion: string },
): Promise<void> {
  const [flow, journal] = await Promise.all([
    r.flows?.getVersion({
      tenantId: r.tenantId,
      flowId: run.flowId as FlowId,
      version: run.flowVersion,
    }) ?? Promise.resolve(null),
    r.runBinding.readJournal(r.tenantId, run.runId as RunId),
  ]);
  const tools = toolNodes(flow);
  if (journal.kind === 'err' || tools.size === 0) return;
  const inputs = new Map<string, unknown>();
  for (const e of journal.value) {
    if (typeof e.nodeId !== 'string' || !tools.has(e.nodeId)) continue;
    const payload = obj(e.payload) ?? {};
    const scope = scopeOf(payload.loopContext);
    const key = `${e.nodeId}\u0000${scope ?? ''}`;
    if (e.kind === 'step.started') inputs.set(key, payload.input);
    if (e.kind === 'step.completed') {
      c.add({
        runId: run.runId,
        nodeId: e.nodeId,
        ...(scope !== undefined && { scope }),
        toolId: tools.get(e.nodeId) as string,
        arguments: inputs.get(key),
        result: payload.output,
      });
    }
  }
}

/** An agent step's turn: its calls, and what it retrieved. */
async function stepTurn(r: Reader, c: Collector, child: KernelRunRecord): Promise<void> {
  const agent = child.agent;
  if (agent === undefined) return;
  const output =
    child.output ?? (await r.runBinding.getRun(r.tenantId, child.runId))?.output ?? undefined;
  const nodeId = (child.parentNodeId as unknown as string | null | undefined) ?? undefined;
  const scope = child.parentScope ?? undefined;
  const retrieved = obj(output)?.retrieved;
  c.steps.push({
    runId: child.runId as unknown as string,
    ...(nodeId !== undefined && { nodeId }),
    ...(scope !== undefined && scope !== '' && { scope }),
    agentId: agent.id,
    agentVersion: agent.version,
    ...(retrieved !== undefined && { retrieved }),
  });
  for (const call of turnToolCalls(output)) {
    c.add({
      runId: child.runId as unknown as string,
      ...(nodeId !== undefined && { nodeId }),
      ...(scope !== undefined && scope !== '' && { scope }),
      ...call,
    });
  }
}

/** A run's child runs (agent steps' turns, sub-flows); none when they can't be read. */
async function childrenOf(r: Reader, runId: string): Promise<readonly KernelRunRecord[]> {
  try {
    const page = await r.runBinding.listRuns({
      tenantId: r.tenantId,
      parent: { runId: runId as RunId },
      limit: MAX_CHILDREN,
    });
    return page.data;
  } catch {
    return [];
  }
}

async function collectRun(
  r: Reader,
  c: Collector,
  run: { readonly runId: string; readonly flowId: string; readonly flowVersion: string },
  depth: number,
): Promise<void> {
  await nodeCalls(r, c, run).catch(() => undefined);
  for (const child of await childrenOf(r, run.runId)) {
    if (child.agent !== undefined) {
      await stepTurn(r, c, child).catch(() => undefined);
    } else if (depth < MAX_FLOW_DEPTH) {
      await collectRun(
        r,
        c,
        {
          runId: child.runId as unknown as string,
          flowId: child.flowId,
          flowVersion: child.flowVersion,
        },
        depth + 1,
      );
    }
  }
}

/**
 * What a judged flow run did (`context.flow`): its tool calls with their
 * results, and its agent steps' turns. `undefined` when nothing could be
 * read.
 */
export async function captureFlowContext(input: {
  readonly tenantId: TenantId;
  readonly run: { readonly runId: string; readonly flowId: string; readonly flowVersion: string };
  readonly runBinding: RunBinding;
  readonly flows: FlowRegistryBinding | undefined;
}): Promise<JudgedRunContext | undefined> {
  const c = new Collector();
  try {
    await collectRun(
      { tenantId: input.tenantId, runBinding: input.runBinding, flows: input.flows },
      c,
      input.run,
      0,
    );
  } catch {
    // Best effort: keep what was read.
  }
  if (c.calls.length === 0 && c.steps.length === 0) return undefined;
  const flow: JudgedFlowContext = {
    calls: c.calls,
    steps: c.steps,
    ...(c.truncated && { truncated: true }),
  };
  return { flow };
}
