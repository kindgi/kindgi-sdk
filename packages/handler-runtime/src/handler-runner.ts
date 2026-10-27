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
 * A check validates the config against the guardrail's `configSchema`
 * (as sent), imports the module, resolves its `evaluate`, and calls
 * `evaluate(config, trace, bindings)`.
 *
 * Neither throws: every failure is a typed `HandlerError`. The runner
 * is not a sandbox; the pack service's process is the boundary, and
 * pack code is the team's own (trusted).
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ErrorObject, ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { Logger } from '@kindgi/log';
import {
  ALLOW_UNION_TYPES,
  type ZodLikeSchema,
  isZodSchema,
  parseWithSchema,
} from '@kindgi/schema';
import {
  type FileStore,
  type ToolConnection,
  connectionRejectionOf,
  withoutConnectionTokens,
} from '@kindgi/tools';
import type { Result } from '@kindgi/types';

import { serializeCause, stringifyError } from './error-text.js';
import { fileStoreOf, fileUploadOf } from './file-upload.js';
import {
  type FileUploadRef,
  MAX_PAUSE_NAME_LENGTH,
  MAX_PAUSE_TIMEOUT_MS,
  type WaitTokenRef,
} from './protocol.js';
import { withoutSecrets } from './secret-redaction.js';

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
  /**
   * The declared connections (`needsSpec.connections`), by the tool's name
   * for each, with a short-lived token (protocol 2.9.0). Not enumerable,
   * like `secrets`. When the app refuses a token, throw
   * `ConnectionRejectedError` (`@kindgi/tools`) with the name, or an error
   * whose `cause` is one: the call answers `connection-rejected`, and the
   * runtime renews the token once and runs the call again.
   */
  readonly connections?: Readonly<Record<string, ToolConnection>>;
  readonly config?: Readonly<Record<string, unknown>>;
  /**
   * The calling agent version's settings blocks' values, by block id
   * (protocol 2.4.0): `ctx.settings['acme.weights'].recency`. Absent when
   * it pins none, and from an older runtime.
   */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The call's wait token (protocol 2.8.0), only for a tool that declares
   * `pauses`: hand `url` to the system that will answer, then return
   * `ctx.pause()`. Reading it when the runtime sent none (one from before
   * 2.8.0) throws, and the call fails with `pause-not-available`. A
   * re-run after a crash gets a new link to the same wait, and either
   * link completes it. Hand on the new one only if the old one never went
   * out, and dedupe on the call's `idempotencyKey`.
   */
  readonly waitToken?: WaitTokenRef;
  /**
   * Only for a tool that declares `pauses`: the value to return when the
   * call waits for another system's answer (`return ctx.pause({ timeoutMs:
   * 2 * 60 * 60 * 1000, name: "the carrier's pickup confirmation" })`).
   * Without `timeoutMs`, the runtime waits 24 hours; at most 24 days.
   * Never on the wire; the runner adds it.
   */
  readonly pause?: (options?: PauseOptions) => PauseAnswer;
  /**
   * Only for a tool that declares `storesFiles`: the call's file store
   * (protocol 2.10.0). `store` sends a file's bytes to the runtime, which
   * checks and stores them, and answers the file value to return in the
   * result's top-level `files`, or why it stored nothing. Absent when the
   * runtime sent no file upload (one from before 2.10.0, one with no file
   * store, or a call with no `idempotencyKey`). Never on the wire; the
   * runner adds it.
   */
  readonly files?: FileStore;
  /**
   * The call's file upload as the runtime sent it (protocol 2.10.0). The
   * runner keeps it from the handler, which gets `files` instead. Not
   * enumerable, like `secrets`.
   */
  readonly fileUpload?: FileUploadRef;
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
  /**
   * The tool declares `pauses`: its handler gets `ctx.waitToken` and
   * `ctx.pause`. A tool without it gets neither, even when the call
   * carried a token.
   */
  readonly pauses?: boolean;
  /**
   * The tool declares `storesFiles`: its handler gets `ctx.files` when the
   * call carried a file upload. A tool without it gets no `files`, and
   * no handler ever gets the upload itself.
   */
  readonly storesFiles?: boolean;
}

/** What a pausing handler passes to `ctx.pause`. */
export interface PauseOptions {
  /** How long the run waits, in milliseconds: 1 to 24 days' worth. Default: 24 hours. */
  readonly timeoutMs?: number;
  /** What the run waits for, in a few words: 1 to 200 characters. */
  readonly name?: string;
}

/** What `ctx.pause` returns; the handler returns it as its result. */
export interface PauseAnswer {
  readonly timeoutMs?: number;
  readonly name?: string;
}

/** A call that waits for another system's answer, as the pack service answers it. */
export interface HandlerPause {
  readonly timeoutMs?: number;
  readonly name?: string;
}

/** A tool call's outcome when its caller can take a pause (`runHandlerOrPause`). */
export type HandlerOutcome =
  | Result<unknown, HandlerError>
  | { readonly kind: 'pause'; readonly pause: HandlerPause };

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
  /**
   * The guardrail's `configSchema` from the index. A call's `config` that
   * doesn't fit it is refused (`input-validation-failed`, with the
   * issues) before the check runs. It is checked as sent, the schema's
   * defaults not filled in, as the indexer checks a declared config; the
   * check's own schema fills them in.
   */
  readonly configSchema?: Readonly<Record<string, unknown>>;
}

/** Every way a call can fail; the pack service answers with the same code. */
export type HandlerErrorCode =
  | 'input-validation-failed'
  | 'output-validation-failed'
  | 'handler-import-failed'
  | 'handler-shape-invalid'
  | 'handler-throw'
  | 'connection-rejected'
  | 'check-shape-invalid'
  | 'pause-not-available';

export interface HandlerError {
  readonly code: HandlerErrorCode;
  readonly message: string;
  readonly toolId?: string;
  readonly cause?: unknown;
  readonly issues?: readonly unknown[];
  /** For `connection-rejected`: the tool's name for the connection the app refused. */
  readonly connection?: string;
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
    allowUnionTypes: ALLOW_UNION_TYPES,
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
 * a `HandlerError`. A caller that can make the run wait calls
 * `runHandlerOrPause` instead: here, a tool's pause is refused as
 * `pause-not-available`, so no caller reads a pause as output.
 */
export async function runHandler(
  options: RunHandlerOptions,
): Promise<Result<unknown, HandlerError>> {
  const outcome = await runHandlerOrPause(options);
  if (outcome.kind !== 'pause') return outcome;
  return {
    kind: 'err',
    error: {
      code: 'pause-not-available',
      message: `Tool "${options.tool.id}" paused, but its caller can't wait for an answer`,
      toolId: options.tool.id,
    },
  };
}

/**
 * Run one tool call whose caller can make the run wait: as `runHandler`,
 * plus a third outcome, `pause`, when a tool that declares `pauses`
 * returns `ctx.pause()`. A pause's output isn't validated: the answer
 * that arrives later is.
 */
export async function runHandlerOrPause(options: RunHandlerOptions): Promise<HandlerOutcome> {
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
        message: `Failed to import handler module '${tool.modulePath}': ${stringifyError(cause)}${missingPackageHint(cause)}`,
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

  const called = await callHandler(handler, prepared, ctx, tool);
  if (called.kind === 'err') return called;
  if (isPauseAnswer(called.value)) return pauseOf(tool, ctx, called.value);
  return checkedOutput(tool, called.value);
}

/** What the handler returned, or the error its throw is. */
async function callHandler(
  handler: HandlerFn,
  input: unknown,
  ctx: HandlerContext,
  tool: ToolInvocationSpec,
): Promise<Result<unknown, HandlerError>> {
  try {
    return { kind: 'ok', value: await handler(input, callContext(ctx, tool)) };
  } catch (cause) {
    const rejection = connectionRejectionOf(cause);
    if (rejection !== undefined) {
      return {
        kind: 'err',
        error: {
          code: 'connection-rejected',
          message: `Tool "${tool.id}": ${rejection.message}`,
          toolId: tool.id,
          connection: rejection.connection,
        },
      };
    }
    if (isPauseNotAvailable(cause)) {
      return {
        kind: 'err',
        error: { code: 'pause-not-available', message: cause.message, toolId: tool.id },
      };
    }
    // The call's own values go before the message is built: its masking,
    // its one-line causes and their cut could otherwise leave part of one
    // where a match on the whole value no longer finds it.
    const shown = withoutCallValues(cause, ctx);
    return {
      kind: 'err',
      error: {
        code: 'handler-throw',
        message: `Handler for tool "${tool.id}" threw: ${stringifyError(shown)}${missingPackageHint(shown)}`,
        toolId: tool.id,
        cause: serializeCause(shown),
      },
    };
  }
}

/** The handler's output, checked against the tool's output schema. */
function checkedOutput(tool: ToolInvocationSpec, output: unknown): Result<unknown, HandlerError> {
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
// Pauses — `ctx.waitToken`, `ctx.pause`
// -----------------------------------------------------------------------

/**
 * Marks what `ctx.pause` returns. Registered, so a handler module that
 * loads its own copy of this package still returns a pause the runner
 * recognizes.
 */
const PAUSE_ANSWER = Symbol.for('kindgi.pack.pause-answer');
const PAUSE_NOT_AVAILABLE = Symbol.for('kindgi.pack.pause-not-available');

class PauseNotAvailableError extends Error {
  readonly [PAUSE_NOT_AVAILABLE] = true;
}

function isPauseNotAvailable(value: unknown): value is PauseNotAvailableError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [PAUSE_NOT_AVAILABLE]?: unknown })[PAUSE_NOT_AVAILABLE] === true
  );
}

function isPauseAnswer(value: unknown): value is PauseAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [PAUSE_ANSWER]?: unknown })[PAUSE_ANSWER] === true
  );
}

function noWaitToken(toolId: string): PauseNotAvailableError {
  return new PauseNotAvailableError(
    `Tool "${toolId}" can't pause: the runtime that called it sent no wait token. Pausing needs a runtime that speaks pack protocol 2.8.0 or later.`,
  );
}

/** What the runner decides for each call: never passed through from the caller. */
const CALL_KEYS: ReadonlySet<string> = new Set(['waitToken', 'pause', 'fileUpload', 'files']);

/**
 * The context a handler gets. A tool that declares `pauses` gets the
 * call's `waitToken` and `pause`; a tool that declares `storesFiles` gets
 * `files` when the call carried a file upload; any other tool gets none of
 * them, even when the call carried a token. No handler gets the upload
 * itself. The caller's context isn't changed; its properties,
 * non-enumerable ones too (`secrets`, `connections`, `log`), are kept.
 */
function callContext(ctx: HandlerContext, tool: ToolInvocationSpec): HandlerContext {
  const own = Object.getOwnPropertyDescriptors(ctx);
  if (tool.pauses !== true && !Object.keys(own).some((key) => CALL_KEYS.has(key))) return ctx;
  const descriptors = Object.fromEntries(
    Object.entries(own).filter(([key]) => !CALL_KEYS.has(key)),
  );
  const out = Object.defineProperties({}, descriptors) as HandlerContext;
  const upload = tool.storesFiles === true ? fileUploadOf(ctx.fileUpload) : undefined;
  if (upload !== undefined) {
    Object.defineProperty(out, 'files', {
      value: fileStoreOf(upload, ctx.abortSignal),
      enumerable: true,
    });
  }
  if (tool.pauses === true) withPause(out, ctx.waitToken, tool);
  return out;
}

/** `waitToken` and `pause` on a pausing tool's context, read from the call's token. */
function withPause(
  out: HandlerContext,
  waitToken: WaitTokenRef | undefined,
  tool: ToolInvocationSpec,
): void {
  if (waitToken === undefined) {
    Object.defineProperty(out, 'waitToken', {
      get: () => {
        throw noWaitToken(tool.id);
      },
    });
  } else {
    Object.defineProperty(out, 'waitToken', {
      value: Object.freeze({ id: waitToken.id, url: waitToken.url }),
      enumerable: true,
    });
  }
  Object.defineProperty(out, 'pause', {
    value: (options: PauseOptions = {}): PauseAnswer => {
      if (waitToken === undefined) throw noWaitToken(tool.id);
      return Object.freeze({
        ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
        ...(options.name !== undefined && { name: options.name }),
        [PAUSE_ANSWER]: true,
      });
    },
  });
}

/**
 * A handler's pause, checked: from a tool that may pause, on a call that
 * carried a wait token, within the limits the protocol states.
 */
function pauseOf(
  tool: ToolInvocationSpec,
  ctx: HandlerContext,
  answer: PauseAnswer,
): HandlerOutcome {
  if (tool.pauses !== true || ctx.waitToken === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'pause-not-available',
        message:
          tool.pauses !== true
            ? `Tool "${tool.id}" answered with a pause, but doesn't declare \`pauses: true\``
            : noWaitToken(tool.id).message,
        toolId: tool.id,
      },
    };
  }
  const { timeoutMs, name } = answer;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_PAUSE_TIMEOUT_MS)
  ) {
    return shapeInvalid(
      tool.id,
      `Tool "${tool.id}" paused with timeoutMs ${String(timeoutMs)}: it must be a whole number of milliseconds from 1 to ${MAX_PAUSE_TIMEOUT_MS} (24 days)`,
    );
  }
  // In code points, as the schema's `maxLength` and a Python pack count it.
  if (
    name !== undefined &&
    (typeof name !== 'string' || name.length === 0 || [...name].length > MAX_PAUSE_NAME_LENGTH)
  ) {
    return shapeInvalid(
      tool.id,
      `Tool "${tool.id}" paused with a name that isn't 1 to ${MAX_PAUSE_NAME_LENGTH} characters`,
    );
  }
  return {
    kind: 'pause',
    pause: {
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(name !== undefined && { name }),
    },
  };
}

function shapeInvalid(toolId: string, message: string): HandlerOutcome {
  return { kind: 'err', error: { code: 'handler-shape-invalid', message, toolId } };
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

  if (check.configSchema !== undefined) {
    let configValidator: ValidateFunction;
    try {
      configValidator = compileSchema(check.configSchema, 'output');
    } catch (cause) {
      return {
        kind: 'err',
        error: {
          code: 'input-validation-failed',
          message: `Check "${check.id}" config schema failed to compile: ${stringifyError(cause)}`,
          toolId: check.id,
          cause: serializeCause(cause),
        },
      };
    }
    if (!configValidator(config)) {
      const issues = configValidator.errors ?? [];
      return {
        kind: 'err',
        error: {
          code: 'input-validation-failed',
          message: `Check "${check.id}" config failed validation${describeFirstIssue(issues)}`,
          toolId: check.id,
          issues,
        },
      };
    }
  }

  let module_: CheckModule;
  try {
    module_ = await importCheck(check.modulePath);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'handler-import-failed',
        message: `Failed to import check module '${check.modulePath}': ${stringifyError(cause)}${missingPackageHint(cause)}`,
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
        message: `Check "${check.id}" evaluate() threw: ${stringifyError(cause)}${missingPackageHint(cause)}`,
        toolId: check.id,
        cause: serializeCause(cause),
      },
    };
  }

  return { kind: 'ok', value: result };
}

/**
 * Where the first issue is and what it says (` at /maxChars: must be >= 0`),
 * for a message that is read without its issues: a runtime reports a
 * check's error by its code and message alone.
 */
function describeFirstIssue(issues: readonly ErrorObject[]): string {
  const first = issues[0];
  if (first === undefined) return '';
  return `${first.instancePath === '' ? '' : ` at ${first.instancePath}`}: ${first.message ?? 'invalid'}`;
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
  return (await import(importSpecifier(modulePath))) as CheckModule;
}

/**
 * A module path as `import()` takes it: an absolute file path as its
 * `file:` URL, since Node's ESM loader refuses Windows' `C:\…` and reads a
 * `#` in a path as a URL fragment; anything else (a URL, a package name)
 * as given. The pack service's own importer does the same.
 */
function importSpecifier(modulePath: string): string {
  return isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath;
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
  return (await import(importSpecifier(modulePath))) as HandlerModule;
}

/**
 * A thrown value with the call's connection tokens, secrets and file
 * upload token replaced by `[redacted]`, at any depth
 * (`withoutConnectionTokens`, `withoutSecrets`).
 */
function withoutCallValues(cause: unknown, ctx: HandlerContext): unknown {
  const secrets = [
    ...(ctx.secrets === undefined ? [] : Object.values(ctx.secrets)),
    ...(ctx.fileUpload === undefined ? [] : [ctx.fileUpload.token]),
  ];
  return withoutSecrets(withoutConnectionTokens(cause, [ctx.connections]), secrets);
}

/**
 * In a pack image that keeps only what the pack loads (the image sets
 * `KINDGI_IMAGE_DEPENDENCIES=loaded`), what to do about a package the
 * code loads and the image doesn't have: a plugin named in a config
 * string, say, which no build gate could see. Empty otherwise.
 */
export function missingPackageHint(
  cause: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.KINDGI_IMAGE_DEPENDENCIES !== 'loaded') return '';
  const code = (cause as { code?: unknown } | null)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const specifier = /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1];
  if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('/')) return '';
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return `. ${name} isn't in this pack image, which keeps only the packages the pack's code imports by name: add it to image.keep in kindgi.config, or set image.dependencies: 'all'`;
}
