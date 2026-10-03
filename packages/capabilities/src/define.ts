// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createSpecRegistry } from '@kindgi/schema';
import type { SpecRegistry } from '@kindgi/schema';
import type { Result } from '@kindgi/types';

import capabilitySchema from './capability.schema.json' with { type: 'json' };
import type { InvalidCapabilityError } from './errors.js';
import type { Capability } from './types.js';

const CAPABILITY_SCHEMA_ID = 'https://kindgi.com/schemas/v1/capability.schema.json';

let cachedRegistry: SpecRegistry | undefined;
function registry(): SpecRegistry {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const built = createSpecRegistry([capabilitySchema]);
  if (built.kind === 'err') {
    throw new Error(
      `@kindgi/capabilities: bundled schema failed to compile: ${built.error.message}`,
    );
  }
  cachedRegistry = built.value;
  return cachedRegistry;
}

/**
 * Validate a capability declaration against `@kindgi/specs/capability.schema.json`
 * and return a typed `Capability` on success. Called by pack authors at
 * agent construction — a rejection here surfaces at pack init, well
 * before any user request touches the flow.
 */
export function defineCapability(spec: Capability): Result<Capability, InvalidCapabilityError> {
  const r = registry().validate<Capability>(CAPABILITY_SCHEMA_ID, spec);
  if (r.kind === 'ok') return r;
  const err = r.error;
  if (err.code !== 'validation-error') {
    throw new Error(`@kindgi/capabilities: unexpected schema error ${err.code}: ${err.message}`);
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
    error: { code: 'invalid-capability', message: err.message, issues },
  };
}

/** The `$id` of the JSON Schema this loader validates against. */
export const CAPABILITY_SCHEMA_URI = CAPABILITY_SCHEMA_ID;
