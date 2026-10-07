// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Unregister stops a tool version being chosen, not the pins that hold
 * it: a retired version is served by its exact version only. No range,
 * "latest" or listing picks it.
 */

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { defineTool } from '../src/define.js';
import { createToolRegistry } from '../src/registry.js';
import type { AnyTool } from '../src/types.js';

const id = 'acme.lookup' as ToolId;

function lookup(version: string): AnyTool {
  const defined = defineTool<{ q: string }, { q: string }>({
    id,
    description: 'Looks something up.',
    version,
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => input,
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function registry() {
  const r = createToolRegistry([lookup('1.0.0')]);
  r.register(lookup('1.1.0'), { retired: true });
  return r;
}

describe('a retired tool version', () => {
  test('is served by its exact version', () => {
    const r = registry();
    const got = r.getVersion(id, '1.1.0');
    expect(got.kind === 'ok' && got.value.version).toBe('1.1.0');
    expect(r.hasVersion(id, '1.1.0')).toBe(true);
  });

  test('no range, "latest" or listing picks it', () => {
    const r = registry();
    const resolved = r.resolve(id, '^1.0.0');
    expect(resolved.kind === 'ok' && resolved.value.resolvedVersion).toBe('1.0.0');
    const latest = r.get(id);
    expect(latest.kind === 'ok' && latest.value.version).toBe('1.0.0');
    expect(r.versions(id)).toEqual(['1.0.0']);
    expect(r.list().map((t) => t.version)).toEqual(['1.0.0']);
  });

  test('an id with only retired versions has none to choose', () => {
    const r = createToolRegistry();
    r.register(lookup('2.0.0'), { retired: true });
    expect(r.has(id)).toBe(false);
    expect(r.ids()).toEqual([]);
    expect(r.resolve(id, '^2.0.0').kind).toBe('err');
    expect(r.getVersion(id, '2.0.0').kind).toBe('ok');
  });
});
