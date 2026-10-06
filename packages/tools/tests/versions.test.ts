// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One rule picks a version from a range, wherever Kindgi resolves one:
 * a range picks the highest version it allows, a prerelease only when
 * the range names one; no range picks the latest, a prerelease included.
 * The in-process registry a turn resolves against picks the same way
 * (tool versions themselves are plain `major.minor.patch`).
 */

import { describe, expect, test } from 'vitest';

import type { ToolId } from '@kindgi/types';

import { defineTool } from '../src/define.js';
import { createToolRegistry } from '../src/registry.js';
import type { AnyTool } from '../src/types.js';
import { latestVersion, pickVersion } from '../src/versions.js';

const available = ['1.0.0', '1.2.0', '1.3.0-beta.1', '2.0.0', 'not-a-version'];

describe('pickVersion', () => {
  test('a range picks the highest version it allows', () => {
    expect(pickVersion(available, '^1.0.0')).toEqual({ kind: 'ok', version: '1.2.0' });
    expect(pickVersion(available, '1.0.0')).toEqual({ kind: 'ok', version: '1.0.0' });
    expect(pickVersion(available, '>=1.0.0')).toEqual({ kind: 'ok', version: '2.0.0' });
  });

  test('a range picks a prerelease only when it names one', () => {
    expect(pickVersion(available, '^1.2.0')).toEqual({ kind: 'ok', version: '1.2.0' });
    expect(pickVersion(available, '^1.3.0-beta.0')).toEqual({
      kind: 'ok',
      version: '1.3.0-beta.1',
    });
  });

  test('no range picks the latest, a prerelease included', () => {
    expect(pickVersion(available)).toEqual({ kind: 'ok', version: '2.0.0' });
    expect(pickVersion(['1.0.0', '1.1.0-rc.1'])).toEqual({ kind: 'ok', version: '1.1.0-rc.1' });
    expect(latestVersion(['0.1.0', '0.10.0', '0.9.0'])).toBe('0.10.0');
  });

  test('an invalid range, or none satisfied, says which', () => {
    expect(pickVersion(available, 'not a range')).toEqual({ kind: 'invalid-range' });
    expect(pickVersion(available, '^3.0.0')).toEqual({ kind: 'not-satisfiable' });
    expect(pickVersion([])).toEqual({ kind: 'not-satisfiable' });
    expect(latestVersion([])).toBeUndefined();
  });
});

function lookup(version: string): AnyTool {
  const defined = defineTool<{ q: string }, { q: string }>({
    id: 'acme.lookup' as ToolId,
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

describe('the in-process registry picks by the same rule', () => {
  test.each([['^1.0.0'], ['~1.0.0'], ['>=1.0.0'], ['1.0.0'], ['^3.0.0']])('%s', (range) => {
    const versions = ['1.0.0', '1.0.4', '1.2.0', '2.0.0'];
    const registry = createToolRegistry(versions.map(lookup));
    const resolved = registry.resolve('acme.lookup' as ToolId, range);
    const picked = pickVersion(versions, range);
    expect(resolved.kind === 'ok' ? resolved.value.resolvedVersion : resolved.error.code).toBe(
      picked.kind === 'ok' ? picked.version : 'tool-version-unresolvable',
    );
  });
});
