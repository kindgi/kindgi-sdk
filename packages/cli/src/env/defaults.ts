// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for `kindgi env`. Loaded lazily by `main.ts`.
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { EnvRunners } from './runners.js';

export const REAL_ENV_RUNNERS: EnvRunners = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents, 'utf8');
  },
};
