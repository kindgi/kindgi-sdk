// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  SchemaCompileBudgetError,
  compileInlineSchema,
  compileJsonSchema,
  createSpecRegistry,
  isZodSchema,
  loadZodConverter,
  loadZodConverterSync,
  toJSONSchemaSync,
} from '@kindgi/schema';
import type {
  AnySchema,
  InvalidZodConversionError,
  SpecRegistry,
  ZodConverter,
  ZodLikeSchema,
} from '@kindgi/schema';
import type { Result, ToolId } from '@kindgi/types';

import type {
  InvalidSchemaError,
  InvalidToolDefinitionError,
  ToolError,
  UnknownEffectError,
} from './errors.js';
import { schemaOptions } from './invoke.js';
import type { PauseContext, ToolPauseAnswer } from './pause.js';
import { type ToolSpecSynthesizerOptions, getToolSpecSynthesizer } from './spec-registry.js';
import toolSchema from './tool.schema.json' with { type: 'json' };
import {
  EFFECT_KINDS,
  type HttpToolSpec,
  type Tool,
  type ToolContext,
  type ToolManifest,
  type ToolSpec,
} from './types.js';

const TOOL_SCHEMA_URI = 'https://kindgi.com/schemas/v1/tool.schema.json';

/**
 * Exact semver regex — accepts `MAJOR.MINOR.PATCH[-PRERELEASE]`. Tool
 * VERSIONS are always exact (a tool row ships a specific semver);
 * agent bindings reference tools via `{ id, version: <range> }`
 * where the range grammar is npm-style (parsed by `semver` at
 * dispatch time).
 */
const SEMVER_EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

let cachedRegistry: SpecRegistry | undefined;
function registry(): SpecRegistry {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const built = createSpecRegistry([toolSchema]);
  if (built.kind === 'err') {
    throw new Error(`@kindgi/tools: bundled schema failed to compile: ${built.error.message}`);
  }
  cachedRegistry = built.value;
  return cachedRegistry;
}

/**
 * Sync converter resolver. `@kindgi/schema` handles caching + peer-dep
 * absence; when zod is installed, this returns the converter on every
 * call after the first at O(1); when zod is missing, this returns
 * `undefined` and callers surface a typed `invalid-schema` error.
 */
function resolveZodConverterSync(): ZodConverter | undefined {
  return loadZodConverterSync();
}

/**
 * For a schema Ajv's strict mode refuses (an authoring lint, not invalid JSON Schema), the way
 * out for a value of any JSON shape. Empty for other failures.
 */
function strictHint(cause: unknown): string {
  return cause instanceof Error && /strict mode/.test(cause.message)
    ? '. For a field that may hold any JSON value, `z.json()` (or `{}` in JSON Schema) compiles.'
    : '';
}

/**
 * Sanity-check that a candidate JSON Schema compiles as the tool's
 * schemas do (`schemaOptions`): a pack's own tool's as Draft 2020-12 in
 * Ajv's strict mode, an MCP server's in the dialect it declares.
 */
function compilesAsSchema(
  schema: unknown,
  where: 'input' | 'output',
  tool: Pick<ToolManifest, 'transport'>,
): InvalidSchemaError | undefined {
  try {
    compileJsonSchema(schema as Readonly<Record<string, unknown>>, schemaOptions(tool));
    return undefined;
  } catch (cause) {
    // A compile the tenant's budget refused says nothing about the schema.
    if (cause instanceof SchemaCompileBudgetError) throw cause;
    return {
      code: 'invalid-schema',
      message: `Tool ${where} schema does not compile: ${cause instanceof Error ? cause.message : String(cause)}${strictHint(cause)}`,
      where,
      cause,
    };
  }
}

/**
 * Given an `AnySchema` (JSON Schema object OR Zod v4 schema), return the
 * JSON Schema wire form. Converts synchronously using the pre-loaded Zod
 * converter — callers must have called `ensureZodConverter()` first if
 * they might be handed a Zod schema.
 */
function resolveWireSchema(
  schema: AnySchema,
  where: 'input' | 'output',
  converter: ZodConverter | undefined,
): Result<
  { readonly wire: Readonly<Record<string, unknown>>; readonly zod?: ZodLikeSchema },
  InvalidSchemaError
> {
  if (!isZodSchema(schema)) {
    return { kind: 'ok', value: { wire: schema } };
  }
  // The input side for `input` (a `.default()` field is optional to the
  // caller), the output side for `output` (the field is always there).
  const converted = toJSONSchemaSync(schema, converter, where);
  if (converted.kind === 'err') {
    return { kind: 'err', error: toSchemaError(converted.error, where) };
  }
  return { kind: 'ok', value: { wire: converted.value, zod: schema } };
}

function toSchemaError(
  err: InvalidZodConversionError,
  where: 'input' | 'output',
): InvalidSchemaError {
  return {
    code: 'invalid-schema',
    message: `Tool ${where} Zod schema conversion failed: ${err.message}`,
    where,
    cause: err.cause,
  };
}

/**
 * Author-time inference from a Zod schema's `_zod.input` — what a caller
 * may send. Non-Zod schemas fall through to `unknown`.
 *
 * A handler's input is typed `InferOutput` of the input schema: it gets
 * the parsed value (defaults filled, transforms applied), not what the
 * caller sent.
 */
export type InferInput<T> = T extends { readonly _zod: { readonly input: infer I } } ? I : unknown;

/** Symmetric — inferred from `_zod.output`. */
export type InferOutput<T> = T extends { readonly _zod: { readonly output: infer O } }
  ? O
  : unknown;

/**
 * The author-facing spec accepted by `defineTool`. Two generic parameters,
 * one per schema slot, each of which is either a JSON Schema object or a
 * Zod v4 schema. Two more generics carry the handler's actual argument
 * and return types — defaulting to the schema-inferred types, but
 * available for contextual inference from the handler literal: authors
 * who write `handler: async () => ({ x: 1 })` get
 * `TOutput = { x: number }` without declaring it separately.
 */
export interface DefineToolSpec<
  TInSchema extends AnySchema,
  TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
> extends Omit<ToolManifest, 'input' | 'output'> {
  /**
   * Tool input schema. Accepts either a Zod v4 schema (auto-converted
   * to JSON Schema at author time; preserved on `tool.inputZod` for
   * TS-side type inference) or a JSON Schema Draft 2020-12 object.
   * Handed to the model as the tool's parameter schema so it can
   * generate valid calls.
   */
  readonly input: TInSchema;
  /**
   * Tool output schema. Same Zod-or-JSON-Schema shape as `input`.
   * `invokeTool` validates the handler's return value against this
   * before surfacing it — an off-schema return fails with `bad-output`.
   */
  readonly output: TOutSchema;
  /**
   * Imperative handler. Mutually exclusive with `spec` — a tool is
   * either author-written code or a declarative spec, never both.
   * Omit when providing `spec`; the framework synthesizes a handler
   * from the spec's kind via the registered synthesizer.
   */
  readonly handler?: (input: THandlerIn, ctx: ToolContext) => Promise<THandlerOut>;
}

/**
 * The spec of a tool that may make its run wait for another system's
 * answer (`pauses: true`). Its handler gets the call's wait token and
 * `pause` beside the usual context, and returns either its output or
 * `ctx.pause()`:
 *
 * ```ts
 * handler: async ({ orderId }, ctx) => {
 *   await carrier.requestPickup(orderId, { callbackUrl: ctx.waitToken.url });
 *   return ctx.pause({ timeoutMs: 2 * 60 * 60 * 1000, name: "the carrier's pickup confirmation" });
 * },
 * ```
 *
 * The answer the carrier posts to the link, valid against `output`, is
 * the call's result. Only a pack runs such a handler: it has no
 * declarative `spec`.
 */
export interface DefinePausingToolSpec<
  TInSchema extends AnySchema,
  TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
> extends Omit<DefineToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>, 'handler' | 'spec'> {
  readonly pauses: true;
  readonly handler: (
    input: THandlerIn,
    ctx: ToolContext & PauseContext,
  ) => Promise<THandlerOut | ToolPauseAnswer>;
}

/**
 * The concrete Tool returned by `defineTool`. When the author passes a
 * Zod schema at the `input` slot, `inputZod` is present and carries the
 * original schema so callers can `z.infer<typeof tool.inputZod>` at the
 * type level. Symmetric for `output`.
 *
 * Wire form (`tool.input` / `tool.output`) is always the converted JSON
 * Schema — non-TS consumers see no change.
 */
export type DefinedTool<
  TInSchema extends AnySchema,
  TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
> = Tool<THandlerIn, THandlerOut> &
  (TInSchema extends ZodLikeSchema
    ? { readonly inputZod: TInSchema }
    : { readonly inputZod?: undefined }) &
  (TOutSchema extends ZodLikeSchema
    ? { readonly outputZod: TOutSchema }
    : { readonly outputZod?: undefined });

/**
 * Build a validated `Tool` from a user-supplied definition.
 *
 * Two authoring surfaces coexist:
 *   1. JSON Schema Draft 2020-12 objects — the only shape that crosses
 *      the wire. Non-TS consumers use this.
 *   2. Zod v4 schemas — TS-user sugar. Framework detects at author time,
 *      converts via `z.toJSONSchema()`, caches the JSON Schema wire form
 *      on `tool.input` / `tool.output`, preserves the original Zod schema
 *      on `tool.inputZod` / `tool.outputZod` for static type inference.
 *
 * Verifies (fail-fast):
 *   1. The manifest projection conforms to `@kindgi/specs/tool.schema.json`.
 *   2. Every declared `effects[].kind` is in the closed `EFFECT_KINDS` set.
 *   3. `input` and `output` are legal JSON Schema Draft 2020-12 documents
 *      (after Zod conversion, when applicable).
 *
 * The `handler` is not validated at author time — its input/output are
 * enforced by `invokeTool` at each call. Returning a tool from this function
 * is the runtime's promise that it's structurally safe to invoke.
 *
 * `zod` is a **peer dependency**. Workspaces that never author with Zod
 * never install it and never pay any resolution cost. Callers that DO
 * pass a Zod schema without `zod` installed get a clean
 * `invalid-schema` error surfaced through the returned `Result`.
 */
export function defineTool<
  const TInSchema extends AnySchema,
  const TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
>(
  spec: DefinePausingToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  options?: DefineToolOptions,
): Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError>;
export function defineTool<
  const TInSchema extends AnySchema,
  const TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
>(
  spec: DefineToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  options?: DefineToolOptions,
): Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError>;
/**
 * Overload with explicit data-type generics, for JSON-Schema-only
 * authors who want to state `<TInput, TOutput>` themselves. Without the
 * generics, inference derives the handler types from a Zod schema, or
 * (for JSON Schema) from the handler literal's return type.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  spec: Tool<TInput, TOutput>,
  options?: DefineToolOptions,
): Result<Tool<TInput, TOutput>, ToolError>;
export function defineTool(
  spec: DefineToolSpec<AnySchema, AnySchema> | DefinePausingToolSpec<AnySchema, AnySchema>,
  options: DefineToolOptions = {},
): Result<DefinedTool<AnySchema, AnySchema>, ToolError> {
  // Fast path: JSON-Schema-only authoring never needs the peer dep.
  const authoredWithZod = isZodSchema(spec.input) || isZodSchema(spec.output);
  const converter = authoredWithZod ? resolveZodConverterSync() : undefined;
  return finalizeDefinition(spec as DefineToolSpec<AnySchema, AnySchema>, converter, options);
}

/** How `defineTool` builds a tool; for the runtime, not for pack authors. */
export interface DefineToolOptions {
  /** What a declarative `spec`'s synthesized handler gets (the runtime's guarded `fetch`). */
  readonly synthesizer?: ToolSpecSynthesizerOptions;
  /**
   * The tool is one the runtime stored when it was registered or deployed, rebuilt to run: an
   * HTTP spec's template checks (`checkHttpTemplates`) aren't run again, so a tool stored before
   * a check existed keeps working after an upgrade. Registration and deploys still run them.
   */
  readonly stored?: boolean;
}

/**
 * Async companion to `defineTool` — resolves the Zod peer dependency
 * via dynamic `import()` instead of Node's `createRequire`. Prefer this
 * in environments that prohibit `createRequire` (edge runtimes, some
 * bundler configurations) OR for pack-init code that already lives on
 * the async path.
 */
export async function defineToolAsync<
  const TInSchema extends AnySchema,
  const TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
>(
  spec: DefinePausingToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  options?: DefineToolOptions,
): Promise<Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError>>;
export async function defineToolAsync<
  const TInSchema extends AnySchema,
  const TOutSchema extends AnySchema,
  THandlerIn = InferOutput<TInSchema>,
  THandlerOut = InferOutput<TOutSchema>,
>(
  spec: DefineToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  options?: DefineToolOptions,
): Promise<Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError>>;
export async function defineToolAsync(
  spec: DefineToolSpec<AnySchema, AnySchema> | DefinePausingToolSpec<AnySchema, AnySchema>,
  options: DefineToolOptions = {},
): Promise<Result<DefinedTool<AnySchema, AnySchema>, ToolError>> {
  const authoredWithZod = isZodSchema(spec.input) || isZodSchema(spec.output);
  const converter = authoredWithZod ? await loadZodConverter() : undefined;
  return finalizeDefinition(spec as DefineToolSpec<AnySchema, AnySchema>, converter, options);
}

function finalizeDefinition<
  TInSchema extends AnySchema,
  TOutSchema extends AnySchema,
  THandlerIn,
  THandlerOut,
>(
  spec: DefineToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  converter: ZodConverter | undefined,
  options: DefineToolOptions,
): Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError> {
  // `version` is required on every tool manifest.
  // Deep semver grammar checked here via a lightweight regex; range
  // parsing (for agent-side `tools[].version` refs) happens elsewhere
  // via the `semver` library at dispatch time. This regex accepts
  // exact semvers only — tool VERSIONS are exact (a tool ships a
  // specific `1.2.3`); ranges live on the agent binding.
  const specVersion = (spec as { readonly version?: unknown }).version;
  if (typeof specVersion !== 'string' || !SEMVER_EXACT_RE.test(specVersion)) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-tool-definition',
        message:
          '`version` is required on every tool manifest and must be an exact semver (e.g., `1.2.3`, `1.2.3-beta.1`). Agent bindings then reference tools via `{ id, version: <range> }`.',
        issues: [
          {
            path: '/version',
            message: 'version must be a non-empty exact semver string',
          },
        ],
      },
    };
  }

  // handler / spec mutual-exclusion + spec synthesis.
  const authorHandler = (spec as { readonly handler?: unknown }).handler;
  const declarativeSpec = (spec as { readonly spec?: ToolSpec }).spec;
  if (authorHandler !== undefined && declarativeSpec !== undefined) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-tool-definition',
        message:
          '`handler` and `spec` are mutually exclusive. Provide an imperative handler OR a declarative spec, not both.',
        issues: [{ path: '/handler', message: 'handler + spec both set' }],
      },
    };
  }
  if (authorHandler === undefined && declarativeSpec === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-tool-definition',
        message:
          'A tool must declare exactly one of `handler` (imperative) or `spec` (declarative).',
        issues: [{ path: '/handler', message: 'handler + spec both absent' }],
      },
    };
  }
  const unpausable = pauseRefusal(spec, declarativeSpec);
  if (unpausable !== undefined) return { kind: 'err', error: unpausable };
  let effectiveHandler = authorHandler as
    | ((input: THandlerIn, ctx: ToolContext) => Promise<THandlerOut>)
    | undefined;
  if (declarativeSpec !== undefined) {
    const synth = getToolSpecSynthesizer(declarativeSpec.kind);
    if (synth === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-tool-definition',
          message: `No synthesizer registered for tool spec kind "${declarativeSpec.kind}". Import the package that owns this kind (e.g. \`@kindgi/tools\` for 'http') before calling \`defineTool\`.`,
          issues: [{ path: '/spec/kind', message: `unknown kind "${declarativeSpec.kind}"` }],
        },
      };
    }
    effectiveHandler = synth(
      declarativeSpec,
      (spec as { readonly id: string }).id,
      options.synthesizer,
    ) as (input: THandlerIn, ctx: ToolContext) => Promise<THandlerOut>;
  }

  const inputResolved = resolveWireSchema(spec.input, 'input', converter);
  if (inputResolved.kind === 'err') return { kind: 'err', error: inputResolved.error };
  const outputResolved = resolveWireSchema(spec.output, 'output', converter);
  if (outputResolved.kind === 'err') return { kind: 'err', error: outputResolved.error };

  // Rebuild the spec against the JSON Schema wire form. Downstream code
  // (invokeTool, manifest projection, MCP publish) reads `.input` /
  // `.output`; the original Zod objects are stored separately on
  // `inputZod` / `outputZod`.
  const wireSpec = {
    ...(spec as unknown as ToolManifest),
    input: inputResolved.value.wire,
    output: outputResolved.value.wire,
    handler: effectiveHandler,
  } as unknown as Tool<THandlerIn, THandlerOut>;

  const manifest: ToolManifest = stripHandler(wireSpec);

  const schemaResult = registry().validate<ToolManifest>(TOOL_SCHEMA_URI, manifest);
  if (schemaResult.kind === 'err') {
    const err = schemaResult.error;
    if (err.code !== 'validation-error') {
      throw new Error(`@kindgi/tools: unexpected schema error ${err.code}: ${err.message}`);
    }
    return { kind: 'err', error: toDefinitionError(err) };
  }

  const badEffect = checkEffectKinds(manifest);
  if (badEffect) return { kind: 'err', error: badEffect };

  const badInput = compilesAsSchema(manifest.input, 'input', manifest);
  if (badInput) return { kind: 'err', error: badInput };
  const badOutput = compilesAsSchema(manifest.output, 'output', manifest);
  if (badOutput) return { kind: 'err', error: badOutput };
  const badNeeds = needsSpecProblem(manifest);
  if (badNeeds) return { kind: 'err', error: badNeeds };
  const badTemplate = checkHttpTemplates(manifest, options);
  if (badTemplate) return { kind: 'err', error: badTemplate };

  const tool = {
    ...wireSpec,
    ...(inputResolved.value.zod !== undefined && { inputZod: inputResolved.value.zod }),
    ...(outputResolved.value.zod !== undefined && { outputZod: outputResolved.value.zod }),
  } as unknown as DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>;

  return { kind: 'ok', value: tool };
}

/**
 * Why a tool can't declare `pauses: true`, if it can't: only a pack's own
 * run of a handler can answer with a pause. The runtime runs a declarative
 * spec itself, and an MCP server can't.
 */
function pauseRefusal(spec: object, declarativeSpec: ToolSpec | undefined): ToolError | undefined {
  const declared = spec as { readonly pauses?: unknown; readonly transport?: unknown };
  if (declared.pauses !== true) return undefined;
  if (declarativeSpec === undefined && declared.transport !== 'mcp') return undefined;
  return {
    code: 'invalid-tool-definition',
    message:
      "`pauses: true` needs a handler the pack runs: a tool with a declarative `spec` or an MCP transport can't pause.",
    issues: [
      {
        path: declarativeSpec !== undefined ? '/spec' : '/transport',
        message: 'pauses needs an imperative handler',
      },
    ],
  };
}

function stripHandler<TInput, TOutput>(spec: Tool<TInput, TOutput>): ToolManifest {
  // Structural copy dropping `handler`. `handler` is a function and Ajv rejects
  // functions during validation, so it MUST be stripped before schema check.
  const { handler: _handler, inputZod: _iz, outputZod: _oz, ...manifest } = spec;
  return manifest;
}

function toDefinitionError(err: {
  readonly errors: readonly unknown[];
  readonly message: string;
}): InvalidToolDefinitionError {
  const issues = err.errors.map((e) => {
    const ajvErr = e as { instancePath?: unknown; message?: unknown };
    return {
      path: typeof ajvErr.instancePath === 'string' ? ajvErr.instancePath : '',
      message: typeof ajvErr.message === 'string' ? ajvErr.message : 'validation failed',
    };
  });
  return { code: 'invalid-tool-definition', message: err.message, issues };
}

/**
 * Each schema in `needsSpec.secrets` and `needsSpec.env` compiles as the runtime compiles it when
 * it loads the tool (`compileInlineSchema`), and an env value's `default` is a string. A runtime
 * that couldn't compile one would leave the whole tool out, so it's refused here, where the
 * tool is defined, registered (`POST /v1/tools`) or deployed, naming the tool, the slot and the
 * name. An HTTP spec's `connection` authorization names a connection `needsSpec.connections`
 * declares.
 */
function needsSpecProblem(manifest: ToolManifest): InvalidToolDefinitionError | undefined {
  const tool = manifest.id as unknown as string;
  for (const slot of ['secrets', 'env'] as const) {
    for (const [name, schema] of Object.entries(manifest.needsSpec?.[slot] ?? {})) {
      const path = `/needsSpec/${slot}/${name}`;
      const compiled = compileInlineSchema(schema);
      if (compiled.kind === 'err') {
        const why = compiled.error.message.replace(/^Inline schema failed to compile: /, '');
        return {
          code: 'invalid-tool-definition',
          message: `Tool "${tool}": the schema for needsSpec.${slot}.${name} doesn't compile: ${why}`,
          issues: [{ path, message: `doesn't compile: ${why}` }],
        };
      }
      const fallback = (schema as { readonly default?: unknown }).default;
      if (slot === 'env' && fallback !== undefined && typeof fallback !== 'string') {
        return {
          code: 'invalid-tool-definition',
          message: `Tool "${tool}": needsSpec.env.${name}'s default must be a string: env values are strings.`,
          issues: [
            { path: `${path}/default`, message: 'must be a string: env values are strings' },
          ],
        };
      }
    }
  }
  const auth = manifest.spec?.authorization;
  if (
    auth?.kind === 'connection' &&
    manifest.needsSpec?.connections?.[auth.connection] === undefined
  ) {
    return {
      code: 'invalid-tool-definition',
      message: `Tool "${tool}": spec.authorization sends the connection "${auth.connection}", which needsSpec.connections doesn't declare.`,
      issues: [
        {
          path: '/spec/authorization/connection',
          message: 'must name a connection needsSpec.connections declares',
        },
      ],
    };
  }
  return undefined;
}

function checkEffectKinds(manifest: ToolManifest): UnknownEffectError | undefined {
  const kinds = new Set<string>(EFFECT_KINDS);
  for (const eff of manifest.effects ?? []) {
    if (!kinds.has(eff.kind)) {
      return {
        code: 'unknown-effect',
        message: `Tool "${manifest.id}" declares unknown effect kind "${eff.kind}"`,
        kind: eff.kind,
      };
    }
  }
  return undefined;
}

/**
 * Validate an arbitrary wire manifest against `@kindgi/specs/tool.schema.json`
 * + the same effect / input-schema / output-schema checks `defineTool`
 * runs, but without requiring a runtime `handler`. Used by transport
 * layers (HTTP API, MCP publish) that accept metadata-only tool
 * registrations — the actual handler is bound server-side via the
 * runtime registry.
 *
 * The returned value has the manifest fields only; there is no
 * `handler` (metadata-only shape).
 */
/**
 * The prefix of tools built into Kindgi (e.g. `kindgi_remember`): their
 * ids are what the model calls, verbatim, so they have no dots. A
 * published tool can't use it; pack tools are `<pack>.<tool>`.
 */
export const BUILT_IN_TOOL_PREFIX = 'kindgi_';

export function validateToolManifest(
  manifest: unknown,
): Result<ToolManifest, InvalidToolDefinitionError | InvalidSchemaError | UnknownEffectError> {
  if (manifest === null || typeof manifest !== 'object') {
    return {
      kind: 'err',
      error: {
        code: 'invalid-tool-definition',
        message: 'Tool manifest must be an object',
        issues: [{ path: '', message: 'must be an object' }],
      },
    };
  }
  // `defineTool` strips `handler` before schema validation; forward the
  // wire object unchanged. `handler` isn't in the ToolManifest shape,
  // so any incidental value on the wire is ignored by validation.
  const { handler: _ignored, ...candidate } = manifest as Record<string, unknown>;
  const schemaResult = registry().validate<ToolManifest>(TOOL_SCHEMA_URI, candidate);
  if (schemaResult.kind === 'err') {
    const err = schemaResult.error;
    if (err.code !== 'validation-error') {
      throw new Error(`@kindgi/tools: unexpected schema error ${err.code}: ${err.message}`);
    }
    return { kind: 'err', error: toDefinitionError(err) };
  }
  const parsed = candidate as unknown as ToolManifest;
  if ((parsed.id as unknown as string).startsWith(BUILT_IN_TOOL_PREFIX)) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-tool-definition',
        message: `Tool id "${parsed.id as unknown as string}": the prefix "${BUILT_IN_TOOL_PREFIX}" is reserved for tools built into Kindgi. Name pack tools "<pack>.<tool>".`,
        issues: [{ path: '/id', message: `must not start with "${BUILT_IN_TOOL_PREFIX}"` }],
      },
    };
  }
  const badEffect = checkEffectKinds(parsed);
  if (badEffect) return { kind: 'err', error: badEffect };
  const badInput = compilesAsSchema(parsed.input, 'input', parsed);
  if (badInput) return { kind: 'err', error: badInput };
  const badOutput = compilesAsSchema(parsed.output, 'output', parsed);
  if (badOutput) return { kind: 'err', error: badOutput };
  const badNeeds = needsSpecProblem(parsed);
  if (badNeeds) return { kind: 'err', error: badNeeds };
  const badUrl = checkHttpUrlTemplate(parsed);
  if (badUrl) return { kind: 'err', error: badUrl };
  const badTemplate = checkHttpTemplates(parsed);
  if (badTemplate) return { kind: 'err', error: badTemplate };
  return { kind: 'ok', value: parsed };
}

/**
 * An HTTP tool's `urlTemplate` fills `{placeholders}` in its path and
 * query only. In the scheme, host or port, a run's input (or a model's
 * arguments) would choose where the server sends the request.
 */
function checkHttpUrlTemplate(manifest: ToolManifest): InvalidToolDefinitionError | undefined {
  const spec = manifest.spec;
  if (spec?.kind !== 'http') return undefined;
  const origin = /^(https?):\/\/([^/?#]*)/i.exec(spec.urlTemplate);
  const message =
    origin === null
      ? 'must start with http:// or https:// and a host'
      : /[{}]/.test(origin[2] ?? '')
        ? 'fills {placeholders} in its path and query only, never in its host or port'
        : (origin[2] ?? '') === ''
          ? 'must name a host'
          : undefined;
  if (message === undefined) return undefined;
  return {
    code: 'invalid-tool-definition',
    message: `Tool "${manifest.id}" spec.urlTemplate ${message}`,
    issues: [{ path: '/spec/urlTemplate', message }],
  };
}

/** A `{field}` placeholder, as the runtime's HTTP tool fills it (`http.ts`). */
const PLACEHOLDER = /\{(\w+)\}/g;

/** A `{name}` with no brace inside it. */
const BRACED = /\{([^{}]+)\}/g;

/** A name of letters, marks, digits and `_`, in any script. */
const WORD = /^[\p{L}\p{M}\p{N}_]+$/u;

const ASCII_WORD = /^\w+$/;

/**
 * An HTTP tool's templates hold only what the runtime fills (`http.ts`): `{field}` placeholders,
 * each named in ASCII letters, digits and `_`, and each a field of the input.
 * - The URL has no other brace: a literal one is written `%7B` or `%7D`.
 * - A text body or a header value keeps the braces of JSON, or of GraphQL with spaces inside
 *   them, but not a `{name}` whose name isn't ASCII: it reads as a placeholder that's never
 *   filled.
 * Run where a tool is defined, registered (`POST /v1/tools`) or deployed, but not when the
 * runtime rebuilds a tool it stored (`DefineToolOptions.stored`). The Java `Tool` builder and
 * Python's `http_tool` refuse the same templates, in the same words.
 */
function checkHttpTemplates(
  manifest: ToolManifest,
  options: DefineToolOptions = {},
): InvalidToolDefinitionError | undefined {
  const spec = manifest.spec;
  if (spec?.kind !== 'http' || options.stored === true) return undefined;
  const body = spec.requestBody?.kind === 'text' ? spec.requestBody.template : undefined;
  return (
    strayUrlBrace(manifest.id, spec.urlTemplate) ??
    unfilledName(manifest.id, spec, body) ??
    unknownField(manifest, spec.urlTemplate, body)
  );
}

function templateRefusal(
  id: ToolId,
  field: string,
  path: string,
  message: string,
): InvalidToolDefinitionError {
  return {
    code: 'invalid-tool-definition',
    message: `Tool "${id}" ${field} ${message}`,
    issues: [{ path, message }],
  };
}

function strayUrlBrace(id: ToolId, urlTemplate: string): InvalidToolDefinitionError | undefined {
  if (!/[{}]/.test(urlTemplate.replace(PLACEHOLDER, ''))) return undefined;
  return templateRefusal(
    id,
    'spec.urlTemplate',
    '/spec/urlTemplate',
    "has a brace that isn't part of a {field} placeholder; write a literal one as %7B or %7D",
  );
}

/** A `{name}` in a text body or a header value whose name isn't ASCII, so it's never filled. */
function unfilledName(
  id: ToolId,
  spec: HttpToolSpec,
  body: string | undefined,
): InvalidToolDefinitionError | undefined {
  const filled = [
    ...(body === undefined
      ? []
      : [{ field: 'spec.requestBody.template', path: '/spec/requestBody/template', text: body }]),
    ...(spec.headers ?? []).map((header, i) => ({
      field: `spec.headers[${i}].value (the header "${header.name}")`,
      path: `/spec/headers/${i}/value`,
      text: header.value,
    })),
  ];
  for (const { field, path, text } of filled) {
    const names = [
      ...new Set(
        [...text.matchAll(BRACED)]
          .map((m) => m[1] ?? '')
          .filter((name) => WORD.test(name) && !ASCII_WORD.test(name)),
      ),
    ];
    if (names.length === 0) continue;
    const which =
      names.length === 1
        ? `{${names[0]}}, which isn't a {field} placeholder`
        : `${names.map((name) => `{${name}}`).join(', ')}, which aren't {field} placeholders`;
    return templateRefusal(
      id,
      field,
      path,
      `has ${which}: a placeholder's name is ASCII letters, digits and _`,
    );
  }
  return undefined;
}

/** A placeholder in the URL or a text body that the input has no field for. */
function unknownField(
  manifest: ToolManifest,
  urlTemplate: string,
  body: string | undefined,
): InvalidToolDefinitionError | undefined {
  const properties = (manifest.input as { readonly properties?: unknown } | undefined)?.properties;
  const fields = new Set(
    properties !== null && typeof properties === 'object' ? Object.keys(properties) : [],
  );
  const templates = [
    { path: '/spec/urlTemplate', text: urlTemplate },
    ...(body === undefined ? [] : [{ path: '/spec/requestBody/template', text: body }]),
  ].map(({ path, text }) => ({
    path,
    unknown: [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').filter((n) => !fields.has(n)),
  }));
  const named = (names: readonly string[]): string =>
    `${[...new Set(names)]
      .sort()
      .map((name) => `{${name}}`)
      .join(', ')} not a field of the input, which fills placeholders`;
  const issues = templates
    .filter(({ unknown }) => unknown.length > 0)
    .map(({ path, unknown }) => ({ path, message: named(unknown) }));
  if (issues.length === 0) return undefined;
  return {
    code: 'invalid-tool-definition',
    message: `Tool "${manifest.id}": ${named(templates.flatMap(({ unknown }) => unknown))}`,
    issues,
  };
}

/** Exported for tests and downstream registry building. */
export function toolIdOf(spec: Pick<ToolManifest, 'id'>): ToolId {
  return spec.id;
}

/** The `$id` of the JSON Schema this loader validates against. */
export const TOOL_SCHEMA_URI_EXPORTED = TOOL_SCHEMA_URI;
