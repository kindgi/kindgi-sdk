// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `parseEvent` (`@kindgi/sdk/webhooks`): the typed event in a verified body, held to the API's schemas. */

import { readFileSync } from 'node:fs';

import type { ApprovalId, RunId } from '@kindgi/types';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { type EventFieldShape, WEBHOOK_EVENT_SHAPES } from '../src/webhook-events.js';
import { type WebhookEvent, parseEvent } from '../src/webhooks.js';

const AT = '2026-10-10T20:00:04.120Z';
const RUN = {
  id: '0b7c3a52-6f1e-4c55-9a43-3f0f3c1d2e10',
  projectId: 'e889c1f5-eae7-45dc-8669-5bd029a5d85c',
  flowId: 'acme-shop.answer',
  flowVersion: '1.2.0',
  status: 'completed',
  dryRun: false,
  failureMessage: null,
  createdAt: '2026-10-10T20:00:00.000Z',
  completedAt: AT,
};
const PASS = {
  id: 'pass_1',
  agentId: 'acme-shop.helpdesk',
  fromVersion: '0.3.0',
  scope: { kind: 'project' },
  suiteId: 'acme-shop.helpdesk-suite',
  tiers: ['prompt'],
  objective: 'accuracy',
  budget: { maxCandidates: 3 },
  requestedBy: 'user_1',
  status: 'completed',
  candidatesEvaluated: 3,
  costUsd: '0.0123',
  createdAt: AT,
  updatedAt: AT,
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
    data: { approval: { approvalId: 'appr_1', requiredRole: 'standard', createdAt: AT } },
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

describe('parseEvent', () => {
  test.each(Object.keys(EVENTS))('a %s event is read with its type', (type) => {
    const read = parseEvent(body(EVENTS[type as WebhookEvent['type']]));
    expect(read).toEqual({ kind: 'ok', event: EVENTS[type as WebhookEvent['type']] });
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

  test('a run that failed: failureMessage a string; optional usage and agent checked when present', () => {
    expect(
      parseEvent(
        withRun({
          ...RUN,
          status: 'failed',
          failureMessage: 'budget-exceeded',
          usage: { calls: 2, costUsd: 0.0021, tokens: { prompt: 900, completion: 40 } },
          agent: { id: 'acme-shop.helpdesk', version: '0.3.0', conversationId: 'c_1' },
        }),
      ).kind,
    ).toBe('ok');
    expect(parseEvent(withRun({ ...RUN, usage: { calls: 1.5, costUsd: 0, tokens: {} } }))).toEqual({
      kind: 'err',
      reason: 'invalid-event',
      message: 'A "run.finished" event: `data.run.usage.calls` is not a whole number.',
    });
  });

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

  test.each([
    [{ ...RUN, completedAt: undefined }, '`data.run.completedAt` is missing.'],
    [
      { ...RUN, status: 'running' },
      '`data.run.status` is not one of "completed", "failed", "cancelled".',
    ],
    [{ ...RUN, dryRun: 'no' }, '`data.run.dryRun` is not true or false.'],
    [{ ...RUN, failureMessage: 7 }, '`data.run.failureMessage` is not a string or null.'],
    [
      { ...RUN, createdAt: '2026-10-10 20:00:00' },
      '`data.run.createdAt` is not a date-time with a time zone.',
    ],
    [{ ...RUN, id: 42 }, '`data.run.id` is not a string.'],
  ])('a field missing or of the wrong type: invalid-event, naming it (%#)', (run, problem) => {
    expect(parseEvent(withRun(run))).toEqual({
      kind: 'err',
      reason: 'invalid-event',
      message: `A "run.finished" event: ${problem}`,
    });
  });

  test("the envelope's own fields, and a body that isn't an object", () => {
    const { createdAt: _createdAt, ...noTime } = EVENTS['webhook.test'];
    expect(parseEvent(body(noTime))).toMatchObject({
      message: 'A "webhook.test" event: `createdAt` is missing.',
    });
    expect(parseEvent(body({ ...EVENTS['webhook.test'], data: [] }))).toMatchObject({
      message: 'A "webhook.test" event: `data` is not an object.',
    });
    for (const value of [null, [], 'run.finished', { data: {} }]) {
      expect(parseEvent(body(value))).toEqual({
        kind: 'err',
        reason: 'invalid-event',
        message: '`type` is missing or not a string.',
      });
    }
  });

  test("an approval's role is one the API names", () => {
    const approval = { approvalId: 'appr_1', requiredRole: 'owner', createdAt: AT };
    expect(parseEvent(body({ ...EVENTS['approval.requested'], data: { approval } }))).toMatchObject(
      {
        reason: 'invalid-event',
        message:
          'A "approval.requested" event: `data.approval.requiredRole` is not one of "standard", "senior", "admin".',
      },
    );
  });
});

/** The API's own schemas (`@kindgi/api`'s OpenAPI document, in this repository). */
const SCHEMAS = (
  JSON.parse(readFileSync(new URL('../../api/openapi.json', import.meta.url), 'utf8')) as {
    components: { schemas: Record<string, Schema> };
  }
).components.schemas;

interface Schema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly const?: string;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly discriminator?: { readonly mapping: Readonly<Record<string, string>> };
}

const resolve = (schema: Schema): Schema =>
  schema.$ref === undefined ? schema : (SCHEMAS[schema.$ref.split('/').at(-1) as string] as Schema);

/** Every way a shape differs from its schema, by path. */
function drift(shape: EventFieldShape, raw: Schema, path: string): string[] {
  const schema = resolve(raw);
  const kind = (expected: string, ok: boolean) =>
    ok ? [] : [`${path}: ${expected} here, the schema says ${JSON.stringify(raw)}`];
  switch (shape.kind) {
    case 'string':
      return kind('string', schema.type === 'string');
    case 'string-or-null':
      return kind('string or null', JSON.stringify(schema.type) === '["string","null"]');
    case 'boolean':
    case 'number':
    case 'integer':
    case 'array':
      return kind(shape.kind, schema.type === shape.kind);
    case 'date-time':
      return kind('date-time', schema.type === 'string' && schema.format === 'date-time');
    case 'enum': {
      const values = schema.const !== undefined ? [schema.const] : (schema.enum ?? []);
      return kind(`one of ${shape.values.join(', ')}`, values.join() === shape.values.join());
    }
    case 'object': {
      const required = Object.keys(shape.required);
      const optional = Object.keys(shape.optional ?? {});
      // An object whose fields aren't checked here: the schema's own object, or a $ref to one.
      if (required.length === 0 && optional.length === 0) return [];
      const problems: string[] = [];
      const theirs = [...(schema.required ?? [])].sort();
      if (required.slice().sort().join() !== theirs.join()) {
        problems.push(`${path}: required ${required.sort().join()}, the schema's ${theirs.join()}`);
      }
      for (const key of optional) {
        if (schema.properties?.[key] === undefined || theirs.includes(key)) {
          problems.push(`${path}.${key}: optional here, not an optional property in the schema`);
        }
      }
      for (const [key, field] of [
        ...Object.entries(shape.required),
        ...Object.entries(shape.optional ?? {}),
      ]) {
        const property = schema.properties?.[key];
        if (property !== undefined) problems.push(...drift(field, property, `${path}.${key}`));
      }
      return problems;
    }
  }
}

describe("the shapes are the API's", () => {
  test('the same event types as the API sends', () => {
    const mapping = (SCHEMAS.WebhookEvent as Schema).discriminator?.mapping ?? {};
    expect(Object.keys(WEBHOOK_EVENT_SHAPES).sort()).toEqual(Object.keys(mapping).sort());
  });

  test.each(Object.keys(WEBHOOK_EVENT_SHAPES))(
    '%s: every required field, its type, and the optional ones checked, as the schema says',
    (type) => {
      const mapping = (SCHEMAS.WebhookEvent as Schema).discriminator?.mapping ?? {};
      const schema = { $ref: mapping[type] as string };
      expect(drift(WEBHOOK_EVENT_SHAPES[type as WebhookEvent['type']], schema, type)).toEqual([]);
    },
  );

  test('the drift check catches a required field the API adds (a control)', () => {
    const shape = WEBHOOK_EVENT_SHAPES['webhook.test'];
    const schema: Schema = {
      type: 'object',
      required: ['id', 'type', 'createdAt', 'data', 'attempt'],
      properties: resolve({ $ref: '#/components/schemas/WebhookTestEvent' }).properties ?? {},
    };
    expect(drift(shape, schema, 'webhook.test')).not.toEqual([]);
  });
});
