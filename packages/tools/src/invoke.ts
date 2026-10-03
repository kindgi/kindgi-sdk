// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { parseWithSchema } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

import type {
  HandlerError,
  InputValidationError,
  OutputValidationError,
  PreconditionFailedError,
  ToolError,
} from './errors.js';
import { isToolPreconditionError } from './precondition.js';
import type { JsonSchema, Tool, ToolContext } from './types.js';

type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>, opts?: unknown) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

/**
 * Cache compiled validators keyed by the schema *object reference*. Tools
 * are defined once and reused, so schema identity is stable — the WeakMap
 * releases entries when the tool is dropped.
 */
const inputCache: WeakMap<JsonSchema, ValidateFunction> = new WeakMap();
const outputCache: WeakMap<JsonSchema, ValidateFunction> = new WeakMap();

/**
 * A compiled validator. Input validators fill in each property's JSON
 * Schema `default` (`useDefaults`) — the data they check is a copy of the
 * caller's.
 */
function compile(schema: JsonSchema, side: 'input' | 'output'): ValidateFunction {
  const cache = side === 'input' ? inputCache : outputCache;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
    ...(side === 'input' && { useDefaults: true }),
  });
  addFormats(ajv);
  const validator = ajv.compile(schema as object);
  cache.set(schema, validator);
  return validator;
}

/**
 * The input a handler receives: validated against `tool.input` with its
 * defaults filled in, then — for a Zod-authored tool — parsed by its Zod
 * schema, so defaults, transforms and refinements apply and the handler
 * gets what its `z.infer` type says.
 */
async function prepareInput(
  tool: Pick<Tool, 'id' | 'input' | 'inputZod'>,
  input: unknown,
): Promise<Result<unknown, InputValidationError>> {
  const candidate = structuredClone(input);
  const validator = compile(tool.input, 'input');
  if (!validator(candidate)) {
    return { kind: 'err', error: inputError(tool.id, validator.errors ?? []) };
  }
  if (tool.inputZod === undefined) return { kind: 'ok', value: candidate };
  const parsed = await parseWithSchema(tool.inputZod, candidate);
  if (parsed.kind === 'ok') return parsed;
  return {
    kind: 'err',
    error: inputError(
      tool.id,
      parsed.issues.map((i) => ({
        instancePath: (i.path ?? []).map((p) => `/${String(p)}`).join(''),
        message: i.message,
      })),
    ),
  };
}

function inputError(toolId: Tool['id'], errors: readonly unknown[]): InputValidationError {
  return {
    code: 'input-validation-failed',
    message: `Input for tool "${toolId}" failed validation`,
    toolId,
    errors,
  };
}

export interface InvokeToolOptions {
  /**
   * Skip validation of the handler's return value against `tool.output`.
   * Trade-off: faster, but a broken handler can produce data that violates
   * the declared contract without the runtime noticing. Default: false.
   */
  readonly skipOutputValidation?: boolean;
}

/**
 * Invoke a tool with a caller-supplied input and context. The path is:
 *   1. Validate a copy of `input` against `tool.input`, filling in its
 *      defaults, and — for a Zod-authored tool — parse it with
 *      `tool.inputZod` (defaults, transforms, refinements). Reject on
 *      failure.
 *   2. Call `tool.handler(prepared, ctx)`. Catch any throw and return
 *      `handler-error` — invocation is total, throws don't escape.
 *   3. Validate the return value against `tool.output` schema (unless the
 *      caller opts out).
 *
 * Validation cost is amortised via a schema-object-keyed cache — the second
 * invocation of the same tool reuses the compiled Ajv validator.
 */
export async function invokeTool<TInput = unknown, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  ctx: ToolContext,
  options: InvokeToolOptions = {},
): Promise<Result<TOutput, ToolError>> {
  const prepared = await prepareInput(tool, input);
  if (prepared.kind === 'err') return prepared;

  let output: TOutput;
  try {
    output = await tool.handler(prepared.value as TInput, ctx);
  } catch (cause) {
    if (isToolPreconditionError(cause)) {
      const refused: PreconditionFailedError = {
        code: 'precondition-failed',
        message: `Tool "${tool.id}" was not run: ${cause.reason}: ${cause.message}`,
        toolId: tool.id,
        reason: cause.reason,
        cause,
      };
      return { kind: 'err', error: refused };
    }
    const err: HandlerError = {
      code: 'handler-error',
      message: `Tool "${tool.id}" handler threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      toolId: tool.id,
      cause,
    };
    return { kind: 'err', error: err };
  }

  if (!options.skipOutputValidation) {
    const outputValidator = compile(tool.output, 'output');
    if (!outputValidator(output)) {
      const err: OutputValidationError = {
        code: 'output-validation-failed',
        message: `Tool "${tool.id}" handler produced output that failed validation`,
        toolId: tool.id,
        errors: outputValidator.errors ?? [],
      };
      return { kind: 'err', error: err };
    }
  }

  return { kind: 'ok', value: output };
}
