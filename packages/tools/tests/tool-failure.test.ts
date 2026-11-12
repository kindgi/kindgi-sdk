// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId, ToolId } from '@kindgi/types';

import { ToolFailure, defineTool, invokeTool, isToolFailure } from '../src/index.js';
import type { ToolContext } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

function ctx(): ToolContext {
  return { tenantId: TENANT, abortSignal: new AbortController().signal };
}

/** A tool whose handler runs `fail`, so each test throws its own. */
function failing(fail: () => never) {
  const spec = defineTool({
    id: 'acme.get-order' as ToolId,
    description: 'Look an order up',
    version: '1.0.0',
    input: { type: 'null' },
    output: { type: 'null' },
    handler: async () => fail(),
  });
  if (spec.kind === 'err') throw new Error(spec.error.message);
  return spec.value;
}

describe('ToolFailure', () => {
  test('keeps its code, its message as written and a JSON copy of its details', () => {
    const at = new Date('2026-11-06T12:00:00.000Z');
    const failure = new ToolFailure('order-not-found', 'No order Z-9', {
      details: { orderId: 'Z-9', at, left: undefined },
    });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe('ToolFailure');
    expect(failure.code).toBe('order-not-found');
    expect(failure.message).toBe('No order Z-9');
    expect(failure.details).toEqual({ orderId: 'Z-9', at: '2026-11-06T12:00:00.000Z' });
    expect(isToolFailure(failure)).toBe(true);
  });

  test('has no details of its own when it was given none', () => {
    const failure = new ToolFailure('order-not-found', 'No order Z-9');
    expect(Object.hasOwn(failure, 'details')).toBe(false);
  });

  test('is recognized by its brand, not instanceof, so another copy of the package agrees', () => {
    const fromAnotherCopy = Object.assign(new Error('No order Z-9'), {
      code: 'order-not-found',
      [Symbol.for('kindgi.tools.tool-failure')]: true,
    });
    expect(isToolFailure(fromAnotherCopy)).toBe(true);
    expect(isToolFailure(new Error('No order Z-9'))).toBe(false);
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure('order-not-found')).toBe(false);
  });

  test('cuts its message at 1,000 characters without splitting a pair', () => {
    expect(new ToolFailure('too-long', 'x'.repeat(1500)).message).toHaveLength(1000);
    // 999 single characters, then a character written as a surrogate pair.
    const cut = new ToolFailure('too-long', `${'x'.repeat(999)}😀😀`).message;
    expect(Array.from(cut)).toHaveLength(1000);
    expect(cut.endsWith('😀')).toBe(true);
  });

  test.each([
    ['Order-Not-Found', 'capitals'],
    ['9-orders', 'a digit first'],
    ['order_not_found', 'an underscore'],
    ['', 'nothing'],
    [`a${'b'.repeat(64)}`, '65 characters'],
  ])('refuses the code %j (%s)', (code) => {
    expect(() => new ToolFailure(code, 'No order Z-9')).toThrow(TypeError);
    expect(() => new ToolFailure(code, 'No order Z-9')).toThrow(/kebab case/);
  });

  test('takes a code of exactly 64 characters', () => {
    expect(new ToolFailure(`a${'b'.repeat(63)}`, 'No order Z-9').code).toHaveLength(64);
  });

  test.each([[''], ['   ']])('refuses the empty message %j', (message) => {
    expect(() => new ToolFailure('order-not-found', message)).toThrow(
      'ToolFailure "order-not-found" needs a message for a person',
    );
  });

  test.each([
    [['Z-9'], 'must be a JSON object'],
    [null, 'must be a JSON object'],
    ['Z-9', 'must be a JSON object'],
    [{ count: 1n }, "aren't JSON"],
  ])('refuses the details %s', (details, why) => {
    expect(
      () =>
        new ToolFailure('order-not-found', 'No order Z-9', {
          details: details as unknown as Record<string, unknown>,
        }),
    ).toThrow(why);
  });

  test.each([
    [new Date('2026-11-06T12:00:00Z'), 'must be a JSON object'],
    [{ toJSON: () => [1] }, 'must be a JSON object'],
    [{ toJSON: () => undefined }, "aren't JSON"],
  ])('checks the JSON copy of the details %s, not the value given', (details, why) => {
    expect(
      () =>
        new ToolFailure('order-not-found', 'No order Z-9', {
          details: details as unknown as Record<string, unknown>,
        }),
    ).toThrow(new TypeError(`ToolFailure "order-not-found"'s details ${why}`));
  });

  test('refuses details of more than 4 KiB as JSON, and takes 4 KiB exactly', () => {
    // {"note":"…"} is 11 bytes around the note.
    const at = (bytes: number) => ({ note: 'x'.repeat(bytes - 11) });
    expect(new ToolFailure('too-big', 'No order Z-9', { details: at(4096) }).details).toEqual(
      at(4096),
    );
    expect(() => new ToolFailure('too-big', 'No order Z-9', { details: at(4097) })).toThrow(
      'ToolFailure "too-big"\'s details take 4097 bytes as JSON, more than 4096',
    );
  });
});

describe('invokeTool — a ToolFailure', () => {
  test("is tool-failed, with the tool's code as reason and its words said once", async () => {
    const tool = failing(() => {
      throw new ToolFailure('order-not-found', 'No order Z-9', { details: { orderId: 'Z-9' } });
    });
    const r = await invokeTool(tool, null, ctx());
    expect(r.kind === 'err' && r.error).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      toolId: 'acme.get-order',
      reason: 'order-not-found',
      details: { orderId: 'Z-9' },
    });
  });

  test('has no details when the tool gave none', async () => {
    const tool = failing(() => {
      throw new ToolFailure('order-not-found', 'No order Z-9');
    });
    const r = await invokeTool(tool, null, ctx());
    expect(r.kind).toBe('err');
    expect(r.kind === 'err' && Object.hasOwn(r.error, 'details')).toBe(false);
  });

  test('masks its message and every string in its details, as a thrown message is', async () => {
    const token = 'kgi_bt_abcdefghijklmnopqrstuv';
    const tool = failing(() => {
      throw new ToolFailure('order-not-found', `No order for ${token}`, {
        details: { by: token, links: [`https://acme.example/o?token=${token}`], apiKey: 'k-1' },
      });
    });
    const r = await invokeTool(tool, null, ctx());
    expect(r.kind === 'err' && r.error).toMatchObject({
      message: 'No order for [redacted]',
      details: {
        by: '[redacted]',
        links: ['https://acme.example/o?token=[redacted]'],
        apiKey: '[redacted]',
      },
    });
  });

  test('keeps a `__proto__` key in its details as a key', async () => {
    const details = JSON.parse('{"__proto__":{"orderId":"Z-9"},"lines":2}') as Record<
      string,
      unknown
    >;
    const tool = failing(() => {
      throw new ToolFailure('order-not-found', 'No order Z-9', { details });
    });
    const r = await invokeTool(tool, null, ctx());
    const said = r.kind === 'err' ? (r.error as { details?: object }).details : undefined;
    expect(said !== undefined && Object.getPrototypeOf(said)).toBe(Object.prototype);
    expect(JSON.stringify(said)).toBe('{"__proto__":{"orderId":"Z-9"},"lines":2}');
  });

  test('a code the class refuses fails the call as a crash that says why', async () => {
    const tool = failing(() => {
      throw new ToolFailure('Order Not Found', 'No order Z-9');
    });
    const r = await invokeTool(tool, null, ctx());
    expect(r.kind === 'err' && r.error).toMatchObject({
      code: 'handler-error',
      message: expect.stringContaining("ToolFailure's code must be kebab case"),
    });
  });

  test("one with a field changed after it was made, or another copy's that didn't check, is a crash that says why", async () => {
    const changed = new ToolFailure('order-not-found', 'No order Z-9');
    Object.defineProperty(changed, 'code', { value: 'Order Not Found' });
    const forged = Object.assign(new Error(''), {
      [Symbol.for('kindgi.tools.tool-failure')]: true,
      code: 'order-not-found',
    });
    const errorOf = async (thrown: unknown) => {
      const r = await invokeTool(
        failing(() => {
          throw thrown;
        }),
        null,
        ctx(),
      );
      return r.kind === 'err' ? r.error : undefined;
    };
    expect(await errorOf(changed)).toMatchObject({
      code: 'handler-error',
      message: expect.stringContaining(
        'kebab case, a letter first, at most 64 characters: "Order Not Found"',
      ),
    });
    expect(await errorOf(forged)).toMatchObject({
      code: 'handler-error',
      message: expect.stringContaining(
        'ToolFailure "order-not-found" needs a message for a person',
      ),
    });
  });

  test("another copy's that did check is tool-failed, as this copy's is", async () => {
    const other = Object.assign(new Error('No order Z-9'), {
      [Symbol.for('kindgi.tools.tool-failure')]: true,
      code: 'order-not-found',
      details: { orderId: 'Z-9' },
    });
    const r = await invokeTool(
      failing(() => {
        throw other;
      }),
      null,
      ctx(),
    );
    expect(r.kind === 'err' && r.error).toStrictEqual({
      code: 'tool-failed',
      message: 'No order Z-9',
      toolId: 'acme.get-order',
      reason: 'order-not-found',
      details: { orderId: 'Z-9' },
    });
  });
});
