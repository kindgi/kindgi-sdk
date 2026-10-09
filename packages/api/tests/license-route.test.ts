// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/license`: where the deployment's license key stands, read on
 * each request from the binding the deployment gives (the days left move),
 * for any signed-in caller; not mounted without one.
 */

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { type LicenseStatus, type TokenResolver, createApp } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const TOKEN = 'license-route-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId: 't-1' as TenantId, userId: 'u-1' as UserId } : null;

/** The app with what this route needs; the run handler is never called here. */
const base = () => ({ ...createStubAppBindings(), resolveToken, runHandler: {} as never });
const app = (license?: () => LicenseStatus) =>
  license === undefined
    ? createApp(base())
    : createApp({ ...base(), license: { status: license } });

const get = (a: ReturnType<typeof app>, token?: string) =>
  a.request(
    '/v1/license',
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  );

describe('GET /v1/license', () => {
  test('what the binding says, read on each request', async () => {
    let daysLeft = 31;
    const a = app(() => ({
      mode: 'licensed',
      name: 'acme.example',
      use: 'non-production',
      expiresAt: '2026-11-20T00:00:00.000Z',
      daysLeft,
      standing: daysLeft <= 30 ? 'expiring' : 'valid',
      ...(daysLeft <= 30 && {
        renew:
          'from this deployment (kindgi license renew …), or sign in at https://access.kindgi.com',
      }),
    }));
    const first = await get(a, TOKEN);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      mode: 'licensed',
      name: 'acme.example',
      use: 'non-production',
      expiresAt: '2026-11-20T00:00:00.000Z',
      daysLeft: 31,
      standing: 'valid',
    });
    daysLeft = 30;
    expect(await (await get(a, TOKEN)).json()).toMatchObject({
      daysLeft: 30,
      standing: 'expiring',
      renew: expect.stringContaining('kindgi license renew'),
    });
  });

  test('development: the mode alone', async () => {
    expect(
      await (
        await get(
          app(() => ({ mode: 'development' })),
          TOKEN,
        )
      ).json(),
    ).toEqual({ mode: 'development' });
  });

  test('signed in only; not mounted without a binding', async () => {
    expect((await get(app(() => ({ mode: 'development' })))).status).toBe(401);
    expect((await get(app(), TOKEN)).status).toBe(404);
  });
});
