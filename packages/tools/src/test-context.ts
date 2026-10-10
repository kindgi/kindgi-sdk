// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

import type { ToolError } from './errors.js';
import { envForCall } from './invoke-env.js';
import { type InvokeToolOptions, invokeTool } from './invoke.js';
import type { Tool, ToolContext } from './types.js';

/**
 * A context for calling a tool in a unit test: tenant `tenant-test`, run `run-test`, a signal
 * that never fires, and whatever you pass over them (`env`, `secrets`, `projectId`, …). The
 * TypeScript counterpart of Python's `ToolContext.for_test`.
 */
export function toolContextForTest(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 'tenant-test' as TenantId,
    runId: 'run-test',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Call a tool in a unit test as a run would: `invokeTool`, with the tool's env values decided
 * the way the runtime decides them for a pack's tool. Each name it declares in `needsSpec.env`
 * takes the context's `env` value, else its schema's `default`; each is checked against its
 * schema; the handler's `ctx.env` holds the declared names only. A name with neither, or a value
 * its schema refuses, is `precondition-failed` (`env-value-missing`, then `env-value-invalid`)
 * and the handler doesn't run. As in a run, the input is checked first: the env is decided as
 * the handler is called. The context is `toolContextForTest(context)`.
 *
 * Test only: in a run, the runtime decides a pack tool's env itself, from its env store, and
 * calls `invokeTool`.
 *
 * ```ts
 * const result = await invokeToolForTest(findOrder, { orderId: 'ord_1001' }, {
 *   env: { ORDERS_BASE_URL: 'https://orders.example.com' },
 * });
 * ```
 */
export function invokeToolForTest<TInput = unknown, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  context: Partial<ToolContext> = {},
  options?: InvokeToolOptions,
): Promise<Result<TOutput, ToolError>> {
  const withEnv: Tool<TInput, TOutput> = {
    ...tool,
    handler: async (prepared, ctx) => {
      const env = envForCall(tool, ctx.env);
      if (env.kind === 'err') throw env.error;
      if (env.value === undefined && ctx.env === undefined) return tool.handler(prepared, ctx);
      const { env: _given, ...rest } = ctx;
      return tool.handler(prepared, env.value === undefined ? rest : { ...rest, env: env.value });
    },
  };
  return invokeTool(withEnv, input, toolContextForTest(context), options);
}
