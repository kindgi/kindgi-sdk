// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections` — the app entries a Kindgi server reads to connect
 * accounts at other apps, and `defineApp` to check one. The entries
 * themselves are subpaths: `@kindgi/connections/google`,
 * `@kindgi/connections/github`.
 */

export { APP_ID_PATTERN, PERMISSION_KEY_PATTERN, defineApp } from './define.js';
export type {
  AccountLookup,
  AppEntry,
  AppPermission,
  AppRateLimit,
  AppRemoval,
  ConnectionOwnerKind,
  SignIn,
} from './types.js';
