// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const SUPERVISOR_ID = 'sup-citation' as never;
const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111' as never;

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

describe('supervisor.proposals — removed in 0.1.5', () => {
  it.each([
    ['draft', 'create'],
    ['list', 'list'],
    ['get', 'get'],
    ['dryRun', 'evaluate'],
    ['submitForReview', 'request'],
    ['reflectReview', 'request'],
    ['apply', 'request'],
    ['rollback', 'rollback'],
    ['withdraw', 'withdraw'],
  ] as const)(
    '%s throws, naming client.proposals.%s, and sends nothing',
    async (method, replacement) => {
      const { client: c, stub } = client();
      const call = c.supervisor.proposals[method] as (...args: unknown[]) => Promise<never>;
      await expect(call(SUPERVISOR_ID, PROPOSAL_ID, { reason: 'x' })).rejects.toMatchObject({
        error: {
          code: 'not-yet-wired',
          method: `supervisor.proposals.${method}`,
          reason: expect.stringContaining(`removed in 0.1.5`),
        },
      });
      await expect(call(SUPERVISOR_ID, PROPOSAL_ID, {})).rejects.toMatchObject({
        error: { reason: expect.stringContaining(`client.proposals.${replacement}`) },
      });
      expect(stub.calls.length).toBe(0);
    },
  );
});
