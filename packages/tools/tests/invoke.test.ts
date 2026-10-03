// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId, ToolId } from '@kindgi/types';

import {
  ToolPreconditionError,
  defineTool,
  invokeTool,
  isToolPreconditionError,
} from '../src/index.js';
import type { Tool, ToolContext } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

function ctx(): ToolContext {
  return { tenantId: TENANT, abortSignal: new AbortController().signal };
}

function echo(): Tool<{ msg: string }, { msg: string; length: number }> {
  const spec = defineTool<{ msg: string }, { msg: string; length: number }>({
    id: 'test.echo' as ToolId,
    description: 'Echo the input with a length count',
    version: '1.0.0',
    input: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    output: {
      type: 'object',
      properties: { msg: { type: 'string' }, length: { type: 'integer', minimum: 0 } },
      required: ['msg', 'length'],
    },
    handler: async (input) => ({ msg: input.msg, length: input.msg.length }),
  });
  if (spec.kind === 'err') throw new Error(spec.error.message);
  return spec.value;
}

describe('invokeTool — happy path', () => {
  test('validates input, calls handler, validates output', async () => {
    const r = await invokeTool(echo(), { msg: 'hi' }, ctx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toEqual({ msg: 'hi', length: 2 });
  });
});

describe('invokeTool — input validation', () => {
  test('rejects wrong-typed field', async () => {
    const r = await invokeTool(echo(), { msg: 42 }, ctx());
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('input-validation-failed');
  });

  test('rejects missing required field', async () => {
    const r = await invokeTool(echo(), {}, ctx());
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('input-validation-failed');
  });

  test('rejects extraneous field when schema is closed', async () => {
    const closed = defineTool({
      id: 'test.closed' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      },
      output: { type: 'string' },
      handler: async () => 'ok',
    });
    if (closed.kind === 'err') throw new Error(closed.error.message);
    const r = await invokeTool(closed.value, { a: 'x', extra: 1 }, ctx());
    expect(r.kind).toBe('err');
  });
});

describe('invokeTool — output validation', () => {
  test('rejects handler returning wrong shape', async () => {
    const spec = defineTool<unknown, { n: number }>({
      id: 'test.wrong-output' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      // handler returns wrong type — no `n`, has `x`
      handler: async () => ({ x: 'not-an-int' }) as unknown as { n: number },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const r = await invokeTool(spec.value, null, ctx());
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('output-validation-failed');
  });

  test('skipOutputValidation returns whatever the handler produces', async () => {
    const spec = defineTool<unknown, { n: number }>({
      id: 'test.skip-out' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      handler: async () => ({ x: 'not-an-int' }) as unknown as { n: number },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const r = await invokeTool(spec.value, null, ctx(), { skipOutputValidation: true });
    expect(r.kind).toBe('ok');
  });
});

describe('invokeTool — handler errors', () => {
  test('handler throw becomes handler-error result, does not propagate', async () => {
    const spec = defineTool({
      id: 'test.boom' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'null' },
      handler: async () => {
        throw new Error('kaboom');
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const r = await invokeTool(spec.value, null, ctx());
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('handler-error');
      expect(r.error.message).toContain('kaboom');
    }
  });

  test("a runtime's refusal (ToolPreconditionError) is precondition-failed, not handler-error", async () => {
    const spec = defineTool({
      id: 'test.keyed' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'null' },
      handler: async () => {
        // What a runtime's handler wrapper throws before the tool's code runs.
        throw new ToolPreconditionError(
          'secret-unavailable',
          'needs secret "API_KEY" in env "local"',
        );
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const r = await invokeTool(spec.value, null, ctx());
    expect(r.kind === 'err' && r.error).toMatchObject({
      code: 'precondition-failed',
      reason: 'secret-unavailable',
      toolId: 'test.keyed',
      message:
        'Tool "test.keyed" was not run: secret-unavailable: needs secret "API_KEY" in env "local"',
    });
  });

  test('a precondition error from another copy of the package is recognized too', () => {
    const elsewhere = Object.assign(new Error('x'), {
      reason: 'env-not-configured',
      [Symbol.for('kindgi.tools.precondition-failed')]: true,
    });
    expect(isToolPreconditionError(elsewhere)).toBe(true);
    expect(isToolPreconditionError(new Error('x'))).toBe(false);
    expect(isToolPreconditionError(null)).toBe(false);
  });
});

describe('invokeTool — context threading', () => {
  test('handler receives the exact context object provided', async () => {
    let observed: ToolContext | undefined;
    const spec = defineTool({
      id: 'test.ctx' as ToolId,
      description: 'x',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'null' },
      handler: async (_input, c) => {
        observed = c;
        return null;
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const c = ctx();
    await invokeTool(spec.value, null, c);
    expect(observed).toBe(c);
  });

  test('a handler reads the secrets it declares from ctx.secrets, typed, without a cast', async () => {
    const spec = defineTool({
      id: 'test.keyed' as ToolId,
      description: 'Reports the tail of its API key.',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'object', properties: { tail: { type: 'string' } }, required: ['tail'] },
      needsSpec: { secrets: { API_KEY: { type: 'string' } } },
      handler: async (_input, c) => {
        const key: string | undefined = c.secrets?.API_KEY;
        return { tail: key?.slice(-3) ?? '' };
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const r = await invokeTool(spec.value, null, { ...ctx(), secrets: { API_KEY: 'key-123' } });
    expect(r).toEqual({ kind: 'ok', value: { tail: '123' } });
  });
});

describe('invokeTool — abortSignal cooperation', () => {
  test('handler observes abort mid-flight and returns early', async () => {
    const spec = defineTool({
      id: 'test.aborter' as ToolId,
      description: 'Loops until abortSignal.aborted; returns exit reason.',
      version: '1.0.0',
      input: { type: 'null' },
      output: {
        type: 'object',
        properties: {
          exitedVia: { type: 'string', enum: ['abort', 'completion'] },
          iterations: { type: 'integer', minimum: 0 },
        },
        required: ['exitedVia', 'iterations'],
      },
      handler: async (_input, c) => {
        let iterations = 0;
        while (!c.abortSignal.aborted && iterations < 1_000_000) {
          iterations += 1;
          // Yield to the event loop so the abort can propagate.
          if (iterations % 100 === 0) await new Promise((r) => setImmediate(r));
        }
        return {
          exitedVia: c.abortSignal.aborted ? 'abort' : 'completion',
          iterations,
        };
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);

    const controller = new AbortController();
    const context: ToolContext = { tenantId: TENANT, abortSignal: controller.signal };
    // Fire abort shortly after invocation.
    setTimeout(() => controller.abort(new Error('caller cancelled')), 20);

    const r = await invokeTool(spec.value, null, context);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.exitedVia).toBe('abort');
      // Loop is capped at 1M — if we actually hit that, the abort didn't work.
      expect(r.value.iterations).toBeLessThan(1_000_000);
    }
  });

  test('handler that ignores abortSignal completes normally (invokeTool does NOT force-cancel)', async () => {
    // Cooperative cancellation semantics: invokeTool doesn't preempt.
    // A handler that never checks the signal finishes as if abort didn't happen.
    const spec = defineTool({
      id: 'test.uncooperative' as ToolId,
      description: 'Ignores abortSignal; runs to completion.',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
      handler: async () => {
        // Tight loop that doesn't observe the signal.
        for (let i = 0; i < 10_000; i++) {
          Math.sqrt(i);
        }
        return { done: true };
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);

    const controller = new AbortController();
    controller.abort(new Error('preemptive'));
    const context: ToolContext = { tenantId: TENANT, abortSignal: controller.signal };

    const r = await invokeTool(spec.value, null, context);
    // Uncooperative handler completes even with pre-aborted signal.
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.done).toBe(true);
  });

  test('abort event fires once — listeners only invoked one time', async () => {
    let eventCount = 0;
    const spec = defineTool({
      id: 'test.event-counter' as ToolId,
      description: 'Attaches an abort listener; returns after abort fires.',
      version: '1.0.0',
      input: { type: 'null' },
      output: { type: 'object', properties: { events: { type: 'integer' } }, required: ['events'] },
      handler: async (_input, c) => {
        return new Promise((resolve) => {
          c.abortSignal.addEventListener('abort', () => {
            eventCount += 1;
            resolve({ events: eventCount });
          });
        });
      },
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);

    const controller = new AbortController();
    const context: ToolContext = { tenantId: TENANT, abortSignal: controller.signal };
    setTimeout(() => {
      controller.abort();
      // Second abort call is a no-op per spec.
      controller.abort();
    }, 10);

    const r = await invokeTool(spec.value, null, context);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect((r.value as { events: number }).events).toBe(1);
  });
});
