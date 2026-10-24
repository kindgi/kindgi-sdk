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
   * Steps after the install, before the prune. With any, the image's
   * install takes dev dependencies too (a generator's CLI), and the prune
   * after the steps drops them. Run in the pack folder.
   */
  readonly postInstall?: readonly BuildStep[];
  /**
   * Env for the build steps, and for the indexer stage that imports the
   * pack's modules: non-secret placeholders only. Never in the final
   * image.
   */
  readonly buildEnv?: Readonly<Record<string, string>>;
  /**
   * What an image that carries only what the pack loads keeps besides
   * the pack's imports: packages, or a generated folder (`.prisma/client`),
   * by the name Node resolves (see `ImageConfig.keep`).
   */
  readonly keep?: readonly string[];
}

/** `image` in `kindgi.config.*` (a TypeScript pack). */
export interface ImageConfig {
  /** Debian packages the image needs (as a Python pack's `[tool.kindgi.image] system-packages`). */
  readonly systemPackages?: readonly string[];
  readonly extensions?: readonly BuildExtension[];
  /** Env for the build steps, merged over the extensions' (see `BuildExtension.buildEnv`). */
  readonly buildEnv?: Readonly<Record<string, string>>;
  /**
   * Which installed dependencies the image carries:
   *   - `'all'` (the default): every production dependency of the app;
   *   - `'loaded'`: only the packages the pack's code imports, with their
   *     own dependencies, and what `keep` names. The build fails, naming
   *     the package, when one the code loads would be missing.
   */
  readonly dependencies?: 'loaded' | 'all';
  /**
   * With `dependencies: 'loaded'`, packages the code loads without
   * importing them by name (a plugin named in a config string, a
   * package whose bin a tool runs), kept with their own dependencies.
   */
  readonly keep?: readonly string[];
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
    // Prisma 6's `prisma-client-js` client loads the generated
    // `.prisma/client`, which no package declares. Prisma 7's client is
    // generated into the app's source, so the bundles carry it.
    keep: ['.prisma/client'],
  };
}
