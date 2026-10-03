// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_PROVIDER_CONFIG = {
  providerId: 'google',
  kind: 'oidc',
  displayName: 'Google Workspace',
};

describe('auth — wire round-trips', () => {
  it('providers.{list,register,unregister} + login/callback/refresh/logout', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [SAMPLE_PROVIDER_CONFIG] }) },
      { status: 201, body: JSON.stringify({ providerId: 'google' }) },
      { status: 200, body: JSON.stringify({ providerId: 'google', unregistered: true }) },
      {
        status: 200,
        body: JSON.stringify({ authorizationUrl: 'https://google/oauth?...', state: 'nonce' }),
      },
      { status: 201, body: JSON.stringify({ sessionToken: 'kgi_sk_...', sessionId: 's1' }) },
      { status: 200, body: JSON.stringify({ sessionToken: 'kgi_sk_...refreshed' }) },
      { status: 200, body: JSON.stringify({ revoked: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.auth.providers.list();
    await client.auth.providers.register(SAMPLE_PROVIDER_CONFIG as never);
    await client.auth.providers.unregister('google');
    await client.auth.login('google', { redirectUri: 'https://console/callback' } as never);
    await client.auth.callback('google', {
      code: 'authcode',
      state: 'nonce',
    } as never);
    await client.auth.refresh();
    await client.auth.logout();
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/auth/providers',
      'POST /v1/auth/providers',
      'POST /v1/auth/providers/google/unregister',
      'POST /v1/auth/login/google',
      'POST /v1/auth/callback/google',
      'POST /v1/auth/refresh',
      'POST /v1/auth/logout',
    ]);
  });
});
