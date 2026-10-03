// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { createToolRegistry, defineTool } from '../src/index.js';
import type { Tool } from '../src/index.js';

function mkTool(id: string, version = '1.0.0'): Tool {
  const spec = defineTool({
    id: id as ToolId,
    description: `Tool ${id}`,
    version,
    input: { type: 'null' },
    output: { type: 'null' },
    handler: async () => null,
  });
  if (spec.kind === 'err') throw new Error(spec.error.message);
  return spec.value;
}

describe('createToolRegistry', () => {
  test('register + get round-trip', () => {
    const reg = createToolRegistry();
    const tool = mkTool('test.a');
    const r = reg.register(tool);
    expect(r.kind).toBe('ok');
    const got = reg.get('test.a' as ToolId);
    if (got.kind === 'err') throw new Error(got.error.message);
    expect(got.value).toBe(tool);
  });

  test('has returns true for registered, false for unknown', () => {
    const reg = createToolRegistry([mkTool('test.a')]);
    expect(reg.has('test.a' as ToolId)).toBe(true);
    expect(reg.has('test.b' as ToolId)).toBe(false);
  });

  test('list returns every tool in insertion order', () => {
    const a = mkTool('test.a');
    const b = mkTool('test.b');
    const reg = createToolRegistry([a, b]);
    expect(reg.list()).toEqual([a, b]);
  });

  test('ids returns just the identifiers', () => {
    const reg = createToolRegistry([mkTool('x'), mkTool('y')]);
    expect(reg.ids()).toEqual(['x', 'y']);
  });

  test('duplicate (id, version) registration rejected', () => {
    const reg = createToolRegistry([mkTool('dup')]);
    const r = reg.register(mkTool('dup'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('duplicate-tool-version');
  });

  test('same id, distinct versions coexist', () => {
    const reg = createToolRegistry([mkTool('multi', '1.0.0'), mkTool('multi', '1.1.0')]);
    expect(reg.versions('multi' as ToolId)).toEqual(['1.1.0', '1.0.0']);
    const latest = reg.get('multi' as ToolId);
    if (latest.kind === 'err') throw new Error(latest.error.message);
    expect(latest.value.version).toBe('1.1.0');
    const pinned = reg.getVersion('multi' as ToolId, '1.0.0');
    if (pinned.kind === 'err') throw new Error(pinned.error.message);
    expect(pinned.value.version).toBe('1.0.0');
  });

  test('get with unknown id returns tool-not-found', () => {
    const reg = createToolRegistry();
    const r = reg.get('missing' as ToolId);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('tool-not-found');
  });

  test('resolve picks maxSatisfying against a range', () => {
    const reg = createToolRegistry([
      mkTool('rng', '1.0.0'),
      mkTool('rng', '1.1.0'),
      mkTool('rng', '2.0.0'),
    ]);
    const caret = reg.resolve('rng' as ToolId, '^1.0.0');
    if (caret.kind === 'err') throw new Error(caret.error.message);
    expect(caret.value.resolvedVersion).toBe('1.1.0');

    const wildcard = reg.resolve('rng' as ToolId, '*');
    if (wildcard.kind === 'err') throw new Error(wildcard.error.message);
    expect(wildcard.value.resolvedVersion).toBe('2.0.0');

    const pinned = reg.resolve('rng' as ToolId, '1.0.0');
    if (pinned.kind === 'err') throw new Error(pinned.error.message);
    expect(pinned.value.resolvedVersion).toBe('1.0.0');
  });

  test('resolve returns invalid-version-range on grammar errors', () => {
    const reg = createToolRegistry([mkTool('rng', '1.0.0')]);
    const r = reg.resolve('rng' as ToolId, 'not-a-range');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-version-range');
  });

  test('resolve returns tool-version-unresolvable when range excludes all versions', () => {
    const reg = createToolRegistry([mkTool('rng', '1.0.0'), mkTool('rng', '1.1.0')]);
    const r = reg.resolve('rng' as ToolId, '^2.0.0');
    expect(r.kind).toBe('err');
    if (r.kind === 'err' && r.error.code === 'tool-version-unresolvable') {
      expect(r.error.availableVersions).toEqual(['1.1.0', '1.0.0']);
    }
  });

  test('resolve returns tool-not-found when id is unregistered', () => {
    const reg = createToolRegistry();
    const r = reg.resolve('missing' as ToolId, '^1.0.0');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('tool-not-found');
  });
});
