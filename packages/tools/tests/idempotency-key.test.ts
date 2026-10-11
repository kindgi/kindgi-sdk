// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool call's idempotency key: a version 5 UUID any runtime reproduces
 * from the namespace and the call's parts. The vectors were computed with
 * Python's `uuid.uuid5(namespace, json.dumps(parts, separators=(',', ':'),
 * ensure_ascii=False))`, independently of this code.
 */

import { describe, expect, test } from 'vitest';

import { TOOL_IDEMPOTENCY_NAMESPACE, toolIdempotencyKey } from '../src/index.js';

const RUN = '4b5f8c1e-2f0a-4c8e-9a51-0c7e2d9a6b13';

describe('toolIdempotencyKey', () => {
  test('the fixed namespace', () => {
    expect(TOOL_IDEMPOTENCY_NAMESPACE).toBe('a70d5bff-e713-4322-b2ea-9d5c4926a861');
  });

  test.each([
    [
      { runId: RUN, stepScope: 'charge-card', toolId: 'acme.payments.charge' },
      'f6c8a374-b63c-5453-8320-1ca9c067447a',
    ],
    [
      {
        runId: RUN,
        stepScope: 'agent-loop#2/dispatch-tools',
        toolId: 'acme.refunds.issue',
        callId: 'call_0',
      },
      'bf055463-2cce-5e82-b31a-43d7698db52e',
    ],
    // Not ASCII: the name is UTF-8, never escaped.
    [
      { runId: RUN, stepScope: 'notify/branch-é', toolId: 'acme.mail.send' },
      '873f6e4e-cd72-5604-ac09-ab1496cfeb8a',
    ],
  ])('%o → %s, as Python computes it', (input, expected) => {
    expect(toolIdempotencyKey(input)).toBe(expected);
  });

  test('beyond ASCII, a part is its own UTF-8, never a \\u escape (another key)', () => {
    const input = { runId: RUN, stepScope: 'notify/branch-é', toolId: 'acme.mail.send' };
    // Python's default `json.dumps` writes "notify/branch-\u00e9": this key, which isn't the call's.
    expect(toolIdempotencyKey(input)).not.toBe('8680f8f9-077a-5815-ba0b-602d3abed6b3');
    expect(toolIdempotencyKey(input)).toBe('873f6e4e-cd72-5604-ac09-ab1496cfeb8a');
  });

  test('a version 5 UUID of the RFC variant', () => {
    expect(toolIdempotencyKey({ runId: RUN, stepScope: 's', toolId: 't' })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('the same call id in two loop iterations: two keys', () => {
    const at = (stepScope: string) =>
      toolIdempotencyKey({ runId: RUN, stepScope, toolId: 'acme.refunds.issue', callId: 'call_0' });
    expect(at('agent-loop#2/dispatch-tools')).toBe('bf055463-2cce-5e82-b31a-43d7698db52e');
    expect(at('agent-loop#3/dispatch-tools')).toBe('f08fa71f-aaa9-5f9e-96bf-7e54d4f1af46');
  });

  test('every part counts: another run, step, tool or call is another key', () => {
    const base = { runId: RUN, stepScope: 'a', toolId: 't', callId: 'c' };
    const keys = new Set([
      toolIdempotencyKey(base),
      toolIdempotencyKey({ ...base, runId: 'another-run' }),
      toolIdempotencyKey({ ...base, stepScope: 'b' }),
      toolIdempotencyKey({ ...base, toolId: 'u' }),
      toolIdempotencyKey({ ...base, callId: 'd' }),
      toolIdempotencyKey({ runId: RUN, stepScope: 'a', toolId: 't' }),
      // Parts are a JSON array, so a separator inside one can't shift the others.
      toolIdempotencyKey({ ...base, stepScope: 'a","t', toolId: 'c' }),
    ]);
    expect(keys.size).toBe(7);
  });
});
