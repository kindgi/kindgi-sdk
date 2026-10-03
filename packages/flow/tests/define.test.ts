// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { defineFlow, loadFlow } from '../src/index.js';
import type { Flow, FlowSpec } from '../src/index.js';

function edge(id: string, from: string, to: string): unknown {
  return { id, from, to };
}

function node(id: string, ref = 'noop'): unknown {
  return { id, kind: 'tool', ref };
}

function flowSpec(overrides: Partial<Record<string, unknown>> = {}): FlowSpec {
  return {
    id: 'test.flow',
    version: '1.0.0',
    nodes: [node('a')],
    edges: [edge('e1', '$start', 'a'), edge('e2', 'a', '$end')],
    ...overrides,
  } as unknown as FlowSpec;
}

describe('defineFlow — happy path', () => {
  test('returns { kind: "ok" } for a valid FlowSpec', () => {
    const r = defineFlow(flowSpec());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.id).toBe('test.flow');
      expect(r.value.version).toBe('1.0.0');
      expect(r.value.nodes).toHaveLength(1);
      expect(r.value.edges).toHaveLength(2);
    }
  });

  test('output is byte-identical to loadFlow on the same input', () => {
    const spec = flowSpec();
    const viaDefine = defineFlow(spec);
    const viaLoad = loadFlow(spec);
    expect(viaDefine.kind).toBe('ok');
    expect(viaLoad.kind).toBe('ok');
    if (viaDefine.kind === 'ok' && viaLoad.kind === 'ok') {
      expect(viaDefine.value).toEqual(viaLoad.value);
    }
  });

  test('idempotent — same spec returns an equal flow across calls', () => {
    const spec = flowSpec();
    const first = defineFlow(spec);
    const second = defineFlow(spec);
    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(first.value).toEqual(second.value);
    }
  });
});

describe('defineFlow — error surface', () => {
  test('schema-invalid spec returns typed schema-validation-failed', () => {
    const bad = {
      id: 'bad.flow',
      version: 'v1', // not semver
      nodes: [],
      edges: [],
    } as unknown as FlowSpec;
    const r = defineFlow(bad);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('unknown node kind returns typed error', () => {
    const bad = flowSpec({ nodes: [{ id: 'a', kind: 'not-a-kind', ref: 'x' }] });
    const r = defineFlow(bad);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('schema-validation-failed');
  });

  test('cycle detection surfaces typed cycle-detected error', () => {
    const cyclic = flowSpec({
      nodes: [node('a'), node('b')],
      edges: [
        edge('e1', '$start', 'a'),
        edge('e2', 'a', 'b'),
        edge('e3', 'b', 'a'), // cycle
        edge('e4', 'b', '$end'),
      ],
    });
    const r = defineFlow(cyclic);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('cycle-detected');
  });

  test('duplicate node ids surfaces typed error', () => {
    const dupNodes = flowSpec({
      nodes: [node('a'), node('a')],
      edges: [edge('e1', '$start', 'a'), edge('e2', 'a', '$end')],
    });
    const r = defineFlow(dupNodes);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-node-id');
  });

  test('missing $start edge surfaces typed error', () => {
    const noStart = flowSpec({
      edges: [edge('e1', 'a', '$end')],
    });
    const r = defineFlow(noStart);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('missing-start-edge');
  });

  test('edge referencing unknown node surfaces typed error', () => {
    const badRef = flowSpec({
      edges: [edge('e1', '$start', 'a'), edge('e2', 'a', 'ghost')],
    });
    const r = defineFlow(badRef);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('unknown-node-reference');
  });
});

describe('defineFlow — type surface', () => {
  test('returned Flow is structurally the input Flow', () => {
    const spec = flowSpec();
    const r = defineFlow(spec);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const flow: Flow = r.value;
      expect(flow.id).toBe(spec.id);
      expect(flow.version).toBe(spec.version);
    }
  });
});

describe('defineFlow — plain string ids', () => {
  test('a whole flow written with plain strings type-checks without a cast, and validates', () => {
    const isBilling = {
      op: 'eq',
      left: { path: 'nodeOutputs.classify.output.category' },
      right: { literal: 'billing' },
    } as const;
    // No `as FlowId` / `as NodeId` / `as EdgeId`, and no cast on the object:
    // a type error here fails this package's typecheck.
    const r = defineFlow({
      id: 'acme.triage-ticket',
      version: '0.1.0',
      nodes: [
        {
          id: 'parse',
          kind: 'tool',
          ref: 'acme.parse-ticket',
          inputMapping: { ticket: { path: 'runInput.ticket' } },
        },
        {
          id: 'classify',
          kind: 'agent',
          ref: 'acme.ticket-classifier',
          config: { parameters: { product: 'acme-cloud' } },
        },
        {
          id: 'each-line',
          kind: 'loop',
          loopKind: 'foreach',
          iterateOver: { path: 'runInput.lines' },
          maxIterations: 10,
          outputSchema: { type: 'object' },
          body: {
            nodes: [{ id: 'line', kind: 'tool', ref: 'acme.check-line' }],
            edges: [
              { id: 'b0', from: '$loop-start', to: 'line' },
              { id: 'b1', from: 'line', to: '$loop-end' },
            ],
          },
        },
      ],
      edges: [
        { id: 'e0', from: '$start', to: 'parse' },
        { id: 'e1', from: 'parse', to: 'classify', policy: { retry: { maxAttempts: 2 } } },
        { id: 'e2', from: 'classify', to: 'each-line', when: isBilling },
        { id: 'e3', from: 'each-line', to: '$end' },
      ],
      output: {
        mapping: { category: { path: 'nodeOutputs.classify.output.category' } },
        schema: { type: 'object' },
      },
    });
    expect(r.kind, r.kind === 'err' ? r.error.message : '').toBe('ok');
    if (r.kind === 'ok') {
      const flow: Flow = r.value;
      expect(flow.id).toBe('acme.triage-ticket');
      expect(flow.nodes.map((n) => n.id)).toEqual(['parse', 'classify', 'each-line']);
    }
  });

  test('branded ids still fit (code written with the casts keeps compiling)', () => {
    const r = defineFlow({
      id: 'acme.echo' as Flow['id'],
      version: '0.1.0',
      nodes: [{ id: 'echo' as Flow['nodes'][number]['id'], kind: 'tool', ref: 'acme.echo' }],
      edges: [
        { id: 'e0' as Flow['edges'][number]['id'], from: '$start', to: 'echo' as never },
        { id: 'e1' as Flow['edges'][number]['id'], from: 'echo' as never, to: '$end' },
      ],
    });
    expect(r.kind).toBe('ok');
  });
});
