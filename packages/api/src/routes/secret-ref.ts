// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type EnvName, makeEnvName } from '@kindgi/types';

/** The longest secret name a `secretRef` can carry. */
export const MAX_SECRET_NAME_LENGTH = 256;

const SECRET_REF_FIELDS = new Set(['envName', 'name']);

/**
 * `{ envName, name }`: a secret by name in the deployment's secrets
 * store, resolved at the owner's scope. The shape webhooks, MCP
 * endpoints and providers share. `field` names it in messages.
 */
export function parseSecretRef(
  raw: unknown,
  field = 'secretRef',
):
  | { readonly kind: 'ok'; readonly value: { readonly envName: EnvName; readonly name: string } }
  | { readonly kind: 'err'; readonly message: string; readonly unknownField?: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'err', message: `\`${field}\` must be an object \`{ envName, name }\`` };
  }
  const ref = raw as Record<string, unknown>;
  const unknown = Object.keys(ref).find((key) => !SECRET_REF_FIELDS.has(key));
  if (unknown !== undefined) {
    return {
      kind: 'err',
      message: `Unknown field \`${field}.${unknown}\``,
      unknownField: `${field}.${unknown}`,
    };
  }
  const envName = typeof ref.envName === 'string' ? makeEnvName(ref.envName) : null;
  if (envName === null) {
    return {
      kind: 'err',
      message: `\`${field}.envName\` must be a lowercase name (letters, digits, hyphens)`,
    };
  }
  if (
    typeof ref.name !== 'string' ||
    ref.name.length === 0 ||
    ref.name.length > MAX_SECRET_NAME_LENGTH
  ) {
    return {
      kind: 'err',
      message: `\`${field}.name\` must be a non-empty string of at most ${MAX_SECRET_NAME_LENGTH} characters`,
    };
  }
  return { kind: 'ok', value: { envName, name: ref.name } };
}
