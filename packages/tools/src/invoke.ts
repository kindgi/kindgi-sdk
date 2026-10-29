// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ValidateFunction } from 'ajv';

import { describeCauses, scrubText } from '@kindgi/log';
import { holdJsonSchema, parseWithSchema } from '@kindgi/schema';
import type { CompileJsonSchemaOptions } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

import type {
  HandlerError,
  InputValidationError,
  OutputValidationError,
  PreconditionFailedError,
  ToolError,
  ToolPauseUnsupportedError,
  WaitTokenRerunsExhaustedError,
} from './errors.js';
import { type ToolPause, isToolRerunsExhaustedError, pauseOf } from './pause.js';
import { isToolPreconditionError } from './precondition.js';
import type { JsonSchema, Tool, ToolContext } from './types.js';

const PACK_SCHEMAS: CompileJsonSchemaOptions = { dialects: ['2020-12'] };
const MCP_SCHEMAS: CompileJsonSchemaOptions = { strict: false };

/**
 * How a tool's schemas compile. A pack's own tools: Draft 2020-12, in
 * Ajv's strict mode (an authoring lint). An MCP server's (`transport:
 * 'mcp'`): in the dialect the server declares, without strict mode — the
 * schema is valid JSON Schema without being written to that lint.
 */
export function schemaOptions(tool: Pick<Tool, 'transport'>): CompileJsonSchemaOptions {
  return tool.transport === 'mcp' ? MCP_SCHEMAS : PACK_SCHEMAS;
}

/**
 * Each schema's validator, held by schema object (a tool's are defined
 * once and reused) and by what it's compiled for. A holder keeps a JSON
 * schema's cache key, not its validator (`holdJsonSchema`), so the cache
 * is all that keeps the validator: once the cache drops it, the next call
 * compiles it again, a recompile the tenant's budget counts. A schema
 * JSON can't carry is held as compiled, not compiled on every call.
 */
const held = new WeakMap<object, Map<string, () => ValidateFunction>>();

/**
 * A compiled validator. Input validators fill in each property's JSON
 * Schema `default` (`useDefaults`) — the data they check is a copy of the
 * caller's.
 */
function compile(
  schema: JsonSchema,
  side: 'input' | 'output',
  tool: Pick<Tool, 'transport'>,
): ValidateFunction {
  let holders = held.get(schema);
  if (holders === undefined) {
    holders = new Map();
    held.set(schema, holders);
  }
  const purpose = `${side} ${tool.transport === 'mcp' ? 'mcp' : 'pack'}`;
  let validator = holders.get(purpose);
  if (validator === undefined) {
    validator = holdJsonSchema(schema as Readonly<Record<string, unknown>>, {
      ...schemaOptions(tool),
      ...(side === 'input' && { useDefaults: true }),
    });
    holders.set(purpose, validator);
  }
  return validator();
}

/**
 * Where `output` doesn't fit `tool.output`, checked as a call's output is
 * (the same validator, in the tool's dialect): one issue per finding, its
 * `path` a JSON pointer into the output; `undefined` when it fits. For an
 * answer that comes from outside the call, such as another system's answer
 * to a call that paused.
 */
export function toolOutputIssues(
  tool: Pick<Tool, 'output' | 'transport'>,
  output: unknown,
): readonly { readonly path: string; readonly message: string }[] | undefined {
  const validator = compile(tool.output, 'output', tool);
  if (validator(output)) return undefined;
  return (validator.errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? 'invalid',
  }));
}

/**
 * The input a handler receives: validated against `tool.input` with its
 * defaults filled in, then — for a Zod-authored tool — parsed by its Zod
 * schema, so defaults, transforms and refinements apply and the handler
 * gets what its `z.infer` type says.
 */
async function prepareInput(
  tool: Pick<Tool, 'id' | 'input' | 'inputZod' | 'transport'>,
  input: unknown,
): Promise<Result<unknown, InputValidationError>> {
  const candidate = structuredClone(input);
  const validator = compile(tool.input, 'input', tool);
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

/** What `invokeToolOrPause` answers: the tool's result, or that its call waits. */
export type ToolOutcome<TOutput> =
  | Result<TOutput, ToolError>
  | { readonly kind: 'pause'; readonly pause: ToolPause };

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
 * Each schema compiles once and is then taken from the schema cache (see
 * `held`): a later call compiles it again only once the cache has dropped it.
 */
export async function invokeTool<TInput = unknown, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  ctx: ToolContext,
  options: InvokeToolOptions = {},
): Promise<Result<TOutput, ToolError>> {
  const outcome = await invokeToolOrPause(tool, input, ctx, options);
  if (outcome.kind !== 'pause') return outcome;
  return {
    kind: 'err',
    error: {
      code: 'tool-pause-unsupported',
      message: `Tool "${tool.id}" waits for another system's answer, and this caller can't wait`,
      toolId: tool.id,
      tokenId: outcome.pause.tokenId,
    },
  };
}

/**
 * Invoke a tool whose caller can park on a wait token: as `invokeTool`,
 * plus a third outcome, `pause`, when the call waits for another system's
 * answer (a pausing pack tool, through the runtime's handler for it). The
 * caller waits on `pause.tokenId` for at most `pause.timeoutMs`; the
 * answer, already checked against the tool's output schema, is the
 * call's result. A pause's own value isn't checked against that schema.
 * A pause from a tool that doesn't declare `pauses` is
 * `tool-pause-unsupported`, and one out of bounds is `handler-error`.
 */
export async function invokeToolOrPause<TInput = unknown, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
  input: unknown,
  ctx: ToolContext,
  options: InvokeToolOptions = {},
): Promise<ToolOutcome<TOutput>> {
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
    if (isToolRerunsExhaustedError(cause)) {
      const exhausted: WaitTokenRerunsExhaustedError = {
        code: 'wait-token-reruns-exhausted',
        message: `Tool "${tool.id}" was not run: ${cause.message}`,
        toolId: tool.id,
        tokenId: cause.tokenId,
        runs: cause.runs,
      };
      return { kind: 'err', error: exhausted };
    }
    const err: HandlerError = {
      code: 'handler-error',
      message: `Tool "${tool.id}" handler threw: ${thrownText(cause)}`,
      toolId: tool.id,
      cause,
    };
    return { kind: 'err', error: err };
  }

  const paused = pausedCall(tool, output);
  if (paused !== undefined) return paused;

  if (!options.skipOutputValidation) {
    const outputValidator = compile(tool.output, 'output', tool);
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

/**
 * What a handler's throw says in its error's message: the error's own
 * message and then its causes (`; caused by …`), so `fetch failed` says
 * why; a value that isn't an error, `String(cause)`. It's masked with
 * `scrubText`'s full mask, since the message reaches the run's record, the
 * console and the model.
 */
function thrownText(cause: unknown): string {
  if (!(cause instanceof Error)) return scrubText(String(cause), { fullMask: true });
  return `${scrubText(String(cause.message), { fullMask: true })}${describeCauses(cause)}`;
}

/**
 * The call's pause, if the handler returned one: from a tool that
 * declares `pauses`, within the bounds `pauseOutcome` checks.
 */
function pausedCall(
  tool: Pick<Tool, 'id' | 'pauses'>,
  output: unknown,
): ToolOutcome<never> | undefined {
  let pause: ToolPause | undefined;
  try {
    pause = pauseOf(output);
  } catch (cause) {
    const err: HandlerError = {
      code: 'handler-error',
      message: `Tool "${tool.id}" paused out of bounds: ${thrownText(cause)}`,
      toolId: tool.id,
      cause,
    };
    return { kind: 'err', error: err };
  }
  if (pause === undefined) return undefined;
  if (tool.pauses !== true) {
    const err: ToolPauseUnsupportedError = {
      code: 'tool-pause-unsupported',
      message: `Tool "${tool.id}" answered with a pause, but doesn't declare \`pauses: true\``,
      toolId: tool.id,
      tokenId: pause.tokenId,
    };
    return { kind: 'err', error: err };
  }
  return { kind: 'pause', pause };
}
