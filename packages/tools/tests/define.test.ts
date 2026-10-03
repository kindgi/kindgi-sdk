// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { defineTool } from '../src/index.js';
import type { Tool } from '../src/index.js';

function baseTool<TIn = unknown, TOut = unknown>(
  over: Partial<Tool<TIn, TOut>> = {},
): Tool<TIn, TOut> {
  return {
    id: 'test.echo' as ToolId,
    description: 'Echo the input as output',
    version: '1.0.0',
    input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    output: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    handler: async (input) => input as unknown as TOut,
    ...over,
  };
}

describe('defineTool — happy path', () => {
  test('accepts a minimal valid tool', () => {
    const r = defineTool(baseTool());
    expect(r.kind).toBe('ok');
  });

  test('preserves the handler reference through validation', () => {
    const handler = async (): Promise<{ msg: string }> => ({ msg: 'ok' });
    const r = defineTool(baseTool({ handler }));
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.handler).toBe(handler);
  });

  test('accepts declared effects with resource + notes', () => {
    const r = defineTool(
      baseTool({
        effects: [
          { kind: 'reads', resource: 'memory:facts' },
          { kind: 'network', resource: 'external:api.example.com', notes: 'rate limited' },
        ],
      }),
    );
    expect(r.kind).toBe('ok');
  });

  test('accepts declared needs', () => {
    const r = defineTool(
      baseTool({
        needs: [{ name: 'tenant' }, { name: 'memory:facts', optional: true }],
      }),
    );
    expect(r.kind).toBe('ok');
  });
});

describe('defineTool — schema conformance', () => {
  test('rejects empty id', () => {
    const r = defineTool(baseTool({ id: '' as ToolId }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-tool-definition');
  });

  test('rejects missing description', () => {
    const r = defineTool(baseTool({ description: '' }));
    expect(r.kind).toBe('err');
  });

  test('rejects malformed version', () => {
    const r = defineTool(baseTool({ version: 'v1' }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-tool-definition');
  });

  test('rejects unknown transport value', () => {
    const r = defineTool(baseTool({ transport: 'weird' as 'auto' }));
    expect(r.kind).toBe('err');
  });
});

describe('defineTool — effect validation', () => {
  test('rejects an unknown effect kind', () => {
    const r = defineTool(
      baseTool({
        effects: [{ kind: 'gambles' as 'reads' }],
      }),
    );
    expect(r.kind).toBe('err');
    // Schema rejects first (enum on Effect.kind), so we may see either code.
    if (r.kind === 'err') {
      expect(['unknown-effect', 'invalid-tool-definition']).toContain(r.error.code);
    }
  });
});

describe('defineTool — input/output schema compilation', () => {
  test('rejects input that is not a valid JSON Schema (bad type keyword)', () => {
    const r = defineTool(baseTool({ input: { type: 'not-a-json-schema-type' } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-schema');
    if (r.kind === 'err' && r.error.code === 'invalid-schema') {
      expect(r.error.where).toBe('input');
    }
  });

  test('rejects output that references an undefined $ref', () => {
    const r = defineTool(baseTool({ output: { $ref: '#/definitions/DoesNotExist' } }));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-schema');
    if (r.kind === 'err' && r.error.code === 'invalid-schema') {
      expect(r.error.where).toBe('output');
    }
  });
});
