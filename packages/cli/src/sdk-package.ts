// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * Root directory of the `@kindgi/sdk` package the CLI depends on,
 * resolved by package name from the CLI's own location. Correct whether
 * the SDK is a workspace sibling, lives in a separate checkout linked into
 * the workspace, or is installed under `node_modules` — no repo-layout
 * assumption. `undefined` when it can't be resolved (broken install).
 */
export function resolveSdkPackageRoot(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('@kindgi/sdk/package.json'));
  } catch {
    return undefined;
  }
}
