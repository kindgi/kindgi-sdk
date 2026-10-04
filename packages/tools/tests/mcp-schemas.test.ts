// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An MCP server's tool schemas, as the server sends them. The TypeScript
 * MCP SDK declares draft-07; they compile and validate in draft-07, and
 * without Ajv's strict-mode lint. A pack's own tools stay Draft 2020-12,
 * in strict mode.
 */

import { describe, expect, test } from 'vitest';

import type { TenantId, ToolId } from '@kindgi/types';

import { defineTool, invokeTool, validateToolManifest } from '../src/index.js';
import type { JsonSchema, Tool, ToolContext } from '../src/index.js';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** A weather tool's schemas, as a TypeScript MCP SDK server lists them. */
const weatherInput: JsonSchema = {
  type: 'object',
  properties: {
    location: { type: 'string', enum: ['New York', 'Chicago'], description: 'Choose city' },
  },
  required: ['location'],
  $schema: DRAFT_07,
};
const weatherOutput: JsonSchema = {
  type: 'object',
  properties: {
    temperature: { type: 'number', description: 'Temperature in celsius' },
    conditions: { type: 'string', description: 'Weather conditions description' },
  },
  required: ['temperature', 'conditions'],
  $schema: DRAFT_07,
  additionalProperties: false,
};

/**
 * Valid JSON Schema that Ajv's strict mode refuses: a union type and an
 * open tuple, as zod (`z.union`, `z.tuple`) writes them.
 */
const looseInput: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: ['string', 'number'] },
    point: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] },
  },
  required: ['id'],
  $schema: DRAFT_07,
};

const ctx: ToolContext = {
  tenantId: '00000000-0000-0000-0000-000000000001' as TenantId,
  abortSignal: new AbortController().signal,
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 'acme.weather' as ToolId,
    description: 'The weather in a city',
    version: '1.0.0',
    input: weatherInput,
    output: weatherOutput,
    transport: 'mcp',
    handler: async () => ({ temperature: 21, conditions: 'Sunny' }),
    ...over,
  };
}

function defined(over: Partial<Tool> = {}): Tool {
  const r = defineTool(tool(over));
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

describe('an MCP tool with draft-07 schemas', () => {
  test('defines, and its manifest validates', () => {
    expect(defineTool(tool()).kind).toBe('ok');
    const { handler: _handler, ...manifest } = tool();
    expect(validateToolManifest(manifest).kind).toBe('ok');
  });

  test('input is validated against its schema', async () => {
    const weather = defined();
    expect(await invokeTool(weather, { location: 'Chicago' }, ctx)).toEqual({
      kind: 'ok',
      value: { temperature: 21, conditions: 'Sunny' },
    });
    const bad = await invokeTool(weather, { location: 'Atlantis' }, ctx);
    expect(bad.kind === 'err' && bad.error.code).toBe('input-validation-failed');
  });

  test('output is validated against its schema', async () => {
    const weather = defined({
      handler: async () => ({ temperature: 'warm', conditions: 'Sunny' }),
    });
    const r = await invokeTool(weather, { location: 'Chicago' }, ctx);
    expect(r.kind === 'err' && r.error.code).toBe('output-validation-failed');
  });

  test('a draft-07 tuple is a tuple', async () => {
    const plot = defined({
      input: looseInput,
      output: { type: 'object', additionalProperties: true },
      handler: async () => ({}),
    });
    expect((await invokeTool(plot, { id: 7, point: [1, 2] }, ctx)).kind).toBe('ok');
    const bad = await invokeTool(plot, { id: 'p', point: [1, 'two'] }, ctx);
    expect(bad.kind === 'err' && bad.error.code).toBe('input-validation-failed');
  });
});

describe('a pack’s own tools are Draft 2020-12, in strict mode', () => {
  /** `tool(over)` as a pack defines it: no transport, or `native`. */
  function packTools(over: Partial<Tool>): ReadonlyArray<readonly [string, Tool]> {
    const { transport: _mcp, ...packTool } = tool(over);
    return [
      ['no transport', packTool],
      ['native', { ...packTool, transport: 'native' }],
    ];
  }

  test('an MCP server’s draft-07 schema is refused on one, naming 2020-12', () => {
    for (const [label, candidate] of packTools({})) {
      const r = defineTool(candidate);
      expect(r.kind === 'err' && r.error.code, label).toBe('invalid-schema');
      if (r.kind === 'err') {
        expect(r.error.message).toMatch(
          /draft-07\/schema#" isn't a JSON Schema dialect Kindgi validates here: 2020-12\./,
        );
      }
    }
  });

  test('a loosely written 2020-12 schema is refused by strict mode', () => {
    const { $schema: _draft07, ...loose2020 } = looseInput;
    const prefixed = {
      ...loose2020,
      properties: {
        id: { type: ['string', 'number'] },
        point: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] },
      },
    };
    for (const [label, candidate] of packTools({ input: prefixed })) {
      const r = defineTool(candidate);
      expect(r.kind === 'err' && r.error.code, label).toBe('invalid-schema');
      if (r.kind === 'err') expect(r.error.message).toMatch(/strict mode/);
    }
  });

  test('the same loose schema is accepted from an MCP server', () => {
    expect(defineTool(tool({ input: looseInput })).kind).toBe('ok');
    const { handler: _handler, ...manifest } = tool({ input: looseInput });
    expect(validateToolManifest(manifest).kind).toBe('ok');
  });
});

describe('a dialect Kindgi does not validate', () => {
  test('is refused on an MCP tool as an invalid schema, naming it', () => {
    const r = defineTool(
      tool({ input: { ...weatherInput, $schema: 'http://json-schema.org/draft-04/schema#' } }),
    );
    expect(r.kind === 'err' && r.error.code).toBe('invalid-schema');
    if (r.kind === 'err') {
      expect(r.error.message).toMatch(
        /draft-04\/schema#" isn't a JSON Schema dialect Kindgi validates: draft-06, draft-07, 2019-09 or 2020-12\./,
      );
    }
  });
});
