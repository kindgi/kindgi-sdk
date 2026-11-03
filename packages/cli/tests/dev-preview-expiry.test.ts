// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s warning for a preview runtime near the end of its life:
 * from 30 days before (and once past it), with the way to a newer one,
 * which depends on which runtime it runs; nothing otherwise.
 */

import { describe, expect, test } from 'vitest';

import type { LicenseStatus } from '@kindgi/client';

import {
  devRuntimeSource,
  previewExpiryWarning,
  previewRefusalHint,
  readLicenseStatus,
} from '../src/dev/preview-expiry.js';
import { DEFAULT_RUNTIME_IMAGE } from '../src/dev/runtime-image.js';

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
      '⚠ This preview runtime (0.1.8) stops starting on 2027-01-18, in 20 days. A preview release stops starting 90 days after it was released. Update the Kindgi CLI (`@kindgi/cli`, or `kindgi-cli` from PyPI) to its newest release: `kindgi dev` runs the runtime release the CLI pins.',
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
  const notUsed = async (): Promise<never> => {
    throw new Error('not used: only the status is read');
  };
  expect(await readLicenseStatus({} as never)).toBeUndefined();
  expect(
    await readLicenseStatus({
      license: {
        get: async () => {
          throw new Error('route-not-found');
        },
        usage: notUsed,
      },
    }),
  ).toBeUndefined();
  const status = preview(20, 'expiring');
  expect(await readLicenseStatus({ license: { get: async () => status, usage: notUsed } })).toBe(
    status,
  );
});

describe('a runtime that refused to start because its preview build is past its end', () => {
  const stop =
    'the Kindgi runtime container stopped while starting (exit code 2):\nThis preview build of the Kindgi runtime (0.1.8, released 2026-10-20) expired on 2027-01-18: a preview release stops starting 90 days after it was released. Run a newer release. With `kindgi dev`, update the Kindgi CLI (`@kindgi/cli`, or `kindgi-cli` from PyPI): it runs the runtime release the CLI pins.';

  test('which runtime kindgi dev runs, from its flags', () => {
    expect(devRuntimeSource({ runtimeUrl: undefined, runtimeImage: DEFAULT_RUNTIME_IMAGE })).toBe(
      'pinned',
    );
    expect(
      devRuntimeSource({ runtimeUrl: undefined, runtimeImage: 'quay.io/acme/runtime:0.1.8' }),
    ).toBe('image');
    expect(
      devRuntimeSource({
        runtimeUrl: 'http://127.0.0.1:4000',
        runtimeImage: DEFAULT_RUNTIME_IMAGE,
      }),
    ).toBe('url');
  });

  test('an image of your own: the way to a newer one is added; the pinned one says it already', () => {
    expect(previewRefusalHint(stop, 'image')).toBe(
      '\nRun a newer runtime image (`--runtime-image`), or drop the flag to run the one this CLI pins.',
    );
    expect(previewRefusalHint(stop, 'pinned')).toBe('');
  });

  test('any other stop: nothing added', () => {
    expect(
      previewRefusalHint(
        'the Kindgi runtime container stopped while starting (exit code 1):\nboom',
        'image',
      ),
    ).toBe('');
  });
});
