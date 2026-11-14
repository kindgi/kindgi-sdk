// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn stops when its run is stopped. The runtime aborts a node's
 * `abortSignal` when the run ends from outside (a cancel, a shutdown), and
 * the turn's own work listens to the turn's abort: each handler links the
 * two as it starts, so a model call in flight stops at once, and unlinks
 * them as it settles, so a long turn leaves no listener behind. The turn's
 * caller's own `abortSignal` is linked once for the whole turn, and left as
 * the turn returns.
 */

import { getEventListeners } from 'node:events';

import { describe, expect, test } from 'vitest';

import type {
  ModelCallResult,
  ModelInfo,
  ModelProvider,
  ProviderMetadata,
} from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { RunBinding } from '@kindgi/runtime';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { MODEL_CALL_NODE } from '../src/agent-turn-flow.js';
import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { turnFailureMessage } from '../src/handlers/errors.js';
import { buildHandlers } from '../src/handlers/index.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import { invokeAgent } from '../src/invoke.js';
import { projectRunResult } from '../src/project-run-result.js';
import type { ConversationId } from '../src/types.js';
import { testNodeContext } from './node-context.js';

/** A turn whose model call waits until its signal aborts, and says when it saw it. */
function turnWithSlowModel(): { ctx: TurnContext; aborted: Promise<void> } {
  const agent = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (agent.kind === 'err') throw new Error(JSON.stringify(agent.error.issues));
  let sawAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    sawAbort = resolve;
  });
  const provider: ModelProvider = {
    metadata: { id: 'acme-model' } as ProviderMetadata,
    // As a network call does: an aborted signal rejects at once, or as it aborts.
    invoke: (input) =>
      new Promise((_, reject) => {
        const stop = (): void => {
          sawAbort();
          reject(new Error('aborted'));
        };
        if (input.abortSignal?.aborted) stop();
        else input.abortSignal?.addEventListener('abort', stop, { once: true });
      }),
  };
  const ctx: TurnContext = {
    input: {
      tenantId: 'acme' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent.value,
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'hi',
    },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
    provider,
    model: { name: 'acme-1', features: [], contextWindow: 200_000 } as unknown as ModelInfo,
    tools: { definitions: [], byName: new Map() },
  };
  return { ctx, aborted };
}

function modelCall(ctx: TurnContext) {
  const handler = buildHandlers(ctx).get(MODEL_CALL_NODE as NodeId);
  if (handler === undefined) throw new Error('no model-call handler');
  return handler;
}

describe("a turn follows its run's abort", () => {
  test('the run stopped mid-call: the model call is aborted, as from outside', async () => {
    const { ctx, aborted } = turnWithSlowModel();
    const run = new AbortController();
    const kctx = testNodeContext({
      runId: 'run-1' as RunId,
      dryRun: false,
      abortSignal: run.signal,
    } as Partial<NodeContext> & { runId: RunId });
    const call = Promise.resolve(modelCall(ctx)({ nextMessages: [] }, kctx)).catch((e) => e);
    run.abort(new Error('the run was cancelled'));
    await aborted;
    expect(ctx.turnAbort.signal.aborted).toBe(true);
    expect(ctx.abortReason).toBe('external');
    await call;
  });

  test('a run already stopped when the step starts: the turn is aborted before the call', async () => {
    const { ctx } = turnWithSlowModel();
    const run = new AbortController();
    run.abort();
    const kctx = testNodeContext({
      runId: 'run-1' as RunId,
      dryRun: false,
      abortSignal: run.signal,
    } as Partial<NodeContext> & { runId: RunId });
    await Promise.resolve(modelCall(ctx)({ nextMessages: [] }, kctx)).catch((e) => e);
    expect(ctx.turnAbort.signal.aborted).toBe(true);
    expect(ctx.abortReason).toBe('external');
  });

  test('a wall-clock timeout keeps its own reason', async () => {
    const { ctx } = turnWithSlowModel();
    ctx.abortReason = 'timeout';
    ctx.turnAbort.abort();
    const run = new AbortController();
    const kctx = testNodeContext({
      runId: 'run-1' as RunId,
      dryRun: false,
      abortSignal: run.signal,
    } as Partial<NodeContext> & { runId: RunId });
    run.abort();
    await Promise.resolve(modelCall(ctx)({ nextMessages: [] }, kctx)).catch((e) => e);
    expect(ctx.abortReason).toBe('timeout');
  });

  test('each step unlinks as it settles: 12 steps on one run leave no listener and no warning', async () => {
    const answer: ModelCallResult = {
      message: { role: 'assistant', content: 'done' },
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 2 },
      costUsd: 0,
      durationMs: 5,
      provider: { id: 'acme-model', model: 'acme-1' },
    };
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on('warning', onWarning);
    try {
      const run = new AbortController();
      const kctx = testNodeContext({
        runId: 'run-1' as RunId,
        dryRun: false,
        abortSignal: run.signal,
      } as Partial<NodeContext> & { runId: RunId });
      const { ctx: slow } = turnWithSlowModel();
      const answers = { ...slow, provider: { ...slow.provider, invoke: async () => answer } };
      const fails = {
        ...slow,
        provider: { ...slow.provider, invoke: () => Promise.reject(new Error('529 overloaded')) },
      };
      for (const ctx of [answers, fails] as TurnContext[]) {
        const handler = modelCall(ctx);
        for (let i = 0; i < 12; i += 1) {
          await Promise.resolve(handler({ nextMessages: [] }, kctx)).catch((e: unknown) => e);
          expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
        }
      }
      // The steps answered and failed as their models did, the turn unstopped.
      await expect(
        modelCall(answers as TurnContext)({ nextMessages: [] }, kctx),
      ).resolves.toBeDefined();
      await expect(modelCall(fails as TurnContext)({ nextMessages: [] }, kctx)).rejects.toThrow();
      expect(slow.turnAbort.signal.aborted).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });
});

describe("a turn follows its caller's signal", () => {
  test('invokeAgent listens to it while its run runs, and leaves it once the turn returns', async () => {
    const caller = new AbortController();
    let listening: number | undefined;
    const runBinding = {
      runGraph: async () => {
        listening = getEventListeners(caller.signal, 'abort').length;
        return { kind: 'err', error: { code: 'journal-error', message: 'stop here', cause: null } };
      },
    } as unknown as RunBinding;
    const bindings = { runBinding } as unknown as InvokeAgentBindings;
    const { ctx } = turnWithSlowModel();
    await invokeAgent({ ...ctx.input, abortSignal: caller.signal }, bindings);
    expect(listening).toBe(1);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });
});

describe('a cancelled turn says it was cancelled, in plain words', () => {
  const ctxFor = (): TurnContext => {
    const { ctx } = turnWithSlowModel();
    return { ...ctx, bindings: {} as InvokeAgentBindings };
  };
  const cancelled = (failureMessage: string | undefined) =>
    ({
      kind: 'ok',
      value: {
        runId: 'run-1',
        status: 'cancelled',
        ...(failureMessage !== undefined && { failureMessage }),
      },
    }) as never;

  test("the step its cancel aborted adds nothing: never the turn's serialized failure", async () => {
    const aborted = turnFailureMessage({
      code: 'agent-turn-aborted',
      message: 'Agent turn aborted: Request was aborted.',
      reason: 'external',
    });
    // As a cancelled run reports it: the step's failure, and the loop's attribution of it.
    const r = await projectRunResult(cancelled(`${aborted}; [body-failure] ${aborted}`), ctxFor());
    expect(r).toEqual({
      kind: 'err',
      error: { code: 'agent-turn-aborted', message: 'Agent turn cancelled', reason: 'external' },
    });
  });

  test('other words are kept, and none is none', async () => {
    const said = await projectRunResult(cancelled('erased'), ctxFor());
    expect(said.kind === 'err' && said.error.message).toBe('Agent turn cancelled: erased');
    const bare = await projectRunResult(cancelled(undefined), ctxFor());
    expect(bare.kind === 'err' && bare.error.message).toBe('Agent turn cancelled');
  });
});
