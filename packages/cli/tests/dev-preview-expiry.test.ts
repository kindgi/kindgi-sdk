// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s warning for a preview runtime near the end of its life:
 * from 30 days before (and once past it), with the way to a newer one,
 * which depends on which runtime it runs; nothing otherwise.
 */

import { describe, expect, test } from 'vitest';

import type { LicenseStatus } from '@kindgi/client';

import { previewExpiryWarning, readLicenseStatus } from '../src/dev/preview-expiry.js';

const preview = (daysLeft: number, standing: 'valid' | 'expiring' | 'expired'): LicenseStatus => ({
  mode: 'development',
  preview: {
    version: '0.1.8',
    releasedAt: '2026-10-20T14:00:00.000Z',
    expiresAt: '2027-01-18T14:00:00.000Z',
    daysLeft,
    standing,
  },
});

describe('previewExpiryWarning', () => {
  test('from 30 days before: the date, the days left, and to update the CLI that pins it', () => {
    expect(previewExpiryWarning(preview(20, 'expiring'), 'pinned')).toBe(
      '⚠ This preview runtime (0.1.8) stops starting on 2027-01-18, in 20 days. Preview releases stop starting 90 days after their release, until Kindgi 1.0. Update the Kindgi CLI (`@kindgi/cli`, or `kindgi-cli` from PyPI) to its newest release: `kindgi dev` runs the runtime release the CLI pins.',
    );
    expect(previewExpiryWarning(preview(1, 'expiring'), 'pinned')).toContain('in 1 day.');
  });

  test('past it, on a runtime started before: it runs on, but won’t start again', () => {
    expect(previewExpiryWarning(preview(-2, 'expired'), 'pinned')).toContain(
      "expired on 2027-01-18: it runs on, but won't start again.",
    );
  });

  test('the way to a newer one follows the runtime kindgi dev runs', () => {
    expect(previewExpiryWarning(preview(9, 'expiring'), 'image')).toContain(
      'Run a newer runtime image (`--runtime-image`), or drop the flag to run the one this CLI pins.',
    );
    expect(previewExpiryWarning(preview(9, 'expiring'), 'url')).toContain(
      'Run a newer runtime release at `--runtime-url`.',
    );
  });

  test('nothing to say: more than 30 days left, no expiry, or a runtime too old to report it', () => {
    expect(previewExpiryWarning(preview(45, 'valid'), 'pinned')).toBeUndefined();
    expect(previewExpiryWarning({ mode: 'licensed', use: 'production' }, 'pinned')).toBeUndefined();
    expect(previewExpiryWarning(undefined, 'pinned')).toBeUndefined();
  });
});

test("a status it can't read says nothing, and never stops kindgi dev", async () => {
  expect(await readLicenseStatus({} as never)).toBeUndefined();
  expect(
    await readLicenseStatus({
      license: {
        get: async () => {
          throw new Error('route-not-found');
        },
      },
    }),
  ).toBeUndefined();
  const status = preview(20, 'expiring');
  expect(await readLicenseStatus({ license: { get: async () => status } })).toBe(status);
});
