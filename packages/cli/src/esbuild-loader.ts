// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one way the CLI loads esbuild (a TypeScript pack's bundles, `kindgi
 * build` of a Node pack). The PyPI CLI (`kindgi-cli`) ships without it, for
 * Python packs only: there, a TypeScript pack gets a clear line naming the
 * npm CLI, not a module-not-found.
 */

import { cliInstall } from './package-manager.js';

export const PYPI_NO_BUNDLER =
  'This kindgi is the PyPI build (kindgi-cli), for Python packs: it has no TypeScript bundler. A TypeScript pack uses the npm CLI: npm install --save-dev @kindgi/cli, then npx kindgi …';

export async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch (err) {
    if (cliInstall() === 'pypi') throw new Error(PYPI_NO_BUNDLER);
    throw err;
  }
}
