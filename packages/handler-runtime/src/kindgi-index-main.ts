// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `kindgi-index` process: `node <this file> --pack-dir … [--bundle-map …]`
 * (package export `@kindgi/handler-runtime/kindgi-index-main`). A pack
 * image's indexer stage runs it, bundled as `dist/kindgi-index.mjs`.
 *
 * A module of its own that runs `main()` as it loads, rather than a
 * process-entry check inside `kindgi-index.ts`: bundled, every module in
 * a bundle shares the bundle's `import.meta.url`, so such a check would
 * also fire in the pack service's bundle, which imports `kindgi-index`.
 */

import { main } from './kindgi-index.js';

process.exitCode = await main(process.argv.slice(2));
