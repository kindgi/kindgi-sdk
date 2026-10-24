// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A call to a tool that declares connections (`needsSpec.connections`):
 * found once and recorded, waited for when a person's connection is
 * missing and a person started the run, asked fresh for its tokens every
 * time the tool runs, and renewed once when the app refuses one. A call
 * they stop runs nothing; its result tells the model why, and the turn
 * goes on. A call that acts with a person's connection is theirs alone to
 * approve.
 */

import { describe, expect, test } from 'vitest';

import type { Principal } from '@kindgi/authz';
import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { WaitpointCancelledError } from '@kindgi/handler';
import type { RunStartedBy } from '@kindgi/runtime';
import {
  type ConnectionNeed,
  ConnectionRejectedError,
  ConnectionRenewError,
  type ResolveConnectionsInput,
  type ResolveConnectionsOutcome,
  type ToolContext,
  defineTool,
  pauseOutcome,
} from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import type { HitlEnqueueInput } from '../src/handlers/public-types.js';
import { computeConnectWaitToken } from '../src/handlers/tool-hitl.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { TurnEvent } from '../src/streaming.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const TENANT = 't-1' as TenantId;
const RUN = 'run-1' as RunId;
const CALL = 'call-0';
const OWNER = 'user-owner';
const owner: Principal = { actor: { kind: 'user', id: OWNER, tenantId: TENANT } };

const mail: ConnectionNeed = { app: 'acme', permissions: ['mail.send'], as: 'person' };
const shared: ConnectionNeed = { app: 'acme', permissions: ['notes.read'], as: 'company' };

const connectToken = (name: string) => computeConnectWaitToken({ runId: RUN, callId: CALL, name });

function agent(
  conversationPolicy: Record<string, unknown> = {},
  toolErrors?: Record<string, unknown>,
): Agent {
  return {
    id: 'pack.agent',
    version: '1.0.0',
    name: 'Pack agent',
    conversationPolicy,
    ...(toolErrors !== undefined && { toolErrors }),
  } as unknown as Agent;
}

/** Every need ready, with a token that says which ask gave it. */
function readyFor(input: ResolveConnectionsInput, asked: number): ResolveConnectionsOutcome {
  return {
    kind: 'ready',
    connections: Object.fromEntries(
      Object.entries(input.needs).map(([name, need]) => [
        name,
        {
          connectionId: `conn-${name}`,
          app: need.app,
          appName: 'Acme',
          accessToken: `secret-token-${name}-${asked}`,
          account: { id: `acct-${name}`, label: 'owner@acme.example' },
        },
      ]),
    ),
  };
}

function waitFor(name: string): ResolveConnectionsOutcome {
  return {
    kind: 'wait',
    requests: [
      {
        name,
        requestId: `req-${name}`,
        waitToken: connectToken(name),
        app: 'acme',
        appName: 'Acme',
        says: ['Send mail as you'],
        connectUrl: 'https://kindgi.acme.example/console/connect/req-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
}

interface TurnOptions {
  readonly needs?: Readonly<Record<string, ConnectionNeed>>;
  readonly mutating?: boolean;
  /** The tool pauses (`Tool.pauses`): its run may answer a pause. */
  readonly pauses?: true;
  /** The tool's run, after it records what it was given. */
  readonly run?: (ctx: ToolContext, attempt: number) => Promise<unknown>;
  /** The resolver's answers, in order; the last one repeats. Absent: every need ready. */
  readonly answers?: readonly (ResolveConnectionsOutcome | Error)[];
  /** No connections binding. */
  readonly unserved?: true;
  readonly principal?: Principal;
  readonly startedBy?: RunStartedBy;
  readonly policy?: Record<string, unknown>;
  /** The agent's `toolErrors`: which failures the model gets back to retry. */
  readonly toolErrors?: Record<string, unknown>;
  readonly enqueue?: (input: HitlEnqueueInput) => Promise<unknown>;
  /** A wait's answer. Absent: connects connect, approvals approve. */
  readonly waitForToken?: (token: string) => Promise<unknown>;
  readonly records?: Map<string, unknown>;
  /** The step's scope. */
  readonly stepScope?: string;
}

/** Every string a value holds as its own (an error's message and stack too), down its causes. */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || depth > 10) return [];
  return Reflect.ownKeys(value).flatMap((key) => stringsOf(Reflect.get(value, key), depth + 1));
}

async function turn(o: TurnOptions = {}) {
  const ran: ToolContext[] = [];
  const asked: ResolveConnectionsInput[] = [];
  const waits: { readonly token: string; readonly timeoutMs?: number }[] = [];
  const enqueued: HitlEnqueueInput[] = [];
  const events: TurnEvent[] = [];
  const results: unknown[] = [];
  const needs = o.needs ?? { mail };
  const defined = defineTool<{ to: string }, { ok: boolean }>({
    id: 'pack.send' as ToolId,
    description: 'Sends a note.',
    version: '1.0.0',
    input: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    effects: [],
    ...(o.mutating !== undefined && { mutating: o.mutating }),
    needsSpec: { connections: needs },
    handler: async (_input, ctx) => {
      ran.push(ctx);
      if (o.run !== undefined) return (await o.run(ctx, ran.length)) as { ok: boolean };
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  const tool = (o.pauses === true
    ? { ...defined.value, pauses: true }
    : defined.value) as unknown as AnyTool;
  const a = agent(o.policy, o.toolErrors);
  const answers = o.answers ?? [];
  const ctx = {
    input: {
      tenantId: TENANT,
      projectId: 'p-1',
      conversationId: 'conv-1',
      agent: a,
      principal: o.principal ?? owner,
      startedBy: o.startedBy ?? 'person',
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          if (m.role === 'tool') results.push(m.content);
          return { kind: 'ok', value: { id: `msg-${results.length}`, ...m } };
        },
      },
      onEvent: (e: TurnEvent) => {
        events.push(e);
      },
      hitl: {
        enqueue: async (input: HitlEnqueueInput) => {
          enqueued.push(input);
          await o.enqueue?.(input);
          return { approvalId: 'appr-1' };
        },
      },
      ...(o.unserved === undefined && {
        connections: {
          envName: 'production',
          resolver: {
            resolveConnections: async (input: ResolveConnectionsInput) => {
              asked.push(input);
              const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
              if (answer instanceof Error) throw answer;
              return answer ?? readyFor(input, asked.length);
            },
          },
        },
      }),
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent: a }),
  } as unknown as TurnContext;
  const records = o.records ?? new Map<string, unknown>();
  let thrown: unknown;
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: CALL, name: 'pack.send', arguments: { to: 'someone' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'send it' }] as readonly ModelMessage[],
    },
    testNodeContext(
      {
        runId: RUN,
        ...(o.stepScope !== undefined && { stepScope: o.stepScope }),
        waitForToken: (async (token: string, options?: { timeoutMs?: number }) => {
          waits.push({ token, ...(options?.timeoutMs !== undefined && options) });
          if (o.waitForToken !== undefined) return o.waitForToken(token);
          return Object.keys(needs).some((name) => connectToken(name) === token)
            ? { kind: 'connected', connectionId: 'conn-new' }
            : { decided: 'approve' };
        }) as NodeContext['waitForToken'],
      },
      records,
    ),
  ).catch((e: unknown) => {
    thrown = e;
  });
  const failed = events.filter((e) => e.kind === 'tool.failed');
  return { ran, asked, waits, enqueued, events, failed, results, records, thrown, ctx };
}

describe('a call gets its connections before it runs', () => {
  test('ready: the tool gets its tokens, asked fresh; the record keeps none', async () => {
    const t = await turn({ needs: { mail, shared } });
    expect(t.ran).toHaveLength(1);
    // Once recorded, once fresh for the run itself.
    expect(t.asked).toHaveLength(2);
    expect(t.ran[0]?.connections?.mail?.accessToken).toBe('secret-token-mail-2');
    expect(t.ran[0]?.connections?.shared?.accessToken).toBe('secret-token-shared-2');
    expect(t.ran[0]?.connections?.mail?.account.label).toBe('owner@acme.example');
    expect(JSON.stringify([...t.records.entries()])).not.toContain('secret-token');
    expect(t.records.get(`connection-gate:${CALL}`)).toEqual({
      kind: 'ready',
      connections: {
        mail: {
          connectionId: 'conn-mail',
          app: 'acme',
          appName: 'Acme',
          account: { id: 'acct-mail', label: 'owner@acme.example' },
        },
        shared: {
          connectionId: 'conn-shared',
          app: 'acme',
          appName: 'Acme',
          account: { id: 'acct-shared', label: 'owner@acme.example' },
        },
      },
    });
    expect(t.failed).toEqual([]);
  });

  test('asks with the run, the call, the served env and the person; waits only in a run a person started', async () => {
    const t = await turn();
    const [first, fresh] = t.asked;
    expect(first).toMatchObject({
      tenantId: TENANT,
      projectId: 'p-1',
      envName: 'production',
      runId: RUN,
      callId: CALL,
      toolId: 'pack.send',
      needs: { mail },
      person: { userId: OWNER },
      waitMs: (t.ctx.hitlPolicy as { timeoutMs: number }).timeoutMs,
    });
    expect(first?.waitMs).toBeGreaterThan(0);
    expect(fresh?.waitMs).toBe(0);
    expect(fresh).not.toHaveProperty('renew');
    // A step with no scope sends none.
    expect(first).not.toHaveProperty('stepScope');

    // No person started the run: nothing may wait.
    const scheduled = await turn({ startedBy: 'schedule', mutating: false });
    expect(scheduled.asked.map((i) => i.waitMs)).toEqual([0, 0]);
  });

  test('the person is the one the turn acts for, and only a user is one', async () => {
    const forUser = await turn({
      principal: {
        actor: { kind: 'agent', id: 'agent-1', tenantId: TENANT },
        onBehalfOf: { kind: 'user', id: 'user-2', tenantId: TENANT },
      },
    });
    expect(forUser.asked[0]?.person).toEqual({ userId: 'user-2' });

    const key = await turn({
      principal: { actor: { kind: 'service_account', id: 'sa-1', tenantId: TENANT } },
      needs: { shared },
    });
    expect(key.asked[0]).not.toHaveProperty('person');
  });

  test('a tool that declares no connection asks nothing and gets none', async () => {
    const t = await turn({ needs: {} });
    expect(t.asked).toEqual([]);
    expect(t.ran[0]).not.toHaveProperty('connections');
  });
});

describe('a call its connections stop runs nothing, and the turn goes on', () => {
  test("refused: the resolver's code and message reach the model", async () => {
    const t = await turn({
      answers: [
        {
          kind: 'refused',
          code: 'connection-missing',
          name: 'mail',
          app: 'acme',
          missing: ['mail.send'],
          message: "user-owner's Acme connection needs reconnecting.",
        },
      ],
    });
    expect(t.ran).toEqual([]);
    expect(t.thrown).toBeUndefined();
    expect(t.failed).toEqual([
      expect.objectContaining({
        invocationId: CALL,
        error: {
          code: 'connection-missing',
          message: "user-owner's Acme connection needs reconnecting.",
        },
      }),
    ]);
    expect(t.events.map((e) => e.kind).filter((k) => k.startsWith('tool.'))).toEqual([
      'tool.started',
      'tool.failed',
    ]);
    expect(t.results).toEqual([
      {
        status: 'failed',
        error: {
          code: 'connection-missing',
          message: "user-owner's Acme connection needs reconnecting.",
          connection: 'mail',
          missing: ['mail.send'],
        },
      },
    ]);
  });

  test('no connections served: connection-app-missing', async () => {
    const t = await turn({ unserved: true });
    expect(t.ran).toEqual([]);
    expect(t.failed[0]?.error.code).toBe('connection-app-missing');
  });

  test.each([
    ['the first ask', [new ConnectionRenewError('mail', 'Acme did not answer.')]],
    ['the fresh ask', [undefined, new ConnectionRenewError('mail', 'Acme did not answer.')]],
  ] as const)(
    "the app can't give a token just now, at %s: connection-renew-failed",
    async (_, answers) => {
      const t = await turn({
        answers: answers.map((a) => a ?? readyFor({ needs: { mail } } as never, 1)),
      });
      expect(t.ran).toEqual([]);
      expect(t.failed[0]?.error).toEqual({
        code: 'connection-renew-failed',
        message: 'Acme did not answer.',
      });
      expect(t.records.has(`connection-gate:${CALL}`)).toBe(answers.length === 2);
    },
  );

  test('a connection that lapsed while the call waited fails it, on the fresh ask', async () => {
    const t = await turn({
      answers: [
        readyFor({ needs: { mail } } as never, 1),
        {
          kind: 'refused',
          code: 'connection-missing',
          name: 'mail',
          app: 'acme',
          message: 'It needs reconnecting.',
        },
      ],
    });
    expect(t.ran).toEqual([]);
    expect(t.failed[0]?.error.code).toBe('connection-missing');
    expect(t.events.filter((e) => e.kind === 'tool.started')).toHaveLength(1);
  });
});

describe('a call that pauses asks for its tokens only when its tool runs', () => {
  const PAUSE = { tokenId: 'pause:k:1', timeoutMs: 7_200_000, name: "Acme's answer" };
  const lapsed: ResolveConnectionsOutcome = {
    kind: 'refused',
    code: 'connection-missing',
    name: 'mail',
    app: 'acme',
    message: 'It needs reconnecting.',
  };

  test('the connection lapsed while it waited for the answer: the answer is its result, and nothing is asked', async () => {
    const records = new Map<string, unknown>();
    const parked = new Error('parked');
    const first = await turn({
      pauses: true,
      run: async () => pauseOutcome(PAUSE),
      records,
      waitForToken: async () => {
        throw parked;
      },
    });
    expect(first.thrown).toBe(parked);
    expect(first.ran).toHaveLength(1);
    expect(first.ran[0]?.connections?.mail?.accessToken).toBe('secret-token-mail-2');

    // The person disconnects Acme before the answer comes; the answer resumes the step.
    const resumed = await turn({
      pauses: true,
      records,
      answers: [lapsed],
      waitForToken: async () => ({ ok: true }),
    });
    expect(resumed.waits.map((w) => w.token)).toEqual([PAUSE.tokenId]);
    expect(resumed.ran).toEqual([]);
    expect(resumed.asked).toEqual([]);
    expect(resumed.failed).toEqual([]);
    expect(resumed.results).toEqual([{ ok: true }]);
  });

  test('the connection lapsed before it ran: it runs nothing, and no pause is recorded', async () => {
    const t = await turn({
      pauses: true,
      run: async () => pauseOutcome(PAUSE),
      answers: [readyFor({ needs: { mail } } as never, 1), lapsed],
    });
    expect(t.ran).toEqual([]);
    expect(t.waits).toEqual([]);
    expect(t.failed[0]?.error.code).toBe('connection-missing');
    expect(t.events.filter((e) => e.kind === 'tool.started')).toHaveLength(1);
    expect([...t.records.keys()]).toEqual([`connection-gate:${CALL}`]);
  });
});

describe('a person connects while the call waits', () => {
  test('connected: asks once more, recorded, then fresh, and the tool runs', async () => {
    const t = await turn({ answers: [waitFor('mail'), undefined as never] });
    expect(t.waits.map((w) => w.token)).toEqual([connectToken('mail')]);
    expect(t.waits[0]?.timeoutMs).toBeGreaterThan(50_000);
    expect(t.asked.map((i) => i.waitMs)).toEqual([expect.any(Number), 0, 0]);
    expect(t.records.get(`connection-gate:${CALL}:connected`)).toMatchObject({ kind: 'ready' });
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]?.connections?.mail?.accessToken).toBe('secret-token-mail-3');
  });

  test.each([
    [
      'declined',
      async () => ({ kind: 'declined' }),
      {
        code: 'connection-declined',
        message: "Connecting Acme for this call was declined, so it didn't run.",
      },
    ],
    [
      'connected without a permission',
      async () => ({ kind: 'declined', missing: ['mail.send'] }),
      {
        code: 'connection-declined',
        message: "Acme was connected without mail.send, which this call needs, so it didn't run.",
      },
    ],
    [
      'an answer that is no connect (fails closed)',
      async () => ({ decided: 'approve' }),
      {
        code: 'connection-declined',
        message: "Connecting Acme for this call was declined, so it didn't run.",
      },
    ],
    [
      'timed out',
      async () => {
        throw new WaitpointCancelledError(
          connectToken('mail'),
          'dispatch-tools' as never,
          'timeout',
        );
      },
      {
        code: 'connection-timed-out',
        message: "Nobody connected Acme for this call in time, so it didn't run.",
      },
    ],
    [
      'the wait cancelled for any other reason',
      async () => {
        throw new WaitpointCancelledError(
          connectToken('mail'),
          'dispatch-tools' as never,
          'run-cancelled',
        );
      },
      {
        code: 'connection-timed-out',
        message: "Nobody connected Acme for this call in time, so it didn't run.",
      },
    ],
  ])('%s: the call fails, with no second ask', async (_, answer, error) => {
    const t = await turn({ answers: [waitFor('mail')], waitForToken: answer });
    expect(t.ran).toEqual([]);
    expect(t.asked).toHaveLength(1);
    expect(t.failed[0]?.error).toEqual(error);
    expect(t.thrown).toBeUndefined();
  });

  test('resumed after the connect: the recorded wait is read back, not asked again', async () => {
    const records = new Map<string, unknown>();
    const parked = new Error('parked');
    const first = await turn({
      answers: [waitFor('mail')],
      records,
      waitForToken: async () => {
        throw parked;
      },
    });
    expect(first.thrown).toBe(parked);
    expect(first.asked).toHaveLength(1);

    const resumed = await turn({ answers: [readyFor({ needs: { mail } } as never, 1)], records });
    // The wait was recorded: asked once for the connected account, once fresh.
    expect(resumed.asked.map((i) => i.waitMs)).toEqual([0, 0]);
    expect(resumed.waits.map((w) => w.token)).toEqual([connectToken('mail')]);
    expect(resumed.ran).toHaveLength(1);
  });
});

describe('the app refuses a token: renewed once, the call runs once more', () => {
  test('a rejected token is renewed and the call runs again with the new one', async () => {
    const t = await turn({
      run: async (ctx, attempt) => {
        if (attempt === 1) throw new ConnectionRejectedError('mail', 'Acme said 401.');
        return { ok: ctx.connections?.mail?.accessToken === 'secret-token-mail-3' };
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.asked[2]).toMatchObject({ renew: ['mail'], waitMs: 0 });
    expect(t.failed).toEqual([]);
    expect(t.results).toEqual([{ ok: true }]);
  });

  test('refused again: the call fails with connection-rejected, and the turn goes on', async () => {
    const t = await turn({
      run: async () => {
        throw new ConnectionRejectedError('mail', 'Acme said 401.');
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.asked).toHaveLength(3);
    expect(t.thrown).toBeUndefined();
    expect(t.failed.map((e) => e.error)).toEqual([
      { code: 'connection-rejected', message: 'Acme said 401.' },
    ]);
    expect(t.results).toEqual([
      {
        status: 'failed',
        error: { code: 'connection-rejected', message: 'Acme said 401.', connection: 'mail' },
      },
    ]);
    // tool.started was sent once, for the call's first run.
    expect(t.events.filter((e) => e.kind === 'tool.started')).toHaveLength(1);
  });

  test("a pack tool's refusal again, under a toolErrors retry: connection-rejected, not a tool error to retry", async () => {
    const t = await turn({
      toolErrors: { retryOn: ['tool-error'] },
      run: async () => {
        throw Object.assign(new Error('Acme said 401.'), {
          code: 'connection-rejected',
          connection: 'mail',
        });
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.failed.map((e) => e.error.code)).toEqual(['connection-rejected']);
    // No `kindgi: 'tool-error-retry'`: the model isn't asked to call it again.
    expect(t.results).toEqual([
      {
        status: 'failed',
        error: { code: 'connection-rejected', message: 'Acme said 401.', connection: 'mail' },
      },
    ]);
  });

  test('refused again for a connection the tool never declared: it fails as the tool did', async () => {
    const t = await turn({
      run: async (_ctx, attempt) => {
        throw new ConnectionRejectedError(attempt === 1 ? 'mail' : 'calendar');
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.failed[0]?.error.code).toBe('tool-invocation-failed');
  });

  test('a connection the tool never declared is not renewed', async () => {
    const t = await turn({
      run: async () => {
        throw new ConnectionRejectedError('calendar');
      },
    });
    expect(t.ran).toHaveLength(1);
    expect(t.asked).toHaveLength(2);
  });

  test("a pack tool's connection-rejected error counts", async () => {
    const t = await turn({
      run: async (_ctx, attempt) => {
        if (attempt === 1) {
          throw Object.assign(new Error('Acme said 401.'), {
            code: 'connection-rejected',
            connection: 'mail',
          });
        }
        return { ok: true };
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.asked[2]?.renew).toEqual(['mail']);
  });

  test('the renewal fails: the call fails with its code', async () => {
    const t = await turn({
      answers: [
        readyFor({ needs: { mail } } as never, 1),
        readyFor({ needs: { mail } } as never, 2),
        new ConnectionRenewError('mail', 'Acme did not answer.'),
      ],
      run: async () => {
        throw new ConnectionRejectedError('mail');
      },
    });
    expect(t.ran).toHaveLength(1);
    expect(t.failed[0]?.error.code).toBe('connection-renew-failed');
    // tool.started was sent once, for the run that failed.
    expect(t.events.filter((e) => e.kind === 'tool.started')).toHaveLength(1);
  });
});

describe('the step the call is in', () => {
  test("every ask names it: with the call id, it's the call across the run", async () => {
    const t = await turn({
      stepScope: 'loop-1:2',
      run: async (_ctx, attempt) => {
        if (attempt === 1) throw new ConnectionRejectedError('mail');
        return { ok: true };
      },
    });
    expect(t.asked).toHaveLength(3);
    expect(t.asked.map((a) => a.stepScope)).toEqual(['loop-1:2', 'loop-1:2', 'loop-1:2']);
  });
});

describe('a token the tool echoes in what it throws goes no further', () => {
  test("the event, the model and the turn's failure see it redacted, the renewed one too", async () => {
    let firstToken = '';
    const t = await turn({
      run: async (ctx, attempt) => {
        const token = ctx.connections?.mail?.accessToken ?? '';
        if (attempt === 1) {
          firstToken = token;
          throw new ConnectionRejectedError('mail', `Acme refused ${token}.`);
        }
        throw new Error(`send failed with ${token}`, {
          cause: new Error(`the first was ${firstToken}`),
        });
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(firstToken).toBe('secret-token-mail-2');
    expect(t.failed[0]?.error.message).toMatch(/send failed with \[redacted\]$/);
    const seen = [JSON.stringify(t.events), JSON.stringify(t.results), ...stringsOf(t.thrown)].join(
      '\n',
    );
    expect(seen).not.toContain('secret-token');
  });

  test('refused again: what connection-rejected says has both tokens redacted', async () => {
    let firstToken = '';
    const t = await turn({
      run: async (ctx, attempt) => {
        const token = ctx.connections?.mail?.accessToken ?? '';
        if (attempt === 1) firstToken = token;
        throw new ConnectionRejectedError('mail', `Acme refused ${token} (first ${firstToken}).`);
      },
    });
    expect(t.ran).toHaveLength(2);
    expect(t.failed[0]?.error).toEqual({
      code: 'connection-rejected',
      message: 'Acme refused [redacted] (first [redacted]).',
    });
    const seen = [JSON.stringify(t.events), JSON.stringify(t.results)].join('\n');
    expect(seen).not.toContain('secret-token');
  });

  class Request {
    readonly header: string;
    constructor(token: string) {
      this.header = `Bearer ${token}`;
    }
  }
  /** Headers written out by `toJSON`, as a client's header class does. */
  class Headers {
    readonly #authorization: string;
    constructor(token: string) {
      this.#authorization = `Bearer ${token}`;
    }
    toJSON() {
      return { authorization: this.#authorization };
    }
  }

  test.each([
    ['a plain object', (token: string) => ({ details: { header: `Bearer ${token}` } })],
    ["a class's instance", (token: string) => ({ request: new Request(token) })],
    [
      'an instance its toJSON writes',
      (token: string) => ({ config: { headers: new Headers(token) } }),
    ],
  ])(
    "in %s inside a plain object the tool throws, the turn's failure sees it redacted",
    async (_, holding) => {
      const t = await turn({
        run: async (ctx) => {
          throw { message: 'send failed', ...holding(ctx.connections?.mail?.accessToken ?? '') };
        },
      });
      expect(t.ran).toHaveLength(1);
      // The run's failure message: the turn's error, written out.
      expect((t.thrown as Error).message).toContain('Bearer [redacted]');
      const seen = [
        JSON.stringify(t.events),
        JSON.stringify(t.results),
        ...stringsOf(t.thrown),
      ].join('\n');
      expect(seen).not.toContain('secret-token');
    },
  );
});

describe("a tool's own abort or timeout reaches the turn as the error it is", () => {
  /** What a fetch given `AbortSignal.timeout(…)` rejects with. */
  async function timedOut(): Promise<unknown> {
    const timeout = AbortSignal.timeout(1);
    await new Promise((resolve) => timeout.addEventListener('abort', resolve));
    return timeout.reason;
  }

  /** The first `DOMException` down a value's causes. */
  function domExceptionIn(value: unknown): unknown {
    for (let at = value, i = 0; typeof at === 'object' && at !== null && i < 10; i += 1) {
      if (at instanceof DOMException) return at;
      at = (at as { cause?: unknown }).cause;
    }
    return undefined;
  }

  test("a fetch it gave up on: the turn fails with the call's failure, its TimeoutError as it was", async () => {
    let reason: unknown;
    const t = await turn({
      run: async () => {
        reason = await timedOut();
        throw reason;
      },
    });
    expect(t.thrown).toBeInstanceOf(AgentTurnFailure);
    const payload = (t.thrown as AgentTurnFailure).payload as { code: string };
    expect(payload.code).toBe('tool-invocation-failed');
    expect(domExceptionIn(payload)).toBe(reason);
    expect((reason as DOMException).code).toBe(DOMException.TIMEOUT_ERR);
  });

  test("retried: the model gets the call's tool-error back", async () => {
    const t = await turn({
      toolErrors: { retryOn: ['tool-error'] },
      run: async () => {
        throw await timedOut();
      },
    });
    expect(t.thrown).toBeUndefined();
    expect(t.failed[0]?.error.code).toBe('tool-invocation-failed');
    expect(t.results).toEqual([
      expect.objectContaining({
        kindgi: 'tool-error-retry',
        status: 'failed',
        error: expect.objectContaining({ kind: 'tool-error' }),
      }),
    ]);
  });

  test("a cancelled run's abort: the turn fails with the call's failure, its reason as it was", async () => {
    const run = new AbortController();
    run.abort();
    const t = await turn({
      run: async () => {
        throw run.signal.reason;
      },
    });
    expect(t.thrown).toBeInstanceOf(AgentTurnFailure);
    const payload = (t.thrown as AgentTurnFailure).payload as { code: string };
    expect(payload.code).toBe('tool-invocation-failed');
    expect(domExceptionIn(payload)).toBe(run.signal.reason);
  });
});

describe("a call that acts with a person's connection is theirs to approve", () => {
  const ask = { hitl: { tools: { overrides: { 'pack.send': 'always_ask' } } } };

  test('the approval names its owner and the account it acts as', async () => {
    const t = await turn({ policy: ask });
    expect(t.enqueued[0]).toMatchObject({
      approver: { kind: 'member', userId: OWNER },
      connection: { app: 'acme', appName: 'Acme', account: 'owner@acme.example' },
    });
    expect(t.ran).toHaveLength(1);
  });

  test('a company connection keeps the reviewers', async () => {
    const t = await turn({ policy: ask, needs: { shared } });
    expect(t.enqueued[0]).not.toHaveProperty('approver');
    expect(t.enqueued[0]).not.toHaveProperty('connection');
  });

  test('the connect comes before the approval', async () => {
    const t = await turn({ policy: ask, answers: [waitFor('mail'), undefined as never] });
    expect(t.waits.map((w) => w.token)).toHaveLength(2);
    expect(t.waits[0]?.token).toBe(connectToken('mail'));
  });

  test('four eyes on it: refused before anyone is asked to connect', async () => {
    const t = await turn({
      policy: { hitl: { ...ask.hitl, separateApprover: true } },
      answers: [waitFor('mail')],
    });
    expect(t.asked).toEqual([]);
    expect(t.enqueued).toEqual([]);
    expect(t.ran).toEqual([]);
    expect(t.failed[0]?.error.code).toBe('connection-approval-conflict');
  });

  test('four eyes on a company connection: asked as before', async () => {
    const t = await turn({
      policy: { hitl: { ...ask.hitl, separateApprover: true } },
      needs: { shared },
    });
    expect(t.enqueued[0]?.separateApprover).toBe(true);
    expect(t.ran).toHaveLength(1);
  });

  test('its owner has no reviewer seat: the call fails at once, naming them and the rank', async () => {
    const t = await turn({
      policy: ask,
      enqueue: async () => {
        throw Object.assign(new Error('no seat'), {
          code: 'approver-not-a-reviewer',
          approverUserId: OWNER,
          requiredRole: 'senior',
        });
      },
    });
    expect(t.ran).toEqual([]);
    // No approval wait: nobody could decide it.
    expect(t.waits).toEqual([]);
    expect(t.thrown).toBeUndefined();
    expect(t.failed[0]?.error).toEqual({
      code: 'connection-approver-not-a-reviewer',
      message:
        'Only user user-owner can approve pack.send, as it acts with their Acme account owner@acme.example, ' +
        'and they have no reviewer seat at senior or above, the rank the approval needs: ' +
        'a tenant admin adds them to the reviewers. ' +
        "The call didn't run.",
    });
  });

  test('any other enqueue failure stays soft: the gate still waits', async () => {
    const t = await turn({
      policy: ask,
      enqueue: async () => {
        throw new Error('database away');
      },
    });
    expect(t.waits).toHaveLength(1);
    expect(t.ran).toHaveLength(1);
  });
});
