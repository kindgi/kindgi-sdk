// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the handler runner: a tool call (`runHandler`) and a
 * guardrail check (`runCheck`), in process.
 */

import { describe, expect, test } from 'vitest';
import * as z from 'zod';

import type { HandlerContext, HandlerModule, ToolInvocationSpec } from '../src/handler-runner.js';
import { runCheck, runHandler } from '../src/handler-runner.js';

const tool = (overrides: Partial<ToolInvocationSpec> = {}): ToolInvocationSpec => ({
  id: 'test.echo',
  modulePath: '/fake/echo.js',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { echoed: { type: 'string' } },
    required: ['echoed'],
    additionalProperties: false,
  },
  ...overrides,
});

const ctx = (overrides: Partial<HandlerContext> = {}): HandlerContext => ({
  tenantId: 'tenant-1',
  runId: 'run-1',
  requestId: 'req-1',
  env: { KEY: 'value' },
  secrets: { API_KEY: 'redacted' },
  config: { model: 'fast' },
  ...overrides,
});

const wrap = (handler: HandlerModule) => async (): Promise<HandlerModule> => handler;

describe('runHandler — happy path', () => {
  test('validates input, invokes handler, validates output, returns Result.ok', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'hello' },
      ctx: ctx(),
      importHandler: wrap((input) => ({ echoed: (input as { message: string }).message })),
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value).toEqual({ echoed: 'hello' });
    }
  });

  test('a union of types in the schemas (type: [...], as Zod writes a union of scalars)', async () => {
    const scalar = {
      type: 'object',
      properties: { value: { type: ['string', 'number', 'boolean', 'null'] } },
      required: ['value'],
      additionalProperties: false,
    };
    const union = tool({ inputSchema: scalar, outputSchema: scalar });
    for (const value of ['a', 1, true, null]) {
      const outcome = await runHandler({
        tool: union,
        input: { value },
        ctx: ctx(),
        importHandler: wrap((input) => input),
      });
      expect(outcome, String(value)).toEqual({ kind: 'ok', value: { value } });
    }
    const bad = await runHandler({
      tool: union,
      input: { value: [1] },
      ctx: ctx(),
      importHandler: wrap((input) => input),
    });
    expect(bad.kind === 'err' && bad.error.code).toBe('input-validation-failed');
  });

  test('awaits a Promise-returning handler', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'async' },
      ctx: ctx(),
      importHandler: wrap(async (input) => ({ echoed: (input as { message: string }).message })),
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.value).toEqual({ echoed: 'async' });
    }
  });

  test('accepts default-export module shape', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'default' },
      ctx: ctx(),
      importHandler: wrap({
        default: (input) => ({ echoed: (input as { message: string }).message }),
      }),
    });
    expect(outcome.kind).toBe('ok');
  });

  test('accepts `run` export shape (compatible with the sandbox handler-base entrypoint)', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'run' },
      ctx: ctx(),
      importHandler: wrap({ run: (input) => ({ echoed: (input as { message: string }).message }) }),
    });
    expect(outcome.kind).toBe('ok');
  });

  test('accepts `handler` export shape', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'handler' },
      ctx: ctx(),
      importHandler: wrap({
        handler: (input) => ({ echoed: (input as { message: string }).message }),
      }),
    });
    expect(outcome.kind).toBe('ok');
  });

  test('ctx passthrough — handler receives byte-shape-identical ctx', async () => {
    let observed: HandlerContext | null = null;
    const inputCtx = ctx({
      env: { A: '1', B: '2' },
      secrets: { S: 'shh' },
      config: { c: true, d: 42 },
    });
    await runHandler({
      tool: tool(),
      input: { message: 'ctx' },
      ctx: inputCtx,
      importHandler: wrap((_input, receivedCtx) => {
        observed = receivedCtx;
        return { echoed: 'ok' };
      }),
    });
    expect(observed).toBe(inputCtx);
  });
});

describe('runHandler — validation failures', () => {
  test('input validation failure surfaces as input-validation-failed with issues', async () => {
    let invoked = false;
    const outcome = await runHandler({
      tool: tool(),
      input: { wrongField: 'nope' },
      ctx: ctx(),
      importHandler: wrap(() => {
        invoked = true;
        return { echoed: 'unreached' };
      }),
    });
    expect(invoked).toBe(false);
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('input-validation-failed');
      expect(outcome.error.toolId).toBe('test.echo');
      expect(Array.isArray(outcome.error.issues)).toBe(true);
      expect((outcome.error.issues ?? []).length).toBeGreaterThan(0);
    }
  });

  test('output validation failure surfaces as output-validation-failed with issues', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'hi' },
      ctx: ctx(),
      importHandler: wrap(() => ({ wrongShape: 42 }) as unknown),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('output-validation-failed');
      expect(Array.isArray(outcome.error.issues)).toBe(true);
    }
  });

  test('handler returning void when schema requires object fails output validation', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'void' },
      ctx: ctx(),
      importHandler: wrap(() => undefined),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('output-validation-failed');
    }
  });
});

describe('runHandler — handler failures', () => {
  test('handler that throws Error → handler-throw with serialized cause', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'boom' },
      ctx: ctx(),
      importHandler: wrap(() => {
        throw new Error('kaboom');
      }),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('handler-throw');
      expect(outcome.error.message).toContain('kaboom');
      const cause = outcome.error.cause as { message?: string } | undefined;
      expect(cause?.message).toBe('kaboom');
    }
  });

  test('handler that throws non-Error primitive → handler-throw with string cause', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'x' },
      ctx: ctx(),
      importHandler: wrap(() => {
        throw 'string-error';
      }),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('handler-throw');
      expect(outcome.error.cause).toBe('string-error');
    }
  });

  test('importHandler that throws → handler-import-failed', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'x' },
      ctx: ctx(),
      importHandler: () => {
        throw new Error('module not found');
      },
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('handler-import-failed');
      expect(outcome.error.message).toContain('module not found');
    }
  });

  test('module missing any callable export → handler-shape-invalid', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: { message: 'x' },
      ctx: ctx(),
      importHandler: wrap({ notAHandler: 42 } as unknown as HandlerModule),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error.code).toBe('handler-shape-invalid');
    }
  });
});

describe('runHandler — the input a handler receives', () => {
  const greetInput = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      greeting: { type: 'string', default: 'Kia ora' },
    },
    required: ['name'],
    additionalProperties: false,
  };
  const greetOutput = {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  };
  const greet = (input: unknown) => {
    const { name, greeting } = input as { name: string; greeting: string };
    return { message: `${greeting}, ${name}!` };
  };

  test("JSON Schema defaults are filled; the caller's input is untouched", async () => {
    const input = { name: 'Ada' };
    const outcome = await runHandler({
      tool: tool({ inputSchema: greetInput, outputSchema: greetOutput }),
      input,
      ctx: ctx(),
      importHandler: wrap(greet),
    });
    expect(outcome).toEqual({ kind: 'ok', value: { message: 'Kia ora, Ada!' } });
    expect(input).toEqual({ name: 'Ada' });
  });

  test("a defineTool export's Zod schema parses the input: transforms and refinements apply", async () => {
    const inputZod = z.object({
      name: z.string().transform((s) => s.trim()),
      greeting: z.string().default('Kia ora'),
      times: z
        .number()
        .refine((n) => n > 0, 'must be positive')
        .default(1),
    });
    // The shape `export default defineTool({...})` leaves in a module.
    const module_ = { default: { handler: greet, inputZod } } as unknown as HandlerModule;
    const spec = tool({
      inputSchema: {
        ...greetInput,
        properties: { ...greetInput.properties, times: { type: 'number', default: 1 } },
      },
      outputSchema: greetOutput,
    });
    expect(
      await runHandler({
        tool: spec,
        input: { name: ' Ada ' },
        ctx: ctx(),
        importHandler: wrap(module_),
      }),
    ).toEqual({ kind: 'ok', value: { message: 'Kia ora, Ada!' } });
    expect(
      await runHandler({
        tool: spec,
        input: { name: 'Ada', times: 0 },
        ctx: ctx(),
        importHandler: wrap(module_),
      }),
    ).toMatchObject({
      kind: 'err',
      error: {
        code: 'input-validation-failed',
        issues: [{ instancePath: '/times', message: 'must be positive' }],
      },
    });
  });
});

describe('runCheck', () => {
  const check = { id: 'test.cites', modulePath: '/fake/cites.js' };

  test("runs the module's evaluate with the config and trace", async () => {
    const seen: unknown[] = [];
    const outcome = await runCheck({
      check,
      config: { strict: true },
      trace: { output: 'hi' },
      importCheck: () => ({
        evaluate: (config: unknown, trace: unknown) => {
          seen.push(config, trace);
          return { passed: true };
        },
      }),
    });
    expect(outcome).toEqual({ kind: 'ok', value: { passed: true } });
    expect(seen).toEqual([{ strict: true }, { output: 'hi' }]);
  });

  test("the check's bindings carry the call's abort signal", async () => {
    const call = new AbortController();
    let bindings: unknown;
    await runCheck({
      check,
      config: {},
      trace: {},
      abortSignal: call.signal,
      importCheck: () => ({
        check: {
          evaluate: (_config: unknown, _trace: unknown, b: unknown) => {
            bindings = b;
            return { passed: true };
          },
        },
      }),
    });
    expect(bindings).toEqual({ abortSignal: call.signal });
  });

  test('a module without evaluate → check-shape-invalid', async () => {
    const outcome = await runCheck({
      check,
      config: {},
      trace: {},
      importCheck: () => ({ default: {} }) as never,
    });
    expect(outcome.kind === 'err' && outcome.error.code).toBe('check-shape-invalid');
  });

  describe("the guardrail's configSchema", () => {
    const withSchema = {
      ...check,
      configSchema: {
        type: 'object',
        properties: { minChars: { type: 'integer', minimum: 0, default: 1 } },
      },
    };

    test("a config that doesn't fit → input-validation-failed with the issues; the check isn't imported", async () => {
      const imported: string[] = [];
      const outcome = await runCheck({
        check: withSchema,
        config: { minChars: -1 },
        trace: {},
        importCheck: (path) => {
          imported.push(path);
          return { evaluate: () => ({ passed: true }) };
        },
      });
      expect(outcome).toMatchObject({
        kind: 'err',
        error: {
          code: 'input-validation-failed',
          message: 'Check "test.cites" config failed validation at /minChars: must be >= 0',
          toolId: 'test.cites',
          issues: [expect.objectContaining({ instancePath: '/minChars', keyword: 'minimum' })],
        },
      });
      expect(imported).toEqual([]);
    });

    test("a config that fits runs, as sent: the schema's defaults aren't filled in", async () => {
      const seen: unknown[] = [];
      const outcome = await runCheck({
        check: withSchema,
        config: {},
        trace: {},
        importCheck: () => ({
          evaluate: (config: unknown) => {
            seen.push(config);
            return { passed: true };
          },
        }),
      });
      expect(outcome).toEqual({ kind: 'ok', value: { passed: true } });
      expect(seen).toEqual([{}]);
    });

    test("a schema that doesn't compile → input-validation-failed, the check not run", async () => {
      let ran = false;
      const outcome = await runCheck({
        check: { ...check, configSchema: { type: 'no-such-type' } },
        config: {},
        trace: {},
        importCheck: () => ({
          evaluate: () => {
            ran = true;
            return { passed: true };
          },
        }),
      });
      expect(outcome.kind === 'err' && outcome.error.code).toBe('input-validation-failed');
      expect(outcome.kind === 'err' && outcome.error.message).toMatch(
        /^Check "test.cites" config schema failed to compile: /,
      );
      expect(ran).toBe(false);
    });
  });
});
