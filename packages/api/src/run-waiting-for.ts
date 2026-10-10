// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a suspended run is waiting for (`GET /v1/runs/{runId}`'s
 * `waitingFor`): its journal's open waits, and the approvals linked to them.
 * The same reading `kindgi runs resume` makes on the client, which falls
 * back to its own when a runtime doesn't answer this field.
 *
 * An approval on the run carries its identity and state only. Its
 * `subjectRef` is never passed on: a tool call's carries the call's input.
 * For a tool-call subject the run names the tool, field by field
 * (`tool: { id, version, callId }`). Everything else stays behind the
 * approvals routes' reviewer gate.
 */

import { TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { JournalEntry, RunBinding } from '@kindgi/runtime';
import type { RunId, TenantId } from '@kindgi/types';

import type { Approval, ApprovalStatus, HitlBinding } from './hitl-binding.js';

/** An approval the run waits for, as a run reader may see it. */
export interface WaitingForApproval {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly requiredRole: string;
  readonly title?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly subjectKind: string;
  /** For a tool-call subject: which call waits. Never its arguments. */
  readonly tool?: { readonly id: string; readonly version: string; readonly callId: string };
}

/** A wait that isn't an open approval: the run's own facts. */
export type WaitingForOther =
  | {
      readonly what: 'child-run';
      readonly childRunId: string;
      readonly childStatus?: string;
      readonly timesOutAt?: string;
    }
  | {
      readonly what: 'decided-approval';
      readonly approvalId: string;
      readonly approvalStatus: string;
    }
  | { readonly what: 'unattributed'; readonly tokenId: string; readonly timesOutAt?: string }
  | { readonly what: 'no-open-wait' };

export interface RunWaitingFor {
  readonly approvals: readonly WaitingForApproval[];
  readonly other: readonly WaitingForOther[];
}

/** An approval in one of these is still to be decided. */
const OPEN_APPROVAL: ReadonlySet<string> = new Set([
  'pending',
  'assigned',
  'in_review',
  'escalated',
]);

/**
 * What `run` (suspended) waits for, or `undefined` when it isn't suspended
 * or its journal can't be read (the field is then left out; a caller
 * falls back to its own reading). Approvals that can't be read leave their
 * waits `unattributed`.
 */
export async function runWaitingFor(
  deps: { readonly runBinding: RunBinding; readonly hitl?: HitlBinding },
  tenantId: TenantId,
  run: { readonly id: RunId; readonly status: string },
): Promise<RunWaitingFor | undefined> {
  if (run.status !== 'suspended') return undefined;
  const journal = await deps.runBinding.readJournal(tenantId, run.id);
  if (journal.kind === 'err') return undefined;
  const open = openWaits(journal.value);
  if (open.length === 0) return { approvals: [], other: [{ what: 'no-open-wait' }] };

  const children = open.filter((w) => childRunOf(w.tokenId) !== undefined);
  const tokens = open.filter((w) => childRunOf(w.tokenId) === undefined);
  const childWaits = await Promise.all(
    children.map((w) => childWait(deps.runBinding, tenantId, w)),
  );
  if (tokens.length === 0) return { approvals: [], other: childWaits };

  const linked = await linkedApprovals(
    deps.hitl,
    tenantId,
    tokens.map((w) => w.tokenId),
  );
  return {
    approvals: linked.filter((a) => OPEN_APPROVAL.has(a.status)).map(onTheRun),
    other: [...childWaits, ...decided(linked), ...unattributed(tokens, linked)],
  };
}

/** A wait on a child run, with the child's status when it can be read. */
async function childWait(
  runBinding: RunBinding,
  tenantId: TenantId,
  wait: OpenWait,
): Promise<WaitingForOther> {
  const childRunId = childRunOf(wait.tokenId) as string;
  const child = await runBinding.getRun(tenantId, childRunId as RunId).catch(() => null);
  return {
    what: 'child-run',
    childRunId,
    ...(child !== null && { childStatus: child.status }),
    ...(wait.timesOutAt !== undefined && { timesOutAt: wait.timesOutAt }),
  };
}

/** Linked approvals already decided: the runtime continues the run. */
function decided(linked: readonly Approval[]): WaitingForOther[] {
  return linked
    .filter((a) => !OPEN_APPROVAL.has(a.status))
    .map((a) => ({
      what: 'decided-approval',
      approvalId: a.id as unknown as string,
      approvalStatus: a.status,
    }));
}

/** Waits no approval is linked to. */
function unattributed(tokens: readonly OpenWait[], linked: readonly Approval[]): WaitingForOther[] {
  return tokens
    .filter((w) => !linked.some((a) => a.waitTokenId === w.tokenId))
    .map((w) => ({
      what: 'unattributed',
      tokenId: w.tokenId,
      ...(w.timesOutAt !== undefined && { timesOutAt: w.timesOutAt }),
    }));
}

/** The approvals linked to these waits; none when they can't be read. */
async function linkedApprovals(
  hitl: HitlBinding | undefined,
  tenantId: TenantId,
  tokenIds: readonly string[],
): Promise<readonly Approval[]> {
  if (hitl === undefined) return [];
  const listed = await hitl
    .listApprovals({ tenantId, limit: 100, waitTokenIds: tokenIds })
    .catch(() => undefined);
  if (listed === undefined || listed.kind === 'err') return [];
  // Kept only when linked to one of these waits, whatever the binding answers.
  return listed.value.approvals.filter(
    (a) => a.waitTokenId !== undefined && tokenIds.includes(a.waitTokenId),
  );
}

/** An approval as a run reader sees it: built field by field, never spread. */
function onTheRun(approval: Approval): WaitingForApproval {
  const tool = toolOf(approval);
  return {
    approvalId: approval.id as unknown as string,
    status: approval.status,
    requiredRole: approval.requiredRole as unknown as string,
    ...(approval.title !== undefined && { title: approval.title }),
    createdAt: approval.createdAt as unknown as string,
    ...(approval.expiresAt !== undefined && { expiresAt: approval.expiresAt as unknown as string }),
    subjectKind: approval.subjectKind,
    ...(tool !== undefined && { tool }),
  };
}

/** A tool-call subject's tool and call, by name; nothing else of the subject. */
function toolOf(approval: Approval): WaitingForApproval['tool'] {
  if (approval.subjectKind !== TOOL_CALL_GATE_SUBJECT) return undefined;
  const { toolId, toolVersion, callId } = approval.subjectRef;
  if (typeof toolId !== 'string' || typeof toolVersion !== 'string' || typeof callId !== 'string') {
    return undefined;
  }
  return { id: toolId, version: toolVersion, callId };
}

interface OpenWait {
  readonly tokenId: string;
  readonly timesOutAt?: string;
}

const payloadOf = (entry: JournalEntry): Record<string, unknown> =>
  typeof entry.payload === 'object' && entry.payload !== null
    ? (entry.payload as Record<string, unknown>)
    : {};

/** `wait.suspended` entries with no `wait.resumed` / `wait.cancelled` for their token after them. */
function openWaits(journal: readonly JournalEntry[]): OpenWait[] {
  const open = new Map<string, OpenWait>();
  for (const entry of journal) {
    const tokenId = payloadOf(entry).tokenId;
    if (typeof tokenId !== 'string') continue;
    if (entry.kind === 'wait.suspended') {
      const timeoutMs = payloadOf(entry).timeoutMs;
      const at = Date.parse(entry.timestamp as unknown as string);
      open.set(tokenId, {
        tokenId,
        ...(typeof timeoutMs === 'number' &&
          Number.isFinite(at) && { timesOutAt: new Date(at + timeoutMs).toISOString() }),
      });
    } else if (entry.kind === 'wait.resumed' || entry.kind === 'wait.cancelled') {
      open.delete(tokenId);
    }
  }
  return [...open.values()];
}

/** `child:<childRunId>:<sequence>`: the runtime's wait on a child run. */
function childRunOf(tokenId: string): string | undefined {
  return /^child:([^:]+):/.exec(tokenId)?.[1];
}
