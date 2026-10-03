// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Run reconstruction snapshot — writes the InvokeAgentInput envelope
// that resumeAgentTurn(runId) needs to rebuild a suspended turn's
// context after a kernel waitpoint resolves.
//
// Called from the setup handler on every flow invocation; the binding
// write is idempotent on the runId primary key, so it is safe under
// kernel flow replay.
//
// Owned by @kindgi/agents (not the kernel): kernel schemas
// stay generic across all flow runners — agent-specific reconstruction
// context lives at this layer.
//

import type { NodeContext } from '@kindgi/handler';

import type { TurnContext } from './context.js';

export async function writeRunSnapshot(ctx: TurnContext, kctx: NodeContext): Promise<void> {
  // Snapshot write is best-effort: if it fails, the turn still proceeds.
  // Resume paths will just get `run-snapshot-missing` and the caller
  // knows to surface the run as unrecoverable. The alternative (throw
  // and fail the turn) is worse — a snapshot-write hiccup shouldn't
  // block a fresh turn from running. The RunSnapshotBinding impl must be
  // idempotent under kernel replay (e.g. ON CONFLICT DO NOTHING on runId).
  await ctx.bindings.runSnapshotBinding.write({
    runId: kctx.runId,
    tenantId: ctx.input.tenantId,
    projectId: ctx.input.projectId,
    agentId: ctx.input.agent.id,
    agentVersion: ctx.input.agent.version,
    conversationId: ctx.input.conversationId,
    userMessage: ctx.input.userMessage,
    ...(ctx.input.parameters !== undefined && { parameters: ctx.input.parameters }),
    ...(ctx.input.input !== undefined && { input: ctx.input.input }),
    ...(ctx.input.participantId !== undefined && { participantId: ctx.input.participantId }),
    ...(ctx.input.dryRun === true && { dryRun: true }),
    ...(ctx.input.principal !== undefined && { principal: ctx.input.principal }),
    ...(ctx.input.authz !== undefined && { authz: ctx.input.authz }),
  });
}
