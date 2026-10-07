// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { KernelError, RunResult } from '@kindgi/runtime';
import type { OrgId, Result, RunId, TenantId } from '@kindgi/types';

import { AGENT_TURN_FLOW } from './agent-turn-flow.js';
import { DEFAULT_MAX_WALL_MS } from './handlers/constants.js';
import type { TurnContext } from './handlers/context.js';
import { AgentTurnFailure, type InvokeAgentError } from './handlers/errors.js';
import { buildHandlers } from './handlers/index.js';
import type { InvokeAgentBindings, InvokeAgentInput } from './handlers/public-types.js';
import { rehydrateTurnContext } from './handlers/rehydrate.js';
import type { AgentTurnResult } from './handlers/result-shape.js';
import { projectRunResult } from './project-run-result.js';
import type { RunSnapshotRecord } from './run-snapshot-binding.js';
import type { Agent } from './types.js';

/**
 * Execute one agent turn end-to-end as a flow run: one `runGraph`
 * invocation (through `bindings.runBinding`) against
 * `AGENT_TURN_FLOW`; handler modules under `./handlers/` implement
 * each node. The run's outcome is projected back to an
 * `AgentTurnResult` or an `InvokeAgentError`.
 *
 * Budgets enforced (all optional, all take agent-declared defaults):
 *   - `agent.budget.maxSteps`     — cap on model↔tool iterations (default 8).
 *   - `agent.budget.maxCostUsd`   — cumulative USD across model calls.
 *   - `agent.budget.maxWallMs`    — wall-clock cap; combined with abortSignal.
 */
export async function invokeAgent(
  input: InvokeAgentInput,
  bindings: InvokeAgentBindings,
): Promise<Result<AgentTurnResult, InvokeAgentError>> {
  const started = Date.now();
  const maxWallMs = input.agent.budget?.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const controller = new AbortController();
  const ctx: TurnContext = {
    input,
    bindings,
    turnAbort: controller,
    startedAt: started,
    appended: [],
    usage: {
      steps: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalCostUsd: 0,
    },
    abortReason: undefined,
  };
  const timer = setTimeout(() => {
    ctx.abortReason = 'timeout';
    controller.abort(new Error('wall-clock budget exhausted'));
  }, maxWallMs);
  if (input.abortSignal !== undefined) {
    const external = input.abortSignal;
    if (external.aborted) {
      ctx.abortReason = 'external';
      controller.abort(external.reason);
    } else {
      external.addEventListener('abort', () => {
        ctx.abortReason = 'external';
        controller.abort(external.reason);
      });
    }
  }

  try {
    const handlers = buildHandlers(ctx);
    if (bindings.runBinding === undefined) {
      throw new Error(
        'invokeAgent: bindings.runBinding is required — pass the RunBinding (from @kindgi/runtime) of the runtime that executes the turn.',
      );
    }
    const runResult: Result<
      RunResult<AgentTurnResult>,
      KernelError
    > = await bindings.runBinding.runGraph<AgentTurnResult>({
      tenantId: input.tenantId,
      projectId: input.projectId,
      flow: AGENT_TURN_FLOW,
      handlers,
      input: input.userMessage,
      // The run's record names the agent, its version and the conversation.
      agent: {
        id: input.agent.id,
        version: input.agent.version,
        conversationId: input.conversationId,
        ...(input.versionVia !== undefined && { via: input.versionVia }),
        ...(input.liveScope !== undefined && { liveScope: input.liveScope }),
      },
      ...(input.segments !== undefined && { segments: input.segments }),
      ...(input.parent !== undefined && { parent: input.parent }),
      // A replay's run says so, and which eval run and past run it is for.
      ...(input.replay !== undefined && { replay: input.replay }),
      ...(input.dryRun === true && { options: { dryRun: true } }),
      // Authorization — carry principal + authz into the run so every
      // tool invocation inside the agent's turn is checked.
      ...(input.principal !== undefined && { principal: input.principal }),
      ...(input.authz !== undefined && { authz: input.authz }),
    });
    return await projectRunResult(runResult, ctx);
  } finally {
    clearTimeout(timer);
  }
}

export interface ResumeAgentTurnInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  /**
   * The agent spec resolved at the target version. Callers of
   * `resumeAgentTurn` are responsible for resolving `agentId +
   * agentVersion` from the run snapshot against their agent registry
   * (replay must match the version the run started on — see the setup
   * handler's agent-version-mismatch guard).
   */
  readonly agent: Agent;
  /**
   * The org of the run's project (the snapshot's `projectId`), when it has
   * one. The caller resolves it from the project, as for `invokeAgent`'s
   * `orgId`, so the resumed turn's tools and guardrails see it too.
   */
  readonly orgId?: OrgId;
}

/**
 * Resume a suspended agent turn — invoked after a kernel waitpoint
 * resolves (e.g. a HITL approval completes). Loads the reconstruction
 * snapshot written by the setup handler, rebuilds an equivalent
 * `InvokeAgentInput` + `TurnContext`, then calls
 * `bindings.runBinding.resumeRun`, which replays the flow from the
 * journal.
 *
 * Same runId, same conversationId, same provenance record across the
 * park-and-resume cycle. Any handler that was mid-execution when the
 * wait suspended runs again from the top; `ctx.waitForToken` returns
 * the resolved value from derived state instead of throwing another
 * SuspensionSignal.
 *
 * Fails with `run-snapshot-missing` when no snapshot exists for the
 * runId — this happens when the setup handler's snapshot write failed
 * (the write is best-effort). Recovery: cancel the run explicitly;
 * there is no way to reconstruct the InvokeAgentInput without the
 * snapshot. Fails with `run-snapshot-unreadable` when reading it failed;
 * resuming again may work.
 */
/**
 * Rebuild a resumed turn's context from its journal (see
 * `rehydrateTurnContext`). Returns the turn's error when it can't be
 * rebuilt; `undefined` to go on and resume.
 */
async function rehydrateFromJournal(
  ctx: TurnContext,
  runId: RunId,
  runBinding: NonNullable<InvokeAgentBindings['runBinding']>,
): Promise<Result<AgentTurnResult, InvokeAgentError> | undefined> {
  const journal = await runBinding.readJournal(ctx.input.tenantId, runId);
  if (journal.kind === 'err') {
    return {
      kind: 'err',
      error: {
        code: 'run-journal-unavailable',
        message: `Failed to read the journal of run ${runId as unknown as string}: ${journal.error.message}`,
      } as never,
    };
  }
  try {
    await rehydrateTurnContext(ctx, runId as unknown as string, journal.value);
    return undefined;
  } catch (cause) {
    if (cause instanceof AgentTurnFailure) return { kind: 'err', error: cause.payload };
    throw cause;
  }
}

export async function resumeAgentTurn(
  input: ResumeAgentTurnInput,
  bindings: InvokeAgentBindings,
): Promise<Result<AgentTurnResult, InvokeAgentError>> {
  // 1. Load the snapshot via the run-snapshot binding.
  const snapshotResult = await bindings.runSnapshotBinding.read(input.tenantId, input.runId);
  if (snapshotResult.kind === 'err') {
    return {
      kind: 'err',
      error: {
        code: 'run-snapshot-unreadable',
        message: `Could not read the run snapshot of run ${input.runId as unknown as string}: ${snapshotResult.error.message}`,
      },
    };
  }
  const snapshot = snapshotResult.value;
  if (snapshot === null) {
    return {
      kind: 'err',
      error: {
        code: 'run-snapshot-missing',
        message: `No run snapshot for run ${input.runId as unknown as string} — resume-context unavailable.`,
      },
    };
  }

  // 2. Agent-version sanity check — the caller passes the Agent spec they
  // resolved via the registry; we refuse if it doesn't match the pinned
  // version in the snapshot. Mirrors the setup handler's guard.
  if (
    (snapshot.agentId as unknown as string) !== (input.agent.id as unknown as string) ||
    snapshot.agentVersion !== input.agent.version
  ) {
    return {
      kind: 'err',
      error: {
        code: 'agent-version-mismatch',
        message: `Snapshot pinned to ${snapshot.agentId as unknown as string}@${snapshot.agentVersion}; resume called with ${input.agent.id as unknown as string}@${input.agent.version as unknown as string}`,
        expectedVersion: snapshot.agentVersion,
        actualVersion: input.agent.version,
      } as never,
    };
  }

  // 3. Reconstruct the InvokeAgentInput envelope from the snapshot.
  const reconstructedInput = turnInputFromSnapshot(snapshot, input);

  // 4. Build the same TurnContext + handlers as invokeAgent().
  const started = Date.now();
  const maxWallMs = input.agent.budget?.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const controller = new AbortController();
  const ctx: TurnContext = {
    input: reconstructedInput,
    bindings,
    turnAbort: controller,
    startedAt: started,
    appended: [],
    usage: {
      steps: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalCostUsd: 0,
    },
    abortReason: undefined,
  };
  const timer = setTimeout(() => {
    ctx.abortReason = 'timeout';
    controller.abort(new Error('wall-clock budget exhausted'));
  }, maxWallMs);

  try {
    const handlers = buildHandlers(ctx);
    if (bindings.runBinding === undefined) {
      throw new Error('resumeAgentTurn: bindings.runBinding is required.');
    }
    // The kernel won't re-run the steps that completed before the park,
    // and they kept their state on the in-memory context: rebuild it.
    const rehydrated = await rehydrateFromJournal(ctx, input.runId, bindings.runBinding);
    if (rehydrated !== undefined) return rehydrated;
    const runResult: Result<
      RunResult<AgentTurnResult>,
      KernelError
    > = await bindings.runBinding.resumeRun<AgentTurnResult>({
      tenantId: reconstructedInput.tenantId,
      runId: input.runId,
      flow: AGENT_TURN_FLOW,
      handlers,
    });
    return await projectRunResult(runResult, ctx);
  } finally {
    clearTimeout(timer);
  }
}

// ============ public API re-exports ============
// The public types live under `./handlers/`; index.ts re-exports them
// from here.

export type {
  AgentStepOutput,
  AgentTurnResult,
  AgentTurnUsage,
  AgentTurnWarning,
} from './handlers/result-shape.js';
export { agentStepOutput } from './handlers/result-shape.js';
export type {
  AgentTurnAbortedError,
  BudgetExceededError,
  CapabilityRoutingError,
  InvokeAgentError,
  ModelInvocationError,
  OutputSchemaViolationError,
  RunSnapshotError,
  SemanticUnavailableError,
  ToolInvocationError,
  UnresolvedToolError,
} from './handlers/errors.js';
export type {
  HitlBindings,
  HitlEnqueueInput,
  HitlEnqueueResult,
  InvokeAgentBindings,
  InvokeAgentInput,
} from './handlers/public-types.js';

/**
 * The `InvokeAgentInput` a resumed turn runs with: the one captured in its
 * snapshot at run start, the agent the caller resolved, and the org of the
 * run's project, which the caller resolves as for `invokeAgent`.
 */
export function turnInputFromSnapshot(
  snapshot: RunSnapshotRecord,
  input: Pick<ResumeAgentTurnInput, 'agent' | 'orgId'>,
): InvokeAgentInput {
  return {
    tenantId: snapshot.tenantId,
    projectId: snapshot.projectId,
    ...(input.orgId !== undefined && { orgId: input.orgId }),
    agent: input.agent,
    conversationId: snapshot.conversationId,
    userMessage: snapshot.userMessage,
    ...(snapshot.parameters !== undefined && { parameters: snapshot.parameters }),
    ...(snapshot.input !== undefined && { input: snapshot.input }),
    ...(snapshot.participantId !== undefined && { participantId: snapshot.participantId }),
    ...(snapshot.dryRun && { dryRun: true }),
    ...(snapshot.principal !== undefined &&
      snapshot.principal !== null && {
        principal: snapshot.principal as Principal,
      }),
    ...(snapshot.authz !== undefined &&
      snapshot.authz !== null && {
        authz: snapshot.authz as { readonly fgaApiUrl: string },
      }),
    ...(snapshot.replay !== undefined && snapshot.replay !== null && { replay: snapshot.replay }),
  };
}
