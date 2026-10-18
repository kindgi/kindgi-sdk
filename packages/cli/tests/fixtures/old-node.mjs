// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Node 20.11.0 as the built CLI sees it (`process.versions.node`), with the
// load hooks in `old-node-hooks.mjs`: a module past the CLI's Node check
// fails to load. Preloaded:
//
//   node --import ./old-node.mjs dist/cli.js <args...>

import { register } from 'node:module';

Object.defineProperty(process.versions, 'node', { value: '20.11.0' });
register('./old-node-hooks.mjs', import.meta.url);
