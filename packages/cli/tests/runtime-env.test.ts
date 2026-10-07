// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KINDGI_ENV_SCHEMA } from '@kindgi/env-schema';

import {
  type RuntimeEnvInput,
  buildRuntimeEnv,
  runtimeEnvPath,
  shellReferencesOf,
  writeRuntimeEnv,
} from '../src/dev/runtime-env.js';

const BASE: RuntimeEnvInput = {
  apiPort: 4000,
  // Published on another host port (T218): the banner names this one.
  publicUrl: 'http://127.0.0.1:4001',
  hostAlias: 'host.docker.internal',
  packDir: '/pack',
  databaseUrl: 'postgres://kindgi:pw@host.docker.internal:55432/kindgi',
  tenantId: '00000000-0000-4000-8000-000000000001',
  token: 'kgi_bt_dev',
  seedUserId: '00000000-0000-4000-8000-000000000002',
  packService: { url: 'http://127.0.0.1:61000', token: 'pack-token' },
  corsOrigins: [],
  shellReferences: {},
};

describe('buildRuntimeEnv', () => {
  test('Docker Desktop: the dev settings, the pack at /pack, loopback calls to the host alias', () => {
    expect(buildRuntimeEnv(BASE)).toEqual({
      KINDGI_DEV: 'true',
      KINDGI_ENV: 'local',
      KINDGI_LOG_FORMAT: 'pretty',
      KINDGI_API_PORT: '4000',
      KINDGI_PUBLIC_URL: 'http://127.0.0.1:4001',
      KINDGI_DEV_HOST_ALIAS: 'host.docker.internal',
      KINDGI_DATABASE_URL: BASE.databaseUrl,
      KINDGI_TENANT_ID: BASE.tenantId,
      KINDGI_API_TOKEN: 'kgi_bt_dev',
      KINDGI_SEED_USER_ID: BASE.seedUserId,
      KINDGI_PACK_DIR: '/pack',
      KINDGI_ARTIFACTS: 'local:/pack/.kindgi/dev/artifacts',
      KINDGI_DEV_CONSOLE_LOGIN: 'true',
      KINDGI_SECRETS_BACKEND: 'dotenv',
      KINDGI_SECRETS_DOTENV_DIR: '/pack',
      KINDGI_PACK_SERVICE_URL: 'http://127.0.0.1:61000',
      KINDGI_PACK_SERVICE_TOKEN: 'pack-token',
    });
  });

  test('Linux host networking: the API binds loopback, no alias', () => {
    const { hostAlias: _alias, ...noAlias } = BASE;
    const env = buildRuntimeEnv({ ...noAlias, apiHost: '127.0.0.1', apiPort: 4321 });
    expect(env).toMatchObject({ KINDGI_API_HOST: '127.0.0.1', KINDGI_API_PORT: '4321' });
    expect(env.KINDGI_DEV_HOST_ALIAS).toBeUndefined();
  });

  test('env files, CORS origins, the mounted key and Google credentials', () => {
    const env = buildRuntimeEnv({
      ...BASE,
      localEnvFiles: ['.env', '.env.dev'],
      corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
      publicTokenKeyPath: '/run/kindgi/public-token-signing.pem',
      googleCredentialsPath: '/run/kindgi/google-credentials.json',
    });
    expect(env).toMatchObject({
      KINDGI_SECRETS_DOTENV_FILES: '.env,.env.dev',
      KINDGI_CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
      KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH: '/run/kindgi/public-token-signing.pem',
      GOOGLE_APPLICATION_CREDENTIALS: '/run/kindgi/google-credentials.json',
    });
  });

  test("shell values for the files' references ride along, never over the runtime's own settings", () => {
    const env = buildRuntimeEnv({
      ...BASE,
      shellReferences: {
        ACME_API_KEY: 'from-shell',
        KINDGI_API_TOKEN: 'hijack',
        GOOGLE_APPLICATION_CREDENTIALS: '/elsewhere',
      },
    });
    expect(env.ACME_API_KEY).toBe('from-shell');
    expect(env.KINDGI_API_TOKEN).toBe('kgi_bt_dev');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  test("every KINDGI_ name it writes is the runtime's, from @kindgi/env-schema", () => {
    const names = new Set(KINDGI_ENV_SCHEMA.map((v) => v.name));
    const env = buildRuntimeEnv({
      ...BASE,
      localEnvFiles: ['.env'],
      corsOrigins: ['http://localhost:3000'],
      publicTokenKeyPath: '/k.pem',
      googleCredentialsPath: '/g.json',
    });
    const hostNetwork = buildRuntimeEnv({ ...BASE, apiHost: '127.0.0.1' });
    for (const name of [...Object.keys(env), ...Object.keys(hostNetwork)]) {
      if (name.startsWith('KINDGI_')) expect(names, name).toContain(name);
    }
  });
});

describe('runtime.env on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kindgi-runtime-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('NAME=value lines, mode 0600, under .kindgi/dev; a line break is refused', async () => {
    const path = runtimeEnvPath(dir);
    expect(path).toBe(join(dir, '.kindgi', 'dev', 'runtime.env'));
    await writeRuntimeEnv(path, { KINDGI_DEV: 'true', ACME_NOTE: 'two words = fine' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines).toEqual(['KINDGI_DEV=true', 'ACME_NOTE=two words = fine', '']);
    await expect(writeRuntimeEnv(path, { BAD: 'a\nb' })).rejects.toThrow('has a line break');
  });

  test("the shell's values for references the env files make and don't define", async () => {
    await writeFile(
      join(dir, '.env'),
      'ACME_URL=https://${ACME_HOST}/v1\nACME_KEY=${ACME_KEY_FROM_SHELL}\nACME_LOCAL=x\nACME_REF=${ACME_LOCAL}\nACME_GONE=${NOT_IN_SHELL}\n',
    );
    const refs = await shellReferencesOf({
      packDir: dir,
      shellEnv: {
        ACME_HOST: 'api.example.com',
        ACME_KEY_FROM_SHELL: 'sk-shell',
        ACME_LOCAL: 'shell-ignored',
        UNRELATED: 'no',
      },
    });
    expect(refs).toEqual({ ACME_HOST: 'api.example.com', ACME_KEY_FROM_SHELL: 'sk-shell' });
  });
});
