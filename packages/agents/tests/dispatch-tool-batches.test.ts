// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * dispatch-tools runs a model step's calls in batches: the calls in a row
 * to read-only tools run at the same time, any other call on its own. The
 * results reach the conversation, the model and the events in call order;
 * a call that waits for a review runs on its own, as do the calls after it,
 * and so does a call that may wait for another system or for a connect.
 */

import type { NodeContext } from '@kindgi/handler';
import { defineTool } from '@kindgi/tools';
import type { AnyTool, ToolContext } from '@kindgi/tools';
import type { RunId, TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import type { InvokeAgentBindings, ToolCallAuthorization } from '../src/handlers/public-types.js';
import type { ReplayToolDecision } from '../src/handlers/replay.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent, ConversationMessage } from '../src/types.js';
import { testNodeContext } from './node-context.js';

type AuthorizeInput = Parameters<NonNullable<InvokeAgentBindings['authorizeToolCall']>>[0];

/** A tool of the step under test: `acme.<name>`, which the model calls as `call-<name>`. */
interface Probe {
  readonly name: string;
  /** As the tool declares it; absent, the tool doesn't say. */
  readonly mutating?: boolean;
  /** The tool answers once this settles (default: at once). */
  readonly until?: Promise<void>;
  /** The tool throws. */
  readonly fails?: boolean;
  /** The tool runs until its call is stopped, then takes a moment to settle. */
  readonly runsUntilStopped?: boolean;
  /** The call waits for a reviewer (`always_ask`). */
  readonly gated?: boolean;
  /** The tool may pause for another system's answer (`Tool.pauses`); this one answers at once. */
  readonly pauses?: boolean;
  /** The tool declares a person's connection; the step serves none, so its call runs nothing. */
  readonly connects?: boolean;
}

/**
 * What happened, in order: `asked <name>` (its authorization), `start <name>`,
 * `stopped <name>` (its abort signal fired), `end <name>`, `stored <name>`.
 * Shared by the steps of one run, so a step run again adds to it.
 */
interface Seen {
  readonly log: string[];
  readonly runs: Map<string, number>;
  inFlight: number;
  mostInFlight: number;
}

const newSeen = (): Seen => ({ log: [], runs: new Map(), inFlight: 0, mostInFlight: 0 });

interface Setup {
  readonly probes: readonly Probe[];
  /** The model's arguments for each call (default: `{ q: 'x' }`). */
  readonly args?: Record<string, unknown>;
  readonly agent?: Record<string, unknown>;
  readonly seen?: Seen;
  /** The step's recorded decisions: pass the same map to run the step again. */
  readonly records?: Map<string, unknown>;
  /** What the step stored before it stopped: the step run again takes it back. */
  readonly storedBeforePark?: readonly ConversationMessage[];
  readonly decide?: (input: AuthorizeInput) => Promise<ToolCallAuthorization>;
  /** The reviewer's answer (default: approve). It may throw, as a park does. */
  readonly answer?: () => Promise<unknown>;
  /** A replay turn, its binding deciding each call by the probe's name. */
  readonly replay?: (name: string) => ReplayToolDecision;
  /** Storing this probe's result fails. */
  readonly storeFails?: string;
}

interface TurnEvent {
  readonly kind: string;
  readonly invocationId?: string;
  readonly replay?: string;
}

function probeTool(probe: Probe, seen: Seen): AnyTool {
  const defined = defineTool<Record<string, unknown>, { ok: boolean; by: string }>({
    id: `acme.${probe.name}` as ToolId,
    description: `The ${probe.name} probe.`,
    version: '1.0.0',
    input: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, by: { type: 'string' } },
      required: ['ok', 'by'],
      additionalProperties: false,
    },
    effects: [],
    ...(probe.mutating !== undefined && { mutating: probe.mutating }),
    ...(probe.connects === true && {
      needsSpec: {
        connections: { mail: { app: 'acme', permissions: ['mail.read'], as: 'person' as const } },
      },
    }),
    handler: async (_input, ctx: ToolContext) => {
      seen.log.push(`start ${probe.name}`);
      seen.runs.set(probe.name, (seen.runs.get(probe.name) ?? 0) + 1);
      seen.inFlight += 1;
      seen.mostInFlight = Math.max(seen.mostInFlight, seen.inFlight);
      try {
        if (probe.until !== undefined) await probe.until;
        if (probe.runsUntilStopped === true) {
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal.aborted) resolve();
            ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
          seen.log.push(`stopped ${probe.name}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (probe.fails === true) throw new Error(`${probe.name} failed`);
        return { ok: true, by: probe.name };
      } finally {
        seen.inFlight -= 1;
        seen.log.push(`end ${probe.name}`);
      }
    },
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return (probe.pauses === true
    ? { ...defined.value, pauses: true }
    : defined.value) as unknown as AnyTool;
}

/** The probe a stored message or a call id is for. */
const probeOf = (callId: string | undefined): string | undefined => callId?.replace(/^call-/, '');

/**
 * One model step that calls each probe once, in order, through dispatch-tools.
 * `done` never rejects: it holds the step's output, or what it threw.
 */
function runStep(setup: Setup) {
  const seen = setup.seen ?? newSeen();
  const records = setup.records ?? new Map<string, unknown>();
  const stored: ConversationMessage[] = [];
  const events: TurnEvent[] = [];
  const tools = setup.probes.map((probe) => probeTool(probe, seen));
  const gated = setup.probes
    .filter((p) => p.gated === true)
    .map((p) => [`acme.${p.name}`, 'always_ask']);
  const agent = {
    id: 'acme.agent',
    version: '1.0.0',
    ...(gated.length > 0 && {
      conversationPolicy: { hitl: { tools: { overrides: Object.fromEntries(gated) } } },
    }),
    ...setup.agent,
  } as unknown as Agent;
  const { decide, replay } = setup;
  let seq = 0;
  const ctx = {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'project-1',
      conversationId: 'conv-1',
      agent,
      ...(replay !== undefined && { replay: { of: 'run-past', evalRunId: 'eval-1' } }),
    },
    bindings: {
      conversationBinding: {
        appendMessage: async (m: Record<string, unknown>) => {
          const name = probeOf((m.toolCall as { invocationId?: string } | undefined)?.invocationId);
          if (name !== undefined && name === setup.storeFails) {
            return { kind: 'err', error: { code: 'internal-error', message: 'the store is down' } };
          }
          const message = { id: `msg-${++seq}`, ...m } as unknown as ConversationMessage;
          if (name !== undefined) seen.log.push(`stored ${name}`);
          stored.push(message);
          return { kind: 'ok', value: message };
        },
      },
      hitl: { enqueue: async () => {} },
      onEvent: (event: TurnEvent) => {
        events.push(event);
      },
      ...(replay !== undefined && {
        replay: {
          decideTool: async (input: { readonly callId: string }) =>
            replay(probeOf(input.callId) ?? ''),
        },
      }),
      ...(decide !== undefined && {
        authorizeToolCall: async (input: AuthorizeInput) => {
          seen.log.push(`asked ${String(input.toolId).replace(/^acme\./, '')}`);
          return decide(input);
        },
      }),
    },
    tools: {
      definitions: [],
      byName: new Map(
        tools.map((tool) => [
          tool.id as unknown as string,
          { tool, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' },
        ]),
      ),
    },
    turnAbort: new AbortController(),
    appended: [],
    // The loop's messages are the step's own (`nextMessages: []`).
    initialMessageCount: 0,
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    ...(setup.storedBeforePark !== undefined && { storedBeforePark: [...setup.storedBeforePark] }),
  } as unknown as TurnContext;

  const output = buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: setup.probes.map((p) => ({
          id: `call-${p.name}`,
          name: `acme.${p.name}`,
          arguments: setup.args ?? { q: 'x' },
        })),
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext(
      {
        runId: 'run-42' as RunId,
        waitForToken: (async () =>
          setup.answer !== undefined
            ? setup.answer()
            : { decided: 'approve' }) as NodeContext['waitForToken'],
      },
      records,
    ),
  ) as Promise<{ readonly nextMessages: readonly { role: string; toolCallId?: string }[] }>;
  const done = output.then(
    (out) => ({ out, error: undefined }),
    (error: unknown) => ({ out: undefined, error }),
  );
  return { seen, records, stored, events, done };
}

/** The probes whose results `messages` hold, in order. */
const results = (messages: readonly ConversationMessage[]) =>
  messages.filter((m) => m.role === 'tool').map((m) => probeOf(m.toolCall?.invocationId));

const completed = (events: readonly TurnEvent[]) =>
  events.filter((e) => e.kind === 'tool.completed').map((e) => probeOf(e.invocationId));

/** Lets every promise that can move, move. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Waits, a bounded while, until `holds()`. */
async function until(holds: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !holds(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(holds()).toBe(true);
}

function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** `a` happened, and before `b`. */
function ranBefore(log: readonly string[], a: string, b: string): boolean {
  const i = log.indexOf(a);
  const j = log.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
}

const PARKED = 'parked: waiting for the reviewer';
const park = async (): Promise<never> => {
  throw new Error(PARKED);
};

describe('dispatch-tools — read-only calls run together', () => {
  test('the calls run at the same time; their results reach the conversation, the model and the events in call order', async () => {
    const [a, b, c] = [latch(), latch(), latch()];
    const step = runStep({
      probes: [
        { name: 'ra', mutating: false, until: a.promise },
        { name: 'rb', mutating: false, until: b.promise },
        { name: 'rc', mutating: false, until: c.promise },
      ],
    });
    await until(() => step.seen.inFlight === 3);
    expect(step.seen.log).toEqual(['start ra', 'start rb', 'start rc']);
    // They finish last first.
    c.open();
    await settle();
    b.open();
    await settle();
    a.open();
    const { out, error } = await step.done;
    expect(error).toBeUndefined();
    expect(step.seen.log.filter((l) => l.startsWith('end'))).toEqual([
      'end rc',
      'end rb',
      'end ra',
    ]);
    expect(results(step.stored)).toEqual(['ra', 'rb', 'rc']);
    expect(
      out?.nextMessages.filter((m) => m.role === 'tool').map((m) => probeOf(m.toolCallId)),
    ).toEqual(['ra', 'rb', 'rc']);
    expect(completed(step.events)).toEqual(['ra', 'rb', 'rc']);
  });

  test('a call to a tool that may change something runs on its own, in its place', async () => {
    const [a, b] = [latch(), latch()];
    const step = runStep({
      probes: [
        { name: 'ra', mutating: false, until: a.promise },
        { name: 'rb', mutating: false, until: b.promise },
        // Says nothing about `mutating`: it may change something.
        { name: 'm' },
        { name: 'rc', mutating: false },
      ],
    });
    await until(() => step.seen.inFlight === 2);
    await settle();
    expect(step.seen.log).toEqual(['start ra', 'start rb']);
    a.open();
    b.open();
    expect((await step.done).error).toBeUndefined();
    expect(ranBefore(step.seen.log, 'stored rb', 'start m')).toBe(true);
    expect(ranBefore(step.seen.log, 'stored m', 'start rc')).toBe(true);
    expect(results(step.stored)).toEqual(['ra', 'rb', 'm', 'rc']);
  });

  test('a call to a read-only tool that may wait runs on its own, in its place: one that pauses, one with a connection', async () => {
    const a = latch();
    const step = runStep({
      probes: [
        { name: 'ra', mutating: false, until: a.promise },
        // May wait for another system's answer.
        { name: 'p', mutating: false, pauses: true },
        { name: 'rb', mutating: false },
        // May wait for the person who started the run to connect an app.
        { name: 'c', mutating: false, connects: true },
        { name: 'rc', mutating: false },
      ],
    });
    await until(() => step.seen.inFlight === 1);
    await settle();
    expect(step.seen.log).toEqual(['start ra']);
    a.open();
    expect((await step.done).error).toBeUndefined();
    expect(step.seen.mostInFlight).toBe(1);
    expect(ranBefore(step.seen.log, 'stored ra', 'start p')).toBe(true);
    expect(ranBefore(step.seen.log, 'stored p', 'start rb')).toBe(true);
    // Its connection isn't served: it runs nothing, and its failure is its result.
    expect(step.seen.runs.has('c')).toBe(false);
    expect(ranBefore(step.seen.log, 'stored rb', 'stored c')).toBe(true);
    expect(ranBefore(step.seen.log, 'stored c', 'start rc')).toBe(true);
    expect(results(step.stored)).toEqual(['ra', 'p', 'rb', 'c', 'rc']);
  });

  test('parallelToolCalls: false: every call runs on its own, in order', async () => {
    const a = latch();
    const step = runStep({
      agent: { parallelToolCalls: false },
      probes: [
        { name: 'ra', mutating: false, until: a.promise },
        { name: 'rb', mutating: false },
      ],
    });
    await until(() => step.seen.inFlight === 1);
    await settle();
    expect(step.seen.log).toEqual(['start ra']);
    a.open();
    expect((await step.done).error).toBeUndefined();
    expect(ranBefore(step.seen.log, 'stored ra', 'start rb')).toBe(true);
  });

  test('at most 8 at the same time: the next start once those are stored', async () => {
    const gate = latch();
    const names = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);
    const step = runStep({
      probes: names.map((name) => ({ name, mutating: false, until: gate.promise })),
    });
    await until(() => step.seen.inFlight === 8);
    await settle();
    expect(step.seen.log.filter((l) => l.startsWith('start'))).toHaveLength(8);
    gate.open();
    expect((await step.done).error).toBeUndefined();
    expect(step.seen.mostInFlight).toBe(8);
    expect(ranBefore(step.seen.log, 'stored r8', 'start r9')).toBe(true);
    expect(results(step.stored)).toEqual(names);
  });
});

describe('dispatch-tools — a call that waits for a review', () => {
  test('from its batch on, one call at a time; the calls after it are decided after the review', async () => {
    const a = latch();
    const seen = newSeen();
    const records = new Map<string, unknown>();
    const decide = async () => ({ allowed: true }) as const;
    const probes: Probe[] = [
      { name: 'ra', mutating: false, until: a.promise },
      { name: 'rb', mutating: false },
      { name: 'rg', mutating: false, gated: true },
      { name: 'rc', mutating: false },
    ];
    const parked = runStep({ probes, seen, records, decide, answer: park });
    await until(() => seen.inFlight === 1);
    await settle();
    expect(seen.log).toEqual(['asked ra', 'asked rb', 'asked rg', 'start ra']);
    a.open();
    expect((await parked.done).error).toEqual(new Error(PARKED));
    expect(seen.log).toEqual([
      'asked ra',
      'asked rb',
      'asked rg',
      'start ra',
      'end ra',
      'stored ra',
      'start rb',
      'end rb',
      'stored rb',
    ]);
    expect([...records.keys()].filter((k) => k.includes('call-rc'))).toEqual([]);

    // Run again once the reviewer approves: what ran before the park comes back stored.
    const resumed = runStep({ probes, seen, records, decide, storedBeforePark: parked.stored });
    expect((await resumed.done).error).toBeUndefined();
    expect(Object.fromEntries(seen.runs)).toEqual({ ra: 1, rb: 1, rg: 1, rc: 1 });
    expect(results(resumed.stored)).toEqual(['rg', 'rc']);
  });

  test('a call after it gets the authorization from after the review, not from before the park', async () => {
    const seen = newSeen();
    const records = new Map<string, unknown>();
    let lost = false;
    const decide = async (input: AuthorizeInput): Promise<ToolCallAuthorization> =>
      lost && input.toolId === 'acme.rc'
        ? { allowed: false, reason: 'You no longer have this tool.' }
        : { allowed: true };
    const probes: Probe[] = [
      { name: 'ra', mutating: false },
      { name: 'm', gated: true },
      { name: 'rc', mutating: false },
    ];
    const parked = runStep({ probes, seen, records, decide, answer: park });
    expect((await parked.done).error).toEqual(new Error(PARKED));
    // rc's access goes while m waits for its reviewer.
    lost = true;
    const resumed = runStep({ probes, seen, records, decide, storedBeforePark: parked.stored });
    expect((await resumed.done).error).toBeUndefined();
    expect(seen.runs.has('rc')).toBe(false);
    expect(resumed.stored.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      { ok: true, by: 'm' },
      { status: 'denied', reason: 'You no longer have this tool.' },
    ]);
  });
});

describe('dispatch-tools — failures in a batch', () => {
  test('a call that fails the turn stops the calls alongside it; the failure is thrown once they have settled', async () => {
    const step = runStep({
      probes: [
        { name: 'ra', mutating: false, fails: true },
        { name: 'rb', mutating: false, runsUntilStopped: true },
      ],
    });
    const { error } = await step.done;
    step.seen.log.push('thrown');
    expect(error).toBeInstanceOf(AgentTurnFailure);
    expect((error as AgentTurnFailure).payload).toMatchObject({ code: 'tool-invocation-failed' });
    expect(step.seen.log.slice(-3)).toEqual(['stopped rb', 'end rb', 'thrown']);
    expect(results(step.stored)).toEqual([]);
  });

  test('retries are counted in call order, as when the calls run one after another', async () => {
    const run = async (agent: Record<string, unknown>) => {
      const step = runStep({
        agent: { toolErrors: { maxRetries: 1, retryOn: ['invalid-arguments'] }, ...agent },
        // Neither call has the `q` it needs.
        args: {},
        probes: [
          { name: 'ra', mutating: false },
          { name: 'rb', mutating: false },
        ],
      });
      const { error } = await step.done;
      return { failure: (error as AgentTurnFailure).payload, sentBack: results(step.stored) };
    };
    const together = await run({});
    expect(together.failure).toMatchObject({ toolId: 'acme.rb', toolRetries: 1 });
    expect(together.sentBack).toEqual(['ra']);
    const alone = await run({ parallelToolCalls: false });
    expect(together.sentBack).toEqual(alone.sentBack);
    expect(together.failure).toMatchObject({
      code: alone.failure.code,
      toolId: (alone.failure as { toolId?: string }).toolId,
      toolRetries: (alone.failure as { toolRetries?: number }).toolRetries,
    });
  });

  test('the step run again after a store failed takes back what was stored, and runs the rest again', async () => {
    const seen = newSeen();
    const records = new Map<string, unknown>();
    const probes: Probe[] = [
      { name: 'ra', mutating: false },
      { name: 'rb', mutating: false },
      { name: 'rc', mutating: false },
    ];
    const failed = runStep({ probes, seen, records, storeFails: 'rb' });
    expect((await failed.done).error).toBeInstanceOf(AgentTurnFailure);
    expect(results(failed.stored)).toEqual(['ra']);
    const again = runStep({ probes, seen, records, storedBeforePark: failed.stored });
    expect((await again.done).error).toBeUndefined();
    expect(Object.fromEntries(seen.runs)).toEqual({ ra: 1, rb: 2, rc: 2 });
    expect([...results(failed.stored), ...results(again.stored)]).toEqual(['ra', 'rb', 'rc']);
  });
});

describe('dispatch-tools — a replay turn', () => {
  test('a recorded call runs nothing; the live ones run together; the results in call order', async () => {
    const [b, c] = [latch(), latch()];
    const step = runStep({
      probes: [
        { name: 'ra', mutating: false },
        { name: 'rb', mutating: false, until: b.promise },
        { name: 'rc', mutating: false, until: c.promise },
      ],
      replay: (name) =>
        name === 'ra'
          ? { kind: 'recorded', result: { ok: true, by: 'the past run' } }
          : { kind: 'live' },
    });
    await until(() => step.seen.inFlight === 2);
    expect(step.seen.log.filter((l) => l.startsWith('start'))).toEqual(['start rb', 'start rc']);
    c.open();
    b.open();
    expect((await step.done).error).toBeUndefined();
    expect(step.seen.runs.has('ra')).toBe(false);
    expect(step.stored.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      { ok: true, by: 'the past run' },
      { ok: true, by: 'rb' },
      { ok: true, by: 'rc' },
    ]);
    expect(
      step.events
        .filter((e) => e.kind === 'tool.completed')
        .map((e) => [probeOf(e.invocationId), e.replay]),
    ).toEqual([
      ['ra', 'recorded'],
      ['rb', 'live'],
      ['rc', 'live'],
    ]);
  });
});
