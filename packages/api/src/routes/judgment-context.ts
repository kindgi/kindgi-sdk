// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  type ConversationBinding,
  RUN_RETRIEVALS_NODE,
  SESSION_GATE_RECORD,
  readGateDecision,
} from '@kindgi/agents';
import type { JournalEntry, RunBinding } from '@kindgi/runtime';
import { TOOL_ENV_RECORD_KEY, toolCallRecordKey } from '@kindgi/tools';
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

type JournalParts = Pick<
  JudgedRunContext,
  'retrieved' | 'recalled' | 'sessionApproval' | 'toolEnv'
>;

/** A record's value when it's env values: an object whose values are strings. */
function envValues(value: unknown): Readonly<Record<string, string>> | undefined {
  const o = obj(value);
  if (o === undefined) return undefined;
  return Object.values(o).every((v) => typeof v === 'string')
    ? (o as Record<string, string>)
    : undefined;
}

/**
 * The env values each tool's calls were sent, by tool id, from a run's
 * journal, added to `into`: for each call given (an agent turn's, with its
 * call id; a flow's tool step, without), its recorded env
 * (`toolCallRecordKey(…, TOOL_ENV_RECORD_KEY)`). A tool's first call wins.
 */
export function addToolEnv(
  entries: readonly JournalEntry[],
  calls: readonly { readonly toolId: string; readonly callId?: string }[],
  into: Record<string, Readonly<Record<string, string>>>,
): void {
  const recorded = new Map<string, unknown>();
  for (const e of entries) {
    const payload = obj(e.payload);
    const key = payload?.key;
    if (e.kind === 'value.recorded' && typeof key === 'string' && !recorded.has(key)) {
      recorded.set(key, payload?.value);
    }
  }
  for (const call of calls) {
    if (into[call.toolId] !== undefined) continue;
    const env = envValues(
      recorded.get(
        toolCallRecordKey({
          toolId: call.toolId,
          key: TOOL_ENV_RECORD_KEY,
          ...(call.callId !== undefined && { callId: call.callId }),
        }),
      ),
    );
    if (env !== undefined) into[call.toolId] = env;
  }
}

/** An agent turn's tool calls, from its output: each `tool` message's tool and call id. */
export function turnCallIds(
  output: unknown,
): readonly { readonly toolId: string; readonly callId: string }[] {
  const appended = obj(output)?.appended;
  if (!Array.isArray(appended)) return [];
  return appended.flatMap((m) => {
    const toolCall = obj(obj(m)?.toolCall);
    const toolId = toolCall?.toolId;
    const callId = toolCall?.invocationId;
    return obj(m)?.role === 'tool' && typeof toolId === 'string' && typeof callId === 'string'
      ? [{ toolId, callId }]
      : [];
  });
}

/** What the turn's journal says it retrieved and recalled, and how its session approval was decided. */
async function readJournalParts(
  runBinding: RunBinding,
  tenantId: TenantId,
  runId: string,
  output: unknown,
): Promise<JournalParts> {
  const journal = await runBinding.readJournal(tenantId, runId as RunId);
  if (journal.kind === 'err') return {};
  const entries = journal.value;
  const toolEnv: Record<string, Readonly<Record<string, string>>> = {};
  addToolEnv(entries, turnCallIds(output), toolEnv);
  const step = entries.find(
    (e) =>
      e.kind === 'step.completed' &&
      typeof e.nodeId === 'string' &&
      (e.nodeId === RUN_RETRIEVALS_NODE || e.nodeId.endsWith(`/${RUN_RETRIEVALS_NODE}`)),
  );
  const stepOutput = obj(obj(step?.payload)?.output);
  const retrieved = stepOutput?.retrieved;
  const recalled = stepOutput?.recalled;
  const sessionApproval = sessionApprovalOf(entries);
  return {
    ...(retrieved !== undefined && { retrieved }),
    ...(recalled !== undefined && { recalled }),
    ...(sessionApproval !== undefined && { sessionApproval }),
    ...(Object.keys(toolEnv).length > 0 && { toolEnv }),
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
 * retrievals returned, the decision at its session approval gate, and the
 * env values its tools were sent. Best effort and read-only: a part that can't be
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
    readJournalParts(input.runBinding, input.tenantId, input.runId, input.output).catch(() => ({})),
  ]);
  const context: JudgedRunContext = { ...history, ...journal };
  return Object.keys(context).length > 0 ? context : undefined;
}
