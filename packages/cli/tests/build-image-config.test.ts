// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `image` in a TypeScript pack's `kindgi.config` (`@kindgi/sdk/build`):
 * read, checked, and resolved into what the Containerfile renders.
 */

import { defineBuildExtension, prisma } from '@kindgi/handler-runtime/build-extensions';
import { describe, expect, test } from 'vitest';

import { readImageConfig } from '../src/build/image-config.js';

describe('prisma()', () => {
  test('copies the schema (and config) and runs prisma generate with the one the app has', () => {
    expect(prisma({ schema: 'prisma/schema.prisma' })).toEqual({
      name: 'prisma',
      contextFiles: ['prisma/schema.prisma'],
      postInstall: [{ bin: 'prisma', args: ['generate', '--schema', 'prisma/schema.prisma'] }],
      keep: ['.prisma/client'],
    });
    expect(prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })).toEqual({
      name: 'prisma',
      contextFiles: ['prisma/schema.prisma', 'prisma.config.ts'],
      postInstall: [{ bin: 'prisma', args: ['generate', '--config', 'prisma.config.ts'] }],
      keep: ['.prisma/client'],
    });
  });
});

describe('readImageConfig', () => {
  test('absent: nothing beyond the install', () => {
    expect(readImageConfig({})).toEqual({
      kind: 'ok',
      image: {
        systemPackages: [],
        buildEnv: {},
        contextFiles: [],
        steps: [],
        extensions: [],
        dependencies: 'all',
        keep: [],
        keepIfInstalled: [],
      },
    });
  });

  test("merges the config's and the extensions' parts: packages deduplicated, the config's env wins", () => {
    const ocr = defineBuildExtension({
      name: 'ocr',
      systemPackages: ['tesseract-ocr', 'poppler-utils'],
      buildEnv: { OCR_LANG: 'eng', DATABASE_URL: 'from-the-extension' },
    });
    expect(
      readImageConfig({
        image: {
          systemPackages: ['tesseract-ocr'],
          extensions: [prisma({ schema: 'prisma/schema.prisma' }), ocr],
          buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
        },
      }),
    ).toEqual({
      kind: 'ok',
      image: {
        systemPackages: ['poppler-utils', 'tesseract-ocr'],
        buildEnv: { DATABASE_URL: 'postgresql://build-placeholder', OCR_LANG: 'eng' },
        contextFiles: ['prisma/schema.prisma'],
        steps: [
          {
            extension: 'prisma',
            bin: 'prisma',
            args: ['generate', '--schema', 'prisma/schema.prisma'],
          },
        ],
        extensions: ['prisma', 'ocr'],
        dependencies: 'all',
        keep: [],
        keepIfInstalled: ['.prisma/client'],
      },
    });
  });

  test("dependencies and keep: 'loaded' with the config's keep; an extension's keep only if installed", () => {
    const read = readImageConfig({
      image: {
        dependencies: 'loaded',
        keep: ['pino-pretty', '@acme/plugin', 'pino-pretty'],
        extensions: [prisma({ schema: 'prisma/schema.prisma' })],
      },
    });
    expect(read.kind === 'ok' && read.image).toMatchObject({
      dependencies: 'loaded',
      keep: ['@acme/plugin', 'pino-pretty'],
      keepIfInstalled: ['.prisma/client'],
    });
  });

  test("a name in both is the config's: it fails the build when it isn't installed", () => {
    const read = readImageConfig({
      image: { keep: ['.prisma/client'], extensions: [prisma({ schema: 'prisma/schema.prisma' })] },
    });
    expect(read.kind === 'ok' && read.image).toMatchObject({
      keep: ['.prisma/client'],
      keepIfInstalled: [],
    });
  });

  test.each([
    [{ image: 'big' }, 'must be an object'],
    [
      { image: { node: '24' } },
      '`node`: it takes systemPackages, extensions, buildEnv, dependencies and keep',
    ],
    [
      { image: { dependencies: 'some' } },
      "`image.dependencies` is 'loaded' (only what the pack's code loads) or 'all'",
    ],
    [{ image: { keep: 'pino-pretty' } }, '`image.keep` must be a list of package names'],
    [{ image: { keep: ['../secret'] } }, '`image.keep`: "../secret" isn\'t a package name'],
    [{ image: { keep: ['/abs/path'] } }, "isn't a package name"],
    [{ image: { keep: ['two words'] } }, "isn't a package name"],
    [{ image: { extensions: [{ name: 'x', keep: [7] }] } }, "(x) keep`: 7 isn't a package name"],
    [{ image: { systemPackages: ['Not A Package'] } }, 'not a Debian package name'],
    [{ image: { extensions: [{}] } }, 'image.extensions[0] has no `name`'],
    [
      { image: { extensions: [{ name: 'x', contextFiles: ['../secret.ts'] }] } },
      "isn't inside the pack folder",
    ],
    [{ image: { extensions: [{ name: 'x', contextFiles: ['.env'] }] } }, 'secret-shaped file'],
    [
      { image: { extensions: [{ name: 'x', postInstall: [{ bin: 'rm -rf /' }] }] } },
      'needs a `bin`',
    ],
    [{ image: { buildEnv: { 'not a name': 'x' } } }, "isn't an env name"],
    [{ image: { buildEnv: { PORT: 8080 } } }, 'PORT must be a string'],
  ])('%j is refused: %s', (config, message) => {
    const read = readImageConfig(config);
    expect(read.kind).toBe('invalid');
    expect(read.kind === 'invalid' && read.message).toContain(message);
  });
});
