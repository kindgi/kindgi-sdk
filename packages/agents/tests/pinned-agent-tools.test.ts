// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pinned agent version runs the tool versions it was published with,
 * not its ranges resolved again: a newer version in range doesn't reach
 * it, and a pinned version that's gone fails the turn rather than
 * running another. A version with no pins resolves its ranges, as
 * before; a resumed turn's own versions come first.
 */

import { describe, expect, test } from 'vitest';

import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool } from '@kindgi/tools';
import type { Semver, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { resolveTurnTools } from '../src/handlers/resolve-tools.js';
import type { Agent, AgentId } from '../src/types.js';

function lookup(version: string): AnyTool {
  const defined = defineTool<{ q: string }, { found: string }>({
    id: 'acme.lookup' as ToolId,
    description: 'Looks something up.',
    version,
    input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    output: {
      type: 'object',
      properties: { found: { type: 'string' } },
      required: ['found'],
      additionalProperties: false,
    },
    effects: [],
    handler: async (input) => ({ found: input.q }),
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  return defined.value as unknown as AnyTool;
}

function agent(pinned?: string): Agent {
  const r = defineAgent({
    id: 'acme.intake' as AgentId,
    version: '1.4.0' as Semver,
    name: 'Intake',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [{ id: 'acme.lookup', version: '^1.0.0' }],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return pinned === undefined
    ? r.value
    : { ...r.value, pins: { tools: { 'acme.lookup': pinned }, prompts: {}, settings: {} } };
}

const registry = (...versions: string[]) => createToolRegistry(versions.map(lookup));

describe('a turn of a pinned agent version', () => {
  test('runs the pinned version, though a newer one is in range', () => {
    const tools = resolveTurnTools(registry('1.0.0', '1.1.0'), agent('1.0.0'));
    expect(tools.byName.get('acme.lookup')).toMatchObject({
      resolvedVersion: '1.0.0',
      requestedRange: '^1.0.0',
    });
  });

  test("a pinned version that's gone fails the turn, naming the agent version", () => {
    let failure: unknown;
    try {
      resolveTurnTools(registry('1.1.0'), agent('1.0.0'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentTurnFailure);
    expect((failure as AgentTurnFailure).payload).toMatchObject({
      code: 'tool-version-unresolvable',
      toolId: 'acme.lookup',
      message: expect.stringContaining(
        'agent "acme.intake" version 1.4.0 runs version 1.0.0 (its pins)',
      ),
    });
  });

  test('a version with no pins resolves its range, as before', () => {
    const tools = resolveTurnTools(registry('1.0.0', '1.1.0'), agent());
    expect(tools.byName.get('acme.lookup')?.resolvedVersion).toBe('1.1.0');
  });

  test("a resumed turn's own versions come first", () => {
    const tools = resolveTurnTools(registry('1.0.0', '1.1.0'), agent('1.0.0'), {
      'acme.lookup': '1.1.0',
    });
    expect(tools.byName.get('acme.lookup')?.resolvedVersion).toBe('1.1.0');
  });
});
