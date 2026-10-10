// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The env values `invokeToolForTest` hands a tool, decided as the runtime decides a pack tool's
 * (its tool bridge, "Env values"): each name the tool declares in `needsSpec.env` takes the
 * context's `env` value, else its schema's `default`, and each is checked against its schema. A
 * name with neither, or a value its schema refuses, refuses the call before the handler runs
 * (`env-value-missing` first, then `env-value-invalid`). The handler sees the declared names
 * only: the runtime sends no others. `env-declaration-invalid` is this helper's own: the runtime
 * never refuses a call for it, it leaves the tool out when it loads (and `defineTool` refuses
 * the schema up front). Test only: `invokeTool` itself never decides env.
 */

import { type CompiledInlineSchema, compileInlineSchema } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

import { ToolPreconditionError } from './precondition.js';
import type { JsonSchema, Tool } from './types.js';

/** Compiled env schemas, by schema object (a tool's are defined once and reused). */
const compiled = new WeakMap<object, CompiledInlineSchema>();

/**
 * The env the handler gets: the declared names, each with its value. Undefined when the tool
 * declares none, as from the runtime.
 */
export function envForCall(
  tool: Pick<Tool, 'id' | 'needsSpec'>,
  given: Readonly<Record<string, string>> | undefined,
): Result<Readonly<Record<string, string>> | undefined, ToolPreconditionError> {
  const declared = Object.entries(tool.needsSpec?.env ?? {});
  if (declared.length === 0) return { kind: 'ok', value: undefined };
  const id = tool.id as unknown as string;
  const chosen = declared.map(([name, schema]) => ({
    name,
    schema,
    value: given !== undefined && Object.hasOwn(given, name) ? given[name] : defaultOf(schema),
  }));
  // As the runtime: a missing value refuses the call first, then each value is checked.
  const missing = chosen.filter((c) => c.value === undefined).map((c) => c.name);
  if (missing.length > 0) return refused('env-value-missing', missingMessage(id, missing));
  const values: Record<string, string> = {};
  for (const { name, schema, value } of chosen) {
    const problem = checkValue(id, name, schema, value as string);
    if (problem !== undefined) return { kind: 'err', error: problem };
    values[name] = value as string;
  }
  return { kind: 'ok', value: values };
}

function missingMessage(id: string, missing: readonly string[]): string {
  const one = missing.length === 1;
  const which = one
    ? `env value "${missing[0]}"`
    : `env values ${missing.map((n) => `"${n}"`).join(', ')}`;
  return `tool "${id}" needs ${which}: the context's \`env\` doesn't set ${one ? 'it' : 'them'}, and ${one ? 'its schema has' : 'their schemas have'} no default`;
}

/** Why a value doesn't fit its schema (or the schema doesn't compile); undefined when it fits. */
function checkValue(
  id: string,
  name: string,
  schema: JsonSchema,
  value: string,
): ToolPreconditionError | undefined {
  const validator = validatorFor(schema);
  if (validator.kind === 'err') {
    return new ToolPreconditionError(
      'env-declaration-invalid',
      `tool "${id}" declares env value "${name}" with a schema that doesn't compile: ${validator.error}`,
    );
  }
  const checked = validator.value.validate(value);
  if (checked.kind === 'ok') return undefined;
  return new ToolPreconditionError(
    'env-value-invalid',
    `env value "${name}" is "${value}", which doesn't match the schema tool "${id}" declares for it: ${constraintsBroken(checked.error.errors)}`,
  );
}

/** A schema's `default`, when it's a string (env values are strings; `defineTool` checks it). */
function defaultOf(schema: JsonSchema): string | undefined {
  const fallback = (schema as { readonly default?: unknown }).default;
  return typeof fallback === 'string' ? fallback : undefined;
}

function validatorFor(schema: JsonSchema): Result<CompiledInlineSchema, string> {
  const key = schema as object;
  const cached = compiled.get(key);
  if (cached !== undefined) return { kind: 'ok', value: cached };
  const result = compileInlineSchema(schema);
  if (result.kind === 'err') return { kind: 'err', error: result.error.message };
  compiled.set(key, result.value);
  return { kind: 'ok', value: result.value };
}

/** What a value broke, in the schema validator's words (the runtime's wording). */
function constraintsBroken(errors: readonly unknown[]): string {
  const messages = errors
    .map((e) => (e as { readonly message?: unknown }).message)
    .filter((m): m is string => typeof m === 'string');
  return messages.length > 0 ? messages.join('; ') : 'it does not validate';
}

function refused(reason: string, message: string): { kind: 'err'; error: ToolPreconditionError } {
  return { kind: 'err', error: new ToolPreconditionError(reason, message) };
}
