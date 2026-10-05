// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The provenance nodes and edges an agent turn records, in one place:
 * the steps add them as they run, and a turn resumed after a park
 * (`rehydrate.ts`) adds those of the steps that ran before it from what
 * they left durable (the conversation, the journal). Either way the DAG
 * is the same.
 */

import type { ProvenanceBuilder } from '@kindgi/provenance';
import type { Timestamp } from '@kindgi/types';

import type { ConversationMessage, RetrievedFact } from '../types.js';
import type { TurnContext } from './context.js';
import type { GateDecision } from './gate-decision.js';

/** The turn's user message. */
export function addInputNode(provenance: ProvenanceBuilder, message: ConversationMessage): void {
  provenance.addNode({
    id: `input:${message.sequence}`,
    kind: 'input',
    timestamp: message.createdAt,
    ...(message.actor !== undefined && { actor: message.actor }),
  });
}

/** The facts the turn retrieved for its user message. */
export function addRetrievalNodes(
  provenance: ProvenanceBuilder,
  retrieved: readonly RetrievedFact[],
  input: ConversationMessage,
): void {
  for (const r of retrieved) {
    provenance.addNode({
      id: `retrieval:${r.fact.id}`,
      kind: 'retrieval',
      timestamp: input.createdAt,
      ...(r.fact.contentHash !== undefined && { contentHash: r.fact.contentHash }),
      attributes: {
        factId: r.fact.id,
        factType: r.fact.type,
        intentScope: r.intent.scope,
        ...(r.score !== undefined && { score: r.score }),
      },
    });
    provenance.addEdge({
      from: `retrieval:${r.fact.id}`,
      to: `input:${input.sequence}`,
      kind: 'influenced-by',
    });
  }
}

/** One model call: its identity; its usage is the cost ledger's, by `callId`. */
export interface ModelCallFacts {
  readonly step: number;
  readonly callId: string;
  readonly provider: { readonly id: string; readonly model: string };
  readonly finishReason: string;
  readonly at: Timestamp;
}

/**
 * A model call, `caused-by` the turn's user message and `influenced-by`
 * each of this turn's tool results it read: all of them so far, since
 * the call's input holds every message of the turn before it.
 */
export function addModelCallNode(
  provenance: ProvenanceBuilder,
  call: ModelCallFacts,
  inputSequence: number,
  toolResultIds: readonly string[],
): void {
  const id = `model-call:${call.step}`;
  provenance.addNode({
    id,
    kind: 'model-call',
    timestamp: call.at,
    modelVersion: `${call.provider.id}/${call.provider.model}`,
    attributes: {
      step: call.step,
      callId: call.callId,
      providerId: call.provider.id,
      model: call.provider.model,
      finishReason: call.finishReason,
    },
  });
  provenance.addEdge({ from: id, to: `input:${inputSequence}`, kind: 'caused-by' });
  for (const invocationId of toolResultIds) {
    provenance.addEdge({ from: id, to: `tool-result:${invocationId}`, kind: 'influenced-by' });
  }
}

/**
 * A tool call the model at `step` made, and its result: the stored tool
 * message (a tool's output, a rejected approval's, or a failed call's).
 * `version` is the tool the agent's binding resolved, when it has one.
 */
export function addToolNodes(
  provenance: ProvenanceBuilder,
  step: number,
  result: ConversationMessage,
  version: { readonly resolvedVersion: string; readonly requestedRange: string } | undefined,
): void {
  const call = result.toolCall;
  if (call === undefined) return;
  const callNodeId = `tool-call:${call.invocationId}`;
  const resultNodeId = `tool-result:${call.invocationId}`;
  provenance.addNode({
    id: callNodeId,
    kind: 'tool-call',
    timestamp: result.createdAt,
    attributes: {
      toolId: call.toolId,
      invocationId: call.invocationId,
      // The version the registry picked for the turn and the range the
      // agent asked for, so a replay can pin against the same version.
      ...(version !== undefined && {
        toolVersion: version.resolvedVersion,
        toolVersionRange: version.requestedRange,
      }),
    },
  });
  provenance.addNode({ id: resultNodeId, kind: 'tool-result', timestamp: result.createdAt });
  provenance.addEdge({ from: callNodeId, to: `model-call:${step}`, kind: 'invoked' });
  provenance.addEdge({ from: resultNodeId, to: callNodeId, kind: 'produced' });
}

/**
 * The tool calls of one model step: a node pair for each result the step
 * stored, and their invocation ids added to the turn's tool results.
 */
export function addStepToolNodes(
  ctx: TurnContext,
  step: number,
  stored: readonly ConversationMessage[],
): void {
  for (const result of stored) {
    if (result.role !== 'tool' || result.toolCall === undefined) continue;
    const { invocationId, toolId } = result.toolCall;
    if (ctx.provenance !== undefined) {
      addToolNodes(ctx.provenance, step, result, versionOf(ctx, toolId));
      const approval = ctx.toolApprovals?.get(invocationId);
      if (approval !== undefined) {
        addToolApprovalNodes(
          ctx.provenance,
          invocationId,
          approval,
          ctx.input.agent.id as unknown as string,
        );
      }
    }
    ctx.toolResultIds ??= [];
    ctx.toolResultIds.push(invocationId);
  }
}

/** A tool call's approval, decided: the wait it parked on and the answer. */
export interface ToolApproval {
  readonly waitTokenId: string;
  /** When the call parked on the approval. */
  readonly parkedAt: Timestamp;
  /** When the decision reached the run. */
  readonly decidedAt: Timestamp;
  readonly decision: GateDecision;
}

/**
 * The approval a tool call waited on, as the session gate records its own:
 * a `wait` node (the agent parked) `resumed-from` a `resume` node (the
 * decision, its actor whoever decided). The call `waited-on` the wait, and
 * its result was `caused-by` the decision: the tool's output when approved,
 * the rejection when not.
 */
export function addToolApprovalNodes(
  provenance: ProvenanceBuilder,
  invocationId: string,
  approval: ToolApproval,
  agentId: string,
): void {
  const waitId = `tool-hitl-gate-wait:${invocationId}`;
  const resumeId = `tool-hitl-gate-resume:${invocationId}`;
  const { decision } = approval;
  provenance.addNode({
    id: waitId,
    kind: 'wait',
    timestamp: approval.parkedAt,
    actor: `agent:${agentId}`,
    attributes: { gate: 'tool-call', invocationId, waitTokenId: approval.waitTokenId },
  });
  provenance.addNode({
    id: resumeId,
    kind: 'resume',
    timestamp: approval.decidedAt,
    ...(decision.decidedBy !== undefined && { actor: decision.decidedBy }),
    attributes: {
      gate: 'tool-call',
      decision: decisionOf(decision),
      ...(!decision.approved &&
        decision.reason === 'rejected' &&
        decision.rationale !== undefined && { rationale: decision.rationale }),
      ...(decision.approvalId !== undefined && { approvalId: decision.approvalId }),
    },
  });
  provenance.addEdge({ from: `tool-call:${invocationId}`, to: waitId, kind: 'waited-on' });
  provenance.addEdge({ from: waitId, to: resumeId, kind: 'resumed-from' });
  provenance.addEdge({ from: `tool-result:${invocationId}`, to: resumeId, kind: 'caused-by' });
}

/** A gate decision as a `resume` node records it. */
export function decisionOf(decision: GateDecision): 'approve' | 'reject' | 'unreadable' {
  if (decision.approved) return 'approve';
  return decision.reason === 'rejected' ? 'reject' : 'unreadable';
}

/** The version the agent's binding of `toolId` resolved, if it has one. */
function versionOf(
  ctx: TurnContext,
  toolId: string,
): { readonly resolvedVersion: string; readonly requestedRange: string } | undefined {
  const bindings = [...(ctx.tools?.byName.values() ?? [])];
  const binding =
    ctx.tools?.byName.get(toolId) ??
    bindings.find((b) => (b.tool.id as unknown as string) === toolId);
  return binding === undefined
    ? undefined
    : { resolvedVersion: binding.resolvedVersion, requestedRange: binding.requestedRange };
}
