// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * @kindgi/cli — the `kindgi` command-line interface.
 *
 * Projects add it as a devDependency and run `kindgi` through their
 * package manager (`pnpm exec kindgi …`). The programmatic surface below
 * is exposed for tests and for tools that embed CLI behavior without
 * spawning a subprocess.
 */

export { runCli } from './main.js';
export type { CliOutcome, RunCliInputs } from './main.js';
export { describeCommands, describeGlobalFlags } from './reference.js';
export type { CommandReference, FlagReference } from './reference.js';
