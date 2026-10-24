// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `kindgi-closure` process: `node <this file> trim|check …` (package
 * export `@kindgi/handler-runtime/kindgi-closure-main`). A pack image's
 * closure and indexer stages run it, bundled as `dist/kindgi-closure.mjs`.
 * A module of its own that runs `main()` as it loads, as
 * `kindgi-index-main` does.
 */

import { main } from './kindgi-closure.js';

process.exitCode = await main(process.argv.slice(2));
