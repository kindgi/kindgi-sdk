// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A guardrail's `config` against the `configSchema` of the check it names,
 * as issues for an API answer. A runtime calls it when a guardrail is
 * registered (`POST /v1/guardrails`), with the schema of the pack check
 * the guardrail names, so a config the pack service would refuse on every
 * call is refused up front instead.
 */

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';

type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>, opts?: unknown) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

/**
 * One way a guardrail's config doesn't fit its check: `path` is a JSON
 * pointer into the guardrail (`/config/maxChars`, `/config` at the root),
 * `message` what is wrong there (`must be > 0`). The shape of
 * `details.issues` in an API error; `describeGuardrailConfigProblems`
 * words the error's message.
 */
export interface GuardrailConfigProblem {
  readonly path: string;
  readonly message: string;
}

export interface GuardrailConfigProblemsInput {
  /** The config schema of the check the guardrail names (JSON Schema Draft 2020-12). */
  readonly configSchema: Readonly<Record<string, unknown>>;
  /** The guardrail's config; absent is checked as `{}`. */
  readonly config: unknown;
}

/** Compiled validators by schema, oldest first. */
const compiled = new Map<string, ValidateFunction | null>();
const MAX_COMPILED = 256;

/**
 * Every way `config` doesn't fit `configSchema`, checked as declared (the
 * schema's defaults not filled in, as the indexer and the pack service
 * check it). Empty when it fits, and when the schema doesn't compile: that
 * is the pack's to fix, and its pack service refuses every call already.
 */
export function guardrailConfigProblems(
  input: GuardrailConfigProblemsInput,
): readonly GuardrailConfigProblem[] {
  const validate = validatorFor(input.configSchema);
  if (validate === null || validate(input.config ?? {})) return [];
  return (validate.errors ?? []).map((issue) => ({
    path: `/config${issue.instancePath}`,
    message: issue.message ?? 'invalid',
  }));
}

/**
 * An error message for `problems`: the guardrail, the check and the first
 * problem, worded as the indexer words a declared config that doesn't fit
 * (`Guardrail "acme.strict"'s config doesn't fit check "my-pack.checks.
 * answer-length"'s configSchema at /maxChars: must be > 0`), and how many
 * more there are. A CLI prints it before each problem's line.
 */
export function describeGuardrailConfigProblems(
  input: { readonly guardrailId: string; readonly check: string },
  problems: readonly GuardrailConfigProblem[],
): string {
  const first = problems[0];
  if (first === undefined) return `Guardrail "${input.guardrailId}"'s config fits its check`;
  const inConfig = first.path.startsWith('/config/') ? first.path.slice('/config'.length) : '';
  const at = inConfig === '' ? '' : ` at ${inConfig}`;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `Guardrail "${input.guardrailId}"'s config doesn't fit check "${input.check}"'s configSchema${at}: ${first.message}${more}`;
}

function validatorFor(schema: Readonly<Record<string, unknown>>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let validate: ValidateFunction | null;
  try {
    // Not strict: a schema keyword Ajv doesn't know (a generator's
    // annotation) mustn't stop the check of the keywords it does.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    validate = ajv.compile(schema as object);
  } catch {
    validate = null;
  }
  if (compiled.size >= MAX_COMPILED) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(key, validate);
  return validate;
}
