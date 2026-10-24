// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that declares `pauses` gets the call's wait token, and its
 * handler may answer `ctx.pause()`: the run waits for another system's
 * answer (pack protocol 2.8.0).
 */

import { describe, expect, test } from 'vitest';

import type {
  HandlerContext,
  HandlerModule,
  HandlerOutcome,
  PauseOptions,
  ToolInvocationSpec,
} from '../src/handler-runner.js';
import { runHandler, runHandlerOrPause } from '../src/handler-runner.js';
import { MAX_PAUSE_TIMEOUT_MS, parsePackResponse } from '../src/protocol.js';

const waitToken = { id: 'wt-1', url: 'https://kindgi.example/v1/wait-tokens/wt-1/answer?sig=s' };

const tool = (overrides: Partial<ToolInvocationSpec> = {}): ToolInvocationSpec => ({
  id: 'acme.carrier.book-pickup',
  modulePath: '/fake/book-pickup.js',
  inputSchema: { type: 'object' },
  outputSchema: {
    type: 'object',
    properties: { confirmedAt: { type: 'string' } },
    required: ['confirmedAt'],
  },
  pauses: true,
  ...overrides,
});

/** The context from a runtime that sends no wait token (before pack protocol 2.8.0). */
const noToken: HandlerContext = { tenantId: 'tenant-1', runId: 'run-1' };
const ctx = (): HandlerContext => ({ ...noToken, waitToken });

type PausingContext = HandlerContext & {
  readonly waitToken: { readonly id: string; readonly url: string };
  readonly pause: (options?: PauseOptions) => unknown;
};

const run = (
  handler: (input: unknown, ctx: PausingContext) => unknown,
  spec: Partial<ToolInvocationSpec> = {},
  context: HandlerContext = ctx(),
): Promise<HandlerOutcome> =>
  runHandlerOrPause({
    tool: tool(spec),
    input: {},
    ctx: context,
    importHandler: async (): Promise<HandlerModule> => handler as HandlerModule,
  });

describe('a tool that pauses', () => {
  test('gets the wait token and answers with a pause', async () => {
    const seen: unknown[] = [];
    const outcome = await run((_input, c) => {
      seen.push(c.waitToken, Object.isFrozen(c.waitToken));
      return c.pause({ timeoutMs: 7_200_000, name: "the carrier's pickup confirmation" });
    });
    expect(seen).toEqual([waitToken, true]);
    expect(outcome).toEqual({
      kind: 'pause',
      pause: { timeoutMs: 7_200_000, name: "the carrier's pickup confirmation" },
    });
  });

  test('pauses with no options, or answers at once', async () => {
    expect(await run((_input, c) => c.pause())).toEqual({ kind: 'pause', pause: {} });
    expect(await run(() => ({ confirmedAt: '2026-10-21T15:00:00Z' }))).toEqual({
      kind: 'ok',
      value: { confirmedAt: '2026-10-21T15:00:00Z' },
    });
  });

  test("keeps the caller's context, its hidden properties too, and doesn't change it", async () => {
    const caller = ctx();
    Object.defineProperty(caller, 'secrets', { value: { API_KEY: 'k' }, enumerable: false });
    const outcome = await run(
      (_input, c) => ({ confirmedAt: String(c.secrets?.API_KEY) }),
      {},
      caller,
    );
    expect(outcome).toEqual({ kind: 'ok', value: { confirmedAt: 'k' } });
    expect(caller).not.toHaveProperty('pause');
  });

  test('from a runtime that sent no wait token: pause-not-available, before anything is handed on', async () => {
    const handedOn: string[] = [];
    const reading = await run(
      (_input, c) => {
        handedOn.push(c.waitToken.url);
        return c.pause();
      },
      {},
      noToken,
    );
    expect(handedOn).toEqual([]);
    expect(reading).toMatchObject({
      kind: 'err',
      error: { code: 'pause-not-available', toolId: 'acme.carrier.book-pickup' },
    });
    expect(reading.kind === 'err' && reading.error.message).toContain('pack protocol 2.8.0');
    const pausing = await run((_input, c) => c.pause(), {}, noToken);
    expect(pausing).toMatchObject({ kind: 'err', error: { code: 'pause-not-available' } });
  });

  test('a pause made without ctx.pause, on a call with no wait token, is pause-not-available', async () => {
    const forged = Object.freeze({ [Symbol.for('kindgi.pack.pause-answer')]: true });
    const outcome = await run(() => forged, {}, noToken);
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'pause-not-available', toolId: 'acme.carrier.book-pickup' },
    });
    expect(outcome.kind === 'err' && outcome.error.message).toContain('pack protocol 2.8.0');
  });

  test('a name is counted in code points, as the schema and a Python pack count it', async () => {
    const name = '\u{1F4E6}'.repeat(200);
    expect(await run((_input, c) => c.pause({ name }))).toEqual({ kind: 'pause', pause: { name } });
    expect(await run((_input, c) => c.pause({ name: `${name}x` }))).toMatchObject({
      kind: 'err',
      error: { code: 'handler-shape-invalid' },
    });
  });

  test.each([
    ['no time', { timeoutMs: 0 }],
    ['more than 24 days', { timeoutMs: MAX_PAUSE_TIMEOUT_MS + 1 }],
    ['part of a millisecond', { timeoutMs: 1.5 }],
    ['an empty name', { name: '' }],
    ['a name over 200 characters', { name: 'x'.repeat(201) }],
  ])('a pause for %s is handler-shape-invalid', async (_label, options) => {
    const outcome = await run((_input, c) => c.pause(options));
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'handler-shape-invalid' } });
  });

  test('runHandler, whose caller can only take a result, refuses the pause', async () => {
    const outcome = await runHandler({
      tool: tool(),
      input: {},
      ctx: ctx(),
      importHandler: async (): Promise<HandlerModule> =>
        ((_input: unknown, c: PausingContext) => c.pause()) as HandlerModule,
    });
    expect(outcome).toMatchObject({ kind: 'err', error: { code: 'pause-not-available' } });
  });
});

describe("a tool that doesn't declare pauses", () => {
  test('gets neither the token nor pause, even when the call carries one', async () => {
    const outcome = await run(
      (_input, c) => ({ confirmedAt: `${'waitToken' in c}/${'pause' in c}` }),
      { pauses: false },
    );
    expect(outcome).toEqual({ kind: 'ok', value: { confirmedAt: 'false/false' } });
  });

  test('answering with a pause is pause-not-available', async () => {
    const forged = Object.freeze({ [Symbol.for('kindgi.pack.pause-answer')]: true });
    const outcome = await run(() => forged, { pauses: false });
    expect(outcome).toMatchObject({
      kind: 'err',
      error: { code: 'pause-not-available', toolId: 'acme.carrier.book-pickup' },
    });
  });
});

describe('the pause response', () => {
  test('parses within the limits the protocol states', () => {
    expect(parsePackResponse({ v: 2, kind: 'pause' }).kind).toBe('ok');
    expect(
      parsePackResponse({ v: 2, kind: 'pause', timeoutMs: MAX_PAUSE_TIMEOUT_MS, name: 'x' }).kind,
    ).toBe('ok');
    for (const bad of [
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { name: '' },
      { name: 'x'.repeat(201) },
    ]) {
      expect(parsePackResponse({ v: 2, kind: 'pause', ...bad }).kind).toBe('err');
    }
  });

  test("counts the name in code points: 200 emoji is 200 characters, as the schema's maxLength says", () => {
    const name = '\u{1F4E6}'.repeat(200);
    expect(parsePackResponse({ v: 2, kind: 'pause', name }).kind).toBe('ok');
    expect(parsePackResponse({ v: 2, kind: 'pause', name: `${name}x` }).kind).toBe('err');
  });
});
