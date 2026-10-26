// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelMessage } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { HitlSpec } from '@kindgi/policy-contract';
import {
  RUN_STARTED_BY,
  type RunMailbox,
  type RunStartedBy,
  type UnattendedWaitReason,
  needsPersonsYesUnattended,
  runIsAttended,
  toolNeedsPersonsYesUnattended,
  unattendedWaitReason,
} from '@kindgi/runtime';
import { defineTool } from '@kindgi/tools';
import type { AnyTool, ConnectionNeed } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';

import { turnInputFromSnapshot } from '../src/invoke.js';
import type { RunSnapshotRecord } from '../src/run-snapshot-binding.js';

import type { TurnContext } from '../src/handlers/context.js';
import {
  buildDispatchToolsHandler,
  resolveEffectiveToolHitl,
} from '../src/handlers/dispatch-tools.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent } from '../src/types.js';
import { testNodeContext } from './node-context.js';

function agent(conversationPolicy?: Record<string, unknown>): Agent {
  return {
    id: 'pack.agent',
    version: '1.0.0',
    ...(conversationPolicy !== undefined && { conversationPolicy }),
  } as unknown as Agent;
}

/** What a test tool declares: the rule's flags, and its connections. */
interface Declared {
  readonly needsApprovalWhenUnattended?: boolean;
  readonly mutating?: boolean;
  readonly needsSpec?: { readonly connections: Record<string, ConnectionNeed> };
}

function refundTool(ran: unknown[], declared: Declared): AnyTool {
  const defined = defineTool<{ order: string }, { ok: boolean }>({
    id: 'pack.refund' as ToolId,
    description: 'Refunds an order.',
    version: '1.0.0',
    input: {
      type: 'object',
      properties: { order: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    ...declared,
    handler: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

const DECLARED = { needsApprovalWhenUnattended: true } as const;
const UNATTENDED: readonly (RunStartedBy | undefined)[] = [
  'key',
  'schedule',
  'webhook',
  'event',
  'mail',
  undefined,
];
/** The runs a trigger with a `toolsAllowedUnattended` list started. */
const LISTABLE = ['webhook', 'schedule', 'mail'] as const;

describe('runIsAttended', () => {
  test('only a person counts', () => {
    expect(RUN_STARTED_BY.filter((by) => runIsAttended(by))).toEqual(['person']);
    expect(runIsAttended(undefined)).toBe(false);
  });
});

describe('needsPersonsYesUnattended — the one rule the gate and the runtime share', () => {
  const declared = { id: 'pack.refund', needsApprovalWhenUnattended: true } as const;

  test('a declared tool in a run no person started, unless its trigger lists it', () => {
    for (const by of UNATTENDED) {
      expect(needsPersonsYesUnattended(declared, by, undefined)).toBe(true);
      expect(needsPersonsYesUnattended(declared, by, [])).toBe(true);
      expect(needsPersonsYesUnattended(declared, by, ['pack.other'])).toBe(true);
    }
    for (const by of LISTABLE) {
      expect(needsPersonsYesUnattended(declared, by, ['pack.other', 'pack.refund'])).toBe(false);
    }
  });

  test("only a webhook's, a schedule's or a mail trigger's run has a list: on any other, one lifts nothing", () => {
    for (const by of ['key', 'event', undefined] as const) {
      expect(needsPersonsYesUnattended(declared, by, ['pack.refund'])).toBe(true);
    }
  });

  test('never in a run a person started, nor for a tool that declares nothing', () => {
    expect(needsPersonsYesUnattended(declared, 'person', undefined)).toBe(false);
    expect(needsPersonsYesUnattended({ id: 'pack.refund' }, 'webhook', undefined)).toBe(false);
    expect(
      needsPersonsYesUnattended(
        { id: 'pack.refund', needsApprovalWhenUnattended: false },
        'schedule',
        undefined,
      ),
    ).toBe(false);
  });

  test('an id that only looks like it is no match: no prefix, case or pattern', () => {
    for (const listed of [['pack.*'], ['pack'], ['PACK.REFUND'], ['pack.refund ']]) {
      expect(needsPersonsYesUnattended(declared, 'schedule', listed)).toBe(true);
    }
  });
});

describe("toolNeedsPersonsYesUnattended — any use of a person's connection counts, reads included", () => {
  const asPerson = { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } } as const;
  const asCompany = {
    repo: { app: 'github', permissions: ['contents:write'], as: 'company' },
  } as const;
  const sends = { id: 'pack.send', needsSpec: { connections: asPerson } };

  test("a tool that changes things with a person's connection, whatever its own flag says", () => {
    expect(toolNeedsPersonsYesUnattended(sends)).toBe(true);
    expect(toolNeedsPersonsYesUnattended({ ...sends, mutating: true })).toBe(true);
    expect(toolNeedsPersonsYesUnattended({ ...sends, needsApprovalWhenUnattended: false })).toBe(
      true,
    );
    // One person's connection among a company's is enough.
    expect(
      toolNeedsPersonsYesUnattended({
        id: 'pack.both',
        needsSpec: { connections: { ...asCompany, ...asPerson } },
      }),
    ).toBe(true);
  });

  test('so it waits in a run no person started, unless its trigger lists it', () => {
    for (const by of UNATTENDED) expect(needsPersonsYesUnattended(sends, by, undefined)).toBe(true);
    expect(needsPersonsYesUnattended(sends, 'person', undefined)).toBe(false);
    for (const by of LISTABLE) {
      expect(needsPersonsYesUnattended(sends, by, ['pack.send'])).toBe(false);
    }
  });

  test("a read with a person's connection too: neither `mutating: false` nor the flag's `false` lifts it", () => {
    const reads = { id: 'pack.read', mutating: false, needsSpec: { connections: asPerson } };
    expect(toolNeedsPersonsYesUnattended(reads)).toBe(true);
    expect(toolNeedsPersonsYesUnattended({ ...reads, needsApprovalWhenUnattended: false })).toBe(
      true,
    );
  });

  test("not a company's connection, or no connection", () => {
    expect(
      toolNeedsPersonsYesUnattended({ id: 'pack.push', needsSpec: { connections: asCompany } }),
    ).toBe(false);
    expect(toolNeedsPersonsYesUnattended({ id: 'pack.plain', needsSpec: { env: {} } })).toBe(false);
    expect(toolNeedsPersonsYesUnattended({ id: 'pack.plain' })).toBe(false);
    // A declared flag counts, read-only or not.
    expect(
      toolNeedsPersonsYesUnattended({
        id: 'pack.flag',
        mutating: false,
        needsApprovalWhenUnattended: true,
      }),
    ).toBe(true);
  });
});

describe('the unattended rule, case by case', () => {
  const person = (app: string) => ({ app, permissions: ['mail.read'], as: 'person' }) as const;
  const company = (app: string) => ({ app, permissions: ['mail.read'], as: 'company' }) as const;
  /** A read-only tool with one connection. */
  const reads = (need: { readonly app: string; readonly as: 'person' | 'company' }) => ({
    id: 'pack.read',
    mutating: false,
    needsSpec: { connections: { mail: need } },
  });
  const personsRead = reads(person('microsoft'));
  const companyGmailRead = reads(company('google'));
  const companyGithubRead = reads(company('github'));
  const companySend = {
    id: 'pack.send',
    needsSpec: { connections: { mail: company('microsoft') } },
  };
  const refund = { id: 'pack.refund' };
  const personMailbox: RunMailbox = { app: 'microsoft', as: 'person' };
  const companyGoogle: RunMailbox = { app: 'google', as: 'company' };
  const companyMicrosoft: RunMailbox = { app: 'microsoft', as: 'company' };

  type Case = readonly [
    string,
    Parameters<typeof needsPersonsYesUnattended>[0],
    RunStartedBy | undefined,
    readonly string[] | undefined,
    RunMailbox | undefined,
    UnattendedWaitReason | undefined,
  ];
  const cases: readonly Case[] = [
    [
      "a webhook's run: a person's read waits",
      personsRead,
      'webhook',
      undefined,
      undefined,
      'persons-connection',
    ],
    [
      "a schedule's run: a person's read waits",
      personsRead,
      'schedule',
      undefined,
      undefined,
      'persons-connection',
    ],
    [
      "a mail's run, a person's mailbox: its read waits",
      personsRead,
      'mail',
      undefined,
      personMailbox,
      'persons-connection',
    ],
    [
      "a webhook's run, the read listed: it runs",
      personsRead,
      'webhook',
      ['pack.read'],
      undefined,
      undefined,
    ],
    [
      "a schedule's run, the read listed: it runs",
      personsRead,
      'schedule',
      ['pack.read'],
      undefined,
      undefined,
    ],
    [
      "a mail's run, a person's mailbox, the read listed: it runs",
      personsRead,
      'mail',
      ['pack.read'],
      personMailbox,
      undefined,
    ],
    [
      "a person's run: a person's read runs",
      personsRead,
      'person',
      undefined,
      undefined,
      undefined,
    ],
    [
      "a webhook's run: a company's read runs",
      companyGithubRead,
      'webhook',
      undefined,
      undefined,
      undefined,
    ],
    [
      "no `startedBy`: a person's read waits, and a list lifts nothing",
      personsRead,
      undefined,
      ['pack.read'],
      undefined,
      'persons-connection',
    ],
    [
      "a key's run: a list lifts nothing",
      personsRead,
      'key',
      ['pack.read'],
      undefined,
      'persons-connection',
    ],
    [
      "a mail's run, a company Google mailbox: a company Google read waits",
      companyGmailRead,
      'mail',
      undefined,
      companyGoogle,
      'mail-own-mailbox',
    ],
    [
      "a mail's run, a company Google mailbox: another app's company read runs",
      companyGithubRead,
      'mail',
      undefined,
      companyGoogle,
      undefined,
    ],
    [
      "a mail's run, a company Microsoft mailbox: a company Google read runs",
      companyGmailRead,
      'mail',
      undefined,
      companyMicrosoft,
      undefined,
    ],
    [
      "a mail's run, a company Google mailbox, its read listed: it runs",
      companyGmailRead,
      'mail',
      ['pack.read'],
      companyGoogle,
      undefined,
    ],
    [
      "a mail's run, a company mailbox: an unlisted reply waits",
      companySend,
      'mail',
      undefined,
      companyMicrosoft,
      'mail-change',
    ],
    [
      "a mail's run, a company mailbox: a listed reply runs",
      companySend,
      'mail',
      ['pack.send'],
      companyMicrosoft,
      undefined,
    ],
    [
      "a mail's run: an unlisted change with no connection waits",
      refund,
      'mail',
      undefined,
      companyGoogle,
      'mail-change',
    ],
    [
      "a mail's run: a listed change with no connection runs",
      refund,
      'mail',
      ['pack.refund'],
      companyGoogle,
      undefined,
    ],
    [
      "a mail's run that records no mailbox: any connection's read waits",
      companyGithubRead,
      'mail',
      undefined,
      undefined,
      'mail-own-mailbox',
    ],
    [
      "a mail's run, its list naming another tool: the read still waits",
      companyGmailRead,
      'mail',
      ['pack.other'],
      companyGoogle,
      'mail-own-mailbox',
    ],
    [
      "a webhook's run: a change with no connection runs, as before",
      refund,
      'webhook',
      undefined,
      undefined,
      undefined,
    ],
    [
      "a webhook's run: a company change runs, as before",
      companySend,
      'webhook',
      undefined,
      undefined,
      undefined,
    ],
    [
      "a person's run that names a mailbox: nothing waits",
      companySend,
      'person',
      undefined,
      companyMicrosoft,
      undefined,
    ],
    [
      "a mail's run: a tool that declares it waits for that first",
      { ...personsRead, id: 'pack.declared', needsApprovalWhenUnattended: true, mutating: true },
      'mail',
      undefined,
      personMailbox,
      'declared',
    ],
    [
      "a mail's run: a change with a person's connection waits for the connection first",
      { ...personsRead, mutating: true },
      'mail',
      undefined,
      personMailbox,
      'persons-connection',
    ],
  ];

  test.each(cases)('%s', (_, tool, startedBy, listed, mailbox, reason) => {
    expect(unattendedWaitReason(tool, startedBy, listed, mailbox)).toBe(reason);
    expect(needsPersonsYesUnattended(tool, startedBy, listed, mailbox)).toBe(reason !== undefined);
  });
});

describe("resolveEffectiveToolHitl — a tool that needs a person's yes when unattended", () => {
  const ran: unknown[] = [];

  test.each(UNATTENDED)('waits on every call in a run started by %s', (by) => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      by === undefined ? {} : { startedBy: by },
    );
    expect(gate.mode).toBe('always_ask');
  });

  test("follows the agent's rules in a run a person started: with none, it never asks", () => {
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      { startedBy: 'person' },
    );
    expect(gate.mode).toBe('never_ask');
  });

  test("an agent's override can't lift it", () => {
    const loose = agent({ hitl: { tools: { overrides: { 'pack.refund': 'never_ask' } } } });
    const unattended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      {},
    );
    expect(unattended.mode).toBe('always_ask');
    const attended = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: loose }),
      refundTool(ran, DECLARED),
      { startedBy: 'person' },
    );
    expect(attended.mode).toBe('never_ask');
  });

  test("a tenant's looser rule can't lift it either, and its reviewer role stands", () => {
    const tenant: HitlSpec = {
      tools: { 'pack.refund': { mode: 'never_ask', requiredRole: 'admin' } },
    };
    const gate = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant, agent: agent() }),
      refundTool(ran, DECLARED),
      {},
    );
    expect(gate).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
  });

  test("listed by the run's trigger: the agent's rules again, as in a run a person started", () => {
    for (const by of ['schedule', 'webhook'] as const) {
      const gate = resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
        refundTool(ran, DECLARED),
        { startedBy: by, toolsAllowedUnattended: ['pack.refund'] },
      );
      expect(gate.mode).toBe('never_ask');
    }
    const unlisted = resolveEffectiveToolHitl(
      resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
      refundTool(ran, DECLARED),
      { startedBy: 'webhook', toolsAllowedUnattended: ['pack.other'] },
    );
    expect(unlisted.mode).toBe('always_ask');
  });

  test("listed: the tenant's and the agent's own rules still ask, with their reviewer role", () => {
    const listed = { startedBy: 'schedule', toolsAllowedUnattended: ['pack.refund'] } as const;
    const tenant: HitlSpec = {
      tools: { 'pack.refund': { mode: 'always_ask', requiredRole: 'admin' } },
    };
    expect(
      resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant, agent: agent() }),
        refundTool(ran, DECLARED),
        listed,
      ),
    ).toEqual({ mode: 'always_ask', requiredRole: 'admin' });
    const strict = agent({ hitl: { tools: { overrides: { 'pack.refund': 'always_ask' } } } });
    expect(
      resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: strict }),
        refundTool(ran, DECLARED),
        listed,
      ).mode,
    ).toBe('always_ask');
  });

  test("a tool that doesn't declare it follows the agent's rules, attended or not", () => {
    for (const declared of [{}, { needsApprovalWhenUnattended: false }]) {
      const gate = resolveEffectiveToolHitl(
        resolveEffectiveHitlPolicy({ tenant: undefined, agent: agent() }),
        refundTool(ran, declared),
        {},
      );
      expect(gate.mode).toBe('never_ask');
    }
  });
});

/**
 * One `pack.refund` call in a turn that started as `startedBy` says, from
 * `mailbox` when one is given. Approvals are granted.
 */
async function dispatchStartedBy(
  startedBy: RunStartedBy | undefined,
  declared: Declared,
  toolsAllowedUnattended?: readonly string[],
  mailbox?: RunMailbox,
) {
  const ran: unknown[] = [];
  const tool = refundTool(ran, declared);
  const enqueued: Record<string, unknown>[] = [];
  const waits: string[] = [];
  const a = agent();
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'p-1',
      conversationId: 'conv-1',
      agent: a,
      ...(startedBy !== undefined && { startedBy }),
      ...(toolsAllowedUnattended !== undefined && { toolsAllowedUnattended }),
      ...(mailbox !== undefined && { mailbox }),
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => ({
          kind: 'ok',
          value: { id: 'msg-1', ...m },
        }),
      },
      hitl: {
        enqueue: async (input: Record<string, unknown>) => {
          enqueued.push(input);
        },
      },
      // Every connection the tool needs is there, so only the approval rule decides.
      connections: {
        envName: 'production',
        resolver: {
          resolveConnections: async (asked: {
            readonly needs: Record<string, ConnectionNeed>;
          }) => ({
            kind: 'ready',
            connections: Object.fromEntries(
              Object.entries(asked.needs).map(([name, need]) => [
                name,
                {
                  connectionId: `conn-${name}`,
                  app: need.app,
                  appName: 'Acme',
                  accessToken: `token-${name}`,
                  account: { id: `acct-${name}`, label: 'support@acme.example' },
                },
              ]),
            ),
          }),
        },
      },
    },
    tools: {
      definitions: [],
      byName: new Map([[tool.id, { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]]),
    },
    turnAbort: new AbortController(),
    appended: [],
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent: a }),
  } as unknown as TurnContext;
  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'pack.refund', arguments: { order: '7' } }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [{ role: 'user', content: 'refund order 7' }] as readonly ModelMessage[],
    },
    testNodeContext({
      runId: 'run-1' as RunId,
      waitForToken: (async (tokenId: string) => {
        waits.push(tokenId);
        return { decided: 'approve' };
      }) as NodeContext['waitForToken'],
    }),
  );
  return { ran, enqueued, waits };
}

describe('dispatch-tools — a turn no person started', () => {
  test.each(UNATTENDED)(
    "a declared tool's call waits for a person's yes (started by %s)",
    async (by) => {
      const { ran, enqueued, waits } = await dispatchStartedBy(by, DECLARED);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ subjectKind: 'tool-call:pending' });
      expect(waits).toHaveLength(1);
      // Approved, so it runs.
      expect(ran).toEqual([{ order: '7' }]);
    },
  );

  test("in a turn a person started, a declared tool's call runs as the agent says: at once", async () => {
    const { ran, enqueued, waits } = await dispatchStartedBy('person', DECLARED);
    expect(enqueued).toEqual([]);
    expect(waits).toEqual([]);
    expect(ran).toEqual([{ order: '7' }]);
  });

  test("a tool that doesn't declare it runs at once in a webhook's turn", async () => {
    const { ran, enqueued, waits } = await dispatchStartedBy('webhook', {});
    expect(enqueued).toEqual([]);
    expect(waits).toEqual([]);
    expect(ran).toEqual([{ order: '7' }]);
  });

  test("in a mail's turn, a change waits unless the trigger lists it, though it declares nothing", async () => {
    const unlisted = await dispatchStartedBy('mail', {});
    expect(unlisted.enqueued).toHaveLength(1);
    expect(unlisted.waits).toHaveLength(1);
    const listed = await dispatchStartedBy('mail', {}, ['pack.refund']);
    expect([listed.enqueued, listed.waits, listed.ran]).toEqual([[], [], [{ order: '7' }]]);
  });

  test("in a mail's turn, a read of another app's company connection runs at once; one of the mailbox's own waits", async () => {
    const mailbox: RunMailbox = { app: 'google', as: 'company' };
    const read = (app: string): Declared => ({
      mutating: false,
      needsSpec: { connections: { mail: { app, permissions: ['mail.read'], as: 'company' } } },
    });
    const other = await dispatchStartedBy('mail', read('github'), undefined, mailbox);
    expect([other.enqueued, other.waits, other.ran]).toEqual([[], [], [{ order: '7' }]]);
    const own = await dispatchStartedBy('mail', read('google'), undefined, mailbox);
    expect(own.enqueued).toHaveLength(1);
    expect(own.enqueued[0]).toMatchObject({ subjectKind: 'tool-call:pending' });
    expect(own.waits).toHaveLength(1);
    // Approved, so it runs.
    expect(own.ran).toEqual([{ order: '7' }]);
  });

  test("a declared tool the turn's trigger lists runs at once; one it doesn't list still waits", async () => {
    const listed = await dispatchStartedBy('schedule', DECLARED, ['pack.refund']);
    expect([listed.enqueued, listed.waits, listed.ran]).toEqual([[], [], [{ order: '7' }]]);
    const unlisted = await dispatchStartedBy('schedule', DECLARED, ['pack.other']);
    expect(unlisted.enqueued).toHaveLength(1);
    expect(unlisted.waits).toHaveLength(1);
  });
});

describe('a resumed turn', () => {
  const snapshot = (over: Record<string, unknown>) =>
    ({
      runId: 'run-1',
      tenantId: 't-1',
      projectId: 'p-1',
      agentId: 'pack.agent',
      agentVersion: '1.0.0',
      conversationId: 'conv-1',
      userMessage: 'go',
      dryRun: false,
      startedBy: 'webhook',
      ...over,
    }) as unknown as RunSnapshotRecord;

  test('gets the list its run started with, from the snapshot, never from whoever resumes it', () => {
    expect(
      turnInputFromSnapshot(snapshot({ toolsAllowedUnattended: ['pack.refund'] }), {
        agent: agent(),
      }).toolsAllowedUnattended,
    ).toEqual(['pack.refund']);
    for (const none of [{}, { toolsAllowedUnattended: null }]) {
      expect(turnInputFromSnapshot(snapshot(none), { agent: agent() })).not.toHaveProperty(
        'toolsAllowedUnattended',
      );
    }
  });

  test("gets its mail's mailbox from the snapshot, never from whoever resumes it", () => {
    const mailbox = { app: 'google', as: 'company' } as const;
    expect(
      turnInputFromSnapshot(snapshot({ startedBy: 'mail', mailbox }), { agent: agent() }).mailbox,
    ).toEqual(mailbox);
    for (const none of [{}, { mailbox: null }]) {
      expect(turnInputFromSnapshot(snapshot(none), { agent: agent() })).not.toHaveProperty(
        'mailbox',
      );
    }
  });
});
