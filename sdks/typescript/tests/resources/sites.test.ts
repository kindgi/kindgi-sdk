// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 'secret-token' };
const USER = {
  userId: '44444444-4444-4444-8444-444444444444',
  displayName: 'Jane',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('projects.sites.restorePerson', () => {
  it('POSTs …/sites/{siteId}/people/{userId}/restore with each id encoded, no body, and returns the person', async () => {
    const stub = jsonFetch({ user: USER });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const restored = await client.projects.sites.restorePerson('proj/1', 'site 1', 'user?1');

    expect(restored).toEqual({ user: USER });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://api.example.com/v1/projects/proj%2F1/sites/site%201/people/user%3F1/restore',
    );
    expect(req.headers.authorization).toBe('Bearer secret-token');
    expect(req.headers['idempotency-key']).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it('forwards Idempotency-Key when the caller supplies one', async () => {
    const stub = jsonFetch({ user: USER });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await client.projects.sites.restorePerson('proj-1', 'site-1', USER.userId, {
      idempotencyKey: 'idem-restore',
    });

    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-restore');
  });

  it('surfaces a refusal as a conflict, with its reason in the fields', async () => {
    const stub = errorFetch(409, {
      code: 'site-person-restore-refused',
      message:
        'Their site said they left it, and forgot them: if they come back, it signs them in as a new person',
      details: { reason: 'left', userId: USER.userId },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(
      client.projects.sites.restorePerson('proj-1', 'site-1', USER.userId),
    ).rejects.toMatchObject({
      name: 'KindgiApiError',
      error: {
        code: 'conflict',
        serverCode: 'site-person-restore-refused',
        fields: { reason: 'left', userId: USER.userId },
      },
    });
  });
});
