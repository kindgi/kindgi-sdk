// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { nameToolsAsSent } from '../src/index.js';

const encode = (id: string): string => id.replace(/\./g, '__');

describe('nameToolsAsSent', () => {
  test("names the call's own tools by their sent names, in backticks, bare, and before a full stop", () => {
    expect(
      nameToolsAsSent(
        'Call `acme.lookup_order` first. Then acme.refund_order, or acme.lookup_order.',
        ['acme.lookup_order', 'acme.refund_order'],
        encode,
      ),
    ).toBe('Call `acme__lookup_order` first. Then acme__refund_order, or acme__lookup_order.');
  });

  test('only whole ids: a longer name, a prefix, a version suffix and another pack are left alone', () => {
    const text =
      'acme.lookup_orders, xacme.lookup_order, acme.lookup_order.v2, acme.lookup_order-old, other.lookup_order';
    expect(nameToolsAsSent(text, ['acme.lookup_order'], encode)).toBe(text);
  });

  test('the longest id wins where one id is the start of another', () => {
    expect(
      nameToolsAsSent(
        'Use acme.orders.lookup, not acme.orders.',
        ['acme.orders', 'acme.orders.lookup'],
        encode,
      ),
    ).toBe('Use acme__orders__lookup, not acme__orders.');
  });

  test('deterministic: the order of the tools changes nothing', () => {
    const text = 'acme.a then acme.ab then acme.b';
    const a = nameToolsAsSent(text, ['acme.a', 'acme.ab', 'acme.b'], encode);
    const b = nameToolsAsSent(text, ['acme.b', 'acme.ab', 'acme.a'], encode);
    expect(a).toBe('acme__a then acme__ab then acme__b');
    expect(b).toBe(a);
  });

  test('a provider that keeps ids as they are (Gemini) changes nothing', () => {
    const text = 'Call acme.lookup_order.';
    expect(nameToolsAsSent(text, ['acme.lookup_order'], (id) => id)).toBe(text);
    expect(nameToolsAsSent(text, [], encode)).toBe(text);
  });

  test('regex characters in an id are literal', () => {
    expect(nameToolsAsSent('a+b.c and aXb.c', ['a+b.c'], encode)).toBe('a+b__c and aXb.c');
  });
});
