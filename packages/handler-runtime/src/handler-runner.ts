// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The handler runner: runs one tool call or one guardrail check of a
 * pack, in this process. The pack service (`./pack-service`) runs every
 * call through it.
 *
 * A tool call:
 *   1. validates the input against the tool's JSON Schema (a copy, with
 *      each property's `default` filled in), then parses it with the
 *      module's Zod schema when it exports one (`defineTool`'s
 *      `inputZod`), so the handler gets what its type says;
 *   2. imports the module and resolves its handler (`default`,
 *      `handler` or `run`, or a `defineTool` export holding one);
 *   3. calls `handler(input, ctx)`;
 *   4. validates the output against the tool's output JSON Schema.
 *
 * A check imports the module, resolves its `evaluate`, and calls
 * `evaluate(config, trace, bindings)`.
 *
 * Neither throws: every failure is a typed `HandlerError`. The runner
 * is not a sandbox; the pack service's process is the boundary, and
 * pack code is the team's own (trusted).
 */

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { Logger } from '@kindgi/log';
import { type ZodLikeSchema, isZodSchema, parseWithSchema } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

/**
 * What a handler gets beside its input: the tenant and run it serves,
 * and the "typed needs" it declares (`needsSpec.env`, `needsSpec.secrets`),
 * resolved by the runtime for this call and sent with it. `config` is
 * reserved: no runtime sends it yet.
 */
export interface HandlerContext {
  readonly tenantId: string;
  readonly runId: string;
  /** The run's project (protocol 2.3.0); absent from an older runtime. */
  readonly projectId?: string;
  /** The project's org, when it has one (2.3.0). */
  readonly orgId?: string;
  readonly requestId?: string;
  /** The declared env values: project, else org, else tenant (protocol 2.5.0). */
  readonly env?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, unknown>>;
  readonly config?: Readonly<Record<string, unknown>>;
  /**
   * The calling agent version's settings blocks' values, by block id
   * (protocol 2.4.0): `ctx.settings['acme.weights'].recency`. Absent when
   * it pins none, and from an older runtime.
   */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Never on the wire; the pack service adds it: aborted when the call
   * is cancelled or passes its deadline. Handlers that do slow I/O
   * should pass it on so they stop promptly.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Never on the wire; the pack service adds it: a logger bound to the
   * call (its tenant, run, request and trace). Not enumerable, like
   * `secrets`.
   */
  readonly log?: Logger;
}

/**
 * The tool being called, from the pack's `index.json` (the `kindgi-index`
 * indexer writes it): its id, its module, and its JSON Schemas. The
 * schemas are authoritative; a TypeScript type on the handler is not
 * checked.
 */
export interface ToolInvocationSpec {
  readonly id: string;
  readonly modulePath: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

/**
 * The guardrail check being called (`RegisteredCheck.evaluate(config,
 * trace, bindings)`): its id and its module. The module's check is
 * resolved like a handler (`default`, `check`, or a bare export with
 * `evaluate`).
 *
 * A check in the pack service gets no callable bindings (no
 * `providerRegistry`), so llm-judge checks run in the server, not here.
 * It does get the call's `abortSignal`.
 */
export interface CheckInvocationSpec {
  readonly id: string;
  readonly modulePath: string;
}

/** Every way a call can fail; the pack service answers with the same code. */
export type HandlerErrorCode =
  | 'input-validation-failed'
  | 'output-validation-failed'
  | 'handler-import-failed'
  | 'handler-shape-invalid'
  | 'handler-throw'
  | 'check-shape-invalid';

export interface HandlerError {
  readonly code: HandlerErrorCode;
  readonly message: string;
  readonly toolId?: string;
  readonly cause?: unknown;
  readonly issues?: readonly unknown[];
}

/**
 * The handler surface — `handler(input, ctx)`. Return value may be
 * either the raw output or a Promise thereof. Throwing is captured as
 * a `handler-throw` error; a handler never takes down the process.
 */
export type HandlerFn = (input: unknown, ctx: HandlerContext) => unknown | Promise<unknown>;

/**
 * Shape the runner accepts back from a resolved handler module. The
 * default `importHandler` accepts any of:
 *   - a bare function export (`export default (input, ctx) => ...`)
 *   - `{ default: HandlerFn }`
 *   - `{ handler: HandlerFn }`
 *   - `{ run: HandlerFn }` (the shape the sandbox entrypoint calls, so
 *     a single module can serve both)
 */
export type HandlerModule =
  | HandlerFn
  | { readonly default: HandlerFn }
  | { readonly handler: HandlerFn }
  | { readonly run: HandlerFn };

// -----------------------------------------------------------------------
// Ajv wiring
// -----------------------------------------------------------------------

type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>, opts?: unknown) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

/** Compiled validators by side and schema, oldest first; see `compileSchema`. */
const compiledValidators = new Map<string, ValidateFunction>();
/** Enough for every schema of a large pack, a few edits over. */
const MAX_COMPILED_VALIDATORS = 512;

/**
 * The ajv validator for a JSON Schema — compiled once per side and
 * schema, then reused: a pack service validates every call of a tool
 * against the same two schemas, and compiling is the cost. An edited
 * schema is a new key, so a hot reload takes effect. A validator is
 * shared by concurrent calls safely: validation is synchronous.
 */
export function compileSchema(
  schema: Readonly<Record<string, unknown>>,
  side: 'input' | 'output',
): ValidateFunction {
  const key = `${side}:${JSON.stringify(schema)}`;
  const cached = compiledValidators.get(key);
  if (cached !== undefined) return cached;
  // An input validator fills in each property's JSON Schema `default`;
  // it checks a copy of the caller's input.
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
    ...(side === 'input' && { useDefaults: true }),
  });
  addFormats(ajv);
  const validator = ajv.compile(schema as object);
  if (compiledValidators.size >= MAX_COMPILED_VALIDATORS) {
    const oldest = compiledValidators.keys().next().value;
    if (oldest !== undefined) compiledValidators.delete(oldest);
  }
  compiledValidators.set(key, validator);
  return validator;
}

// -----------------------------------------------------------------------
// Tool calls — `runHandler`
// -----------------------------------------------------------------------

export interface RunHandlerOptions {
  readonly tool: ToolInvocationSpec;
  readonly input: unknown;
  readonly ctx: HandlerContext;
  /**
   * Override the default `import(modulePath)` resolver (tests). Return
   * the same shape `HandlerModule` covers.
   */
  readonly importHandler?: (modulePath: string) => Promise<HandlerModule> | HandlerModule;
}

/**
 * Run one tool call; a typed `Result`, never a throw — every failure is
 * a `HandlerError`.
 */
export async function runHandler(
  options: RunHandlerOptions,
): Promise<Result<unknown, HandlerError>> {
  const { tool, input, ctx } = options;
  const importHandler = options.importHandler ?? defaultImportHandler;

  let inputValidator: ValidateFunction;
  try {
    inputValidator = compileSchema(tool.inputSchema, 'input');
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'input-validation-failed',
        message: `Tool "${tool.id}" input schema failed to compile: ${stringifyError(cause)}`,
        toolId: tool.id,
        cause: serializeCause(cause),
      },
    };
  }

  const candidate = structuredClone(input);
  if (!inputValidator(candidate)) {
    return {
      kind: 'err',
      error: {
        code: 'input-validation-failed',
        message: `Tool "${tool.id}" input failed validation`,
        toolId: tool.id,
        issues: inputValidator.errors ?? [],
      },
    };
  }

  let module_: HandlerModule;
  try {
    module_ = await importHandler(tool.modulePath);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'handler-import-failed',
        message: `Failed to import handler module '${tool.modulePath}': ${stringifyError(cause)}`,
        toolId: tool.id,
        cause: serializeCause(cause),
      },
    };
  }

  const handler = resolveHandler(module_);
  const inputZod = resolveInputZod(module_);
  if (handler === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'handler-shape-invalid',
        message: `Handler module '${tool.modulePath}' does not export a handler function (looked for default / handler / run)`,
        toolId: tool.id,
      },
    };
  }

  // A Zod-authored tool gets its parsed input: defaults, transforms and
  // refinements applied, as its handler's type says.
  let prepared: unknown = candidate;
  if (inputZod !== undefined) {
    const parsed = await parseWithSchema(inputZod, candidate);
    if (parsed.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'input-validation-failed',
          message: `Tool "${tool.id}" input failed validation`,
          toolId: tool.id,
          issues: parsed.issues.map((i) => ({
            instancePath: (i.path ?? []).map((p) => `/${String(p)}`).join(''),
            message: i.message,
          })),
        },
      };
    }
    prepared = parsed.value;
  }

  let output: unknown;
  try {
    output = await handler(prepared, ctx);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'handler-throw',
        message: `Handler for tool "${tool.id}" threw: ${stringifyError(cause)}`,
        toolId: tool.id,
        cause: serializeCause(cause),
      },
    };
  }

  let outputValidator: ValidateFunction;
  try {
    outputValidator = compileSchema(tool.outputSchema, 'output');
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'output-validation-failed',
        message: `Tool "${tool.id}" output schema failed to compile: ${stringifyError(cause)}`,
        toolId: tool.id,
        cause: serializeCause(cause),
      },
    };
  }
  if (!outputValidator(output)) {
    return {
      kind: 'err',
      error: {
        code: 'output-validation-failed',
        message: `Tool "${tool.id}" handler produced output that failed validation`,
        toolId: tool.id,
        issues: outputValidator.errors ?? [],
      },
    };
  }

  return { kind: 'ok', value: output };
}

// -----------------------------------------------------------------------
// Check invocation (guardrail `RegisteredCheck.evaluate`)
// -----------------------------------------------------------------------

/**
 * Shape the runner accepts from a resolved check module. Analogous to
 * `HandlerModule` — matches the `RegisteredCheck` shape (has `.evaluate`
 * function) accessed via `default`, `check`, or bare export.
 */
export type CheckModule =
  | { readonly evaluate: (...args: unknown[]) => unknown | Promise<unknown> }
  | {
      readonly default:
        | { readonly evaluate: (...args: unknown[]) => unknown | Promise<unknown> }
        | ((...args: unknown[]) => unknown | Promise<unknown>);
    }
  | {
      readonly check:
        | { readonly evaluate: (...args: unknown[]) => unknown | Promise<unknown> }
        | ((...args: unknown[]) => unknown | Promise<unknown>);
    };

export interface RunCheckOptions {
  readonly check: CheckInvocationSpec;
  readonly config: Readonly<Record<string, unknown>>;
  readonly trace: unknown;
  /**
   * Aborted when the call is cancelled or passes its deadline; the
   * check finds it as `bindings.abortSignal`.
   */
  readonly abortSignal?: AbortSignal;
  readonly importCheck?: (modulePath: string) => Promise<CheckModule> | CheckModule;
}

/**
 * Run one guardrail check: `evaluate(config, trace, bindings)`, where
 * `bindings` carries only the call's `abortSignal` (no provider
 * registry, so no llm-judge checks here). A typed `Result`, never a
 * throw — every failure is a `HandlerError`.
 */
export async function runCheck(options: RunCheckOptions): Promise<Result<unknown, HandlerError>> {
  const { check, config, trace } = options;
  const importCheck = options.importCheck ?? defaultImportCheck;

  let module_: CheckModule;
  try {
    module_ = await importCheck(check.modulePath);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'handler-import-failed',
        message: `Failed to import check module '${check.modulePath}': ${stringifyError(cause)}`,
        toolId: check.id,
        cause: serializeCause(cause),
      },
    };
  }

  const evaluate = resolveCheckEvaluate(module_);
  if (evaluate === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'check-shape-invalid',
        message: `Check module '${check.modulePath}' does not export a check with .evaluate() (looked for default / check / bare export with evaluate)`,
        toolId: check.id,
      },
    };
  }

  let result: unknown;
  try {
    result = await evaluate(config as unknown, trace, {
      ...(options.abortSignal !== undefined && { abortSignal: options.abortSignal }),
    });
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'handler-throw',
        message: `Check "${check.id}" evaluate() threw: ${stringifyError(cause)}`,
        toolId: check.id,
        cause: serializeCause(cause),
      },
    };
  }

  return { kind: 'ok', value: result };
}

function resolveCheckEvaluate(
  module_: CheckModule,
):
  | ((config: unknown, trace: unknown, bindings: unknown) => unknown | Promise<unknown>)
  | undefined {
  const candidates: unknown[] = [
    (module_ as { evaluate?: unknown }).evaluate,
    (module_ as { default?: unknown }).default,
    (module_ as { check?: unknown }).check,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'function') {
      return candidate as (c: unknown, t: unknown, b: unknown) => unknown | Promise<unknown>;
    }
    const nested = (candidate as { evaluate?: unknown }).evaluate;
    if (typeof nested === 'function') {
      return nested as (c: unknown, t: unknown, b: unknown) => unknown | Promise<unknown>;
    }
  }
  return undefined;
}

async function defaultImportCheck(modulePath: string): Promise<CheckModule> {
  return (await import(modulePath)) as CheckModule;
}

/** The Zod input schema of a `defineTool` export (`inputZod`), when the module has one. */
function resolveInputZod(module_: HandlerModule): ZodLikeSchema | undefined {
  if (typeof module_ !== 'object' || module_ === null) return undefined;
  const record = module_ as Record<string, unknown>;
  for (const candidate of [record.default, record.handler, record.run]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const inputZod = (candidate as { readonly inputZod?: unknown }).inputZod;
    if (isZodSchema(inputZod)) return inputZod as ZodLikeSchema;
  }
  return undefined;
}

function resolveHandler(module_: HandlerModule): HandlerFn | undefined {
  if (typeof module_ === 'function') return module_;
  if (typeof module_ !== 'object' || module_ === null) return undefined;
  const record = module_ as Record<string, unknown>;
  const candidates: unknown[] = [record.default, record.handler, record.run];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'function') return candidate as HandlerFn;
    // `export default defineTool({..., handler: fn})` — the export is
    // a Tool object; the callable lives at `.handler` (or `.run` for
    // the sandbox-entrypoint shape). Walk one level in before giving up.
    if (typeof candidate === 'object') {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.handler === 'function') return nested.handler as HandlerFn;
      if (typeof nested.run === 'function') return nested.run as HandlerFn;
    }
  }
  return undefined;
}

async function defaultImportHandler(modulePath: string): Promise<HandlerModule> {
  return (await import(modulePath)) as HandlerModule;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Handlers may throw arbitrary values (Error, string, plain objects,
 * undefined). The wire protocol carries `cause` as JSON — serialize to
 * a shape JSON.stringify handles cleanly. Preserve the original message
 * + name when `err` is an Error; fall back to a stringified rep otherwise.
 */
function serializeCause(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err === undefined) return null;
  if (
    err === null ||
    typeof err === 'string' ||
    typeof err === 'number' ||
    typeof err === 'boolean'
  ) {
    return err;
  }
  try {
    JSON.stringify(err);
    return err;
  } catch {
    return String(err);
  }
}
