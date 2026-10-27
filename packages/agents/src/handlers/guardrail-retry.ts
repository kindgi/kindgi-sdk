// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelMessage } from '@kindgi/capabilities';
import type { EvaluationResult, Guardrail } from '@kindgi/guardrails';

import type { TurnContext } from './context.js';
import { loopMessages } from './history.js';

/**
 * A `retry` guardrail's attempts when it gives none (`action.retry`
 * left out): two answers in all, so one is sent back, as output repair's
 * default is one repair (`DEFAULT_MAX_REPAIRS`).
 */
export const DEFAULT_GUARDRAIL_ATTEMPTS = 2;

/** Marks the notes this module adds, so they can be counted. */
const RETRY_MARKER = '[kindgi:guardrail-retry]';

/** The most of a check's reason a note repeats. */
const REASON_LIMIT = 500;

/** A guardrail whose failed check sends the answer back to the model. */
export function isRetryGuardrail(guardrail: Guardrail): boolean {
  return guardrail.action['on-violation'] === 'retry';
}

/**
 * The guardrails the agent loop judges on each finished answer, when the
 * turn has a `retry` guardrail: the `retry` ones, and the `halt` ones,
 * so a `halt` fails the turn before any answer is sent back.
 */
export function judgedInLoop(guardrail: Guardrail): boolean {
  return isRetryGuardrail(guardrail) || guardrail.action['on-violation'] === 'halt';
}

/** The answers a `retry` guardrail allows in a turn, the first one included. */
export function attemptsOf(guardrail: Guardrail): number {
  return guardrail.action.retry?.maxAttempts ?? DEFAULT_GUARDRAIL_ATTEMPTS;
}

/**
 * A message of the turn's loop. A tool result the loop wrote as a
 * guardrail's note (a call refused before it ran, or a result withheld)
 * carries the guardrails' ids in `guardrailNote`: a tool's own result can
 * start with the marker, so a tool message never counts by its text. The
 * mark never reaches a model (`toWireMessages`).
 */
export type LoopMessage = ModelMessage & { readonly guardrailNote?: readonly string[] };

/** A guardrail that failed a reply, a call or its result, with its check's reason. */
export interface RetryFailure {
  readonly guardrailId: string;
  readonly reason?: string;
}

/** Whether a message reads as an answer's note (`retryNote`): a user message with the marker. */
export function isRetryNote(m: ModelMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(RETRY_MARKER);
}

/** Whether a message is a call's note (`callNote`): a tool message with the loop's mark. */
export function isCallNote(m: ModelMessage): boolean {
  return m.role === 'tool' && Array.isArray((m as LoopMessage).guardrailNote);
}

/**
 * The messages as a model takes them: only `ModelMessage`'s own fields,
 * so a loop message's mark never leaves the loop (an adapter may pass on
 * what it's given).
 */
export function toWireMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.map((m) =>
    (m as LoopMessage).guardrailNote === undefined
      ? m
      : {
          role: m.role,
          content: m.content,
          ...(m.toolCallId !== undefined && { toolCallId: m.toolCallId }),
          ...(m.toolCalls !== undefined && { toolCalls: m.toolCalls }),
        },
  );
}

/**
 * The guardrails each note in `messages` sent an answer back for, in
 * order. The note's first line names them as a JSON array after the
 * marker, so any guardrail id reads back as written. Read only what the
 * turn's loop added (`turnRetryNotes`): anyone can write a message that
 * starts with the marker.
 */
export function retryNotes(
  messages: readonly ModelMessage[],
  withCalls = false,
): readonly (readonly string[])[] {
  const notes: string[][] = [];
  for (const m of messages) {
    if (withCalls && isCallNote(m)) {
      notes.push([...((m as LoopMessage).guardrailNote ?? [])]);
      continue;
    }
    if (!isRetryNote(m)) continue;
    const content = m.content as string;
    const firstLine = content.slice(RETRY_MARKER.length).split('\n', 1)[0] ?? '';
    notes.push(idsOf(firstLine));
  }
  return notes;
}

/**
 * The notes this turn's loop added to `messages`, the messages a step
 * of the loop sent (`loopMessages`). A message of the person's, this
 * turn's or one in the history, that starts with the marker is theirs,
 * and counts for nothing. What the loop's attempts, the outer node's
 * sent-back provenance and a failure's `attempts` all count. `withCalls`
 * adds the calls' notes, which a guardrail at a tool point counts its
 * attempts by; an answer's are only the answers sent back.
 */
export function turnRetryNotes(
  ctx: TurnContext,
  messages: readonly ModelMessage[],
  withCalls = false,
): readonly (readonly string[])[] {
  return retryNotes(loopMessages(ctx, messages, "a guardrail's notes"), withCalls);
}

/**
 * The notes that sent an answer back: those that name a guardrail of the
 * final answer (`atFinal`). A reply's note (`'model-step'`) is a user
 * message too, but names only guardrails of its own point, and a
 * guardrail runs at one point.
 */
export function answerNotes(
  notes: readonly (readonly string[])[],
  atFinal: readonly Guardrail[],
): readonly (readonly string[])[] {
  const ids = new Set(atFinal.map((g) => g.id as unknown as string));
  return notes.filter((note) => note.some((id) => ids.has(id)));
}

function idsOf(line: string): string[] {
  try {
    const parsed: unknown = JSON.parse(line);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * How many answers each guardrail has sent back this turn so far, by
 * guardrail id, from the turn's notes (`turnRetryNotes`). Counted from
 * the journaled messages, so a replayed or resumed turn counts the same.
 */
export function sentBackSoFar(notes: readonly (readonly string[])[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const ids of notes) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The note that sends an answer back: the guardrails it failed, each
 * with its check's reason (cut to `REASON_LIMIT`), and that the model is
 * to write a new answer. A judge's own answer is never in it.
 */
export function retryNote(
  failures: readonly (EvaluationResult | RetryFailure)[],
  what: 'answer' | 'reply' = 'answer',
): ModelMessage {
  const listed = failures.map(failureOf);
  return {
    role: 'user',
    content: [
      `${RETRY_MARKER} ${JSON.stringify(listed.map((f) => f.guardrailId))}`,
      what === 'answer'
        ? `Your answer wasn't sent: it didn't pass ${listed.length === 1 ? 'this guardrail' : 'these guardrails'}.`
        : `Your reply wasn't acted on, and none of its tool calls ran: it didn't pass ${listed.length === 1 ? 'this guardrail' : 'these guardrails'}.`,
      ...reasonLines(listed, `the ${what} didn't pass it`),
      what === 'answer'
        ? `Write a new answer that meets ${listed.length === 1 ? 'it' : 'them'}.`
        : `Write a new reply that meets ${listed.length === 1 ? 'it' : 'them'}.`,
    ].join('\n'),
  };
}

/**
 * A call's note: the text the model gets as the call's result when a
 * guardrail refused the call before it ran (`'refused'`), or withheld its
 * result after it ran (`'withheld'`), with each guardrail's reason. Its
 * first line is the marker and the ids, for a person reading it; the loop
 * counts it by its mark (`LoopMessage.guardrailNote`), never by its text.
 */
export function callNote(failures: readonly RetryFailure[], kind: 'refused' | 'withheld'): string {
  const one = failures.length === 1;
  return [
    `${RETRY_MARKER} ${JSON.stringify(failures.map((f) => f.guardrailId))}`,
    kind === 'refused'
      ? `This call didn't run: it didn't pass ${one ? 'this guardrail' : 'these guardrails'}.`
      : `This call ran, but its result is withheld: it didn't pass ${one ? 'this guardrail' : 'these guardrails'}.`,
    ...reasonLines(
      failures,
      kind === 'refused' ? "the call didn't pass it" : "the result didn't pass it",
    ),
    kind === 'refused'
      ? `Don't make this call again as it is. Go on without it, or make a call that meets ${one ? 'it' : 'them'}.`
      : 'Go on without its result.',
  ].join('\n');
}

/** A loop message marked as the note of the guardrails `guardrailIds` (`LoopMessage.guardrailNote`). */
export function markedNote(message: ModelMessage, guardrailIds: readonly string[]): ModelMessage {
  const marked: LoopMessage = { ...message, guardrailNote: [...guardrailIds] };
  return marked;
}

/** The messages, the last one (a call's note, just appended) marked as the guardrails'. */
export function withNoteMark(
  messages: readonly ModelMessage[],
  guardrailIds: readonly string[],
): ModelMessage[] {
  const last = messages.at(-1);
  if (last === undefined) return [...messages];
  return [...messages.slice(0, -1), markedNote(last, guardrailIds)];
}

/**
 * The result a call gets in the loop's messages when guardrails send the
 * reply that asked for it back (`'model-step'`): it didn't run. A model's
 * next call expects a result for every call it asked for. It isn't a
 * note, and counts for nothing: the reply's note (`retryNote`) counts.
 */
export function unrunCallResult(callId: string, guardrailIds: readonly string[]): ModelMessage {
  const named = guardrailIds.length === 1 ? 'this guardrail' : 'these guardrails';
  return {
    role: 'tool',
    content: JSON.stringify({
      status: 'denied',
      reason: `This call didn't run: the reply that asked for it didn't pass ${named}: ${guardrailIds.join(', ')}.`,
    }),
    toolCallId: callId,
  };
}

function failureOf(f: EvaluationResult | RetryFailure): RetryFailure {
  if (!('result' in f)) return f;
  const reason = f.result.reason?.trim();
  return {
    guardrailId: f.guardrailId as unknown as string,
    ...(reason !== undefined && reason !== '' && { reason }),
  };
}

function reasonLines(failures: readonly RetryFailure[], fallback: string): string[] {
  return failures.map((f) => {
    const reason = f.reason?.trim();
    const shown =
      reason === undefined || reason === ''
        ? fallback
        : reason.length > REASON_LIMIT
          ? `${reason.slice(0, REASON_LIMIT)}…`
          : reason;
    return `- ${f.guardrailId}: ${shown}`;
  });
}
