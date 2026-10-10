// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { defineConfig } from 'tsup';

/**
 * Bundle @kindgi/client for external distribution.
 *
 * - ESM (index.js) + CJS (index.cjs) for consumer-side compat.
 * - Types bundled into a single index.d.ts — every workspace `import
 *   type` (from @kindgi/{types,agents,runtime,platform,flow}) is
 *   inlined by tsup's dts step, so consumers don't need those
 *   packages installed to use the SDK's TypeScript surface.
 * - Runtime deps: only `zod` stays external — consumers install it
 *   directly. Everything else (typed-openapi generated schemas +
 *   hand-written resource clients + Transport + KindgiApiError +
 *   readSse) is bundled.
 */
export default defineConfig({
  // `sso-handoff` has no dependencies, so a browser app can take it alone.
  entry: ['src/index.ts', 'src/sso-handoff.ts'],
  format: ['esm', 'cjs'],
  // Types are bundled by a separate dts-bundle-generator pass in the
  // build script — rollup-plugin-dts (tsup's dts step) can't resolve
  // @kindgi/types's `export *`-from-submodules pattern cleanly.
  dts: false,
  // Sourcemaps ship as separate .map files that we EXCLUDE from the
  // published tarball (see `files` in package.json). Local `pnpm build`
  // still emits them for in-workspace debugging.
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['zod'],
  splitting: false,
  treeshake: true,
});
