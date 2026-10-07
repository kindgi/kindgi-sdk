// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `loadEsbuild`: the PyPI CLI ships without esbuild, so a TypeScript pack
 * there gets a line naming the npm CLI, not a module-not-found.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('esbuild', () => {
  throw new Error("Cannot find package 'esbuild'");
});

const { PYPI_NO_BUNDLER, loadEsbuild } = await import('../src/esbuild-loader.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadEsbuild without esbuild', () => {
  test('from the PyPI CLI: the line that names the npm CLI', async () => {
    vi.stubEnv('KINDGI_CLI_INSTALL', 'pypi');
    await expect(loadEsbuild()).rejects.toThrow(PYPI_NO_BUNDLER);
  });

  test('from the npm CLI: the original error', async () => {
    vi.stubEnv('KINDGI_CLI_INSTALL', '');
    await expect(loadEsbuild()).rejects.not.toThrow(PYPI_NO_BUNDLER);
  });
});
