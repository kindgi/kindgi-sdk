// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi env`. Every filesystem side-effect
 * flows through this shape so tests substitute fixtures — no real
 * `.env.<envName>` files touch disk during unit tests.
 *
 * Production wiring lives at `packages/cli/src/env/defaults.ts`; tests
 * pass `RunCliInputs.envRunners` with in-memory stubs.
 */

export interface EnvRunners {
  /**
   * Read `path` as UTF-8. Returns `null` when the file does not exist;
   * throws for any other IO error.
   */
  readonly readFile: (path: string) => Promise<string | null>;
  /**
   * Write `contents` to `path`. `mkdir -p` on the parent dir is the
   * caller's job (env files sit next to `kindgi.config.ts`, which
   * always exists).
   */
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}
