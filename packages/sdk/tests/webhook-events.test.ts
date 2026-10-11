// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `parseEvent` (`@kindgi/sdk/webhooks`): the typed event in a verified body, checked against shapes generated from the API's schemas. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ApprovalId, RunId } from '@kindgi/types';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { type WebhookEvent, parseEvent } from '../src/webhooks.js';

const AT = '2026-10-10T20:00:04.120Z';
const PROJECT = 'e889c1f5-eae7-45dc-8669-5bd029a5d85c';
const RUN = {
  id: '0b7c3a52-6f1e-4c55-9a43-3f0f3c1d2e10',
  projectId: PROJECT,
  flowId: 'acme-shop.answer',
  flowVersion: '1.2.0',
  status: 'completed',
  dryRun: false,
  failureMessage: null,
  createdAt: '2026-10-10T20:00:00.000Z',
  completedAt: AT,
};
/** A run with every optional part the API can send. */
const RUN_IN_FULL = {
  ...RUN,
  status: 'failed',
  failureMessage: 'budget-exceeded',
  usage: {
    calls: 2,
    costUsd: 0.0021,
    tokens: { prompt: 900, completion: 40, cacheRead: 0, cacheWrite: 0, reasoning: 12 },
  },
  agent: {
    id: 'acme-shop.helpdesk',
    version: '0.3.0',
    conversationId: '5d2a1c7e-2b9f-4a51-8f0e-0c6d9b1a7e33',
    via: 'live',
    liveScope: { kind: 'project', projectId: PROJECT },
  },
};
const PASS = {
  id: 'c3f1e9a0-7d4b-4e2a-9b6c-1f8e2d3a4b5c',
  agentId: 'acme-shop.helpdesk',
  fromVersion: '0.3.0',
  scope: {
    kind: 'segment',
    projectId: PROJECT,
    path: [{ key: 'company', value: 'acme' }],
  },
  suiteId: 'acme-shop.helpdesk-suite',
  tiers: ['prompt'],
  objective: 'weightedYesShare',
  budget: { maxCostUsd: 2, maxCandidates: 3 },
  requestedBy: 'user_1',
  status: 'completed',
  candidatesEvaluated: 3,
  costUsd: '0.0123',
  outcome: {
    kind: 'proposed',
    proposalId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    holdOut: { baseline: 0.5, candidate: 0.62, delta: null },
  },
  comparisons: [{ role: 'candidate', part: 'search', score: null, changed: { anything: [1] } }],
  trigger: { triggerId: 'improve-nightly', fireId: 'fire_1' },
  createdAt: AT,
  updatedAt: AT,
  finishedAt: AT,
};
const APPROVAL = {
  approvalId: 'appr_1',
  projectId: PROJECT,
  requiredRole: 'senior',
  title: 'Refund over $500',
  createdAt: AT,
  expiresAt: '2026-10-11T20:00:04.120Z',
  url: 'https://console.acme.example/approvals/appr_1',
};
const EVENTS: Record<WebhookEvent['type'], Record<string, unknown>> = {
  'run.finished': { id: 'evt_1', type: 'run.finished', createdAt: AT, data: { run: RUN } },
  'improvement-pass.finished': {
    id: 'evt_2',
    type: 'improvement-pass.finished',
    createdAt: AT,
    data: { pass: PASS },
  },
  'approval.requested': {
    id: 'evt_3',
    type: 'approval.requested',
    createdAt: AT,
    data: { approval: APPROVAL },
  },
  'webhook.test': {
    id: 'evt_4',
    type: 'webhook.test',
    createdAt: AT,
    data: { endpointId: 'acme-hooks' },
  },
};
const body = (value: unknown) => JSON.stringify(value);
const withRun = (run: Record<string, unknown>) =>
  body({ ...EVENTS['run.finished'], data: { run } });
const withPass = (pass: Record<string, unknown>) =>
  body({ ...EVENTS['improvement-pass.finished'], data: { pass } });
const problem = (read: ReturnType<typeof parseEvent>) =>
  read.kind === 'err' ? read.message : 'ok';

/** Each check the schema makes, at depth: a body that breaks it, and the message naming the field. */
const REFUSED: readonly (readonly [string, string, string])[] = [
  ['a uuid', withRun({ ...RUN, id: 'run_1' }), '`data.run.id` is not a UUID.'],
  [
    'an enum',
    withRun({ ...RUN, status: 'running' }),
    '`data.run.status` is not one of "completed", "failed", "cancelled".',
  ],
  [
    'a required field',
    withRun({ ...RUN, completedAt: undefined }),
    '`data.run.completedAt` is missing.',
  ],
  [
    'a date-time zone',
    withRun({ ...RUN, createdAt: '2026-10-10 20:00:00' }),
    '`data.run.createdAt` is not a date-time with a time zone.',
  ],
  [
    'a nullable string',
    withRun({ ...RUN, failureMessage: 7 }),
    '`data.run.failureMessage` is not a string.',
  ],
  ['a boolean', withRun({ ...RUN, dryRun: 'no' }), '`data.run.dryRun` is not true or false.'],
  [
    'a nested required field',
    withRun({
      ...RUN_IN_FULL,
      usage: { ...RUN_IN_FULL.usage, tokens: { prompt: 1, completion: 1 } },
    }),
    '`data.run.usage.tokens.cacheRead` is missing.',
  ],
  [
    'a minimum',
    withRun({ ...RUN_IN_FULL, usage: { ...RUN_IN_FULL.usage, calls: -1 } }),
    '`data.run.usage.calls` is less than 0.',
  ],
  [
    'a whole number',
    withRun({ ...RUN_IN_FULL, usage: { ...RUN_IN_FULL.usage, calls: 1.5 } }),
    '`data.run.usage.calls` is not a whole number.',
  ],
  [
    "an optional field's format",
    withRun({ ...RUN_IN_FULL, agent: { ...RUN_IN_FULL.agent, conversationId: 'c_1' } }),
    '`data.run.agent.conversationId` is not a UUID.',
  ],
  [
    "an optional field's enum",
    withRun({ ...RUN_IN_FULL, agent: { ...RUN_IN_FULL.agent, via: 'guess' } }),
    '`data.run.agent.via` is not one of "explicit", "flow-pin", "conversation", "live", "latest".',
  ],
  [
    "a union's variant",
    withRun({ ...RUN_IN_FULL, agent: { ...RUN_IN_FULL.agent, liveScope: { kind: 'project' } } }),
    '`data.run.agent.liveScope.projectId` is missing.',
  ],
  [
    "a union's tag",
    withRun({ ...RUN_IN_FULL, agent: { ...RUN_IN_FULL.agent, liveScope: { kind: 'galaxy' } } }),
    '`data.run.agent.liveScope.kind` is not one of "tenant", "org", "project", "segment".',
  ],
  [
    'an enum on a pass',
    withPass({ ...PASS, objective: 'accuracy' }),
    '`data.pass.objective` is not one of "weightedYesShare", "weightedPrecisionAtK".',
  ],
  [
    'an exclusive minimum',
    withPass({ ...PASS, budget: { maxCostUsd: 0, maxCandidates: 3 } }),
    '`data.pass.budget.maxCostUsd` is not more than 0.',
  ],
  [
    'a maximum',
    withPass({ ...PASS, budget: { maxCostUsd: 2, maxCandidates: 500 } }),
    '`data.pass.budget.maxCandidates` is more than 200.',
  ],
  [
    'minItems',
    withPass({ ...PASS, scope: { ...PASS.scope, path: [] } }),
    '`data.pass.scope.path` has fewer than 1 items.',
  ],
  [
    "an array item's pattern",
    withPass({ ...PASS, scope: { ...PASS.scope, path: [{ key: 'Company', value: 'acme' }] } }),
    "`data.pass.scope.path[0].key` doesn't match ^[a-z][a-z0-9_-]{0,63}$.",
  ],
  [
    'a minLength',
    withPass({ ...PASS, scope: { ...PASS.scope, path: [{ key: 'company', value: '' }] } }),
    '`data.pass.scope.path[0].value` is shorter than 1 characters.',
  ],
  [
    "an array item's enum",
    withPass({ ...PASS, comparisons: [{ role: 'judge', part: 'search' }] }),
    '`data.pass.comparisons[0].role` is not one of "reference", "candidate", "proof".',
  ],
  [
    'a nullable number',
    withPass({
      ...PASS,
      outcome: { kind: 'proposed', holdOut: { baseline: 'high', candidate: null, delta: null } },
    }),
    '`data.pass.outcome.holdOut.baseline` is not a number.',
  ],
];

describe('parseEvent: real events', () => {
  test.each(Object.keys(EVENTS))('a %s event is read with its type', (type) => {
    const event = EVENTS[type as WebhookEvent['type']];
    expect(parseEvent(body(event))).toEqual({ kind: 'ok', event });
  });

  test('a run with every optional part (usage, agent, its live scope) is read', () => {
    expect(problem(parseEvent(withRun(RUN_IN_FULL)))).toBe('ok');
  });

  test("a run's id is a RunId and an approval's an ApprovalId, for the client's getters", () => {
    const read = parseEvent(body(EVENTS['run.finished']));
    if (read.kind !== 'ok') throw new Error(read.message);
    const event = read.event;
    if (event.type === 'run.finished') {
      expectTypeOf(event.data.run.id).toEqualTypeOf<RunId>();
      const id: RunId = event.data.run.id;
      expect(id).toBe(RUN.id);
    }
    if (event.type === 'approval.requested') {
      expectTypeOf(event.data.approval.approvalId).toEqualTypeOf<ApprovalId>();
    }
    // @ts-expect-error a plain string isn't a RunId: the brand is real
    const notARunId: RunId = 'not-branded';
    expect(notARunId).toBe('not-branded');
  });

  test('the raw bytes of a body, as a framework hands them over', () => {
    const read = parseEvent(new TextEncoder().encode(body(EVENTS['webhook.test'])));
    expect(read.kind === 'ok' && read.event.type).toBe('webhook.test');
  });

  test("a field this version doesn't know is kept, at any depth", () => {
    const read = parseEvent(
      body({ ...EVENTS['run.finished'], extra: 1, data: { run: { ...RUN, later: { a: true } } } }),
    );
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && (read.event as unknown as { extra: number }).extra).toBe(1);
  });
});

describe('parseEvent: what it refuses', () => {
  test('not JSON: not-json', () => {
    expect(parseEvent('{"type": ')).toEqual({
      kind: 'err',
      reason: 'not-json',
      message: 'The body is not JSON.',
    });
  });

  test("a type this version doesn't know: unknown-type, naming it (a 2xx and leave it)", () => {
    expect(parseEvent(body({ ...EVENTS['webhook.test'], type: 'run.started' }))).toEqual({
      kind: 'err',
      reason: 'unknown-type',
      message: `"run.started" is an event type this version of the SDK doesn't know.`,
    });
    for (const type of ['constructor', '__proto__', 'toString']) {
      const read = parseEvent(body({ type, data: {} }));
      expect(read.kind === 'err' && read.reason).toBe('unknown-type');
    }
  });

  test("a body that isn't an event object", () => {
    for (const value of [null, [], 'run.finished', { data: {} }]) {
      expect(parseEvent(body(value))).toEqual({
        kind: 'err',
        reason: 'invalid-event',
        message: '`type` is missing or not a string.',
      });
    }
  });

  test.each(REFUSED)('%s', (_what, sent, message) => {
    const read = parseEvent(sent);
    expect(read).toMatchObject({ kind: 'err', reason: 'invalid-event' });
    expect(read.kind === 'err' && read.message).toMatch(/^A "[^"]+" event: /);
    expect(read.kind === 'err' && read.message.replace(/^A "[^"]+" event: /, '')).toBe(message);
  });

  test("an approval's role, and a test event's endpoint", () => {
    expect(
      problem(
        parseEvent(
          body({
            ...EVENTS['approval.requested'],
            data: { approval: { ...APPROVAL, requiredRole: 'owner' } },
          }),
        ),
      ),
    ).toBe(
      'A "approval.requested" event: `data.approval.requiredRole` is not one of "standard", "senior", "admin".',
    );
    expect(problem(parseEvent(body({ ...EVENTS['webhook.test'], data: {} })))).toBe(
      'A "webhook.test" event: `data.endpointId` is missing.',
    );
  });
});

describe('the shapes are the API schema, generated', () => {
  test('the generated shapes are current with packages/api/openapi.json (pnpm run check:webhook-shapes)', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const run = spawnSync('node', ['scripts/gen-webhook-event-shapes.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect([run.status, run.stderr.trim()]).toEqual([0, '']);
  });
});
