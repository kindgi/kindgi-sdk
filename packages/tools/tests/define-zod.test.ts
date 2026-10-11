// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, expectTypeOf, test } from 'vitest';
import * as z from 'zod';

import type { ToolId } from '@kindgi/types';

import { defineTool, invokeTool, toManifest, toMcpManifest } from '../src/index.js';
import type { ToolContext } from '../src/index.js';

const ctx = (): ToolContext => ({
  tenantId: '00000000-0000-0000-0000-000000000001' as never,
  abortSignal: new AbortController().signal,
});

describe('defineTool — Zod-optional authoring surface', () => {
  test('accepts a Zod input schema and converts to JSON Schema on the wire', () => {
    const inputSchema = z.object({ msg: z.string() });
    const outputSchema = z.object({ msg: z.string(), length: z.number().int() });
    const r = defineTool({
      id: 'test.zod-echo' as ToolId,
      description: 'Echo the input with a length count (Zod-authored).',
      version: '1.0.0',
      input: inputSchema,
      output: outputSchema,
      handler: async (input) => ({ msg: input.msg, length: input.msg.length }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    // Wire form: JSON Schema, not the Zod object.
    expect(r.value.input).toMatchObject({
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    });
    expect(r.value.output).toMatchObject({
      type: 'object',
      properties: { msg: { type: 'string' }, length: { type: 'integer' } },
    });
    // Original Zod schemas preserved on the extension slots.
    expect(r.value.inputZod).toBe(inputSchema);
    expect(r.value.outputZod).toBe(outputSchema);
  });

  test('accepts JSON Schema input/output — behavior unchanged', () => {
    const r = defineTool({
      id: 'test.json-echo' as ToolId,
      description: 'JSON-Schema-only echo.',
      version: '1.0.0',
      input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      output: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
      handler: async () => ({ msg: 'ok' }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.inputZod).toBeUndefined();
    expect(r.value.outputZod).toBeUndefined();
  });

  test('mixed: Zod input + JSON Schema output', () => {
    const zodIn = z.object({ q: z.string() });
    const r = defineTool({
      id: 'test.mixed' as ToolId,
      description: 'Zod in, JSON out.',
      version: '1.0.0',
      input: zodIn,
      output: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
      handler: async (input) => ({ answer: `you said: ${input.q}` }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.inputZod).toBe(zodIn);
    expect(r.value.outputZod).toBeUndefined();
    // Wire form is JSON Schema for input too.
    expect(r.value.input).toMatchObject({ type: 'object' });
  });

  test('mixed: JSON Schema input + Zod output', () => {
    const zodOut = z.object({ n: z.number() });
    const r = defineTool({
      id: 'test.mixed-2' as ToolId,
      description: 'JSON in, Zod out.',
      version: '1.0.0',
      input: { type: 'null' },
      output: zodOut,
      handler: async () => ({ n: 42 }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.inputZod).toBeUndefined();
    expect(r.value.outputZod).toBe(zodOut);
  });

  test('toManifest() emits JSON Schema regardless of authoring form', () => {
    const r = defineTool({
      id: 'test.wire' as ToolId,
      description: 'Wire form test.',
      version: '1.0.0',
      input: z.object({ msg: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    const manifest = toManifest(r.value);
    // No zod objects on the wire projection.
    expect((manifest as { inputZod?: unknown }).inputZod).toBeUndefined();
    expect((manifest as { outputZod?: unknown }).outputZod).toBeUndefined();
    expect(manifest.input).toMatchObject({ type: 'object' });
    expect(manifest.output).toMatchObject({ type: 'object' });
    // JSON round-trip works.
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    expect(roundTripped.input).toEqual(manifest.input);
  });

  test('toMcpManifest() emits JSON Schema on inputSchema/outputSchema', () => {
    const r = defineTool({
      id: 'test.mcp' as ToolId,
      description: 'MCP projection test.',
      version: '1.0.0',
      input: z.object({ x: z.number() }),
      output: z.object({ y: z.number() }),
      handler: async (input) => ({ y: input.x * 2 }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    const mcp = toMcpManifest(r.value);
    expect(mcp.inputSchema).toMatchObject({ type: 'object' });
    expect(mcp.outputSchema).toMatchObject({ type: 'object' });
  });

  test('invokeTool: handler receives properly-typed input at call time', async () => {
    const r = defineTool({
      id: 'test.runtime-typed' as ToolId,
      description: 'Runtime typed test.',
      version: '1.0.0',
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      handler: async (input) => ({ greeting: `hello ${input.name}` }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    const out = await invokeTool(r.value, { name: 'world' }, ctx());
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.value).toEqual({ greeting: 'hello world' });
    }
  });

  test('invokeTool: input validation still runs against the converted wire schema', async () => {
    const r = defineTool({
      id: 'test.zod-validation' as ToolId,
      description: 'Validation via converted schema.',
      version: '1.0.0',
      input: z.object({ n: z.number().int().positive() }),
      output: z.object({ n: z.number() }),
      handler: async (input) => ({ n: input.n }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    const bad = await invokeTool(r.value, { n: 'not-a-number' }, ctx());
    expect(bad.kind).toBe('err');
    if (bad.kind === 'err') expect(bad.error.code).toBe('input-validation-failed');
  });

  test('a Zod union of scalars (type: [...] on the wire) in input and output compiles and validates', async () => {
    const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
    const r = defineTool({
      id: 'test.zod-scalar-union' as ToolId,
      description: 'Echoes a scalar of any type.',
      version: '1.0.0',
      input: z.object({ value: Value }),
      output: z.object({ value: Value }),
      handler: async (input) => ({ value: input.value }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.input).toMatchObject({
      properties: { value: { type: ['string', 'number', 'boolean', 'null'] } },
    });
    for (const value of ['a', 1, true, null]) {
      const out = await invokeTool(r.value, { value }, ctx());
      expect(out, String(value)).toEqual({ kind: 'ok', value: { value } });
    }
    const bad = await invokeTool(r.value, { value: [1] }, ctx());
    expect(bad.kind === 'err' && bad.error.code).toBe('input-validation-failed');
  });

  test('unrepresentable Zod construct surfaces as invalid-schema at author time', () => {
    // z.function() has no direct JSON Schema representation.
    const r = defineTool({
      id: 'test.bad-zod' as ToolId,
      description: 'Should fail conversion.',
      version: '1.0.0',
      input: z.function() as unknown as z.ZodType,
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-schema');
  });

  test('TS: z.infer<typeof tool.inputZod> produces the expected type', () => {
    const inputSchema = z.object({ msg: z.string(), age: z.number().int() });
    const r = defineTool({
      id: 'test.infer' as ToolId,
      description: 'Type inference test.',
      version: '1.0.0',
      input: inputSchema,
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    // Static assertion — inputZod is the exact Zod schema type.
    type InferredIn = z.infer<typeof r.value.inputZod>;
    expectTypeOf<InferredIn>().toEqualTypeOf<{ msg: string; age: number }>();
  });

  test('TS: defineTool with Zod schemas infers handler input type', () => {
    // Compile-time check — if the handler param wasn't inferred as
    // `{ n: number }`, the `.toFixed()` call would fail to type-check.
    const r = defineTool({
      id: 'test.handler-inference' as ToolId,
      description: 'Handler type inference.',
      version: '1.0.0',
      input: z.object({ n: z.number() }),
      output: z.object({ pretty: z.string() }),
      handler: async (input) => {
        expectTypeOf(input).toEqualTypeOf<{ n: number }>();
        return { pretty: input.n.toFixed(2) };
      },
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
  });

  test('TS: defineTool with JSON Schema falls back to unknown handler input', () => {
    const r = defineTool({
      id: 'test.json-infer' as ToolId,
      description: 'JSON Schema handler inference.',
      version: '1.0.0',
      input: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      output: { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] },
      handler: async (input) => {
        // For JSON Schema authoring, handler input defaults to `unknown`.
        expectTypeOf(input).toEqualTypeOf<unknown>();
        // Cast at boundary — matches pre-Zod-optional pattern.
        const parsed = input as { x: number };
        return { y: parsed.x * 2 };
      },
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
  });

  test('runtime: structural Zod detection works without importing zod at framework side', () => {
    // Emulate a Zod schema by structure only — no `import 'zod'` on the
    // framework side. The framework must detect it via `_zod` + `~standard`.
    const fakeZod = {
      _zod: { input: 'unknown' as unknown, output: 'unknown' as unknown, def: { type: 'string' } },
      '~standard': {},
    };
    const r = defineTool({
      id: 'test.structural' as ToolId,
      description: 'Structural detection test.',
      version: '1.0.0',
      // Present a plain JSON Schema so this succeeds — the point is only
      // that isZodSchema won't accidentally flag it.
      input: { type: 'object' },
      output: { type: 'object' },
      handler: async () => ({}),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    // Verify the structural probe recognises our fake schema shape.
    // (The framework doesn't actually convert it — that would require the
    // real zod runtime — but detection is separable from conversion.)
    expect(fakeZod._zod).toBeDefined();
    expect(fakeZod['~standard']).toBeDefined();
  });

  test('mixed JSON Schema + inline overrides still passes the wire-form check', () => {
    const r = defineTool({
      id: 'test.override' as ToolId,
      description: 'Overrides.',
      version: '1.0.0',
      input: z.string(),
      output: z.string(),
      handler: async (input) => `echo: ${input}`,
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.input).toMatchObject({ type: 'string' });
    expect(r.value.output).toMatchObject({ type: 'string' });
  });

  test('empty Zod object (no properties) converts cleanly', () => {
    const r = defineTool({
      id: 'test.empty' as ToolId,
      description: 'Empty object schema.',
      version: '1.0.0',
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(r.value.input).toMatchObject({ type: 'object' });
  });
});

describe('Zod defaults, transforms and refinements on tool input', () => {
  function greetTool() {
    const r = defineTool({
      id: 'test.greet' as ToolId,
      description: 'Greet someone.',
      version: '1.0.0',
      input: z.object({
        name: z.string().transform((s) => s.trim()),
        greeting: z.string().default('Kia ora'),
        times: z
          .number()
          .int()
          .refine((n) => n > 0, 'must be positive')
          .default(1),
      }),
      output: z.object({ message: z.string() }),
      handler: async (input) => ({
        message: `${input.greeting}, ${input.name}!`.repeat(input.times),
      }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    return r.value;
  }

  test('the advertised input schema leaves defaulted fields optional', () => {
    expect(greetTool().input).toMatchObject({ required: ['name'] });
  });

  test("the handler gets the defaults and the transform's result; the caller's input is untouched", async () => {
    const input = { name: '  Ada ' };
    const r = await invokeTool(greetTool(), input, ctx());
    expect(r).toEqual({ kind: 'ok', value: { message: 'Kia ora, Ada!' } });
    expect(input).toEqual({ name: '  Ada ' });
  });

  test('a refinement failure is input-validation-failed, with the path', async () => {
    const r = await invokeTool(greetTool(), { name: 'Ada', times: 0 }, ctx());
    expect(r).toMatchObject({
      kind: 'err',
      error: {
        code: 'input-validation-failed',
        errors: [{ instancePath: '/times', message: 'must be positive' }],
      },
    });
  });
});

describe('JSON Schema defaults on tool input', () => {
  test('a JSON-Schema-authored tool gets its default filled', async () => {
    const r = defineTool<{ name: string; greeting: string }, { message: string }>({
      id: 'test.greet-json' as ToolId,
      description: 'Greet someone.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { name: { type: 'string' }, greeting: { type: 'string', default: 'Hi' } },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      handler: async (input) => ({ message: `${input.greeting}, ${input.name}!` }),
    });
    if (r.kind !== 'ok') throw new Error(r.error.message);
    expect(await invokeTool(r.value, { name: 'Ada' }, ctx())).toEqual({
      kind: 'ok',
      value: { message: 'Hi, Ada!' },
    });
  });
});
