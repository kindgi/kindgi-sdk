// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that fails a call on purpose (`ToolFailure`), in the handler
 * runner: the call answers `tool-failed` with the tool's code, words and
 * details, and a check that throws one is a plain `handler-throw`.
 */

import { describe, expect, test } from 'vitest';

import { ToolFailure } from '@kindgi/tools';

import type { HandlerContext, HandlerModule, ToolInvocationSpec } from '../src/handler-runner.js';
import { runCheck, runHandler } from '../src/handler-runner.js';

const tool: ToolInvocationSpec = {
  id: 'acme.get-order',
  modulePath: '/fake/get-order.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
};

const SECRET = 'sk-acme-0123456789';

const ctx: HandlerContext = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  requestId: 'req-1',
  secrets: { API_KEY: SECRET },
};

const throwing = (fail: () => never) => async (): Promise<HandlerModule> => () => fail();

describe('runHandler — a ToolFailure', () => {
  test("answers tool-failed: the tool's code, its words as written, its details, and no cause", async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw new ToolFailure('order-not-found', 'No order Z-9', { details: { orderId: 'Z-9' } });
      }),
    });
    expect(outcome).toStrictEqual({
      kind: 'err',
      error: {
        code: 'tool-failed',
        message: 'No order Z-9',
        toolId: 'acme.get-order',
        reason: 'order-not-found',
        details: { orderId: 'Z-9' },
      },
    });
  });

  test('has no details when the tool gave none', async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw new ToolFailure('order-not-found', 'No order Z-9');
      }),
    });
    expect(outcome).toStrictEqual({
      kind: 'err',
      error: {
        code: 'tool-failed',
        message: 'No order Z-9',
        toolId: 'acme.get-order',
        reason: 'order-not-found',
      },
    });
  });

  test('leaves out a secret the call was sent, from its words and from its details', async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw new ToolFailure('key-refused', `The app refused ${SECRET}`, {
          details: { sent: SECRET, tried: [`key=${SECRET}`] },
        });
      }),
    });
    expect(outcome.kind).toBe('err');
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(outcome).toMatchObject({
      error: {
        code: 'tool-failed',
        message: 'The app refused [redacted]',
        details: { sent: '[redacted]', tried: ['key=[redacted]'] },
      },
    });
  });

  test('a ToolFailure the class refuses is a handler-throw that says why', async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw new ToolFailure('order-not-found', '');
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: {
        code: 'handler-throw',
        message: expect.stringContaining(
          'ToolFailure "order-not-found" needs a message for a person',
        ),
      },
    });
  });
});

describe("runHandler — another copy's ToolFailure, or one changed after it was made", () => {
  const brand = Symbol.for('kindgi.tools.tool-failure');

  test('is tool-failed when the class would take it', async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw Object.assign(new Error('No order Z-9'), {
          [brand]: true,
          code: 'order-not-found',
          details: { orderId: 'Z-9' },
        });
      }),
    });
    expect(outcome).toStrictEqual({
      kind: 'err',
      error: {
        code: 'tool-failed',
        message: 'No order Z-9',
        toolId: 'acme.get-order',
        reason: 'order-not-found',
        details: { orderId: 'Z-9' },
      },
    });
  });

  test("is a handler-throw that says why when the class wouldn't", async () => {
    const changed = new ToolFailure('order-not-found', 'No order Z-9');
    Object.defineProperty(changed, 'code', { value: 'Order Not Found' });
    const outcome = await runHandler({
      tool,
      input: {},
      ctx,
      importHandler: throwing(() => {
        throw changed;
      }),
    });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: {
        code: 'handler-throw',
        message: expect.stringContaining(
          'kebab case, a letter first, at most 64 characters: "Order Not Found"',
        ),
      },
    });
  });
});

describe('runCheck — a ToolFailure', () => {
  test('is a plain handler-throw: a check that fails on purpose returns its verdict', async () => {
    const outcome = await runCheck({
      check: { id: 'acme.cites', modulePath: '/fake/cites.js' },
      config: {},
      trace: {},
      importCheck: () => ({
        evaluate: () => {
          throw new ToolFailure('no-citation', 'The answer cites nothing');
        },
      }),
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'handler-throw' } });
  });
});
