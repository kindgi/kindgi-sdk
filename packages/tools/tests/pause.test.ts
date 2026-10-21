// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool call that waits for another system's answer: what a pausing
 * tool declares, and what a caller of `invokeTool` / `invokeToolOrPause`
 * gets when the call waits.
 */

import { describe, expect, expectTypeOf, test } from 'vitest';
import * as z from 'zod';

import type { TenantId, ToolId } from '@kindgi/types';

import {
  DEFAULT_PAUSE_TIMEOUT_MS,
  MAX_PAUSE_TIMEOUT_MS,
  ToolRerunsExhaustedError,
  defineTool,
  invokeTool,
  invokeToolOrPause,
  isToolRerunsExhaustedError,
  pauseOf,
  pauseOutcome,
} from '../src/index.js';
import type { PauseContext, Tool, ToolContext, ToolPauseAnswer } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

function ctx(): ToolContext {
  return { tenantId: TENANT, abortSignal: new AbortController().signal };
}

const Pickup = z.object({ orderId: z.string() });
const Confirmed = z.object({ confirmedAt: z.string() });

/** A tool as a runtime wraps a pack's pausing tool: its handler answers what the pack did. */
function wrapped(answer: () => unknown, pauses = true): Tool {
  const r = defineTool({
    id: 'acme.carrier.book-pickup' as ToolId,
    description: 'Books a pickup and waits for the carrier to confirm it.',
    version: '1.0.0',
    pauses,
    input: { type: 'object' },
    output: {
      type: 'object',
      properties: { confirmedAt: { type: 'string' } },
      required: ['confirmedAt'],
    },
    handler: async () => answer(),
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value as Tool;
}

describe('defineTool with pauses', () => {
  test("the handler gets the call's wait token and pause; the manifest says it pauses", () => {
    const r = defineTool({
      id: 'acme.carrier.book-pickup' as ToolId,
      description: 'Books a pickup and waits for the carrier to confirm it.',
      version: '1.0.0',
      input: Pickup,
      output: Confirmed,
      pauses: true,
      handler: async (input, c) => {
        expectTypeOf(input).toEqualTypeOf<{ orderId: string }>();
        expectTypeOf(c).toMatchTypeOf<ToolContext & PauseContext>();
        expectTypeOf(c.pause).returns.toEqualTypeOf<ToolPauseAnswer>();
        return c.pause({ timeoutMs: 7_200_000, name: "the carrier's pickup confirmation" });
      },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.pauses).toBe(true);
  });

  test("a tool the pack doesn't run can't pause", () => {
    const r = defineTool({
      id: 'acme.carrier.remote' as ToolId,
      description: 'A tool on an MCP server.',
      version: '1.0.0',
      input: Pickup,
      output: Confirmed,
      pauses: true,
      transport: 'mcp',
      handler: async (_input, c) => c.pause(),
    });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('invalid-tool-definition');
      expect(r.error.message).toContain("can't pause");
    }
  });
});

describe('a call that waits', () => {
  test('invokeToolOrPause gives the pause, as a plain copy', async () => {
    const pause = { tokenId: 'wt-1', timeoutMs: DEFAULT_PAUSE_TIMEOUT_MS, name: 'the pickup' };
    const outcome = await invokeToolOrPause(
      wrapped(() => pauseOutcome(pause)),
      {},
      ctx(),
    );
    expect(outcome).toEqual({ kind: 'pause', pause });
    if (outcome.kind === 'pause') {
      expect(Object.getOwnPropertySymbols(outcome.pause)).toEqual([]);
      expect(JSON.parse(JSON.stringify(outcome.pause))).toEqual(pause);
    }
  });

  test('an answer at once is the result, checked as usual', async () => {
    const tool = wrapped(() => ({ confirmedAt: '2026-10-21T15:00:00Z' }));
    expect(await invokeToolOrPause(tool, {}, ctx())).toEqual({
      kind: 'ok',
      value: { confirmedAt: '2026-10-21T15:00:00Z' },
    });
    const bad = await invokeToolOrPause(
      wrapped(() => ({})),
      {},
      ctx(),
    );
    expect(bad.kind === 'err' && bad.error.code).toBe('output-validation-failed');
  });

  test("invokeTool, whose caller can't wait, refuses the pause", async () => {
    const tool = wrapped(() => pauseOutcome({ tokenId: 'wt-1', timeoutMs: 60_000 }));
    const outcome = await invokeTool(tool, {}, ctx());
    expect(outcome).toMatchObject({
      kind: 'err',
      error: {
        code: 'tool-pause-unsupported',
        toolId: 'acme.carrier.book-pickup',
        tokenId: 'wt-1',
      },
    });
  });

  test.each([
    ['no token id', { tokenId: '', timeoutMs: 60_000 }],
    ['no time', { tokenId: 'wt-1', timeoutMs: 0 }],
    ['more than 24 days', { tokenId: 'wt-1', timeoutMs: MAX_PAUSE_TIMEOUT_MS + 1 }],
    ['part of a millisecond', { tokenId: 'wt-1', timeoutMs: 1.5 }],
  ])('a pause with %s is refused where it is made', (_label, pause) => {
    expect(() => pauseOutcome(pause)).toThrow(RangeError);
  });

  test("a pause from a tool that doesn't declare pauses is tool-pause-unsupported", async () => {
    const tool = wrapped(() => pauseOutcome({ tokenId: 'wt-1', timeoutMs: 60_000 }), false);
    expect(await invokeToolOrPause(tool, {}, ctx())).toMatchObject({
      kind: 'err',
      error: {
        code: 'tool-pause-unsupported',
        toolId: 'acme.carrier.book-pickup',
        tokenId: 'wt-1',
      },
    });
  });

  test('a pause made without pauseOutcome is checked as pauseOutcome checks it', async () => {
    const forged = (pause: unknown) =>
      Object.freeze({ [Symbol.for('kindgi.tool-pause')]: true, pause });
    for (const pause of [
      { tokenId: '', timeoutMs: 60_000 },
      { tokenId: 'wt-1', timeoutMs: 0 },
      null,
    ]) {
      expect(() => pauseOf(forged(pause))).toThrow(RangeError);
      const outcome = await invokeToolOrPause(
        wrapped(() => forged(pause)),
        {},
        ctx(),
      );
      expect(outcome).toMatchObject({ kind: 'err', error: { code: 'handler-error' } });
    }
    expect(pauseOf(forged({ tokenId: 'wt-1', timeoutMs: 60_000 }))).toEqual({
      tokenId: 'wt-1',
      timeoutMs: 60_000,
    });
  });

  test('a call that may not run again is wait-token-reruns-exhausted', async () => {
    const tool = wrapped(() => {
      throw new ToolRerunsExhaustedError('wt-1', 3);
    });
    const outcome = await invokeTool(tool, {}, ctx());
    expect(outcome).toMatchObject({
      kind: 'err',
      error: {
        code: 'wait-token-reruns-exhausted',
        toolId: 'acme.carrier.book-pickup',
        tokenId: 'wt-1',
        runs: 3,
      },
    });
  });

  test('the refusal is known from any copy of the package', () => {
    const fromAnotherCopy = { [Symbol.for('kindgi.tools.wait-token-reruns-exhausted')]: true };
    expect(isToolRerunsExhaustedError(fromAnotherCopy)).toBe(true);
    expect(isToolRerunsExhaustedError(new Error('x'))).toBe(false);
  });
});
