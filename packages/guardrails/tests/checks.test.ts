// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { RunId, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { BUILT_IN_CHECK_IDS, createCheckRegistry } from '../src/index.js';
import type { RunTrace } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

function baseTrace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: crypto.randomUUID() as RunId,
    tenantId: TENANT,
    output: '',
    toolCalls: [],
    toolResults: [],
    modelCalls: [],
    mode: 'runtime',
    ...over,
  };
}

describe('createCheckRegistry — built-ins present', () => {
  test('all built-in checks are registered', () => {
    const registry = createCheckRegistry();
    for (const id of BUILT_IN_CHECK_IDS) {
      expect(registry.get(id)?.id).toBe(id);
    }
  });

  test('custom check overrides built-in', () => {
    const registry = createCheckRegistry([
      {
        id: 'must-cite',
        kind: 'zero-llm',
        evaluate: async () => ({ passed: true, attributes: { custom: true } }),
      },
    ]);
    expect(registry.get('must-cite')?.evaluate).toBeDefined();
  });
});

describe('must-cite check', () => {
  test('passes when citation count meets threshold', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('must-cite');
    if (check === undefined) throw new Error('must-cite missing');
    const result = await check.evaluate(
      { minCitations: 2 },
      baseTrace({ output: 'The answer per [Smith] and [Jones] is clear.' }),
      {},
    );
    expect(result.passed).toBe(true);
    expect(result.attributes?.citationCount).toBe(2);
  });

  test('fails when citation count below threshold', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('must-cite');
    if (check === undefined) throw new Error('must-cite missing');
    const result = await check.evaluate(
      { minCitations: 2 },
      baseTrace({ output: 'Only [Smith] is here.' }),
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('expected >= 2 citations');
  });

  test('empty output fails immediately', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('must-cite');
    if (check === undefined) throw new Error('must-cite missing');
    const result = await check.evaluate({ minCitations: 1 }, baseTrace(), {});
    expect(result.passed).toBe(false);
  });
});

describe('never-call-tool check', () => {
  test('passes when no forbidden tools called', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('never-call-tool');
    if (check === undefined) throw new Error('never-call-tool missing');
    const result = await check.evaluate(
      { tools: [{ id: 'send-email', version: '1.0.0' }] },
      baseTrace({
        toolCalls: [
          {
            toolId: 'search' as ToolId,
            toolName: 'search',
            arguments: {},
            at: '2026-09-17T12:00:00.000Z' as Timestamp,
          },
        ],
      }),
      {},
    );
    expect(result.passed).toBe(true);
  });

  test('fails when forbidden tool invoked', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('never-call-tool');
    if (check === undefined) throw new Error('never-call-tool missing');
    const result = await check.evaluate(
      { tools: [{ id: 'send-email', version: '1.0.0' }] },
      baseTrace({
        toolCalls: [
          {
            toolId: 'send-email' as ToolId,
            toolName: 'send-email',
            arguments: { to: 'x' },
            at: '2026-09-17T12:00:00.000Z' as Timestamp,
          },
        ],
      }),
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('send-email');
  });
});

describe('max-tool-calls check', () => {
  test('passes under limit', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('max-tool-calls');
    if (check === undefined) throw new Error('max-tool-calls missing');
    const trace = baseTrace({
      toolCalls: [
        {
          toolId: 'a' as ToolId,
          toolName: 'a',
          arguments: {},
          at: '2026-09-17T12:00:00.000Z' as Timestamp,
        },
        {
          toolId: 'b' as ToolId,
          toolName: 'b',
          arguments: {},
          at: '2026-09-17T12:00:01.000Z' as Timestamp,
        },
      ],
    });
    const result = await check.evaluate({ max: 5 }, trace, {});
    expect(result.passed).toBe(true);
  });

  test('fails over limit', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('max-tool-calls');
    if (check === undefined) throw new Error('max-tool-calls missing');
    const trace = baseTrace({
      toolCalls: Array.from({ length: 6 }, (_, i) => ({
        toolId: `t-${i}` as ToolId,
        toolName: `t-${i}`,
        arguments: {},
        at: '2026-09-17T12:00:00.000Z' as Timestamp,
      })),
    });
    const result = await check.evaluate({ max: 5 }, trace, {});
    expect(result.passed).toBe(false);
  });
});

describe('output-matches check', () => {
  test('positive match passes', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('output-matches');
    if (check === undefined) throw new Error('output-matches missing');
    const result = await check.evaluate(
      { pattern: '^APPROVED', flags: '' },
      baseTrace({ output: 'APPROVED: proceed to next step' }),
      {},
    );
    expect(result.passed).toBe(true);
  });

  test('negate=true fails on match', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('output-matches');
    if (check === undefined) throw new Error('output-matches missing');
    const result = await check.evaluate(
      { pattern: 'SSN|social security', flags: 'i', negate: true },
      baseTrace({ output: 'The client provided their SSN.' }),
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('matched forbidden pattern');
  });
});

describe('tool-order check', () => {
  test('subsequence match passes', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('tool-order');
    if (check === undefined) throw new Error('tool-order missing');
    const trace = baseTrace({
      toolCalls: [
        {
          toolId: 'a' as ToolId,
          toolName: 'search',
          arguments: {},
          at: '2026-09-17T12:00:00.000Z' as Timestamp,
        },
        {
          toolId: 'b' as ToolId,
          toolName: 'other',
          arguments: {},
          at: '2026-09-17T12:00:01.000Z' as Timestamp,
        },
        {
          toolId: 'c' as ToolId,
          toolName: 'summarize',
          arguments: {},
          at: '2026-09-17T12:00:02.000Z' as Timestamp,
        },
      ],
    });
    const result = await check.evaluate({ sequence: ['search', 'summarize'] }, trace, {});
    expect(result.passed).toBe(true);
  });

  test('missing subsequence fails', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('tool-order');
    if (check === undefined) throw new Error('tool-order missing');
    const trace = baseTrace({
      toolCalls: [
        {
          toolId: 'a' as ToolId,
          toolName: 'summarize',
          arguments: {},
          at: '2026-09-17T12:00:00.000Z' as Timestamp,
        },
      ],
    });
    const result = await check.evaluate({ sequence: ['search', 'summarize'] }, trace, {});
    expect(result.passed).toBe(false);
  });
});

describe('required-substring check', () => {
  test('passes when every pattern is present (case-insensitive default)', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('required-substring');
    if (check === undefined) throw new Error('required-substring missing');
    const result = await check.evaluate(
      { patterns: ['DISCLAIMER', 'not legal advice'] },
      baseTrace({
        output: 'This is a summary. Disclaimer: not legal advice. Consult a professional.',
      }),
      {},
    );
    expect(result.passed).toBe(true);
  });

  test('fails when a required pattern is missing', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('required-substring');
    if (check === undefined) throw new Error('required-substring missing');
    const result = await check.evaluate(
      { patterns: ['DISCLAIMER', 'not legal advice'] },
      baseTrace({ output: 'This is a summary. It has a disclaimer.' }),
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not legal advice');
    expect((result.attributes?.missing as string[]) ?? []).toEqual(['not legal advice']);
  });

  test('caseSensitive: true respects casing', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('required-substring');
    if (check === undefined) throw new Error('required-substring missing');
    const result = await check.evaluate(
      { patterns: ['Disclaimer'], caseSensitive: true },
      baseTrace({ output: 'This is a summary. disclaimer: lower-case.' }),
      {},
    );
    expect(result.passed).toBe(false);
  });

  test('empty patterns passes vacuously', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('required-substring');
    if (check === undefined) throw new Error('required-substring missing');
    const result = await check.evaluate({ patterns: [] }, baseTrace({ output: 'anything' }), {});
    expect(result.passed).toBe(true);
  });

  test('empty output fails when patterns declared', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('required-substring');
    if (check === undefined) throw new Error('required-substring missing');
    const result = await check.evaluate({ patterns: ['x'] }, baseTrace({ output: '' }), {});
    expect(result.passed).toBe(false);
  });
});

describe('forbidden-substring check', () => {
  test('passes when no forbidden pattern appears', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('forbidden-substring');
    if (check === undefined) throw new Error('forbidden-substring missing');
    const result = await check.evaluate(
      { patterns: ['SSN', 'credit card'] },
      baseTrace({ output: 'clean response' }),
      {},
    );
    expect(result.passed).toBe(true);
  });

  test('fails when a forbidden pattern appears (case-insensitive default)', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('forbidden-substring');
    if (check === undefined) throw new Error('forbidden-substring missing');
    const result = await check.evaluate(
      { patterns: ['SSN'] },
      baseTrace({ output: 'The ssn is 123-45-6789' }),
      {},
    );
    expect(result.passed).toBe(false);
    expect((result.attributes?.violated as string[]) ?? []).toEqual(['SSN']);
  });

  test('empty output passes vacuously', async () => {
    const registry = createCheckRegistry();
    const check = registry.get('forbidden-substring');
    if (check === undefined) throw new Error('forbidden-substring missing');
    const result = await check.evaluate({ patterns: ['x'] }, baseTrace({ output: '' }), {});
    expect(result.passed).toBe(true);
  });
});
