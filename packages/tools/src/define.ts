// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
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
import { type ToolSpecSynthesizerOptions, getToolSpecSynthesizer } from './spec-registry.js';
import toolSchema from './tool.schema.json' with { type: 'json' };
import {
  EFFECT_KINDS,
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
    return {
      code: 'invalid-schema',
      message: `Tool ${where} schema does not compile: ${cause instanceof Error ? cause.message : String(cause)}`,
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
  spec: DefineToolSpec<AnySchema, AnySchema>,
  options: DefineToolOptions = {},
): Result<DefinedTool<AnySchema, AnySchema>, ToolError> {
  // Fast path: JSON-Schema-only authoring never needs the peer dep.
  const authoredWithZod = isZodSchema(spec.input) || isZodSchema(spec.output);
  const converter = authoredWithZod ? resolveZodConverterSync() : undefined;
  return finalizeDefinition(spec, converter, options);
}

/** How `defineTool` builds a tool; for the runtime, not for pack authors. */
export interface DefineToolOptions {
  /** What a declarative `spec`'s synthesized handler gets (the runtime's guarded `fetch`). */
  readonly synthesizer?: ToolSpecSynthesizerOptions;
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
  spec: DefineToolSpec<TInSchema, TOutSchema, THandlerIn, THandlerOut>,
  options: DefineToolOptions = {},
): Promise<Result<DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>, ToolError>> {
  const authoredWithZod = isZodSchema(spec.input) || isZodSchema(spec.output);
  const converter = authoredWithZod ? await loadZodConverter() : undefined;
  return finalizeDefinition(spec, converter, options);
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

  const tool = {
    ...wireSpec,
    ...(inputResolved.value.zod !== undefined && { inputZod: inputResolved.value.zod }),
    ...(outputResolved.value.zod !== undefined && { outputZod: outputResolved.value.zod }),
  } as unknown as DefinedTool<TInSchema, TOutSchema, THandlerIn, THandlerOut>;

  return { kind: 'ok', value: tool };
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
 * name.
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

/** Exported for tests and downstream registry building. */
export function toolIdOf(spec: Pick<ToolManifest, 'id'>): ToolId {
  return spec.id;
}

/** The `$id` of the JSON Schema this loader validates against. */
export const TOOL_SCHEMA_URI_EXPORTED = TOOL_SCHEMA_URI;
