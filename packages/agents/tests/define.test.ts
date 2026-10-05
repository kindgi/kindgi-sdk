// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';

const baseCapabilities = [{ needs: [{ feature: 'structured-output' as const }] }];

const baseSpec = {
  id: 'acme.citation-verifier',
  version: '1.0.0',
  name: 'Citation Verifier',
  instructions: 'Answer questions about acme order history.',
  capabilities: baseCapabilities,
  tools: [{ id: 'citations.verify', version: '1.0.0' }],
  retrieval: [{ types: ['prior-verification'], scope: 'same-project' as const }],
  guardrails: ['no-hallucinated-citations'],
};

describe('defineAgent — happy path', () => {
  test('returns ok with a frozen-like agent shape', () => {
    const r = defineAgent(baseSpec);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.id).toBe('acme.citation-verifier');
      expect(r.value.version).toBe('1.0.0');
      expect(r.value.tools).toEqual([{ id: 'citations.verify', version: '1.0.0' }]);
      expect(r.value.retrieval[0]?.scope).toBe('same-project');
    }
  });

  test('accepts optional fields (description, budget, conversationPolicy, tags)', () => {
    const r = defineAgent({
      ...baseSpec,
      description: 'Verifies legal citations',
      conversationPolicy: { historyLimit: 20, hitlAfterTurns: 10 },
      budget: { maxSteps: 4, maxCostUsd: 0.5, maxWallMs: 30_000 },
      tags: ['legal', 'verification'],
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.description).toBe('Verifies legal citations');
      expect(r.value.conversationPolicy?.historyLimit).toBe(20);
      expect(r.value.budget?.maxSteps).toBe(4);
      expect(r.value.tags).toEqual(['legal', 'verification']);
    }
  });

  test('accepts pre-release semver', () => {
    const r = defineAgent({ ...baseSpec, version: '1.0.0-rc.1' });
    expect(r.kind).toBe('ok');
  });

  test('accepts declared prompt parameters', () => {
    const r = defineAgent({
      ...baseSpec,
      parameters: [
        { name: 'firmName', type: 'string' },
        { name: 'jurisdiction', type: 'string', required: false, default: 'CA' },
      ],
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.parameters).toHaveLength(2);
  });

  test('accepts multiple capabilities', () => {
    const r = defineAgent({
      ...baseSpec,
      capabilities: [
        { needs: [{ feature: 'structured-output' as const }] },
        { needs: [{ feature: 'tool-use' as const }] },
      ],
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.capabilities).toHaveLength(2);
  });
});

describe('defineAgent — rejections', () => {
  test('rejects empty id', () => {
    const r = defineAgent({ ...baseSpec, id: '' });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/id')).toBe(true);
    }
  });

  test('rejects malformed semver', () => {
    const r = defineAgent({ ...baseSpec, version: 'v1' });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/version')).toBe(true);
    }
  });

  test('rejects blank instructions', () => {
    const r = defineAgent({ ...baseSpec, instructions: '   ' });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/instructions')).toBe(true);
    }
  });

  test('rejects retrieval intent with empty types', () => {
    const r = defineAgent({
      ...baseSpec,
      retrieval: [{ types: [], scope: 'tenant' as const }],
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/retrieval/0/types')).toBe(true);
    }
  });

  test('rejects retrieval intent with invalid scope', () => {
    const r = defineAgent({
      ...baseSpec,
      retrieval: [{ types: ['x'], scope: 'nonsense' as unknown as 'tenant' }],
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/retrieval/0/scope')).toBe(true);
    }
  });

  test('rejects negative budget values', () => {
    const r = defineAgent({
      ...baseSpec,
      budget: { maxSteps: -1, maxCostUsd: -0.5 },
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/budget/maxSteps')).toBe(true);
      expect(r.error.issues.some((i) => i.path === '/budget/maxCostUsd')).toBe(true);
    }
  });

  test('rejects a parameter named the same as an auto-injected var', () => {
    const r = defineAgent({
      ...baseSpec,
      parameters: [{ name: 'today', type: 'date' }],
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/parameters/0/name')).toBe(true);
    }
  });

  test('rejects duplicate parameter names', () => {
    const r = defineAgent({
      ...baseSpec,
      parameters: [
        { name: 'foo', type: 'string' },
        { name: 'foo', type: 'string' },
      ],
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/parameters/1/name')).toBe(true);
    }
  });

  test('rejects a parameter with invalid type', () => {
    const r = defineAgent({
      ...baseSpec,
      parameters: [{ name: 'foo', type: 'array' as unknown as 'string' }],
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/parameters/0/type')).toBe(true);
    }
  });

  test('rejects empty capabilities array', () => {
    const r = defineAgent({ ...baseSpec, capabilities: [] });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues.some((i) => i.path === '/capabilities')).toBe(true);
    }
  });

  test('reports all issues at once, not first-failure', () => {
    const r = defineAgent({
      ...baseSpec,
      id: '',
      version: 'not-semver',
      instructions: '',
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('defineAgent — invariance', () => {
  test('caller-mutated arrays after define do not affect the definition', () => {
    const tools = [
      { id: 'a', version: '1.0.0' },
      { id: 'b', version: '1.0.0' },
    ];
    const guardrails = ['x'];
    const retrieval = [{ types: ['t'], scope: 'tenant' as const }];
    const r = defineAgent({ ...baseSpec, tools, guardrails, retrieval });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      tools.push({ id: 'c', version: '1.0.0' });
      guardrails.push('y');
      retrieval[0]?.types.slice().push('mutated');
      expect(r.value.tools).toEqual([
        { id: 'a', version: '1.0.0' },
        { id: 'b', version: '1.0.0' },
      ]);
      expect(r.value.guardrails).toEqual(['x']);
      expect(r.value.retrieval[0]?.types).toEqual(['t']);
    }
  });
});

describe('defineAgent — hitl.onTimeout', () => {
  const withOnTimeout = (onTimeout: unknown) =>
    defineAgent({
      ...baseSpec,
      conversationPolicy: { hitl: { onTimeout } },
    } as unknown as Parameters<typeof defineAgent>[0]);

  test("'escalate', what happens when an approval times out, is accepted", () => {
    expect(withOnTimeout('escalate').kind).toBe('ok');
  });

  test.each(['auto-approve', 'auto-reject'])(
    "'%s' isn't supported: refused, saying what happens instead",
    (value) => {
      const r = withOnTimeout(value);
      expect(r.kind).toBe('err');
      if (r.kind === 'err') {
        expect(r.error.issues).toContainEqual({
          path: '/conversationPolicy/hitl/onTimeout',
          message: `hitl.onTimeout '${value}' isn't supported: an approval that times out escalates one reviewer tier, and at admin it expires (the turn fails with hitl-cancelled). Use 'escalate', or leave it out.`,
        });
      }
    },
  );

  test('any other value is refused', () => {
    const r = withOnTimeout('approve-later');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.issues).toContainEqual({
        path: '/conversationPolicy/hitl/onTimeout',
        message: "hitl.onTimeout must be 'escalate'",
      });
    }
  });
});
