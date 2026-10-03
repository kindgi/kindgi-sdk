// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeHandler } from '@kindgi/handler';
import type { Timestamp } from '@kindgi/types';

import type { ConversationMessage } from '../types.js';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';

/**
 * Persist the caller's user message BEFORE the model is called. A
 * crash mid-turn leaves the question intact for a later replay. Also
 * seeds the provenance DAG with the `input:<sequence>` node — every
 * subsequent model/tool node ties back through that root.
 *
 * Dry-run branch: skips the DB write; builds a synthetic
 * `ConversationMessage` with `sequence: -1` (sentinel — real sequences
 * are always ≥ 0). Provenance node is still seeded so downstream
 * dry-run handlers can build a plausible plan DAG.
 */
export function buildPersistUserMessageHandler(ctx: TurnContext): NodeHandler {
  return async (_input, kctx) => {
    if (kctx.dryRun) {
      const synthetic: ConversationMessage = {
        sequence: -1,
        role: 'user',
        content: ctx.input.userMessage,
        createdAt: new Date().toISOString() as Timestamp,
        ...(ctx.input.participantId !== undefined && { actor: ctx.input.participantId }),
      };
      ctx.userMessage = synthetic;
      ctx.appended.push(synthetic);

      if (ctx.provenance !== undefined) {
        ctx.provenance.addNode({
          id: `input:${synthetic.sequence}`,
          kind: 'input',
          timestamp: synthetic.createdAt,
          ...(synthetic.actor !== undefined && { actor: synthetic.actor }),
        });
      }
      return { sequence: synthetic.sequence };
    }

    const persisted = await ctx.bindings.conversationBinding.appendMessage({
      tenantId: ctx.input.tenantId,
      conversationId: ctx.input.conversationId,
      role: 'user',
      content: ctx.input.userMessage,
      ...(ctx.input.participantId !== undefined && { actor: ctx.input.participantId }),
    });
    if (persisted.kind === 'err') throwAgentTurnFailure(persisted.error);

    ctx.userMessage = persisted.value;
    ctx.appended.push(persisted.value);

    if (ctx.provenance !== undefined) {
      ctx.provenance.addNode({
        id: `input:${persisted.value.sequence}`,
        kind: 'input',
        timestamp: persisted.value.createdAt,
        ...(persisted.value.actor !== undefined && { actor: persisted.value.actor }),
      });
    }

    return { sequence: persisted.value.sequence };
  };
}
