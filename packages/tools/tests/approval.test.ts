// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool's `approval`: how an approval of a call to it reads. Each
 * `{field}` placeholder is checked against the tool's input where the
 * tool is defined, registered or deployed, so every call fills it; a
 * call's arguments then fill it as one line of plain text.
 */

import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import type { ToolId } from '@kindgi/types';

import { defineTool, renderApproval, validateToolManifest } from '../src/index.js';
import type { JsonSchema, Tool, ToolApproval } from '../src/index.js';

const input = {
  type: 'object',
  properties: {
    orderId: { type: 'integer' },
    amount: { type: 'number' },
    reason: { type: 'string' },
    notify: { type: 'boolean' },
    channel: { enum: ['mail', 'phone'] },
    note: { type: 'string' },
    lines: { type: 'array', items: { type: 'string' } },
    customer: { type: 'object' },
    coupon: { type: ['string', 'null'] },
  },
  required: ['orderId', 'amount', 'reason', 'notify', 'channel', 'lines', 'customer', 'coupon'],
} as unknown as JsonSchema;

const tool = (approval: unknown): Tool =>
  ({
    id: 'acme.refund' as ToolId,
    description: 'Refunds an order.',
    version: '0.1.0',
    input,
    output: { type: 'object' } as JsonSchema,
    mutating: true,
    ...(approval !== undefined && { approval }),
    handler: async () => ({}),
  }) as unknown as Tool;

/** Both ways a tool is checked: defined in a pack, or a manifest sent to the API or a deploy. */
const checks = (approval: unknown) => {
  const candidate = tool(approval);
  const { handler: _handler, ...manifest } = candidate;
  return [
    ['defineTool', defineTool(candidate)],
    ['validateToolManifest', validateToolManifest(manifest)],
  ] as const;
};

describe('an approval is checked against the input where the tool is defined', () => {
  test('placeholders naming required string, number, integer, boolean and enum fields are kept', () => {
    const approval: ToolApproval = {
      title: 'Refund {amount} on order #{orderId}',
      summary: '{reason} (notify: {notify}, by {channel})',
      about: { kind: 'acme.order', id: '{orderId}' },
    };
    for (const [label, r] of checks(approval)) {
      expect(r.kind, label).toBe('ok');
      if (r.kind === 'ok') expect(r.value.approval, label).toEqual(approval);
    }
  });

  test.each([
    [
      'a field the input has not',
      { title: 'Refund {total}' },
      '/approval/title',
      "names {total}, which isn't a field of the input",
    ],
    [
      'an optional field, which a call may leave out',
      { title: 'Refund {amount}', summary: '{note}' },
      '/approval/summary',
      'names {note}, an optional field of the input: a call may leave it out',
    ],
    [
      'an array',
      { title: 'Refund {lines}' },
      '/approval/title',
      "names {lines}, a field of the input that isn't a string, a number, an integer or a boolean",
    ],
    [
      'an object',
      { title: 'Refund for {customer}' },
      '/approval/title',
      "names {customer}, a field of the input that isn't a string, a number, an integer or a boolean",
    ],
    [
      'a field that may be null',
      { title: 'Refund with {coupon}' },
      '/approval/title',
      "names {coupon}, a field of the input that isn't a string, a number, an integer or a boolean",
    ],
    [
      'a brace outside a placeholder',
      { title: 'Refund {{amount}}' },
      '/approval/title',
      "has a brace that isn't part of a {field} placeholder",
    ],
    [
      'an about id with no placeholder',
      { title: 'Refund {amount}', about: { kind: 'acme.order', id: 'latest' } },
      '/approval/about/id',
      'must hold at least one {field} placeholder',
    ],
  ])('one naming %s is refused, naming the tool and the text', (_why, approval, path, message) => {
    const where = path.slice(1).replaceAll('/', '.');
    for (const [label, r] of checks(approval)) {
      expect(r.kind, label).toBe('err');
      if (r.kind !== 'err') continue;
      expect(r.error, label).toEqual({
        code: 'invalid-tool-definition',
        message: `Tool "acme.refund": ${where} ${message}`,
        issues: [{ path, message }],
      });
    }
  });

  test.each([
    ['no title', { summary: '{reason}' }],
    ['a title on two lines', { title: 'Refund {amount}\non order #{orderId}' }],
    ['an empty title', { title: '' }],
    ['a field it does not know', { title: 'Refund {amount}', body: '{reason}' }],
    [
      'an about kind that is not a dotted name',
      { title: 'Refund', about: { kind: 'Order', id: '{orderId}' } },
    ],
  ])('one with %s is refused by its schema', (_why, approval) => {
    for (const [label, r] of checks(approval)) {
      expect(r.kind, label).toBe('err');
      if (r.kind === 'err') expect(r.error.code, label).toBe('invalid-tool-definition');
    }
  });

  test("a Zod input's optional field is refused, and its required ones kept", () => {
    const zodTool = (title: string) =>
      defineTool({
        id: 'acme.refund' as ToolId,
        description: 'Refunds an order.',
        version: '0.1.0',
        input: z.object({ orderId: z.number().int().positive(), note: z.string().optional() }),
        output: z.object({}),
        approval: { title },
        handler: async () => ({}),
      });
    expect(zodTool('Refund order #{orderId}').kind).toBe('ok');
    const r = zodTool('Refund: {note}');
    expect(r.kind === 'err' && r.error.message).toBe(
      'Tool "acme.refund": approval.title names {note}, an optional field of the input: a call may leave it out',
    );
  });

  test('a tool without one is defined as before, with no approval', () => {
    for (const [label, r] of checks(undefined)) {
      expect(r.kind, label).toBe('ok');
      if (r.kind === 'ok') expect(r.value, label).not.toHaveProperty('approval');
    }
  });
});

describe("renderApproval fills a call's approval from its arguments", () => {
  const approval: ToolApproval = {
    title: 'Refund {amount} on order #{orderId}',
    summary: '{reason}',
    about: { kind: 'acme.order', id: '{orderId}' },
  };

  test('each placeholder takes its value as text: numbers and booleans too', () => {
    expect(
      renderApproval(
        { title: 'Refund {amount} on #{orderId}, notify {notify}' },
        { amount: 25.5, orderId: 1043, notify: false },
      ),
    ).toEqual({ kind: 'ok', value: { text: { title: 'Refund 25.5 on #1043, notify false' } } });
    expect(renderApproval(approval, { amount: 25, orderId: 1043, reason: 'Zip broke' })).toEqual({
      kind: 'ok',
      value: {
        text: { title: 'Refund 25 on order #1043', summary: 'Zip broke' },
        about: { kind: 'acme.order', id: '1043' },
      },
    });
  });

  test('in one pass: a value that holds a placeholder stays as it is', () => {
    const r = renderApproval(approval, { amount: 25, orderId: 1043, reason: 'see {orderId}' });
    expect(r.kind === 'ok' && r.value.text.summary).toBe('see {orderId}');
  });

  test('a value reads on one line: breaks and controls become spaces, bidi controls go', () => {
    const reason = 'Zip\nbroke\r\n\tday\u{2028}one \u{202E}lanigiro\u{202C} \u{0007}\u{061C}end';
    const r = renderApproval(approval, { amount: 25, orderId: 1043, reason });
    expect(r.kind === 'ok' && r.value.text.summary).toBe('Zip broke day one lanigiro end');
  });

  test('a long value is cut, ending in …, and so is a long text', () => {
    const r = renderApproval(
      { title: '{reason}', summary: '{reason} {reason} {reason}' },
      { reason: 'x'.repeat(600) },
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.text.title).toBe(`${'x'.repeat(79)}…`);
    expect(Array.from(r.value.text.summary ?? '')).toHaveLength(1000);
    expect(r.value.text.summary?.endsWith('…')).toBe(true);
  });

  test('a cut counts characters, not UTF-16 units', () => {
    const r = renderApproval({ title: '{reason}' }, { reason: '\u{1F4E6}'.repeat(100) });
    expect(r.kind === 'ok' && r.value.text.title).toBe(`${'\u{1F4E6}'.repeat(79)}…`);
  });

  test('arguments that leave a placeholder unfilled answer the text that did not fill', () => {
    expect(renderApproval(approval, { orderId: 1043, reason: 'Zip broke' })).toEqual({
      kind: 'err',
      error: { path: '/approval/title' },
    });
    expect(renderApproval(approval, { amount: 25, orderId: 1043, reason: { text: 'x' } })).toEqual({
      kind: 'err',
      error: { path: '/approval/summary' },
    });
    expect(renderApproval(approval, null)).toEqual({
      kind: 'err',
      error: { path: '/approval/title' },
    });
  });

  test('a title that fills to nothing answers its path, so the approval reads the default', () => {
    expect(
      renderApproval({ title: '{reason} {note}' }, { reason: ' \n ', note: '\u{200E}' }),
    ).toEqual({
      kind: 'err',
      error: { path: '/approval/title' },
    });
  });

  test('a summary that fills to nothing is left out', () => {
    expect(renderApproval(approval, { amount: 25, orderId: 1043, reason: '\t ' })).toEqual({
      kind: 'ok',
      value: {
        text: { title: 'Refund 25 on order #1043' },
        about: { kind: 'acme.order', id: '1043' },
      },
    });
  });

  test('an about id that fills to nothing leaves about out', () => {
    expect(
      renderApproval(
        { title: 'Look up an order', about: { kind: 'acme.order', id: '{orderId}' } },
        { orderId: ' ' },
      ),
    ).toEqual({ kind: 'ok', value: { text: { title: 'Look up an order' } } });
  });

  // A pack's index is JSON read from disk, unchecked: its `approval` may be anything.
  test.each([
    ['a string', 'Refund', '/approval'],
    ['null', null, '/approval'],
    ['a list', [{ title: 'Refund' }], '/approval'],
    ['a title that is a number', { title: 25 }, '/approval/title'],
    ['no title', { summary: 'x' }, '/approval/title'],
    ['a summary that is a number', { title: 'x', summary: 5 }, '/approval/summary'],
    ['an about with no id', { title: 'x', about: { kind: 'acme.order' } }, '/approval/about'],
    ['an about that is null', { title: 'x', about: null }, '/approval/about'],
    [
      'an about kind that is a number',
      { title: 'x', about: { kind: 7, id: '{orderId}' } },
      '/approval/about',
    ],
  ])('an approval that is %s answers the path that is wrong, never throws', (_, bad, path) => {
    expect(renderApproval(bad as unknown as ToolApproval, { orderId: 1043 })).toEqual({
      kind: 'err',
      error: { path },
    });
  });
});
