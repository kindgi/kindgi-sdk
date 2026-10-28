// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runtime`: which runtime answers, as the host passes it
 * (`CreateAppInput.runtime`). Any caller of a tenant reads it; without the
 * input the route isn't mounted.
 */

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { type RuntimeInfo, type TokenResolver, createApp } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

const MEMBER = 'runtime-route-member';

const resolveToken: TokenResolver = async (token) =>
  token === MEMBER ? { tenantId: 't-1' as TenantId, userId: 'u-member' as UserId } : null;

function makeApp(runtime: RuntimeInfo | undefined) {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as never,
    ...(runtime !== undefined && { runtime }),
  });
  return async (token?: string) => {
    const res = await app.request(
      '/v1/runtime',
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (a 404 from no route): the status says it.
    }
    return { status: res.status, body };
  };
}

describe('GET /v1/runtime', () => {
  test('answers a caller of the tenant with its version, how it is hosted and whether it runs in development mode', async () => {
    const info: RuntimeInfo = { version: '0.3.0', hosting: 'self-hosted', development: false };
    const answer = await makeApp(info)(MEMBER);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(info);
    expect(validateAgainst('RuntimeInfo', answer.body)).toEqual([]);
  });

  test('a hosted runtime built outside a release, in development mode', async () => {
    const info: RuntimeInfo = { version: 'dev', hosting: 'hosted', development: true };
    const answer = await makeApp(info)(MEMBER);
    expect(answer.body).toEqual(info);
    expect(validateAgainst('RuntimeInfo', answer.body)).toEqual([]);
  });

  test("only the three fields: nothing else on the host's object reaches the wire", async () => {
    const info = {
      version: '0.3.0',
      hosting: 'hosted',
      development: false,
      licenseKeyRef: 'gcp:projects/acme-prod/secrets/kindgi-license-key',
    } as RuntimeInfo;
    const answer = await makeApp(info)(MEMBER);
    expect(answer.body).toEqual({ version: '0.3.0', hosting: 'hosted', development: false });
  });

  test('a caller who is not signed in gets 401', async () => {
    const info: RuntimeInfo = { version: '0.3.0', hosting: 'self-hosted', development: false };
    const get = makeApp(info);
    expect((await get()).status).toBe(401);
    expect((await get('not-a-token')).status).toBe(401);
  });

  test("without the host's input the route isn't mounted: 404, as on a runtime that doesn't report it", async () => {
    expect((await makeApp(undefined)(MEMBER)).status).toBe(404);
  });
});
