// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCliPackage } from './cli-package.js';
import { resolveSdkPackageRoot } from './sdk-package.js';

/**
 * The running CLI's and SDK's versions, read from their `package.json`
 * the way `kindgi init` resolves them (`resolveCliPackage`,
 * `resolveSdkPackageRoot`), so a release never has to bump a constant.
 * `'unknown'` only for a broken install.
 */
export const CLI_VERSION: string = resolveCliPackage()?.version ?? 'unknown';
export const SDK_VERSION: string = sdkVersion() ?? 'unknown';

function sdkVersion(): string | undefined {
  const root = resolveSdkPackageRoot();
  if (root === undefined) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
