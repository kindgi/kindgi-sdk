// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createSpecRegistry } from '@kindgi/schema';
import type { SpecRegistry } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

import type {
  InvalidCheckConfigError,
  InvalidGuardrailError,
  UnknownCheckError,
} from './errors.js';
import guardrailSchema from './guardrail.schema.json' with { type: 'json' };
import type { CheckRegistry, Guardrail } from './types.js';

const GUARDRAIL_SCHEMA_ID = 'https://kindgi.com/schemas/v1/guardrail.schema.json';

let cachedRegistry: SpecRegistry | undefined;
function schemaRegistry(): SpecRegistry {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const built = createSpecRegistry([guardrailSchema]);
  if (built.kind === 'err') {
    throw new Error(`@kindgi/guardrails: bundled schema failed to compile: ${built.error.message}`);
  }
  cachedRegistry = built.value;
  return cachedRegistry;
}

/**
 * Validate a guardrail declaration + resolve its check.
 *
 * Fails if:
 *   1. The declaration doesn't match `@kindgi/specs/guardrail.schema.json`.
 *   2. The `check` id isn't in the registry.
 *   3. The registered check's `kind` differs from the guardrail's `kind`.
 *   4. The check has a config validator and `guardrail.config` fails it.
 *
 * Every failure surfaces at pack-init — before any run touches the guardrail.
 */
export function defineGuardrail(
  spec: Guardrail,
  checks: CheckRegistry,
): Result<Guardrail, InvalidGuardrailError | UnknownCheckError | InvalidCheckConfigError> {
  const r = schemaRegistry().validate<Guardrail>(GUARDRAIL_SCHEMA_ID, spec);
  if (r.kind === 'err') {
    const err = r.error;
    if (err.code !== 'validation-error') {
      throw new Error(`@kindgi/guardrails: unexpected schema error ${err.code}: ${err.message}`);
    }
    const issues = err.errors.map((e) => {
      const ajv = e as { instancePath?: unknown; message?: unknown };
      return {
        path: typeof ajv.instancePath === 'string' ? ajv.instancePath : '',
        message: typeof ajv.message === 'string' ? ajv.message : 'validation failed',
      };
    });
    return {
      kind: 'err',
      error: { code: 'invalid-guardrail', message: err.message, issues },
    };
  }

  const check = checks.get(spec.check);
  if (check === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'unknown-check',
        message: `Guardrail "${spec.id}" references unregistered check "${spec.check}"`,
        guardrailId: spec.id,
        checkId: spec.check,
      },
    };
  }

  if (check.kind !== spec.kind) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-guardrail',
        message: `Guardrail "${spec.id}" kind "${spec.kind}" does not match check "${spec.check}" kind "${check.kind}"`,
        issues: [{ path: '/kind', message: `expected "${check.kind}"` }],
      },
    };
  }

  if (check.validateConfig !== undefined && spec.config !== undefined) {
    const reason = check.validateConfig(spec.config);
    if (reason !== undefined) {
      return {
        kind: 'err',
        error: {
          code: 'invalid-check-config',
          message: `Guardrail "${spec.id}" config invalid: ${reason}`,
          guardrailId: spec.id,
          reason,
        },
      };
    }
  }

  return { kind: 'ok', value: spec };
}

/**
 * Validate an arbitrary wire spec against `@kindgi/specs/guardrail.schema.json`.
 * Unlike `defineGuardrail`, this does NOT resolve the `check` reference
 * against a `CheckRegistry` — used by transport layers (e.g. the
 * `@kindgi/api` guardrail routes) that accept metadata-only guardrail
 * registrations. The check implementation must already be available to
 * the server that evaluates the guardrail.
 */
export function validateGuardrailSpec(spec: unknown): Result<Guardrail, InvalidGuardrailError> {
  if (spec === null || typeof spec !== 'object') {
    return {
      kind: 'err',
      error: {
        code: 'invalid-guardrail',
        message: 'Guardrail spec must be an object',
        issues: [{ path: '', message: 'must be an object' }],
      },
    };
  }
  const r = schemaRegistry().validate<Guardrail>(GUARDRAIL_SCHEMA_ID, spec);
  if (r.kind === 'err') {
    const err = r.error;
    if (err.code !== 'validation-error') {
      throw new Error(`@kindgi/guardrails: unexpected schema error ${err.code}: ${err.message}`);
    }
    const issues = err.errors.map((e) => {
      const ajv = e as { instancePath?: unknown; message?: unknown };
      return {
        path: typeof ajv.instancePath === 'string' ? ajv.instancePath : '',
        message: typeof ajv.message === 'string' ? ajv.message : 'validation failed',
      };
    });
    return {
      kind: 'err',
      error: { code: 'invalid-guardrail', message: err.message, issues },
    };
  }
  return { kind: 'ok', value: spec as Guardrail };
}

/** The `$id` of the JSON Schema this loader validates against. */
export const GUARDRAIL_SCHEMA_URI = GUARDRAIL_SCHEMA_ID;

/**
 * The fields a guardrail spec may carry (`guardrail.schema.json`'s properties). A reader that
 * builds a spec from a source a newer version may extend (a pack index) keeps only these, so a
 * field it doesn't know never fails the spec; a direct registration stays strict.
 */
export const GUARDRAIL_SPEC_KEYS: readonly string[] = Object.keys(guardrailSchema.properties);
