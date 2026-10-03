// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A TypeScript pack image's build extensions: what an app's image needs
 * beyond installing the app's dependencies — Debian packages, a step
 * that generates code after the install (Prisma's client), placeholder
 * env for build steps. `image` in `kindgi.config.*`:
 *
 * ```ts
 * import { prisma } from '@kindgi/sdk/build';
 *
 * export default {
 *   pack: { id: 'acme.app', version: '1.0.0' },
 *   image: {
 *     systemPackages: ['tesseract-ocr'],
 *     extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
 *     buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
 *   },
 * };
 * ```
 *
 * Data only: nothing here runs at build time. `kindgi build` renders it
 * into the image's Containerfile — system packages in the base stage,
 * `buildEnv` in the install stage only (never in the final image), each
 * `postInstall` step after the install and before the prune to
 * production, through the app's own package manager.
 */

/** A package's bin, run through the app's package manager (`pnpm exec`, `npx --no`, `yarn`). */
export interface BuildStep {
  readonly bin: string;
  readonly args?: readonly string[];
}

export interface BuildExtension {
  readonly name: string;
  /**
   * Files the steps read, relative to the pack folder: copied into the
   * image's install stage, at the same paths.
   */
  readonly contextFiles?: readonly string[];
  /** Debian packages the image needs. */
  readonly systemPackages?: readonly string[];
  /**
   * Steps after the install, before the prune: dev dependencies (a
   * generator's CLI) are still there. Run in the pack folder.
   */
  readonly postInstall?: readonly BuildStep[];
  /**
   * Env for the build steps, and for the indexer stage that imports the
   * pack's modules: non-secret placeholders only. Never in the final
   * image.
   */
  readonly buildEnv?: Readonly<Record<string, string>>;
}

/** `image` in `kindgi.config.*` (a TypeScript pack). */
export interface ImageConfig {
  /** Debian packages the image needs (as a Python pack's `[tool.kindgi.image] system-packages`). */
  readonly systemPackages?: readonly string[];
  readonly extensions?: readonly BuildExtension[];
  /** Env for the build steps, merged over the extensions' (see `BuildExtension.buildEnv`). */
  readonly buildEnv?: Readonly<Record<string, string>>;
}

/** An app's own extension: the shape checked by the type, returned as is. */
export function defineBuildExtension(extension: BuildExtension): BuildExtension {
  return extension;
}

export interface PrismaExtensionOptions {
  /** The Prisma schema, relative to the pack folder. */
  readonly schema: string;
  /** The Prisma config file (`prisma.config.ts`), when the app has one; it names the schema. */
  readonly config?: string;
}

/**
 * Prisma's generated client in the image. The app's own `postinstall:
 * prisma generate` doesn't run (the image installs with scripts off), so
 * this copies the schema (and config) in and runs `prisma generate` after
 * the install, with the app's `prisma` CLI.
 */
export function prisma(options: PrismaExtensionOptions): BuildExtension {
  return {
    name: 'prisma',
    contextFiles:
      options.config !== undefined ? [options.schema, options.config] : [options.schema],
    postInstall: [
      {
        bin: 'prisma',
        args:
          options.config !== undefined
            ? ['generate', '--config', options.config]
            : ['generate', '--schema', options.schema],
      },
    ],
  };
}
