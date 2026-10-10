// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Typed agent output and structured step input: the answer checked
 * against `Agent.output`, the repair loop in `budget-check`, the turn
 * result, and the input reaching the prompt, the snapshot and the
 * guardrail trace.
 */

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { RunBinding, RunFlowInput } from '@kindgi/runtime';
import type { NodeId, OrgId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { buildRunTrace } from '../src/guardrails-gate.js';
import { buildBudgetCheckHandler } from '../src/handlers/budget-check.js';
import { buildBuildInitialMessagesHandler } from '../src/handlers/build-initial-messages.js';
import { buildComposeResultHandler } from '../src/handlers/compose-result.js';
import type { AgentTurnIterationOutput, TurnContext } from '../src/handlers/context.js';
import { parseFailureMessage } from '../src/handlers/errors.js';
import { addModelWarnings } from '../src/handlers/model-call.js';
import type { InvokeAgentBindings, InvokeAgentInput } from '../src/handlers/public-types.js';
import { writeRunSnapshot } from '../src/handlers/run-snapshot.js';
import {
  outputChecker,
  outputInstructions,
  parseJsonAnswer,
  repairMessage,
  repairsSoFar,
} from '../src/handlers/structured-output.js';
import { agentStepOutput, invokeAgent, turnInputFromSnapshot } from '../src/invoke.js';
import { renderInstructions } from '../src/prompt.js';
import type { RunSnapshotRecord, RunSnapshotWriteInput } from '../src/run-snapshot-binding.js';
import type { Agent, AgentOutputSpec, ConversationId } from '../src/types.js';

const tenantId = 'acme' as TenantId;
const projectId = '00000000-0000-0000-0000-0000000000aa' as ProjectId;
const conversationId = '00000000-0000-0000-0000-0000000000cc' as ConversationId;
const runId = '00000000-0000-0000-0000-0000000000dd' as RunId;

const AXES: AgentOutputSpec = {
  name: 'axes',
  schema: {
    type: 'object',
    properties: { remedy: { type: 'array', items: { type: 'string' } } },
    required: ['remedy'],
    additionalProperties: false,
  },
};

function agent(extra: Record<string, unknown> = {}): Agent {
  const r = defineAgent({
    id: 'acme.parse-grievance',
    version: '1.0.0',
    name: 'Parse grievance',
    instructions: 'Read {{ input.grievance.id }} and list the remedies.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...extra,
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

function ctxFor(a: Agent, input: Partial<InvokeAgentInput> = {}): TurnContext {
  return {
    input: { tenantId, projectId, agent: a, conversationId, userMessage: 'go', ...input },
    bindings: {} as InvokeAgentBindings,
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    abortReason: undefined,
  };
}

const kctx = (dryRun = false) =>
  ({ runId, dryRun, nodeId: 'n' as NodeId }) as unknown as NodeContext;

function answer(content: string, sent: readonly ModelMessage[] = []) {
  return {
    step: 1,
    finishReason: 'stop',
    message: { role: 'assistant', content },
    iterationAppended: [],
    iterationUsage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    provider: { id: 'p', model: 'm' },
    nextMessages: sent,
    hasToolCalls: false,
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (cause) {
    return parseFailureMessage((cause as Error).message);
  }
  throw new Error('expected the handler to fail');
}

describe('reading and checking the answer', () => {
  test('a bare or fenced JSON answer parses; anything else does not', () => {
    expect(parseJsonAnswer('{"remedy":["reinstatement"]}')).toEqual({
      kind: 'ok',
      value: { remedy: ['reinstatement'] },
    });
    expect(parseJsonAnswer('```json\n{"remedy":[]}\n```')).toEqual({
      kind: 'ok',
      value: { remedy: [] },
    });
    expect(parseJsonAnswer('Sure! Here it is.').kind).toBe('invalid');
    expect(parseJsonAnswer('').kind).toBe('invalid');
  });

  test('the checker lists where the answer departs from the schema', () => {
    const checker = outputChecker(AXES);
    expect(checker.check('{"remedy":["backpay"]}').kind).toBe('ok');
    const wrong = checker.check('{"remedy":"backpay"}');
    expect(wrong.kind === 'invalid' && wrong.errors).toEqual(['/remedy must be array']);
  });

  test('a repair message names the output and the problems, and is counted', () => {
    const msg = repairMessage(AXES, ['/remedy must be array']);
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('the axes as JSON');
    expect(msg.content).toContain('- /remedy must be array');
    expect(repairsSoFar([{ role: 'user', content: 'go' }, msg])).toBe(1);
  });
});

describe("the output, told from the turn's start", () => {
  /** The system message the turn's first model call is sent. */
  async function systemOf(a: Agent): Promise<string> {
    const ctx = {
      ...ctxFor(a),
      bindings: {
        conversationBinding: { readMessages: async () => ({ kind: 'ok', value: [] }) },
      },
      conversation: { id: conversationId, tenantId, projectId },
      retrieved: [],
      renderedPrompt: 'Read the grievance and list the remedies.',
      userMessage: { sequence: 1, role: 'user', content: 'go' },
    } as unknown as TurnContext;
    const out = (await buildBuildInitialMessagesHandler(ctx)(undefined, kctx())) as {
      nextMessages: { role: string; content: string }[];
    };
    const [system] = out.nextMessages;
    expect(system?.role).toBe('system');
    return system?.content ?? '';
  }

  test("a typed agent's system message carries the output, in the words a repair uses", async () => {
    const system = await systemOf(agent({ output: AXES }));
    expect(system.startsWith('Read the grievance and list the remedies.')).toBe(true);
    expect(system).toContain(outputInstructions(AXES));
    expect(system).toContain('Call the tools you need first');
    expect(repairMessage(AXES, ['x']).content).toContain(outputInstructions(AXES));
  });

  test('the schema goes as written, its descriptions included', async () => {
    const described: AgentOutputSpec = {
      name: 'verdict',
      schema: {
        type: 'object',
        properties: { refund: { type: 'boolean', description: 'Whether the order is refunded' } },
        required: ['refund'],
      },
    };
    const system = await systemOf(agent({ output: described }));
    expect(system).toContain('the verdict as JSON');
    expect(system).toContain('"description":"Whether the order is refunded"');
  });

  test("an untyped agent's system message has no output part", async () => {
    const system = await systemOf(agent());
    expect(system).not.toContain('as JSON matching this JSON Schema');
  });
});

describe('budget-check with a typed output', () => {
  test('a valid answer finishes the turn', async () => {
    const handler = buildBudgetCheckHandler(ctxFor(agent({ output: AXES })));
    const out = (await handler(
      answer('{"remedy":["reinstatement"]}'),
      kctx(),
    )) as AgentTurnIterationOutput;
    expect(out.finishedTurn).toBe(true);
  });

  test('an invalid answer with a repair left keeps the turn going with a repair message', async () => {
    const handler = buildBudgetCheckHandler(ctxFor(agent({ output: AXES })));
    const sent: ModelMessage[] = [{ role: 'user', content: 'go' }];
    const out = (await handler(answer('not json', sent), kctx())) as AgentTurnIterationOutput;
    expect(out.finishedTurn).toBe(false);
    expect(out.nextMessages.slice(0, 2)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'not json' },
    ]);
    expect(repairsSoFar(out.nextMessages)).toBe(1);
  });

  test('still invalid after the repairs: output-schema-violation, with the attempts', async () => {
    const handler = buildBudgetCheckHandler(ctxFor(agent({ output: AXES })));
    const sent = [{ role: 'user', content: 'go' } as ModelMessage, repairMessage(AXES, ['x'])];
    const error = await failureOf(() => handler(answer('{"remedy":1}', sent), kctx()));
    expect(error).toMatchObject({
      code: 'output-schema-violation',
      errors: ['/remedy must be array'],
      attempts: 2,
    });
  });

  test('maxRepairs 0 fails on the first invalid answer', async () => {
    const handler = buildBudgetCheckHandler(ctxFor(agent({ output: { ...AXES, maxRepairs: 0 } })));
    const error = await failureOf(() => handler(answer('nope'), kctx()));
    expect(error).toMatchObject({ code: 'output-schema-violation', attempts: 1 });
  });

  test('no steps left: no repair, the turn fails', async () => {
    const a = agent({ output: AXES, budget: { maxSteps: 1 } });
    const handler = buildBudgetCheckHandler(ctxFor(a));
    const error = await failureOf(() => handler(answer('nope'), kctx()));
    expect(error).toMatchObject({ code: 'output-schema-violation' });
  });

  test('a dry run, a tool call, or an agent without output: no check', async () => {
    const typed = buildBudgetCheckHandler(ctxFor(agent({ output: AXES })));
    expect(
      ((await typed(answer('[dry-run]'), kctx(true))) as AgentTurnIterationOutput).finishedTurn,
    ).toBe(true);
    const toolCall = { ...answer(''), hasToolCalls: true, finishReason: 'tool-use' };
    expect(((await typed(toolCall, kctx())) as AgentTurnIterationOutput).finishedTurn).toBe(false);
    const plain = buildBudgetCheckHandler(ctxFor(agent()));
    expect(
      ((await plain(answer('free text'), kctx())) as AgentTurnIterationOutput).finishedTurn,
    ).toBe(true);
  });
});

describe('the turn result', () => {
  function composed(a: Agent, content: string) {
    const ctx = ctxFor(a);
    ctx.conversation = { turnCount: 2 } as NonNullable<TurnContext['conversation']>;
    ctx.finalMessage = {
      sequence: 1,
      role: 'agent',
      content,
      createdAt: 'now',
    } as NonNullable<TurnContext['finalMessage']>;
    return { ctx, handler: buildComposeResultHandler(ctx) };
  }

  /** The turn result — returned wrapped as `{ output }`, so its own `output` survives. */
  async function result(handler: ReturnType<typeof buildComposeResultHandler>, k: NodeContext) {
    const returned = (await handler(undefined, k)) as { readonly output: Record<string, unknown> };
    expect(Object.keys(returned)).toEqual(['output']);
    return returned.output;
  }

  test('carries the run id, and the parsed output when the agent declares one', async () => {
    const { handler } = composed(agent({ output: AXES }), '```json\n{"remedy":["backpay"]}\n```');
    expect(await result(handler, kctx())).toMatchObject({
      runId,
      output: { remedy: ['backpay'] },
    });
  });

  test('a turn on a fallback provider carries a fallback-provider warning', async () => {
    const onProvider = (fallback: boolean) => {
      const c = composed(agent(), 'Tool responded: hi');
      c.ctx.provider = {
        metadata: {
          id: 'dev-echo',
          region: 'local',
          models: [],
          ...(fallback && { fallback: true }),
        },
        invoke: () => Promise.reject(new Error('not called')),
      };
      return c.handler;
    };
    expect(await result(onProvider(true), kctx())).toMatchObject({
      warnings: [
        {
          code: 'fallback-provider',
          message:
            'Answered by "dev-echo", a fallback provider: no other registered provider satisfies agent "acme.parse-grievance".',
        },
      ],
    });
    expect(await result(onProvider(false), kctx())).not.toHaveProperty('warnings');
  });

  test('same-user memory in a run that names no end user carries memory-needs-participant', async () => {
    const recalls = {
      ...agent(),
      retrieval: [{ source: 'conversations', scope: 'same-user' }],
    } as unknown as Agent;
    const remembers = {
      ...agent(),
      memory: { remember: { types: ['acme.note'], scope: 'same-user' } },
    } as unknown as Agent;
    for (const a of [recalls, remembers]) {
      const got = (await result(composed(a, 'hi').handler, kctx())) as {
        warnings: { code: string; message: string }[];
      };
      expect(got.warnings).toEqual([
        {
          code: 'memory-needs-participant',
          message: expect.stringContaining("Pass the person's `participantId` on each run"),
        },
      ]);
    }
    // With the end user named, none.
    const named = composed(recalls, 'hi');
    named.ctx.conversation = {
      turnCount: 2,
      participantId: 'cus_ben',
    } as NonNullable<TurnContext['conversation']>;
    expect(await result(named.handler, kctx())).not.toHaveProperty('warnings');
    // Memory that isn't per person: none either.
    const project = {
      ...agent(),
      retrieval: [{ types: ['acme.note'], scope: 'same-project' }],
    } as unknown as Agent;
    expect(await result(composed(project, 'hi').handler, kctx())).not.toHaveProperty('warnings');
  });

  test("a provider's own warnings follow, one per code (dev-echo's dev-echo-not-a-model)", async () => {
    const c = composed(agent(), 'hi');
    c.ctx.provider = {
      metadata: { id: 'dev-echo', region: 'local', models: [], fallback: true },
      invoke: () => Promise.reject(new Error('not called')),
    };
    addModelWarnings(c.ctx, [{ code: 'dev-echo-not-a-model', message: 'not a model (first)' }]);
    addModelWarnings(c.ctx, [{ code: 'dev-echo-not-a-model', message: 'not a model (second)' }]);
    const got = (await result(c.handler, kctx())) as {
      warnings: { code: string; message: string }[];
    };
    expect(got.warnings.map((w) => w.code)).toEqual(['fallback-provider', 'dev-echo-not-a-model']);
    expect(got.warnings[1]?.message).toBe('not a model (first)');
  });

  test('a dry run reports output null; an untyped agent has no output', async () => {
    const typed = composed(agent({ output: AXES }), '[dry-run]');
    expect(await result(typed.handler, kctx(true))).toMatchObject({ output: null });
    const plain = composed(agent(), 'hello');
    expect(await result(plain.handler, kctx())).not.toHaveProperty('output');
  });
});

describe('defineAgent output', () => {
  test('a Zod schema is converted to JSON Schema at definition time', () => {
    const a = agent({
      output: { schema: z.object({ remedy: z.array(z.string()) }), name: 'axes' },
    });
    expect(a.output?.name).toBe('axes');
    expect(a.output?.schema).toMatchObject({ type: 'object', required: ['remedy'] });
  });

  test('a schema that does not compile, or a negative maxRepairs, is invalid', () => {
    const r = defineAgent({
      id: 'acme.bad',
      version: '1.0.0',
      name: 'Bad',
      instructions: 'x',
      capabilities: [{ needs: [{ feature: 'tool-use' }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
      output: { schema: { type: 'not-a-type' }, maxRepairs: -1 },
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.map((i) => i.path).sort()).toEqual([
        '/output/maxRepairs',
        '/output/schema',
      ]);
    }
  });

  test('preferredModel is kept', () => {
    expect(agent({ preferredProvider: 'anthropic', preferredModel: 'claude-x' })).toMatchObject({
      preferredProvider: 'anthropic',
      preferredModel: 'claude-x',
    });
  });
});

describe('structured step input', () => {
  test('renders as {{ input.* }}; without one, a reference to it is missing', () => {
    const rendered = renderInstructions(agent(), {
      parameters: {},
      input: { grievance: { id: 'g-acme-1' } },
    });
    expect(rendered.ok && rendered.value.rendered).toBe('Read g-acme-1 and list the remedies.');
    const missing = renderInstructions(agent(), { parameters: {} });
    expect(!missing.ok && missing.error.code).toBe('missing-parameter');
  });

  test('the run snapshot keeps input and parameters, so a resumed turn renders the same', async () => {
    const written: RunSnapshotWriteInput[] = [];
    const ctx = ctxFor(agent(), {
      input: { grievance: { id: 'g-1' } },
      parameters: { tone: 'formal' },
    });
    (ctx as { bindings: InvokeAgentBindings }).bindings = {
      runSnapshotBinding: {
        write: async (w: RunSnapshotWriteInput) => {
          written.push(w);
          return { kind: 'ok', value: undefined };
        },
        read: async () => ({ kind: 'ok', value: null }),
      },
    } as unknown as InvokeAgentBindings;
    await writeRunSnapshot(ctx, kctx());
    expect(written[0]).toMatchObject({
      runId,
      input: { grievance: { id: 'g-1' } },
      parameters: { tone: 'formal' },
    });
  });

  test("invokeAgent records the turn's parent on its run", async () => {
    const seen: RunFlowInput[] = [];
    const runBinding = {
      runGraph: async (input: RunFlowInput) => {
        seen.push(input);
        return { kind: 'err', error: { code: 'journal-error', message: 'stop here', cause: null } };
      },
    } as unknown as RunBinding;
    const parent = { runId: 'parent-run' as RunId, nodeId: 'parse' as NodeId, scope: '' };
    await invokeAgent(
      { tenantId, projectId, agent: agent(), conversationId, userMessage: '{}', input: {}, parent },
      { runBinding } as unknown as InvokeAgentBindings,
    );
    expect(seen[0]?.parent).toEqual(parent);
  });

  test("invokeAgent names the agent, its version and the conversation on the turn's run", async () => {
    const seen: RunFlowInput[] = [];
    const runBinding = {
      runGraph: async (input: RunFlowInput) => {
        seen.push(input);
        return { kind: 'err', error: { code: 'journal-error', message: 'stop here', cause: null } };
      },
    } as unknown as RunBinding;
    const spec = agent();
    await invokeAgent(
      { tenantId, projectId, agent: spec, conversationId, userMessage: '{}', input: {} },
      { runBinding } as unknown as InvokeAgentBindings,
    );
    expect(seen[0]?.agent).toEqual({ id: spec.id, version: spec.version, conversationId });
  });
});

describe('buildRunTrace', () => {
  test("carries the project's org when it has one, and no orgId when it hasn't", () => {
    const base = {
      runId,
      tenantId,
      projectId,
      conversationId,
      turnNumber: 1,
      agent: agent(),
      userMessage: 'go',
      appended: [],
      finalResponse: { sequence: 1, role: 'agent', content: 'ok', createdAt: 'now' } as never,
      usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0, durationMs: 1 },
    };
    const orgId = 'org-1' as OrgId;
    expect(buildRunTrace({ ...base, orgId })).toMatchObject({ projectId, orgId });
    expect(buildRunTrace(base)).not.toHaveProperty('orgId');
  });

  test('carries the run, project, turn number, user input, step input and structured output', () => {
    const trace = buildRunTrace({
      runId,
      tenantId,
      projectId,
      conversationId,
      turnNumber: 3,
      agent: agent(),
      userMessage: 'go',
      stepInput: { grievance: { id: 'g-1' } },
      structuredOutput: { remedy: [] },
      appended: [],
      finalResponse: { sequence: 1, role: 'agent', content: '{}', createdAt: 'now' } as never,
      usage: { steps: 2, promptTokens: 1, completionTokens: 1, totalCostUsd: 0.01, durationMs: 5 },
    });
    expect(trace).toMatchObject({
      runId,
      projectId,
      conversationId,
      turnNumber: 3,
      userInput: 'go',
      totalCostUsd: 0.01,
      attributes: {
        steps: 2,
        stepInput: { grievance: { id: 'g-1' } },
        structuredOutput: { remedy: [] },
      },
    });
  });
});

describe('agentStepOutput', () => {
  test("a flow step's output: the typed answer, its text, the child run and the findings", () => {
    const step = agentStepOutput({
      runId,
      conversationId,
      turnNumber: 1,
      appended: [],
      response: { sequence: 2, role: 'agent', content: '{"remedy":[]}', createdAt: 'now' } as never,
      retrieved: [],
      violations: [
        {
          guardrailId: 'acme.tone' as never,
          result: { passed: false },
          action: 'warn',
          severity: 'warning',
          at: 'now',
        } as never,
      ],
      usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0, durationMs: 1 },
      provider: { id: 'p', model: 'm' },
      output: { remedy: [] },
    });
    expect(step).toEqual({
      output: { remedy: [] },
      text: '{"remedy":[]}',
      runId,
      conversationId,
      usage: { steps: 1, promptTokens: 1, completionTokens: 1, totalCostUsd: 0, durationMs: 1 },
      violations: [{ guardrailId: 'acme.tone', severity: 'warning', action: 'warn' }],
    });
  });
});

describe('turnInputFromSnapshot', () => {
  test("a resumed turn keeps the run's project, and gets the org its caller resolved", () => {
    const snapshot = {
      runId,
      tenantId,
      projectId,
      agentId: 'pack.agent',
      agentVersion: '1.0.0',
      conversationId,
      userMessage: 'go',
      dryRun: false,
    } as unknown as RunSnapshotRecord;
    const orgId = 'org-1' as OrgId;
    expect(turnInputFromSnapshot(snapshot, { agent: agent(), orgId })).toMatchObject({
      tenantId,
      projectId,
      orgId,
    });
    expect(turnInputFromSnapshot(snapshot, { agent: agent() })).not.toHaveProperty('orgId');
  });
});
