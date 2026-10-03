// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/build` — a TypeScript pack image's build extensions, for
 * `image` in `kindgi.config.*` (`systemPackages`, `extensions`,
 * `buildEnv`).
 *
 * Re-exports `@kindgi/handler-runtime/build-extensions` verbatim.
 */

export { defineBuildExtension, prisma } from '@kindgi/handler-runtime/build-extensions';
export type {
  BuildExtension,
  BuildStep,
  ImageConfig,
  PrismaExtensionOptions,
} from '@kindgi/handler-runtime/build-extensions';
