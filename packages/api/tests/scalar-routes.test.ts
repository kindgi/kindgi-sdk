// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const noopResolveToken: TokenResolver = async () => ({ tenantId: 't' as TenantId });
const noopRunHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

describe('Scalar docs UI mount', () => {
  test('opt-in via `openapi.docs: true` serves HTML at /docs', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
      openapi: { docs: true },
    });
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase()).toContain('text/html');
    const body = await res.text();
    // The Scalar payload must reference the openapi.json we mount.
    expect(body).toContain('/v1/openapi.json');
    // Default title.
    expect(body).toContain('Kindgi API');
  });

  test('custom mount path is respected; default /docs is NOT mounted', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
      openapi: { docs: { path: '/reference' } },
    });
    const res = await app.request('/reference');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase()).toContain('text/html');

    const defaultPath = await app.request('/docs');
    expect(defaultPath.status).toBe(404);
  });

  test('opt-out (openapi.docs absent) — /docs returns 404', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
    });
    const res = await app.request('/docs');
    expect(res.status).toBe(404);
  });

  test('custom title flows through to the rendered page', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
      openapi: { docs: { title: 'Acme Legal API' } },
    });
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Acme Legal API');
  });

  test('docs mount is public — no bearer chain required', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null, // Would reject any bearer.
      runHandler: noopRunHandler,
      openapi: { docs: true },
    });
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
  });
});
