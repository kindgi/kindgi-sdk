// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An error the kernel answers a turn's run with, at its start or its
 * resume, comes back as the turn's `model-invocation-failed`, with that
 * very error as its `cause`. A runtime serving the turn reads the kernel's
 * code back from it: a run the kernel can't resume, or one another
 * executor holds, is told apart from a model call that failed.
 */

import { describe, expect, test } from 'vitest';

import type { KernelError, RunBinding } from '@kindgi/runtime';
import type { ProjectId, Result, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { InvokeAgentError } from '../src/handlers/errors.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { AgentTurnResult } from '../src/handlers/result-shape.js';
import { invokeAgent, resumeAgentTurn } from '../src/invoke.js';
import type { ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;
const projectId = '00000000-0000-0000-0000-0000000000aa' as ProjectId;
const conversationId = '00000000-0000-0000-0000-0000000000cc' as ConversationId;
const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

function agent() {
  const defined = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (defined.kind === 'err') throw new Error(JSON.stringify(defined.error.issues));
  return defined.value;
}

/** The `cause` of a turn's `model-invocation-failed`; undefined for any other result. */
function causeOf(result: Result<AgentTurnResult, InvokeAgentError>): unknown {
  return result.kind === 'err' && result.error.code === 'model-invocation-failed'
    ? result.error.cause
    : undefined;
}

describe("a kernel error comes back as the turn's model-invocation-failed, with that error as its cause", () => {
  test('at the start: a run this executor lost', async () => {
    const lost: KernelError = {
      code: 'run-lease-lost',
      message: `Run ${runId}'s lease moved on to another executor`,
      runId,
    };
    const runBinding = {
      runGraph: async () => ({ kind: 'err', error: lost }),
    } as unknown as RunBinding;
    const result = await invokeAgent(
      { tenantId, projectId, agent: agent(), conversationId, userMessage: 'hi' },
      { runBinding } as unknown as InvokeAgentBindings,
    );
    expect(result).toEqual({
      kind: 'err',
      error: {
        code: 'model-invocation-failed',
        message: `Kernel run failed: ${lost.message}`,
        cause: lost,
      },
    });
    // The same object, not a copy: a copy carries no proof it is the kernel's.
    expect(causeOf(result)).toBe(lost);
  });

  test("at a resume: a run started on another version of the turn's flow", async () => {
    const spec = agent();
    const refused: KernelError = {
      code: 'flow-mismatch',
      message: 'Run was started with flow agent-turn@1; resumeRun called with agent-turn@2',
      expected: { id: 'agent-turn', version: '1' },
      got: { id: 'agent-turn', version: '2' },
    };
    const result = await resumeAgentTurn({ tenantId, runId, agent: spec }, {
      runSnapshotBinding: {
        read: async () => ({
          kind: 'ok',
          value: {
            runId,
            tenantId,
            projectId,
            agentId: spec.id,
            agentVersion: spec.version,
            conversationId,
            userMessage: 'hi',
            dryRun: false,
            createdAt: '2026-10-01T00:00:00Z',
          },
        }),
      },
      runBinding: {
        // A turn parked before its setup completed: nothing to rebuild.
        readJournal: async () => ({ kind: 'ok', value: [] }),
        resumeRun: async () => ({ kind: 'err', error: refused }),
      },
    } as never);
    expect(result).toEqual({
      kind: 'err',
      error: {
        code: 'model-invocation-failed',
        message: `Kernel run failed: ${refused.message}`,
        cause: refused,
      },
    });
    expect(causeOf(result)).toBe(refused);
  });
});
