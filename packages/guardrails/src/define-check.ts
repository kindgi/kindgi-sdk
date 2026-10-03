// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { isZodSchema, loadZodConverterSync, toJSONSchemaSync } from '@kindgi/schema';
import type { AnySchema, ZodLikeSchema } from '@kindgi/schema';

import type { InvalidCheckDefinitionError } from './errors.js';
import type { CheckFunction, GuardrailKind, RegisteredCheck } from './types.js';

type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>, opts?: unknown) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

/**
 * Author-time inference from a Zod schema's `_zod.output`. Non-Zod
 * schemas fall through to `Readonly<Record<string, unknown>>` — the
 * same type that `Guardrail.config` already carries.
 */
export type InferCheckConfig<T> = T extends { readonly _zod: { readonly output: infer O } }
  ? O
  : Readonly<Record<string, unknown>>;

/**
 * The author-facing spec accepted by `defineCheck`. Extends
 * `RegisteredCheck` with an optional `configSchema` slot that can be
 * either a JSON Schema object or a Zod v4 schema. When set,
 * `defineCheck` derives `validateConfig` from the schema — authors
 * don't have to write it separately.
 *
 * `evaluate` is typed against the schema-inferred config for Zod-
 * authored checks; JSON-Schema-authored checks fall back to
 * `Readonly<Record<string, unknown>>`.
 */
export interface DefineCheckSpec<TConfigSchema extends AnySchema> {
  /**
   * Check identifier. Referenced by `Guardrail.check` on the wire.
   * Convention: dot-namespaced for pack-authored checks (e.g.
   * `'acme.max-citations'`); framework-shipped checks use stable ids
   * like `'must-cite'` / `'never-call-tool'`.
   */
  readonly id: string;
  /**
   * `'zero-llm'` — pure function over the trace (fast, deterministic,
   * default). `'llm-judge'` — uses a model (opt-in, costs money;
   * needs `bindings.providerRegistry` or `bindings.judgeProvider`).
   * `'external'` — evaluated by a caller-registered strategy.
   */
  readonly kind: GuardrailKind;
  /**
   * Config schema — Zod v4 or JSON Schema. When present, `defineCheck`
   * derives `RegisteredCheck.validateConfig` from it, and
   * `defineGuardrail` runs that against each `Guardrail.config`.
   * Zod authors get schema-inferred config types on `evaluate`'s first
   * parameter.
   */
  readonly configSchema?: TConfigSchema;
  /**
   * The check function. Signature: `(config, trace, bindings) => Promise<CheckResult>`.
   * `config` is the guardrail's declared config (typed via `configSchema`
   * when Zod-authored). `trace` is the accumulated `RunTrace` from the
   * agent turn. `bindings` is the `EvaluationBindings` the caller
   * passed to the engine (`{}` when none).
   * Return `{passed: true}` or `{passed: false, reason: string, ...}`.
   */
  readonly evaluate: (
    config: InferCheckConfig<TConfigSchema>,
    trace: Parameters<CheckFunction>[1],
    bindings: Parameters<CheckFunction>[2],
  ) => ReturnType<CheckFunction>;
  /**
   * Optional custom config validator. When `configSchema` is also set,
   * both run — `configSchema` first, then this. `undefined` return means
   * "config is valid"; non-undefined string is the error message.
   */
  readonly validateConfig?: (config: unknown) => string | undefined;
}

/**
 * The concrete RegisteredCheck returned by `defineCheck`. When the
 * author provided a Zod schema at `configSchema`, `configZod` is
 * present so TS callers can `z.infer<typeof check.configZod>` for
 * static types.
 */
export type DefinedCheck<TConfigSchema extends AnySchema> = RegisteredCheck & {
  readonly configZod: TConfigSchema extends ZodLikeSchema ? TConfigSchema : undefined;
  readonly configJsonSchema?: Readonly<Record<string, unknown>>;
};

/**
 * Build a `RegisteredCheck` with optional schema-derived config
 * validation. Two authoring surfaces coexist:
 *   1. JSON Schema Draft 2020-12 objects — compiled at author time
 *      via Ajv; the check's `validateConfig` is derived from the
 *      compiled validator.
 *   2. Zod v4 schemas — converted via `z.toJSONSchema()` (peer dep),
 *      then compiled the same way. TS callers get `z.infer<typeof
 *      check.configZod>` for static config typing.
 *
 * When `configSchema` is omitted, this behaves as a passthrough:
 * returns the check with the caller's `validateConfig` (or undefined).
 *
 * Failures at author time (Zod conversion or Ajv compile) surface via
 * throw — same failure mode as construction of a bad
 * `RegisteredCheck` object literal. Consumers catch at pack-init;
 * downstream `defineGuardrail` runs the derived `validateConfig` at
 * spec-registration time and reports via `Result`.
 */
export function defineCheck<TConfigSchema extends AnySchema = AnySchema>(
  spec: DefineCheckSpec<TConfigSchema>,
): DefinedCheck<TConfigSchema> {
  const converter =
    spec.configSchema !== undefined && isZodSchema(spec.configSchema)
      ? loadZodConverterSync()
      : undefined;

  let derivedValidator: ((config: unknown) => string | undefined) | undefined;
  let jsonSchema: Readonly<Record<string, unknown>> | undefined;
  let zodSchema: ZodLikeSchema | undefined;

  if (spec.configSchema !== undefined) {
    if (isZodSchema(spec.configSchema)) {
      zodSchema = spec.configSchema;
      const converted = toJSONSchemaSync(spec.configSchema, converter, 'input');
      if (converted.kind === 'err') {
        const err: InvalidCheckDefinitionError = {
          code: 'invalid-check-definition',
          message: `Check "${spec.id}" configSchema Zod conversion failed: ${converted.error.message}`,
          checkId: spec.id,
          cause: converted.error.cause,
        };
        throw errorFromDefinition(err);
      }
      jsonSchema = converted.value;
    } else {
      jsonSchema = spec.configSchema as Readonly<Record<string, unknown>>;
    }
    const validator = compileValidator(jsonSchema, spec.id);
    derivedValidator = (config: unknown) => {
      if (!validator(config)) {
        const errors = validator.errors ?? [];
        const first = errors[0] as { instancePath?: string; message?: string } | undefined;
        const path = first?.instancePath ?? '';
        const message = first?.message ?? 'invalid config';
        return `${path} ${message}`.trim();
      }
      return undefined;
    };
  }

  const chainValidator = (
    a?: (config: unknown) => string | undefined,
    b?: (config: unknown) => string | undefined,
  ): ((config: unknown) => string | undefined) | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return (config) => {
      const first = a(config);
      if (first !== undefined) return first;
      return b(config);
    };
  };

  const validate = chainValidator(derivedValidator, spec.validateConfig);

  const check = {
    id: spec.id,
    kind: spec.kind,
    evaluate: spec.evaluate as CheckFunction,
    ...(validate !== undefined && { validateConfig: validate }),
    ...(zodSchema !== undefined && { configZod: zodSchema }),
    ...(jsonSchema !== undefined && { configJsonSchema: jsonSchema }),
  } as unknown as DefinedCheck<TConfigSchema>;

  return check;
}

function compileValidator(
  schema: Readonly<Record<string, unknown>>,
  checkId: string,
): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: false });
  addFormats(ajv);
  try {
    return ajv.compile(schema as object);
  } catch (cause) {
    const err: InvalidCheckDefinitionError = {
      code: 'invalid-check-definition',
      message: `Check "${checkId}" configSchema does not compile as JSON Schema Draft 2020-12: ${cause instanceof Error ? cause.message : String(cause)}`,
      checkId,
      cause,
    };
    throw errorFromDefinition(err);
  }
}

function errorFromDefinition(err: InvalidCheckDefinitionError): Error {
  const wrapped = new Error(err.message);
  Object.assign(wrapped, err);
  return wrapped;
}
