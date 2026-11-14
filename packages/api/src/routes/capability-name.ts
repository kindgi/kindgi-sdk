// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The longest capability name: one a key is minted with, or one a person is given. */
export const MAX_CAPABILITY_LENGTH = 100;

/**
 * Whether `raw` can name a capability: a non-empty string of at most
 * {@link MAX_CAPABILITY_LENGTH} characters. Whether anyone may hold it is
 * the route's and the binding's to decide.
 */
export function isCapabilityName(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_CAPABILITY_LENGTH;
}
