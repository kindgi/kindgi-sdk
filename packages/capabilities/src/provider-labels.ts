// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ProviderMetadata.labels`: string keys to string values, for whoever
 * manages a provider to record that it does. The router ignores them.
 *
 * One validator, used where a provider is registered in-process
 * (`createProviderRegistry`) and over the wire (`POST /v1/providers`),
 * so the two accept the same labels.
 */

/** The convention key for who manages a provider: `kindgi-dev`, `kindgi-dev:<pack id>`, `kindgi-deploy:<environment>`. */
export const PROVIDER_LABEL_MANAGED_BY = 'kindgi.com/managed-by';

export const PROVIDER_LABELS_MAX_KEYS = 32;
export const PROVIDER_LABEL_VALUE_MAX_LENGTH = 256;

/** 1–63 characters: lowercase letters and digits, with `.`, `-`, `_` or `/` inside. */
export const PROVIDER_LABEL_KEY = /^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$/;

/**
 * `undefined` when `labels` is absent or well formed; otherwise why not,
 * as the `invalid-provider` error's `message` and `reason`.
 */
export function validateProviderLabels(
  providerId: string,
  labels: unknown,
): { readonly message: string; readonly reason: 'invalid-labels' } | undefined {
  if (labels === undefined) return undefined;
  const invalid = (detail: string) => ({
    message: `provider "${providerId}" labels ${detail}`,
    reason: 'invalid-labels' as const,
  });
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return invalid('must be an object of string keys to string values');
  }
  const entries = Object.entries(labels);
  if (entries.length > PROVIDER_LABELS_MAX_KEYS) {
    return invalid(`may have at most ${PROVIDER_LABELS_MAX_KEYS} keys (got ${entries.length})`);
  }
  for (const [key, value] of entries) {
    if (!PROVIDER_LABEL_KEY.test(key)) {
      return invalid(
        `key "${key}" must be 1-63 lowercase letters and digits, with ".", "-", "_" or "/" inside`,
      );
    }
    if (typeof value !== 'string') {
      return invalid(`value of "${key}" must be a string`);
    }
    if (value.length > PROVIDER_LABEL_VALUE_MAX_LENGTH) {
      return invalid(
        `value of "${key}" may be at most ${PROVIDER_LABEL_VALUE_MAX_LENGTH} characters (got ${value.length})`,
      );
    }
  }
  return undefined;
}
