// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The Node pack service (`@kindgi/handler-runtime`) and the TypeScript indexer. */

import { fileURLToPath } from 'node:url';

import { runIndexer } from '@kindgi/handler-runtime';

import { describePackServiceConformance, fixturePackDir } from '../src/index.js';

const packDir = fixturePackDir('node-pack');
// The built `@kindgi/handler-runtime/pack-service-main` (the package's exports are import-only).
const entrypoint = fileURLToPath(
  new URL('../node_modules/@kindgi/handler-runtime/dist/pack-service/main.js', import.meta.url),
);

describePackServiceConformance({
  name: 'node',
  packDir,
  command: [process.execPath, entrypoint],
  async buildIndex(outputPath, pins) {
    const outcome = await runIndexer({ packDir, outputPath, ...pins });
    if (outcome.kind === 'err') throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    if (outcome.value.fileErrors.length > 0) {
      throw new Error(outcome.value.fileErrors.map((e) => e.message).join('\n'));
    }
  },
});
