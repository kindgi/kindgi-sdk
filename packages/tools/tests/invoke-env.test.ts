// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `invokeToolForTest` decides `needsSpec.env` as the runtime does for a pack tool; `invokeTool` itself decides none. */

import type { TenantId, ToolId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { defineTool, invokeTool, invokeToolForTest, toolContextForTest } from '../src/index.js';
import type { JsonSchema, Tool, ToolContext } from '../src/index.js';

/** A tool that declares `env` and answers with the `ctx.env` its handler saw, counting its calls. */
function envTool(env: Readonly<Record<string, JsonSchema>> | undefined, input?: JsonSchema) {
  const calls = { count: 0 };
  const spec = defineTool({
    id: 'acme.env' as ToolId,
    description: 'Answers with the env it was given.',
    version: '1.0.0',
    input: input ?? { type: 'object' },
    output: { type: 'object' },
    ...(env !== undefined && { needsSpec: { env } }),
    handler: async (_input: unknown, c: ToolContext) => {
      calls.count += 1;
      return { env: c.env ?? null };
    },
  });
  if (spec.kind === 'err') throw new Error(spec.error.message);
  return { tool: spec.value as Tool, calls };
}

const run = (tool: Tool, env?: Record<string, string>, input: unknown = {}) =>
  invokeToolForTest(tool, input, env === undefined ? {} : { env });

describe('invokeToolForTest: needsSpec.env, as the runtime decides it', () => {
  test("a name the context doesn't set takes its schema's default", async () => {
    const { tool } = envTool({ X: { type: 'string', default: 'd' } });
    expect(await run(tool)).toEqual({ kind: 'ok', value: { env: { X: 'd' } } });
  });

  test("the context's value wins over the default", async () => {
    const { tool } = envTool({ X: { type: 'string', default: 'd' } });
    expect(await run(tool, { X: 'given' })).toEqual({ kind: 'ok', value: { env: { X: 'given' } } });
  });

  test('a name with neither a value nor a default: precondition-failed, env-value-missing, the handler never runs', async () => {
    const { tool, calls } = envTool({
      ACME_ACCOUNT_ID: { type: 'string' },
      ORDERS_REGION: { type: 'string', default: 'eu' },
    });
    const result = await run(tool);
    expect(result).toMatchObject({
      kind: 'err',
      error: {
        code: 'precondition-failed',
        reason: 'env-value-missing',
        toolId: 'acme.env',
        message:
          'Tool "acme.env" was not run: env-value-missing: tool "acme.env" needs env value "ACME_ACCOUNT_ID": the context\'s `env` doesn\'t set it, and its schema has no default',
      },
    });
    expect(calls.count).toBe(0);
  });

  test('several missing: named together', async () => {
    const { tool } = envTool({ A: { type: 'string' }, B: { type: 'string' } });
    const result = await run(tool);
    expect(result.kind === 'err' && result.error.message).toContain(
      `needs env values "A", "B": the context's \`env\` doesn't set them, and their schemas have no default`,
    );
  });

  test("a value its schema refuses, the context's or a default: env-value-invalid, naming the value and the rule", async () => {
    const { tool, calls } = envTool({
      ORDERS_BASE_URL: { type: 'string', pattern: '^https://' },
      ORDERS_REGION: { type: 'string', enum: ['eu', 'us'], default: 'eu' },
    });
    const result = await run(tool, { ORDERS_BASE_URL: 'http://orders.example.com' });
    expect(result).toMatchObject({
      kind: 'err',
      error: {
        code: 'precondition-failed',
        reason: 'env-value-invalid',
        message:
          'Tool "acme.env" was not run: env-value-invalid: env value "ORDERS_BASE_URL" is "http://orders.example.com", which doesn\'t match the schema tool "acme.env" declares for it: must match pattern "^https://"',
      },
    });
    expect(calls.count).toBe(0);
    const badDefault = envTool({ R: { type: 'string', enum: ['us'], default: 'eu' } });
    const refused = await run(badDefault.tool);
    expect(
      refused.kind === 'err' &&
        refused.error.code === 'precondition-failed' &&
        refused.error.reason,
    ).toBe('env-value-invalid');
  });

  test('a missing value is refused before a bad one is checked, as the runtime orders them', async () => {
    const { tool } = envTool({ A: { type: 'string' }, B: { type: 'string', pattern: '^x' } });
    const result = await run(tool, { B: 'y' });
    expect(
      result.kind === 'err' && result.error.code === 'precondition-failed' && result.error.reason,
    ).toBe('env-value-missing');
  });

  test('the handler sees the declared names only, as from the runtime', async () => {
    const declared = envTool({ X: { type: 'string' } });
    expect(await run(declared.tool, { X: '1', UNDECLARED: '2' })).toEqual({
      kind: 'ok',
      value: { env: { X: '1' } },
    });
    const none = envTool(undefined);
    expect(await run(none.tool, { UNDECLARED: '2' })).toEqual({ kind: 'ok', value: { env: null } });
  });

  test('the input is checked first, as in a run: the env is decided as the handler is called', async () => {
    const { tool, calls } = envTool(
      { A: { type: 'string' } },
      { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    );
    const result = await run(tool, undefined, { n: 'not a number' });
    expect(result.kind === 'err' && result.error.code).toBe('input-validation-failed');
    expect(calls.count).toBe(0);
  });
});

describe('invokeTool decides no env: in a run, the tool resolves its own', () => {
  test("a tool shaped like the runtime's pack tool gets its env from its store through invokeTool", async () => {
    // As the runtime builds a pack tool: the manifest, and a handler that resolves the names the
    // context doesn't pin from the env store (here, a map). A live call comes with no `env`.
    const store: Record<string, string> = {
      WOO_STORE_URL: 'https://shop.acme.example',
      WOO_REFUND: 'true',
    };
    const spec = defineTool({
      id: 'acme.probe' as ToolId,
      description: 'Answers with the env its runtime handler resolved.',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
      needsSpec: {
        env: {
          WOO_STORE_URL: { type: 'string' },
          WOO_REFUND: { type: 'string', enum: ['true', 'false'], default: 'false' },
        },
      },
      handler: async () => ({}),
    });
    if (spec.kind === 'err') throw new Error(spec.error.message);
    const names = Object.keys(spec.value.needsSpec?.env ?? {});
    const runtimeTool: Tool = {
      ...(spec.value as Tool),
      handler: async (_input: unknown, c: ToolContext) => {
        const pinned = c.env ?? {};
        return { env: Object.fromEntries(names.map((n) => [n, pinned[n] ?? store[n]])) };
      },
    };
    expect(await invokeTool(runtimeTool, {}, toolContextForTest())).toEqual({
      kind: 'ok',
      value: { env: { WOO_STORE_URL: 'https://shop.acme.example', WOO_REFUND: 'true' } },
    });
  });

  test('the context reaches the handler as it was given, env and all', async () => {
    const { tool } = envTool({ X: { type: 'string', default: 'd' } });
    let seen: ToolContext | undefined;
    const spy = {
      ...tool,
      handler: async (_i: unknown, c: ToolContext) => {
        seen = c;
        return {};
      },
    };
    const c = toolContextForTest({ env: { UNDECLARED: '1' } });
    await invokeTool(spy, {}, c);
    expect(seen).toBe(c);
  });
});

describe('toolContextForTest', () => {
  test("tenant-test, run-test, a signal that hasn't fired; what you pass goes over them", () => {
    const c = toolContextForTest();
    expect([c.tenantId, c.runId, c.abortSignal.aborted]).toEqual([
      'tenant-test',
      'run-test',
      false,
    ]);
    const given = toolContextForTest({
      tenantId: 'acme' as TenantId,
      env: { X: '1' },
      secrets: { KEY: 'k' },
    });
    expect([given.tenantId, given.runId, given.env, given.secrets]).toEqual([
      'acme',
      'run-test',
      { X: '1' },
      { KEY: 'k' },
    ]);
    expect(toolContextForTest().abortSignal).not.toBe(c.abortSignal);
  });
});
