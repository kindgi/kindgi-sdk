// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `createClient()` finds its options on first use, not when it's called:
 * a module-scope client must survive a production build that imports the
 * module with no runtime settings (`next build` sets `NODE_ENV=production`).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createClient } from '../src/client.js';
import { resetWarningsForTests } from '../src/runtime-config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-client-lazy-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.stubEnv('KINDGI_API_URL', '');
  vi.stubEnv('KINDGI_API_TOKEN', '');
  vi.stubEnv('KINDGI_ENV', '');
  resetWarningsForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const MISSING =
  "createClient(): KINDGI_API_URL and KINDGI_API_TOKEN aren't set. Set them in your env file (.env / .env.local), or pass { apiUrl, auth }.";

describe('createClient() resolves on first use (T540)', () => {
  test('in production with nothing set, calling it at module scope throws nothing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createClient()).not.toThrow();
  });

  test('the first use throws the error that says what to set, and the next use works once it is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const kindgi = createClient();
    expect(() => kindgi.runs).toThrow(MISSING);
    vi.stubEnv('KINDGI_API_URL', 'https://kindgi.example.com');
    vi.stubEnv('KINDGI_API_TOKEN', 'kgi_bt_prod');
    expect(typeof kindgi.runs.start).toBe('function');
  });

  test('awaiting it, or returning it from an async function, resolves nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const kindgi = createClient();
    await expect((async () => kindgi)()).resolves.toBe(kindgi);
    expect(String(Object.prototype.toString.call(kindgi))).toBe('[object Object]');
  });

  test('outside production, it still finds the running kindgi dev from .kindgirc.json, warning once', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await writeFile(
      join(dir, '.kindgirc.json'),
      JSON.stringify({ apiUrl: 'http://127.0.0.1:4000', token: 'kgi_bt_dev' }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kindgi = createClient();
    expect(warn).not.toHaveBeenCalled();
    expect(typeof kindgi.agents.list).toBe('function');
    expect(typeof kindgi.runs.get).toBe('function');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Using the running kindgi dev from');
  });

  test('it behaves as the client: its resources, keys and `in`', () => {
    const kindgi = createClient({
      apiUrl: 'http://127.0.0.1:4000',
      auth: { kind: 'apiToken', token: 't' },
    });
    expect('runs' in kindgi).toBe(true);
    expect(Object.keys(kindgi)).toContain('agents');
    expect(kindgi.runs).toBe(kindgi.runs);
  });

  test('a write lands on the client, as on the plain object: a test can swap a resource', () => {
    const kindgi = createClient({
      apiUrl: 'http://127.0.0.1:4000',
      auth: { kind: 'apiToken', token: 't' },
    });
    const fake = { start: async () => ({ id: 'run-1' }) } as unknown as typeof kindgi.runs;
    (kindgi as { runs: typeof kindgi.runs }).runs = fake;
    expect(kindgi.runs).toBe(fake);
    Object.defineProperty(kindgi, 'agents', { value: fake, configurable: true, enumerable: true });
    expect(kindgi.agents).toBe(fake);
    expect(Reflect.deleteProperty(kindgi, 'tools')).toBe(true);
    expect('tools' in kindgi).toBe(false);
  });
});
