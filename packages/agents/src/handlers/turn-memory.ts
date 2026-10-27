// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MessageFile, ModelMessage } from '@kindgi/capabilities';
import type { RunId } from '@kindgi/types';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * A turn's memory charge, answered: taken, or refused by one of the
 * runtime's limits, naming it and what it holds.
 */
export type TurnMemoryCharge =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `tenant`: the turn's tenant already holds its share. `server`:
       * every tenant's turns together hold the runtime's whole limit.
       */
      readonly limit: 'tenant' | 'server';
      /** What that limit's turns hold now, in bytes. */
      readonly heldBytes: number;
      /** The limit, in bytes. */
      readonly limitBytes: number;
    };

/**
 * A runtime's charge for what one running turn holds in memory, by size:
 * a runtime may limit it per tenant and in all (Kindgi Cloud does). The runtime binds one
 * per turn (one `invokeAgent` call), so two turns of one run (parallel
 * nodes, subflows) are charged apart, and it releases the turn's charge
 * when the call settles: the turn ends, suspends or fails. Absent: nothing
 * is charged.
 */
export interface TurnMemoryBinding {
  /**
   * Replaces this turn's charge with `bytes`. `turn.runId` is the turn's
   * own run, for the runtime's record of a refusal.
   */
  charge(bytes: number, turn: { readonly runId: RunId }): Promise<TurnMemoryCharge>;
}

/**
 * What a turn holds, by size, when it's about to make a model call after
 * `iterationsDone` iterations: (4 + n) × the conversation as sent, in
 * UTF-8 bytes, plus 3 × `fileBytes`, the stored files the call reads. Its
 * journal keeps the conversation at each loop step, and the call holds it
 * more than once. A message holds its files by reference, so the journal
 * keeps no bytes of them; the call holds each one's bytes, their base64
 * and the request body.
 */
export function turnMemoryBytes(
  nextMessages: readonly ModelMessage[],
  iterationsDone: number,
  fileBytes: number,
): number {
  return (
    (4 + iterationsDone) * Buffer.byteLength(JSON.stringify(nextMessages), 'utf8') + 3 * fileBytes
  );
}

/**
 * Charges the turn before its next model call: once the first messages
 * are built, and after each tool result has joined the conversation and
 * been journaled. Refused, the turn fails with `turn-memory-limit-reached`
 * before the model is called. Every finished tool result is already in the
 * conversation then, so a new run on it never calls that tool again.
 */
export async function chargeTurnMemory(
  ctx: TurnContext,
  turn: { readonly runId: RunId },
  call: { readonly messages: readonly ModelMessage[]; readonly files: readonly MessageFile[] },
  iterationsDone: number,
): Promise<void> {
  const binding = ctx.bindings.turnMemory;
  if (binding === undefined) return;
  const fileBytes = call.files.reduce((sum, file) => sum + file.size, 0);
  const bytes = turnMemoryBytes(call.messages, iterationsDone, fileBytes);
  const charged = await binding.charge(bytes, { runId: turn.runId });
  if (charged.ok) return;
  const whose = charged.limit === 'tenant' ? "the tenant's share of" : "the runtime's";
  throwAgentTurnFailure({
    code: 'turn-memory-limit-reached',
    message: `The turn needs more memory than ${whose} turn memory has left (${mib(charged.heldBytes)} of ${mib(charged.limitBytes)} MiB held). Retry later, or use a smaller conversation.`,
    limit: charged.limit,
    heldBytes: charged.heldBytes,
    limitBytes: charged.limitBytes,
  });
}

const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
