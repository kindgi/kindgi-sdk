// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ConversationBinding, RUN_RETRIEVALS_NODE } from '@kindgi/agents';
import type { RunBinding } from '@kindgi/runtime';
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

async function readRetrieved(
  runBinding: RunBinding,
  tenantId: TenantId,
  runId: string,
): Promise<unknown> {
  const journal = await runBinding.readJournal(tenantId, runId as RunId);
  if (journal.kind === 'err') return undefined;
  const step = journal.value.find(
    (e) =>
      e.kind === 'step.completed' &&
      typeof e.nodeId === 'string' &&
      (e.nodeId === RUN_RETRIEVALS_NODE || e.nodeId.endsWith(`/${RUN_RETRIEVALS_NODE}`)),
  );
  return obj(obj(step?.payload)?.output)?.retrieved;
}

/**
 * What a judged agent turn read besides its input, so it can be replayed
 * faithfully later: the conversation before the turn and what its
 * retrievals returned. Best effort and read-only: a part that can't be
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
  const [history, retrieved] = await Promise.all([
    input.conversations !== undefined && input.conversationId !== undefined && before !== undefined
      ? readHistory(input.conversations, input.tenantId, input.conversationId, before).catch(
          () => ({}),
        )
      : Promise.resolve({}),
    readRetrieved(input.runBinding, input.tenantId, input.runId).catch(() => undefined),
  ]);
  const context: JudgedRunContext = {
    ...history,
    ...(retrieved !== undefined && { retrieved }),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}
