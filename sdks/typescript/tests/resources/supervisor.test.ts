// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

function client() {
  const stub = recordingFetch([]);
  return {
    stub,
    client: createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch }),
  };
}

describe('supervisor not-yet-wired surface', () => {
  it('supervisor CRUD throws not-yet-wired', async () => {
    const { client: c, stub } = client();
    await expect(
      c.supervisor.define({
        id: 'sup-x',
        version: '1.0.0',
        name: 'X',
        triggerGuardrails: [],
        proposerTiers: ['prompt'],
      }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'supervisor.define' } });
    await expect(c.supervisor.get('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.get' },
    });
    await expect(c.supervisor.list()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.list' },
    });
    await expect(c.supervisor.versions('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.versions' },
    });
    await expect(c.supervisor.delete('sup-x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'supervisor.delete' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
