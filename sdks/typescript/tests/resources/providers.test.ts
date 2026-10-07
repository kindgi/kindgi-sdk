// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_PROVIDER = {
  providerId: 'azure-oai-east',
  kind: 'model',
  model: 'gpt-4o',
  region: 'us-east-2',
  contextWindow: 128000,
  features: ['tool-use', 'streaming'],
};

describe('providers — wire round-trips', () => {
  it('CRUD + capabilities hit /v1/providers/*', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ providerId: 'azure-oai-east' }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_PROVIDER], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_PROVIDER) },
      { status: 200, body: JSON.stringify({ data: [] }) },
      { status: 200, body: JSON.stringify({ providerId: 'azure-oai-east', unregistered: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.providers.register({ provider: SAMPLE_PROVIDER } as never);
    await client.providers.list({ feature: 'tool-use' });
    await client.providers.get('azure-oai-east');
    await client.providers.capabilities('azure-oai-east');
    await client.providers.unregister('azure-oai-east');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/providers',
      'GET /v1/providers',
      'GET /v1/providers/azure-oai-east',
      'GET /v1/providers/azure-oai-east/capabilities',
      'POST /v1/providers/azure-oai-east/unregister',
    ]);
    expect(stub.calls[1]?.url).toMatch(/feature=tool-use/);
  });

  it('check reads GET /v1/providers/{id}/check', async () => {
    const answer = {
      providerId: 'acme llm',
      adapterId: '@kindgi/adapter-model-openai-compat',
      checked: true,
      problems: [{ field: 'adapter_config.api', message: 'adapter_config.api must be one of …' }],
    };
    const stub = recordingFetch([{ status: 200, body: JSON.stringify(answer) }]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.providers.check('acme llm')).toEqual(answer);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/providers/acme%20llm/check',
    ]);
  });
});
