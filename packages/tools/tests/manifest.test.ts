// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { TOOL_SCHEMA_URI, defineTool, toManifest, toMcpManifest } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function mkTool() {
  const r = defineTool({
    id: 'test.classify' as ToolId,
    description: 'Classify a document by category',
    version: '1.2.3',
    input: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    output: {
      type: 'object',
      properties: { category: { type: 'string' } },
      required: ['category'],
    },
    needs: [{ name: 'tenant' }],
    effects: [{ kind: 'reads', resource: 'memory:facts' }],
    transport: 'auto',
    metadata: { author: 'test' },
    handler: async () => ({ category: 'contract' }),
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

describe('toManifest', () => {
  test('strips the handler and preserves every declared field', () => {
    const tool = mkTool();
    const m = toManifest(tool);
    expect((m as unknown as { handler?: unknown }).handler).toBeUndefined();
    expect(m.id).toBe(tool.id);
    expect(m.description).toBe(tool.description);
    expect(m.version).toBe('1.2.3');
    expect(m.needs).toEqual([{ name: 'tenant' }]);
    expect(m.effects).toEqual([{ kind: 'reads', resource: 'memory:facts' }]);
    expect(m.transport).toBe('auto');
    expect(m.metadata).toEqual({ author: 'test' });
  });

  test('manifest is JSON-serialisable', () => {
    const m = toManifest(mkTool());
    const round = JSON.parse(JSON.stringify(m));
    expect(round).toEqual(m);
  });
});

describe('toMcpManifest', () => {
  test('produces MCP shape: name/description/inputSchema/outputSchema', () => {
    const m = toMcpManifest(mkTool());
    expect(m.name).toBe('test.classify');
    expect(m.description).toBe('Classify a document by category');
    expect(m.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(m.outputSchema).toEqual({
      type: 'object',
      properties: { category: { type: 'string' } },
      required: ['category'],
    });
  });

  test('MCP manifest carries no needs / effects / transport', () => {
    const m = toMcpManifest(mkTool()) as unknown as Record<string, unknown>;
    expect(m.needs).toBeUndefined();
    expect(m.effects).toBeUndefined();
    expect(m.transport).toBeUndefined();
  });
});

describe('schema drift', () => {
  test('bundled tool.schema.json matches @kindgi/specs/tool.schema.json', async () => {
    const bundled = await readFile(join(__dirname, '..', 'src', 'tool.schema.json'), 'utf-8');
    const canonical = await readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/tool.schema.json'),
      'utf-8',
    );
    expect(JSON.parse(bundled)).toEqual(JSON.parse(canonical));
  });

  test('exports the canonical $id', () => {
    expect(TOOL_SCHEMA_URI).toBe('https://kindgi.com/schemas/v1/tool.schema.json');
  });
});
