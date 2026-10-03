// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, Semver, TenantId, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import {
  DEFAULT_TOOL_ERRORS,
  type ToolErrorPolicy,
  effectiveToolErrorPolicy,
  toolErrorKindOf,
  toolErrorResult,
  toolRetriesSoFar,
} from '../src/handlers/tool-errors.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent, AgentId } from '../src/types.js';

describe('effectiveToolErrorPolicy', () => {
  const kinds = (p: ToolErrorPolicy) => [...p.retryOn].sort();

  test('without settings: one retry, for invalid arguments and unknown tools', () => {
    const p = effectiveToolErrorPolicy(undefined, undefined);
    expect(p.maxRetries).toBe(1);
    expect(kinds(p)).toEqual(['invalid-arguments', 'unknown-tool']);
    expect(DEFAULT_TOOL_ERRORS.maxRetries).toBe(1);
  });

  test("the agent's setting applies", () => {
    const p = effectiveToolErrorPolicy({ maxRetries: 3, retryOn: ['tool-error'] }, undefined);
    expect(p.maxRetries).toBe(3);
    expect(kinds(p)).toEqual(['tool-error']);
  });

  test('a tenant policy caps it: the fewer retries, the kinds both allow', () => {
    const p = effectiveToolErrorPolicy(
      { maxRetries: 3, retryOn: ['invalid-arguments', 'tool-error'] },
      { maxRetries: 2, retryOn: ['invalid-arguments', 'unknown-tool'] },
    );
    expect(p.maxRetries).toBe(2);
    expect(kinds(p)).toEqual(['invalid-arguments']);
    // A cap never raises the agent's setting.
    expect(effectiveToolErrorPolicy({ maxRetries: 1 }, { maxRetries: 5 }).maxRetries).toBe(1);
    expect(effectiveToolErrorPolicy(undefined, { maxRetries: 0 }).maxRetries).toBe(0);
  });
});

describe('toolErrorKindOf', () => {
  test.each([
    [{ code: 'unresolved-tool' }, 'unknown-tool'],
    [
      { code: 'tool-invocation-failed', cause: { code: 'input-validation-failed' } },
      'invalid-arguments',
    ],
    [{ code: 'tool-invocation-failed', cause: { code: 'handler-error' } }, 'tool-error'],
    [{ code: 'tool-invocation-failed', cause: { code: 'output-validation-failed' } }, 'tool-error'],
  ])('%j → %s', (error, kind) => {
    expect(toolErrorKindOf(error)).toBe(kind);
  });
});

describe('toolRetriesSoFar', () => {
  const retry = (): ModelMessage => ({
    role: 'tool',
    toolCallId: 'c',
    content: JSON.stringify(toolErrorResult('invalid-arguments', 'bad', undefined)),
  });

  test("counts this turn's retries; earlier turns' results and repair prompts don't move the boundary", () => {
    expect(
      toolRetriesSoFar([
        { role: 'user', content: 'earlier turn' },
        retry(),
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'this turn' },
        { role: 'assistant', content: '', toolCalls: [] },
        retry(),
        { role: 'tool', toolCallId: 'd', content: '{"ok":true}' },
        { role: 'user', content: '[kindgi:output-repair]\nfix it' },
        retry(),
      ]),
    ).toBe(2);
    expect(toolRetriesSoFar([{ role: 'user', content: 'hi' }])).toBe(0);
  });
});

// --- dispatch-tools -------------------------------------------------------

function strictTool(handler: () => Promise<{ ok: boolean }> = async () => ({ ok: true })) {
  const defined = defineTool<{ q: string }, { ok: boolean }>({
    id: 'pack.lookup' as ToolId,
    description: 'Looks something up.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    handler,
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function turn(
  tool: AnyTool,
  policy?: ToolErrorPolicy,
  options: {
    readonly agent?: Record<string, unknown>;
    readonly waitForToken?: () => Promise<unknown>;
  } = {},
) {
  const persisted: Record<string, unknown>[] = [];
  const agent = { id: 'pack.agent', version: '1.0.0', ...options.agent } as unknown as Agent;
  const ctx = {
    input: { tenantId: 't-1' as TenantId, conversationId: 'conv-1', agent },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          persisted.push(m);
          return { kind: 'ok', value: { id: `msg-${persisted.length}`, ...m } };
        },
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    ...(policy !== undefined && { toolErrorPolicy: policy }),
  } as unknown as TurnContext;
  const dispatch = (
    calls: { readonly name: string; readonly arguments: Record<string, unknown> }[],
    nextMessages: readonly ModelMessage[] = [{ role: 'user', content: 'look it up' }],
  ) =>
    buildDispatchToolsHandler(ctx)(
      {
        step: 1,
        finishReason: 'tool-use',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: calls.map((c, i) => ({ id: `call-${i}`, ...c })),
        },
        iterationUsage: { promptTokens: 0, completionTokens: 0 },
        provider: { id: 'p', model: 'm' },
        nextMessages,
      },
      {
        runId: 'run-1' as RunId,
        ...(options.waitForToken !== undefined && { waitForToken: options.waitForToken }),
      } as unknown as NodeContext,
    ) as Promise<{ readonly nextMessages: readonly ModelMessage[] }>;
  return { dispatch, persisted };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    if (error instanceof AgentTurnFailure)
      return error.payload as unknown as Record<string, unknown>;
    throw error;
  }
  throw new Error('the turn did not fail');
}

describe('dispatch-tools — failed calls', () => {
  test('invalid arguments go back to the model once, with the issues; the next call runs', async () => {
    const { dispatch, persisted } = turn(strictTool());
    const out = await dispatch([
      { name: 'pack.lookup', arguments: { query: 'x' } },
      { name: 'pack.lookup', arguments: { q: 'x' } },
    ]);
    const [, , failed, ok] = out.nextMessages;
    const result = JSON.parse(failed?.content ?? '{}');
    expect(result).toMatchObject({
      kindgi: 'tool-error-retry',
      status: 'failed',
      error: {
        kind: 'invalid-arguments',
        message: 'Input for tool "pack.lookup" failed validation',
      },
    });
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(failed?.toolCallId).toBe('call-0');
    expect(JSON.parse(ok?.content ?? '{}')).toEqual({ ok: true });
    // The failed call's result is in the conversation too.
    expect(persisted.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  test('past the retries the turn fails, with the retries it took', async () => {
    const { dispatch } = turn(strictTool());
    const first = await dispatch([{ name: 'pack.lookup', arguments: { query: 'x' } }]);
    const payload = await failure(
      dispatch([{ name: 'pack.lookup', arguments: { query: 'y' } }], first.nextMessages),
    );
    expect(payload).toMatchObject({ code: 'tool-invocation-failed', toolRetries: 1 });
  });

  test('an unknown tool goes back to the model', async () => {
    const { dispatch } = turn(strictTool());
    const out = await dispatch([{ name: 'pack.nope', arguments: {} }]);
    expect(JSON.parse(out.nextMessages.at(-1)?.content ?? '{}')).toMatchObject({
      error: { kind: 'unknown-tool' },
    });
  });

  test('a tool that throws fails the turn — unless the policy retries tool errors', async () => {
    const throwing = strictTool(async () => {
      throw new Error('upstream down');
    });
    const payload = await failure(
      turn(throwing).dispatch([{ name: 'pack.lookup', arguments: { q: 'x' } }]),
    );
    expect(payload.code).toBe('tool-invocation-failed');
    expect(payload).not.toHaveProperty('toolRetries');

    const retrying = turn(
      throwing,
      effectiveToolErrorPolicy({ retryOn: ['tool-error'] }, undefined),
    );
    const out = await retrying.dispatch([{ name: 'pack.lookup', arguments: { q: 'x' } }]);
    expect(JSON.parse(out.nextMessages.at(-1)?.content ?? '{}')).toMatchObject({
      error: { kind: 'tool-error' },
    });
  });

  test('maxRetries 0: the first failure ends the turn', async () => {
    const { dispatch } = turn(strictTool(), effectiveToolErrorPolicy({ maxRetries: 0 }, undefined));
    const payload = await failure(dispatch([{ name: 'pack.lookup', arguments: {} }]));
    expect(payload).toMatchObject({ code: 'tool-invocation-failed', toolRetries: 0 });
  });
});

describe('defineAgent — toolErrors', () => {
  const base = {
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  };

  test('a valid setting is kept', () => {
    const r = defineAgent({
      ...base,
      toolErrors: { maxRetries: 2, retryOn: ['invalid-arguments'] },
    });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
    expect(r.value.toolErrors).toEqual({ maxRetries: 2, retryOn: ['invalid-arguments'] });
  });

  test('invalid settings are issues under /toolErrors', () => {
    const r = defineAgent({
      ...base,
      toolErrors: {
        maxRetries: 11,
        retryOn: ['tool-error', 'tool-error', 'oops'],
        extra: true,
      } as never,
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.map((i) => i.path).sort()).toEqual([
        '/toolErrors/extra',
        '/toolErrors/maxRetries',
        '/toolErrors/retryOn/1',
        '/toolErrors/retryOn/2',
      ]);
    }
  });
});

describe('dispatch-tools — a rejected tool approval', () => {
  test("is stored as the call's result, like a tool's own result; the tool never runs", async () => {
    let ran = false;
    const tool = strictTool(async () => {
      ran = true;
      return { ok: true };
    });
    const { dispatch, persisted } = turn(tool, undefined, {
      agent: {
        conversationPolicy: { hitl: { tools: { overrides: { 'pack.lookup': 'always_ask' } } } },
      },
      waitForToken: async () => ({ decided: 'reject', rationale: 'not this one' }),
    });
    const out = await dispatch([{ name: 'pack.lookup', arguments: { q: 'x' } }]);
    expect(ran).toBe(false);
    expect(out.nextMessages.at(-1)).toEqual({
      role: 'tool',
      content: JSON.stringify({ status: 'rejected', rationale: 'not this one' }),
      toolCallId: 'call-0',
    });
    expect(persisted.find((m) => m.role === 'tool')).toMatchObject({
      role: 'tool',
      content: { status: 'rejected', rationale: 'not this one' },
      toolCall: { toolId: 'pack.lookup', invocationId: 'call-0' },
    });
  });
});
