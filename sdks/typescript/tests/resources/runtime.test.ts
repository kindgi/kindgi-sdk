// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

describe('runtime — wire round-trip', () => {
  it('get: GET /v1/runtime, which runtime answers as it reports it', async () => {
    const info = { version: '0.3.0', hosting: 'self-hosted', development: false };
    const stub = jsonFetch(info);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.runtime.get()).toEqual(info);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`GET ${API}/v1/runtime`);
  });
});
