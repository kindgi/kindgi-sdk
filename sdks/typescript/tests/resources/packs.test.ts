// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

describe('packs not-yet-wired surface — pack authoring not implemented yet', () => {
  it('every method throws not-yet-wired without hitting the network', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const dummyManifest = {
      agents: [],
      tools: [],
      guardrails: [],
      memorySchemas: [],
      capabilities: [],
      metadata: {},
    };

    await expect(
      client.packs.install({ kind: 'bundle', manifest: dummyManifest }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'packs.install' } });

    await expect(client.packs.installed()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.installed' },
    });

    await expect(client.packs.get('pack-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.get' },
    });

    await expect(client.packs.versions('pack-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.versions' },
    });

    await expect(
      client.packs.configure('inst-1' as never, { firmName: 'Acme' }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'packs.configure' } });

    await expect(client.packs.disable('inst-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.disable' },
    });

    await expect(client.packs.enable('inst-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.enable' },
    });

    await expect(client.packs.upgrade('inst-1' as never, '1.1.0')).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.upgrade' },
    });

    await expect(client.packs.uninstall('inst-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.uninstall' },
    });

    await expect(client.packs.registry.browse()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.registry.browse' },
    });

    await expect(client.packs.registry.configured()).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'packs.registry.configured' },
    });

    expect(stub.calls.length).toBe(0);
  });
});
