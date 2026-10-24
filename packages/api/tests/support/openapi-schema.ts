// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Validate a value against one of `openapi.json`'s component schemas, as the clients read it. */

import { readFileSync } from 'node:fs';

import { compileInlineSchema } from '@kindgi/schema';

const COMPONENTS = JSON.parse(
  JSON.stringify(
    (
      JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
        components: { schemas: Record<string, unknown> };
      }
    ).components.schemas,
  ).replaceAll('#/components/schemas/', '#/$defs/'),
  // OpenAPI's `discriminator` only names the property that picks a `oneOf` branch, and the
  // validator's strict mode refuses it; the `oneOf` next to it still checks the shape.
  (key, value) =>
    key === 'discriminator' && value?.propertyName !== undefined ? undefined : value,
) as Record<string, unknown>;

/** The schema's errors for `data` (as it reaches the wire: JSON); none when it fits. */
export function validateAgainst(name: string, data: unknown): readonly unknown[] {
  const compiled = compileInlineSchema({ $defs: COMPONENTS, $ref: `#/$defs/${name}` });
  if (compiled.kind === 'err') throw new Error(compiled.error.message);
  const result = compiled.value.validate(data);
  return result.kind === 'ok' ? [] : result.error.errors;
}
