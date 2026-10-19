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

/** Whether a message reads as one of this module's notes (`retryNote`). */
export function isRetryNote(m: ModelMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(RETRY_MARKER);
}

/**
 * The guardrails each note in `messages` sent an answer back for, in
 * order. The note's first line names them as a JSON array after the
 * marker, so any guardrail id reads back as written. Read only what the
 * turn's loop added (`turnRetryNotes`): anyone can write a message that
 * starts with the marker.
 */
export function retryNotes(messages: readonly ModelMessage[]): readonly (readonly string[])[] {
  const notes: string[][] = [];
  for (const m of messages) {
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
 * sent-back provenance and a failure's `attempts` all count.
 */
export function turnRetryNotes(
  ctx: TurnContext,
  messages: readonly ModelMessage[],
): readonly (readonly string[])[] {
  return retryNotes(loopMessages(ctx, messages, "a guardrail's notes"));
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
export function retryNote(violations: readonly EvaluationResult[]): ModelMessage {
  const ids = violations.map((v) => v.guardrailId as unknown as string);
  const lines = violations.map((v) => {
    const reason = v.result.reason?.trim();
    const shown =
      reason === undefined || reason === ''
        ? "the answer didn't pass it"
        : reason.length > REASON_LIMIT
          ? `${reason.slice(0, REASON_LIMIT)}…`
          : reason;
    return `- ${v.guardrailId}: ${shown}`;
  });
  return {
    role: 'user',
    content: [
      `${RETRY_MARKER} ${JSON.stringify(ids)}`,
      `Your answer wasn't sent: it didn't pass ${violations.length === 1 ? 'this guardrail' : 'these guardrails'}.`,
      ...lines,
      `Write a new answer that meets ${violations.length === 1 ? 'it' : 'them'}.`,
    ].join('\n'),
  };
}
