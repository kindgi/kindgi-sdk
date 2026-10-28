// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { AppEnv } from '../types.js';

/**
 * A list's `?includeRetired=true`: retired items too (no active version),
 * each as its highest version with `unregisteredAt`. Anything else →
 * items with an active version only (the default). Spread into a
 * binding's list input, so the input names it only when it's asked for.
 */
export function includeRetiredOf(c: Context<AppEnv>): { readonly includeRetired?: true } {
  return c.req.query('includeRetired') === 'true' ? { includeRetired: true } : {};
}
