// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The running `@kindgi/cli` package — its root, version, and the SDK spec it depends on. */
export interface CliPackageInfo {
  readonly root: string;
  readonly version: string;
  /** `dependencies['@kindgi/sdk']` — `workspace:*` in a checkout, a version once published. */
  readonly sdkDependency: string | undefined;
}

/**
 * Walk up from this module to the `package.json` named `@kindgi/cli`.
 * Works from `src/` (tests) and `dist/` (built), in a checkout or under
 * `node_modules`. Companion to `resolveSdkPackageRoot` — no repo-layout
 * assumption. `undefined` when not found (broken install).
 */
export function resolveCliPackage(): CliPackageInfo | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const info = readCliPackageJson(join(dir, 'package.json'));
    if (info !== undefined) return { root: dir, ...info };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readCliPackageJson(
  path: string,
): { readonly version: string; readonly sdkDependency: string | undefined } | undefined {
  let pkg: { name?: unknown; version?: unknown; dependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8')) as typeof pkg;
  } catch {
    return undefined;
  }
  if (pkg.name !== '@kindgi/cli' || typeof pkg.version !== 'string') return undefined;
  const sdk = pkg.dependencies?.['@kindgi/sdk'];
  return { version: pkg.version, sdkDependency: typeof sdk === 'string' ? sdk : undefined };
}
