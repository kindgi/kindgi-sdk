// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A guardrail's `config` against the `configSchema` of the check it names,
 * as issues for an API answer. A runtime calls it when a guardrail is
 * registered (`POST /v1/guardrails`), with the schema of the pack check
 * the guardrail names, so a config the pack service would refuse on every
 * call is refused up front instead.
 */

import { TenantBudgetError } from '@kindgi/bounds';
import { compileJsonSchema } from '@kindgi/schema';
import type { ValidateFunction } from 'ajv';

/**
 * One way a guardrail's config doesn't fit its check: `path` is a JSON
 * pointer into the guardrail (`/config/maxChars`, `/config` at the root),
 * `message` the setting and what it takes (`config.maxChars must be > 0.`).
 * The shape of `details.issues` in an API error, as the provider check's
 * (`provider-config-invalid`); `describeGuardrailConfigProblems` words the
 * error's message.
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
  return (validate.errors ?? []).map((issue) => {
    const path = `/config${issue.instancePath}`;
    return { path, message: `${settingName(path)} ${issue.message ?? 'is invalid'}.` };
  });
}

/** `/config/rules/0/pattern` → `config.rules.0.pattern`, as a message names it. */
function settingName(pointer: string): string {
  return pointer
    .slice(1)
    .split('/')
    .map((step) => step.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.');
}

/**
 * An error message for `problems`, one sentence as the provider check's:
 * the guardrail, the check, the first problem and how many more
 * (`Guardrail "acme.strict" doesn't fit check "my-pack.checks.answer-length":
 * config.maxChars must be > 0 (and 1 more).`). A CLI prints it before each
 * problem's line.
 */
export function describeGuardrailConfigProblems(
  input: { readonly guardrailId: string; readonly check: string },
  problems: readonly GuardrailConfigProblem[],
): string {
  const first = problems[0];
  const head = `Guardrail "${input.guardrailId}"`;
  if (first === undefined) return `${head} fits check "${input.check}".`;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `${head} doesn't fit check "${input.check}": ${first.message.replace(/\.$/, '')}${more}.`;
}

/**
 * The schema's validator, or null when it doesn't compile or is over the
 * process's bounds. `compileJsonSchema` keeps it compiled. A compile the
 * tenant's budget refuses throws: the config isn't checked, so it isn't
 * passed either.
 */
function validatorFor(schema: Readonly<Record<string, unknown>>): ValidateFunction | null {
  try {
    // Not strict: a schema keyword Ajv doesn't know (a generator's
    // annotation) mustn't stop the check of the keywords it does.
    return compileJsonSchema(schema, { dialects: ['2020-12'], strict: false });
  } catch (cause) {
    if (cause instanceof TenantBudgetError) throw cause;
    return null;
  }
}
