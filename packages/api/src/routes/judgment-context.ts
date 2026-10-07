// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type ConversationBinding,
  RUN_RETRIEVALS_NODE,
  SESSION_GATE_RECORD,
  readGateDecision,
} from '@kindgi/agents';
import type { JournalEntry, RunBinding } from '@kindgi/runtime';
import type { ConversationId, RunId, TenantId } from '@kindgi/types';

import type { JudgedRunContext } from '../judgment-binding.js';

/** The most messages of conversation history a judged turn keeps. */
export const MAX_JUDGED_HISTORY = 200;
/** How many messages are read to find a turn's history. */
const HISTORY_READ_LIMIT = 1000;

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The sequence of the first message the turn appended (its user message). */
function firstAppendedSequence(output: unknown): number | undefined {
  const appended = obj(output)?.appended;
  if (!Array.isArray(appended)) return undefined;
  const sequences = appended
    .map((m) => obj(m)?.sequence)
    .filter((s): s is number => typeof s === 'number');
  return sequences.length > 0 ? Math.min(...sequences) : undefined;
}

async function readHistory(
  conversations: ConversationBinding,
  tenantId: TenantId,
  conversationId: string,
  before: number,
): Promise<Pick<JudgedRunContext, 'history' | 'historyTruncated'>> {
  const read = await conversations.readMessages({
    tenantId,
    conversationId: conversationId as ConversationId,
    limit: HISTORY_READ_LIMIT,
  });
  if (read.kind === 'err') return {};
  const earlier = read.value.filter((m) => m.sequence < before);
  const kept = earlier.slice(-MAX_JUDGED_HISTORY);
  return {
    history: kept,
    ...(kept.length < earlier.length && { historyTruncated: true }),
  };
}

type JournalParts = Pick<JudgedRunContext, 'retrieved' | 'recalled' | 'sessionApproval'>;

/** What the turn's journal says it retrieved and recalled, and how its session approval was decided. */
async function readJournalParts(
  runBinding: RunBinding,
  tenantId: TenantId,
  runId: string,
): Promise<JournalParts> {
  const journal = await runBinding.readJournal(tenantId, runId as RunId);
  if (journal.kind === 'err') return {};
  const entries = journal.value;
  const step = entries.find(
    (e) =>
      e.kind === 'step.completed' &&
      typeof e.nodeId === 'string' &&
      (e.nodeId === RUN_RETRIEVALS_NODE || e.nodeId.endsWith(`/${RUN_RETRIEVALS_NODE}`)),
  );
  const output = obj(obj(step?.payload)?.output);
  const retrieved = output?.retrieved;
  const recalled = output?.recalled;
  const sessionApproval = sessionApprovalOf(entries);
  return {
    ...(retrieved !== undefined && { retrieved }),
    ...(recalled !== undefined && { recalled }),
    ...(sessionApproval !== undefined && { sessionApproval }),
  };
}

/** The decision that resolved the turn's session approval gate, if it waited on one. */
function sessionApprovalOf(
  entries: readonly JournalEntry[],
): JudgedRunContext['sessionApproval'] | undefined {
  const gate = entries.find(
    (e) => e.kind === 'value.recorded' && obj(e.payload)?.key === SESSION_GATE_RECORD,
  );
  const tokenId = obj(obj(gate?.payload)?.value)?.waitTokenId;
  if (typeof tokenId !== 'string') return undefined;
  const resumed = entries.find(
    (e) => e.kind === 'wait.resumed' && obj(e.payload)?.tokenId === tokenId,
  );
  if (resumed === undefined) return undefined;
  const decision = readGateDecision(obj(resumed.payload)?.value);
  return {
    approved: decision.approved,
    ...(!decision.approved &&
      decision.rationale !== undefined && { rationale: decision.rationale }),
  };
}

/**
 * What a judged agent turn read besides its input, so it can be replayed
 * faithfully later: the conversation before the turn, what its
 * retrievals returned, and the decision at its session approval gate. Best effort and read-only: a part that can't be
 * read is left out (the judgment never fails over it). `undefined` for
 * a flow run, or when nothing could be read.
 */
export async function captureTurnContext(input: {
  readonly tenantId: TenantId;
  readonly runId: string;
  readonly output: unknown;
  readonly conversationId: string | undefined;
  readonly runBinding: RunBinding;
  readonly conversations: ConversationBinding | undefined;
}): Promise<JudgedRunContext | undefined> {
  const before = firstAppendedSequence(input.output);
  const [history, journal] = await Promise.all([
    input.conversations !== undefined && input.conversationId !== undefined && before !== undefined
      ? readHistory(input.conversations, input.tenantId, input.conversationId, before).catch(
          () => ({}),
        )
      : Promise.resolve({}),
    readJournalParts(input.runBinding, input.tenantId, input.runId).catch(() => ({})),
  ]);
  const context: JudgedRunContext = { ...history, ...journal };
  return Object.keys(context).length > 0 ? context : undefined;
}
