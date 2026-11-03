// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * In a pack image that keeps only what the pack loads, a tool that loads
 * a package the image dropped says which one, and what to do.
 */

import { describe, expect, test } from 'vitest';

import { missingPackageHint } from '../src/handler-runner.js';

const LOADED = { KINDGI_IMAGE_DEPENDENCIES: 'loaded' };

function notFound(message: string, code = 'ERR_MODULE_NOT_FOUND'): Error {
  return Object.assign(new Error(message), { code });
}

describe('missingPackageHint', () => {
  test('a missing package, from ESM or CommonJS: named, with image.keep and the fallback', () => {
    expect(
      missingPackageHint(
        notFound("Cannot find package 'pino-pretty' imported from /app/dist/log.mjs"),
        LOADED,
      ),
    ).toBe(
      ". pino-pretty isn't in this pack image, which keeps only the packages the pack's code imports by name: add it to image.keep in kindgi.config, or set image.dependencies: 'all'",
    );
    expect(
      missingPackageHint(
        notFound(
          "Cannot find module '@acme/plugin/sub'\nRequire stack:\n- /app/dist/x.mjs",
          'MODULE_NOT_FOUND',
        ),
        LOADED,
      ),
    ).toContain('. @acme/plugin isn');
  });

  test("nothing when the image keeps every dependency, or it isn't a missing package", () => {
    const error = notFound("Cannot find package 'pino-pretty' imported from /app/dist/log.mjs");
    expect(missingPackageHint(error, {})).toBe('');
    expect(
      missingPackageHint(notFound("Cannot find module '/app/node_modules/x/lib/y.js'"), LOADED),
    ).toBe('');
    expect(missingPackageHint(notFound("Cannot find module './local.js'"), LOADED)).toBe('');
    expect(missingPackageHint(new Error('ECONNREFUSED'), LOADED)).toBe('');
    expect(missingPackageHint('a string', LOADED)).toBe('');
  });
});
