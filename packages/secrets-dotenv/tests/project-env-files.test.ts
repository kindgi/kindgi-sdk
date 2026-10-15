// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The binding over a project's own env files — Kindgi embedded in an
 * existing app (`.env` + `.env.local` shared with, say, Next.js). Real
 * tmp directories; every host file is checked byte-for-byte after writes.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId } from '@kindgi/types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createDotenvSecretBinding } from '../src/index.js';

let dir: string;
const SCOPE: Scope = { kind: 'tenant', tenantId: 't' as TenantId };
const LOCAL = 'local' as EnvName;
const HOOK = () => [] as const;
const CTX = { caller: 'dispatch' as const };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-project-env-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, body: string): Promise<void> => writeFile(join(dir, name), body);
const read = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');

async function resolved(
  binding: ReturnType<typeof createDotenvSecretBinding>,
  name: string,
  envName: EnvName = LOCAL,
): Promise<string | undefined> {
  const r = await binding.resolve({ scope: SCOPE, envName, name, resolveContext: CTX });
  return r.kind === 'ok' ? r.value.value : undefined;
}

describe('reads the project env files', () => {
  test('a key added to .env by hand resolves — nothing to copy', async () => {
    await put('.env', 'ANTHROPIC_API_KEY=sk-from-dot-env\n');
    expect(await resolved(createDotenvSecretBinding({ packDir: dir }), 'ANTHROPIC_API_KEY')).toBe(
      'sk-from-dot-env',
    );
  });

  test('.env.local overrides .env', async () => {
    await put('.env', 'KEY=base\n');
    await put('.env.local', 'KEY=local\n');
    expect(await resolved(createDotenvSecretBinding({ packDir: dir }), 'KEY')).toBe('local');
  });

  test('${VAR} references expand across the files; env fills names no file defines', async () => {
    await put('.env', 'URL=https://${HOST}/v1?home=${HOME}\n');
    await put('.env.local', 'HOST=localhost\n');
    const b = createDotenvSecretBinding({ packDir: dir, env: { HOME: '/h', HOST: 'shell' } });
    expect(await resolved(b, 'URL')).toBe('https://localhost/v1?home=/h');
  });

  test('KINDGI_* names are runtime config — invisible to list / get / resolve', async () => {
    await put('.env', 'KINDGI_DATABASE_URL=postgres://x\nAGENT_KEY=a\n');
    const b = createDotenvSecretBinding({ packDir: dir });
    expect(await resolved(b, 'KINDGI_DATABASE_URL')).toBeUndefined();
    expect(await b.get({ scope: SCOPE, envName: LOCAL, name: 'KINDGI_DATABASE_URL' })).toBeNull();
    const page = await b.list({ scope: SCOPE, envName: LOCAL, limit: 50 });
    expect(page.data.map((r) => r.name)).toEqual(['AGENT_KEY']);
  });

  test('a not-found error names the files it looked in', async () => {
    const r = await createDotenvSecretBinding({ packDir: dir }).resolve({
      scope: SCOPE,
      envName: LOCAL,
      name: 'MISSING',
      resolveContext: CTX,
    });
    expect(r.kind === 'err' && r.error.message).toContain('.env, .env.local');
  });

  test('dev.envFiles override: custom list, lowest precedence first', async () => {
    await put('.env', 'K=base\n');
    await put('.env.dev', 'K=dev\n');
    const b = createDotenvSecretBinding({ packDir: dir, localEnvFiles: ['.env', '.env.dev'] });
    expect(await resolved(b, 'K')).toBe('dev');
  });

  test('other environments read only .env.<envName>', async () => {
    await put('.env', 'K=base\n');
    await put('.env.staging', 'K=staging\n');
    const b = createDotenvSecretBinding({ packDir: dir });
    expect(await resolved(b, 'K', 'staging' as EnvName)).toBe('staging');
    expect(await resolved(b, 'ONLY_IN_ENV', 'staging' as EnvName)).toBeUndefined();
  });
});

describe("writes land in Kindgi's own file, which wins; nothing else changes", () => {
  const set = (
    b: ReturnType<typeof createDotenvSecretBinding>,
    name: string,
    value: string,
    writeMode: 'create-new' | 'add-version' = 'add-version',
  ) => b.set({ scope: SCOPE, envName: LOCAL, name, value, writeMode, enqueueTuples: HOOK });

  test("set writes .kindgi/secrets.env and leaves the app's .env byte-identical", async () => {
    const hostEnv = '# app config\nDATABASE_URL="postgres://app"\nKEY=from-env\n';
    await put('.env', hostEnv);
    const b = createDotenvSecretBinding({ packDir: dir });
    expect((await set(b, 'KEY', 'override')).kind).toBe('ok');
    expect(await read('.env')).toBe(hostEnv);
    expect(await read('.kindgi/secrets.env')).toBe('KEY=override\n');
    expect(await resolved(b, 'KEY')).toBe('override');
  });

  test('create-new sees a name defined in ANY file (already-exists)', async () => {
    await put('.env', 'KEY=from-env\n');
    const r = await set(createDotenvSecretBinding({ packDir: dir }), 'KEY', 'x', 'create-new');
    expect(r.kind).toBe('already-exists');
  });

  test('values with $ and quotes round-trip through the file', async () => {
    const b = createDotenvSecretBinding({ packDir: dir });
    const value = `pa$$w0rd "quoted" 'single'`;
    expect((await set(b, 'TRICKY', value)).kind).toBe('ok');
    expect(await resolved(b, 'TRICKY')).toBe(value);
  });

  test.each([
    ['a double quote and a carriage return', 'a"b\rc'],
    ['a backslash before n, and a carriage return', 'a\\nb\rc'],
    ['a double quote, a single quote and a backtick', `"a" 'b' \`c\``],
    ['a backslash before r, a single quote and a backtick', "\\r 'b' `c`"],
  ])(
    "refuses a value with %s as the caller's secret-value-invalid, before any file, never saying it",
    async (_, value) => {
      await put('.env.local', 'KEEP=1\n');
      const b = createDotenvSecretBinding({ packDir: dir });
      for (const writeMode of ['add-version', 'create-new'] as const) {
        // `create-new` on a name the files have: the value is refused first.
        const r = await set(b, 'KEEP', value, writeMode);
        expect(r).toEqual({
          kind: 'error',
          code: 'secret-value-invalid',
          message: expect.stringContaining(
            'no env-file quoting can hold the value for KEEP so that it reads back unchanged',
          ),
        });
        expect(r.kind === 'error' && r.message).not.toContain(value);
      }
      expect(await read('.env.local')).toBe('KEEP=1\n');
      await expect(read('.kindgi/secrets.env')).rejects.toThrow(/ENOENT/);
    },
  );

  test.each([
    ['a double quote and a newline', 'a"b\nc'],
    ['a carriage return alone', 'a\rb'],
    ['a backslash before n alone', 'a\\nb'],
    ['a double quote and a single quote', `"a" 'b'`],
    ['a double quote and a backtick', '"a" `b`'],
  ])('still writes a value with %s, which reads back unchanged', async (_, value) => {
    const b = createDotenvSecretBinding({ packDir: dir });
    expect((await set(b, 'NEAR_MISS', value)).kind).toBe('ok');
    expect(await resolved(b, 'NEAR_MISS')).toBe(value);
  });

  test("with dev.envFiles, a secret still goes to Kindgi's file; appEnvFile, to the last of them", async () => {
    const b = createDotenvSecretBinding({ packDir: dir, localEnvFiles: ['.env', '.env.dev'] });
    await set(b, 'K', 'v');
    expect(await read('.kindgi/secrets.env')).toBe('K=v\n');
    await b.set({
      scope: SCOPE,
      envName: LOCAL,
      name: 'SHARED',
      value: 's',
      writeMode: 'create-new',
      appEnvFile: true,
      enqueueTuples: HOOK,
    });
    expect(await read('.env.dev')).toBe('SHARED=s\n');
  });

  test.each([
    ['KINDGI_DATABASE_URL', 'secret-name-invalid', 'runtime config'],
    ['kindgi.webhook', 'reserved-name-prefix', 'reserved'],
    [
      'lower_case',
      'secret-name-invalid',
      'not starting with a digit (^[A-Z_][A-Z0-9_]*$). "lower_case" isn\'t one: use "LOWER_CASE".',
    ],
    [
      'acme-woo-orders',
      'secret-name-invalid',
      '"acme-woo-orders" isn\'t one: use "ACME_WOO_ORDERS".',
    ],
    ['9-lives', 'secret-name-invalid', 'use "_9_LIVES".'],
    ['kindgi_db', 'secret-name-invalid', '"kindgi_db" isn\'t one.'],
    // Nothing of the name's would be left to offer.
    ['--', 'secret-name-invalid', '"--" isn\'t one.'],
    ['ключ', 'secret-name-invalid', '"ключ" isn\'t one.'],
  ])(
    "refuses %s as the caller's %s, writing nothing; nameRefusal says the same",
    async (name, code, says) => {
      await put('.env.local', 'KEEP=1\n');
      const b = createDotenvSecretBinding({ packDir: dir });
      const r = await set(b, name, 'v');
      expect(r).toEqual({ kind: 'error', code, message: expect.stringContaining(says) });
      expect(b.nameRefusal?.(name)).toEqual({ code, message: r.kind === 'error' && r.message });
      expect(await read('.env.local')).toBe('KEEP=1\n');
    },
  );

  test('nameRefusal takes every name set writes', () => {
    const b = createDotenvSecretBinding({ packDir: dir });
    for (const name of ['ACME_WOO_ORDERS', '_PRIVATE', 'K', 'A1']) {
      expect(b.nameRefusal?.(name), name).toBeUndefined();
    }
  });

  test("a key typed into .env by hand that Kindgi wouldn't write still resolves", async () => {
    await put('.env', 'acme-woo-orders=from-hand\n');
    const b = createDotenvSecretBinding({ packDir: dir });
    expect(await resolved(b, 'acme-woo-orders')).toBe('from-hand');
    expect(b.nameRefusal?.('acme-woo-orders')?.code).toBe('secret-name-invalid');
  });

  test('a value no dotenv quoting can hold is refused, file untouched', async () => {
    await put('.env.local', 'KEEP=1\n');
    const r = await set(createDotenvSecretBinding({ packDir: dir }), 'BAD', `"a" 'b' \`c\` \\n`);
    expect(r.kind).toBe('error');
    expect(await read('.env.local')).toBe('KEEP=1\n');
  });
});
