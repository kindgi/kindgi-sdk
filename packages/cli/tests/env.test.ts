// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi env` tests. Every `.env.<envName>` read/write flows
 * through the injected `EnvRunners` seam so these tests never touch
 * disk. The pack-config loader (`buildConfigLoader`) is likewise
 * injected — the same shape the build and deploy tests use.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

import type { EnvRunners } from '../src/env/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';

let packDir: string;

interface Fixtures {
  runners: EnvRunners;
  readonly state: {
    files: Map<string, string>;
    readCalls: number;
    writeCalls: number;
  };
}

function makeFixtures(preExisting: Record<string, string> = {}): Fixtures {
  const files = new Map<string, string>(Object.entries(preExisting));
  const state: Fixtures['state'] = {
    files,
    readCalls: 0,
    writeCalls: 0,
  };
  const runners: EnvRunners = {
    readFile: async (path) => {
      state.readCalls += 1;
      return files.get(path) ?? null;
    },
    writeFile: async (path, contents) => {
      state.writeCalls += 1;
      files.set(path, contents);
    },
  };
  return { runners, state };
}

function baseInputs(
  fixtures: Fixtures,
  argv: readonly string[],
  extras: Partial<RunCliInputs> = {},
): RunCliInputs {
  return {
    argv,
    env: {},
    cwd: packDir,
    home: '/tmp/fake-home',
    envRunners: fixtures.runners,
    ...extras,
  };
}

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-env-'));
  // Real config file so path-resolution defaults still work — the
  // env command never READS kindgi.config.ts unless we inject a
  // loader, but downstream commands may look for it.
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

// ---------- env list ----------

describe('kindgi env list', () => {
  test('precedence: .env file wins over config env block', async () => {
    const envPath = join(packDir, '.env.staging');
    const fixtures = makeFixtures({
      [envPath]: 'FOO_URL=https://from-file.example.com\n',
    });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'list', `--path=${packDir}`], {
        buildConfigLoader: async () => ({
          environments: {
            staging: { env: { FOO_URL: 'https://from-config.example.com' } },
          },
        }),
      }),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as {
      values: Array<{ key: string; source: string; inFile: boolean; inConfig: boolean }>;
    };
    const row = summary.values.find((v) => v.key === 'FOO_URL');
    expect(row?.source).toBe('env-file');
    expect(row?.inFile).toBe(true);
    expect(row?.inConfig).toBe(true);
  });

  test('--reveal without TTY and without --force-reveal refuses to emit', async () => {
    const envPath = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [envPath]: 'SECRET=abc123\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'list', '--reveal', `--path=${packDir}`]),
    );
    // In test env stderr isn't a TTY; refuses without --force-reveal.
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('refuses to emit values to a non-TTY');
  });

  test('--reveal to a file or pipe refuses, even from a terminal (the values go to stdout)', async () => {
    const envPath = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [envPath]: 'SECRET=abc123\n' });
    const saved = { out: process.stdout.isTTY, err: process.stderr.isTTY };
    // `kindgi env list --reveal > file` typed in a terminal: stderr is a TTY, stdout isn't.
    process.stdout.isTTY = false as never;
    process.stderr.isTTY = true as never;
    try {
      const out = await runCli(
        baseInputs(fixtures, ['env', 'list', '--reveal', `--path=${packDir}`]),
      );
      expect(out.exitCode).toBe(1);
      expect(out.stdout).not.toContain('abc123');
    } finally {
      process.stdout.isTTY = saved.out;
      process.stderr.isTTY = saved.err;
    }
  });

  test('--reveal --force-reveal emits raw values', async () => {
    const envPath = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [envPath]: 'SECRET=abcdefg\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'list', '--reveal', '--force-reveal', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { values: Array<{ key: string; value: string }> };
    const row = summary.values.find((v) => v.key === 'SECRET');
    expect(row?.value).toBe('abcdefg');
  });

  test('malformed line surfaces as a file:line warning — never its text', async () => {
    const envPath = join(packDir, '.env.staging');
    const fixtures = makeFixtures({
      [envPath]: 'GOOD_KEY=value\nAPI KEY=sk-typo-secret\n',
    });
    const out = await runCli(baseInputs(fixtures, ['env', 'list', `--path=${packDir}`]));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { warnings?: string[] };
    expect(summary.warnings).toEqual(['.env.staging:2: ignored — not a `KEY=value` line']);
    expect(out.stdout + out.stderr).not.toContain('sk-typo-secret');
  });

  test('missing env file does not error — reports 0 keys', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['env', 'list', `--path=${packDir}`]));
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { count: number };
    expect(summary.count).toBe(0);
  });
});

// ---------- env set ----------

describe('kindgi env set', () => {
  test('creates the .env file when absent', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'FOO_URL', 'https://example.com', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const path = join(packDir, '.env.staging');
    expect(fixtures.state.files.get(path)).toBe('FOO_URL=https://example.com\n');
  });

  test('quotes values so they read back unchanged (dollar escaped)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'PASS', 'pa$$ word', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.files.get(join(packDir, '.env.staging'))).toBe('PASS="pa\\$\\$ word"\n');
  });

  test('refuses a value no dotenv quoting can hold — never writes a different value', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [path]: 'KEEP=1\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'BAD', `"a" 'b' \`c\` \\n`, `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('cannot be written to a dotenv file');
    expect(fixtures.state.files.get(path)).toBe('KEEP=1\n');
  });

  test('refuses to overwrite without --force', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [path]: 'FOO_URL=old\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'FOO_URL', 'new', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('refuses to change FOO_URL');
    expect(fixtures.state.files.get(path)).toBe('FOO_URL=old\n');
  });

  test('--force overwrites and preserves other lines', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({
      [path]: '# a comment\nFOO_URL=old\nBAR_URL=keep-me\n',
    });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'FOO_URL', 'new', '--force', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const contents = fixtures.state.files.get(path);
    expect(contents).toContain('FOO_URL=new');
    expect(contents).toContain('BAR_URL=keep-me');
    expect(contents).toContain('# a comment');
  });

  test('refuses KINDGI_* keys', async () => {
    const fixtures = makeFixtures();
    for (const key of ['KINDGI_API_URL', 'KINDGI_DATABASE_URL']) {
      const out = await runCli(
        baseInputs(fixtures, ['env', 'set', key, 'https://x', `--path=${packDir}`]),
      );
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('reserved for framework runtime config');
    }
  });

  test('accepts DATABASE_URL — un-prefixed names belong to the pack, not the runtime', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'DATABASE_URL', 'postgres://x', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.files.get(join(packDir, '.env.staging'))).toBe(
      'DATABASE_URL=postgres://x\n',
    );
  });

  test('rejects invalid KEY shape', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'lower-case-bad', 'x', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Invalid KEY');
  });
});

// ---------- env unset ----------

describe('kindgi env unset', () => {
  test('removes the key while preserving unrelated lines', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({
      [path]: '# hdr\nA=1\nB=2\nC=3\n',
    });
    const out = await runCli(baseInputs(fixtures, ['env', 'unset', 'B', `--path=${packDir}`]));
    expect(out.exitCode).toBe(0);
    const contents = fixtures.state.files.get(path);
    expect(contents).toContain('A=1');
    expect(contents).toContain('C=3');
    expect(contents).not.toContain('B=2');
    expect(contents).toContain('# hdr');
  });

  test('idempotent success when key is absent', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [path]: 'A=1\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'unset', 'MISSING', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { removed: boolean };
    expect(summary.removed).toBe(false);
  });

  test('idempotent success when file does not exist', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'unset', 'ANYTHING', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { removed: boolean; note?: string };
    expect(summary.removed).toBe(false);
    expect(summary.note).toBe('file did not exist');
  });
});

// ---------- env pull (WIRED via /v1/env/*) ----------

describe('kindgi env pull — wired via /v1/env/*', () => {
  test('rejects when --scope is missing (fail-loud)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['env', 'pull', `--path=${packDir}`]));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--scope=<kind>[:id]');
  });

  test('fetches remote env values and writes to .env.<envName>', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown => ({
      env: {
        list: async () => ({
          data: [
            {
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
              envName: 'staging',
              name: 'FOO_URL',
              value: 'https://from-remote.example.com',
              revision: 1,
              createdAt: '2026-09-22T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
            {
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
              envName: 'staging',
              name: 'BAR_URL',
              value: 'https://from-remote-bar.example.com',
              revision: 1,
              createdAt: '2026-09-22T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
          ],
        }),
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'env',
        'pull',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
        `--path=${packDir}`,
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const summary = JSON.parse(out.stdout) as {
      fetched: number;
      added: number;
      overwritten: number;
    };
    expect(summary.fetched).toBe(2);
    expect(summary.added).toBe(2);
    const contents = fixtures.state.files.get(join(packDir, '.env.staging'));
    expect(contents).toContain('FOO_URL=https://from-remote.example.com');
    expect(contents).toContain('BAR_URL=https://from-remote-bar.example.com');
  });

  test('does not overwrite existing keys without --overwrite-existing', async () => {
    const path = join(packDir, '.env.staging');
    const fixtures = makeFixtures({ [path]: 'FOO_URL=local-wins\n' });
    const clientFactory = (): unknown => ({
      env: {
        list: async () => ({
          data: [
            {
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
              envName: 'staging',
              name: 'FOO_URL',
              value: 'remote-loses',
              revision: 1,
              createdAt: '2026-09-22T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
          ],
        }),
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'env',
        'pull',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
        `--path=${packDir}`,
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const summary = JSON.parse(out.stdout) as {
      added: number;
      overwritten: number;
      skipped: number;
    };
    expect(summary.skipped).toBe(1);
    expect(summary.overwritten).toBe(0);
    // Original value preserved.
    expect(fixtures.state.files.get(path)).toBe('FOO_URL=local-wins\n');
  });

  test('rejects malformed --scope with helpful message', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'pull', '--scope=org', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--scope=org:<orgId>');
  });
});

// ---------- env set/list/unset --scope (the runtime's env values) ----------

interface StoredEnv {
  readonly scope: { readonly kind: string; readonly orgId?: string; readonly projectId?: string };
  readonly envName: string;
  readonly name: string;
  readonly value: string;
  readonly revision: number;
}

/** A fake `/v1/env` behind the client the CLI builds, recording each call. */
function fakeEnvApi(seed: readonly StoredEnv[] = []) {
  const rows = new Map<string, StoredEnv>();
  const keyOf = (scope: StoredEnv['scope'], envName: string, name: string) =>
    `${scope.kind}:${scope.orgId ?? scope.projectId ?? ''}|${envName}|${name}`;
  for (const r of seed) rows.set(keyOf(r.scope, r.envName, r.name), r);
  const calls: { readonly method: string; readonly input: Record<string, unknown> }[] = [];
  const record = (r: StoredEnv) => ({
    ...r,
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
  });
  const env = {
    get: async (input: { scope: StoredEnv['scope']; envName: string; name: string }) => {
      calls.push({ method: 'get', input });
      const r = rows.get(keyOf(input.scope, input.envName, input.name));
      return r === undefined ? null : record(r);
    },
    set: async (input: {
      scope: StoredEnv['scope'];
      envName: string;
      name: string;
      value: string;
      ifRevision?: number;
    }) => {
      calls.push({ method: 'set', input });
      const k = keyOf(input.scope, input.envName, input.name);
      const prev = rows.get(k);
      if (input.ifRevision !== undefined && prev?.revision !== input.ifRevision) {
        return { kind: 'revision-conflict', currentRevision: prev?.revision ?? 0 };
      }
      const next = { ...input, revision: (prev?.revision ?? 0) + 1 };
      rows.set(k, next);
      return { kind: 'ok', record: record(next) };
    },
    list: async (input: { scope: StoredEnv['scope']; envName: string }) => {
      calls.push({ method: 'list', input });
      const prefix = keyOf(input.scope, input.envName, '');
      return {
        data: [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, r]) => record(r)),
        hasMore: false,
      };
    },
    delete: async (input: { scope: StoredEnv['scope']; envName: string; name: string }) => {
      calls.push({ method: 'delete', input });
      return { deleted: rows.delete(keyOf(input.scope, input.envName, input.name)) };
    },
  };
  return { calls, rows, clientFactory: (() => ({ env })) as never };
}

const API = ['--url=https://api.example.com', '--token=t'];

describe("kindgi env set/list/unset --scope — the runtime's env values (ctx.env)", () => {
  test('--scope needs --env: a value under the wrong env name would never resolve', async () => {
    const fixtures = makeFixtures();
    const api = fakeEnvApi();
    const out = await runCli({
      ...baseInputs(fixtures, [
        'env',
        'set',
        'ACME_BASE_URL',
        'https://a.example',
        '--scope=project:p-1',
        ...API,
      ]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Missing required flag: --env=<name>');
    expect(out.stderr).toContain('--env=local');
    expect(api.calls).toEqual([]);
  });

  test('set writes /v1/env at the scope, and no local file', async () => {
    const fixtures = makeFixtures();
    const api = fakeEnvApi();
    const out = await runCli({
      ...baseInputs(fixtures, [
        'env',
        'set',
        'ACME_BASE_URL',
        'https://a.example',
        '--scope=project:p-1',
        '--env=local',
        ...API,
      ]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(api.calls.find((c) => c.method === 'set')?.input).toEqual({
      scope: { kind: 'project', projectId: 'p-1' },
      envName: 'local',
      name: 'ACME_BASE_URL',
      value: 'https://a.example',
    });
    expect(fixtures.state.writeCalls).toBe(0);
    expect(out.stderr).toContain('Set ACME_BASE_URL at project:p-1 in env local');
    const summary = JSON.parse(out.stdout) as { changed: boolean; revision: number };
    expect(summary).toMatchObject({ changed: true, overwritten: false, revision: 1 });
    expect(out.stderr).not.toContain('looks like a credential');
  });

  test("set refuses to change a scope's value without --force, and replaces it with", async () => {
    const seed = {
      scope: { kind: 'org', orgId: 'o-1' },
      envName: 'local',
      name: 'ACME_REGION',
      value: 'eu',
      revision: 3,
    };
    const argv = ['env', 'set', 'ACME_REGION', 'us', '--scope=org:o-1', '--env=local', ...API];
    const refused = fakeEnvApi([seed]);
    const no = await runCli({
      ...baseInputs(makeFixtures(), argv),
      clientFactory: refused.clientFactory,
    });
    expect(no.exitCode).toBe(1);
    expect(no.stderr).toContain('already set at org:o-1 in env local to "eu"');
    expect(no.stderr).toContain('--force');
    expect(refused.calls.map((c) => c.method)).toEqual(['get']);

    const forced = fakeEnvApi([seed]);
    const yes = await runCli({
      ...baseInputs(makeFixtures(), [...argv, '--force']),
      clientFactory: forced.clientFactory,
    });
    expect(yes.exitCode, yes.stderr).toBe(0);
    // Replaces the revision it read, so a concurrent change isn't lost silently.
    expect(forced.calls.find((c) => c.method === 'set')?.input).toMatchObject({
      value: 'us',
      ifRevision: 3,
    });
    expect(yes.stderr).toContain('Updated ACME_REGION');
  });

  test('set with the value already there changes nothing', async () => {
    const api = fakeEnvApi([
      {
        scope: { kind: 'tenant' },
        envName: 'local',
        name: 'ACME_REGION',
        value: 'eu',
        revision: 1,
      },
    ]);
    const out = await runCli({
      ...baseInputs(makeFixtures(), [
        'env',
        'set',
        'ACME_REGION',
        'eu',
        '--scope=tenant',
        '--env=local',
        ...API,
      ]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(api.calls.map((c) => c.method)).toEqual(['get']);
    expect(out.stderr).toContain('no change');
  });

  test('a name that looks like a credential is set, with a warning pointing at kindgi secrets', async () => {
    const api = fakeEnvApi();
    const out = await runCli({
      ...baseInputs(makeFixtures(), [
        'env',
        'set',
        'ACME_API_KEY',
        'abc',
        '--scope=project:p-1',
        '--env=local',
        ...API,
      ]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(api.calls.some((c) => c.method === 'set')).toBe(true);
    expect(out.stderr).toContain('ACME_API_KEY looks like a credential');
    expect(out.stderr).toContain('kindgi secrets set ACME_API_KEY --env=local --scope=project:p-1');
    const summary = JSON.parse(out.stdout) as { warnings?: string[] };
    expect(summary.warnings).toHaveLength(1);
  });

  test('the KINDGI_ prefix stays refused with --scope', async () => {
    const api = fakeEnvApi();
    const out = await runCli({
      ...baseInputs(makeFixtures(), [
        'env',
        'set',
        'KINDGI_ENV',
        'x',
        '--scope=tenant',
        '--env=local',
        ...API,
      ]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode).toBe(1);
    expect(api.calls).toEqual([]);
  });

  test("list shows a scope's values (env isn't secret), sorted", async () => {
    const api = fakeEnvApi([
      { scope: { kind: 'tenant' }, envName: 'local', name: 'ZED', value: 'z', revision: 1 },
      {
        scope: { kind: 'tenant' },
        envName: 'local',
        name: 'ACME_REGION',
        value: 'eu',
        revision: 2,
      },
      {
        scope: { kind: 'project', projectId: 'p-1' },
        envName: 'local',
        name: 'OTHER',
        value: 'o',
        revision: 1,
      },
    ]);
    const out = await runCli({
      ...baseInputs(makeFixtures(), ['env', 'list', '--scope=tenant', '--env=local', ...API]),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const summary = JSON.parse(out.stdout) as { values: { key: string; value: string }[] };
    expect(summary.values.map((v) => [v.key, v.value])).toEqual([
      ['ACME_REGION', 'eu'],
      ['ZED', 'z'],
    ]);
    expect(out.stderr).toContain('Scope:       tenant');
  });

  test('unset removes the value at the scope and says what a call gets now', async () => {
    const api = fakeEnvApi([
      {
        scope: { kind: 'org', orgId: 'o-1' },
        envName: 'local',
        name: 'ACME_REGION',
        value: 'eu',
        revision: 1,
      },
    ]);
    const argv = ['env', 'unset', 'ACME_REGION', '--scope=org:o-1', '--env=local', ...API];
    const out = await runCli({
      ...baseInputs(makeFixtures(), argv),
      clientFactory: api.clientFactory,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ removed: true });
    expect(out.stderr).toContain("now gets the tenant's value");
    const again = await runCli({
      ...baseInputs(makeFixtures(), argv),
      clientFactory: api.clientFactory,
    });
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toContain("wasn't set at org:o-1 in env local: no change");
  });

  test("a runtime that doesn't serve /v1/env says so, and how to use local files", async () => {
    const clientFactory = (() => ({
      env: {
        get: async () => {
          throw new KindgiApiError({
            code: 'not-found',
            serverCode: 'route-not-found',
            message: 'No route for PUT /v1/env/ACME_REGION',
            resource: { kind: 'route', id: 'unknown' },
          });
        },
      },
    })) as never;
    const out = await runCli({
      ...baseInputs(makeFixtures(), [
        'env',
        'set',
        'ACME_REGION',
        'eu',
        '--scope=tenant',
        '--env=local',
        ...API,
      ]),
      clientFactory,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("this runtime doesn't serve `/v1/env`");
    expect(out.stderr).toContain('Without --scope');
  });
});

// ---------- env init ----------

describe('kindgi env init', () => {
  test('non-interactive: writes .env.example for postgres+gcp target', async () => {
    const fixtures = makeFixtures();
    const outPath = join(packDir, '.env.example');
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=postgres',
        '--kms=gcp',
        `--out=${outPath}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    const written = fixtures.state.files.get(outPath);
    expect(written).toBeDefined();
    // Required GCP vars uncommented.
    expect(written).toContain('KINDGI_SECRETS_GCP_PROJECT_ID=my-proj');
    expect(written).toContain('KINDGI_SECRETS_GCP_LOCATION_ID=us-central1');
    // Optional core vars commented out.
    expect(written).toContain('# KINDGI_API_PORT=4000');
  });

  test('non-interactive: backend=none writes only core vars (no secrets group)', async () => {
    const fixtures = makeFixtures();
    const outPath = join(packDir, '.env.example');
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=none',
        `--out=${outPath}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    const written = fixtures.state.files.get(outPath);
    expect(written).toBeDefined();
    expect(written).not.toContain('KINDGI_SECRETS_GCP_PROJECT_ID');
    // Backend var itself is universal (optional), gets included.
    expect(written).toContain('KINDGI_SECRETS_BACKEND');
  });

  test('non-interactive + missing --secrets-backend → exit 2 with clear message', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        `--out=${join(packDir, '.env.example')}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--secrets-backend is required');
  });

  test('non-interactive + backend=postgres + missing --kms → exit 2', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=postgres',
        `--out=${join(packDir, '.env.example')}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--kms is required');
  });

  test('invalid --secrets-backend value → exit 2 with allowed list', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=redis',
        `--out=${join(packDir, '.env.example')}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--secrets-backend must be one of');
  });

  test('refuses to overwrite existing file without --force', async () => {
    const outPath = join(packDir, '.env.example');
    const fixtures = makeFixtures({ [outPath]: '# existing content\n' });
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=none',
        `--out=${outPath}`,
        '--non-interactive',
      ]),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Refusing to overwrite');
    // Original preserved.
    expect(fixtures.state.files.get(outPath)).toBe('# existing content\n');
  });

  test('--force overwrites existing file', async () => {
    const outPath = join(packDir, '.env.example');
    const fixtures = makeFixtures({ [outPath]: '# old\n' });
    const out = await runCli(
      baseInputs(fixtures, [
        'env',
        'init',
        '--secrets-backend=none',
        `--out=${outPath}`,
        '--force',
        '--non-interactive',
      ]),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.files.get(outPath)).not.toContain('# old');
    expect(fixtures.state.files.get(outPath)).toContain('kindgi env init');
  });

  test('interactive: prompt fixture supplies backend + kms', async () => {
    const fixtures = makeFixtures();
    const outPath = join(packDir, '.env.example');
    const questionsAsked: string[] = [];
    const answers = ['postgres', 'gcp'];
    const out = await runCli(
      baseInputs(fixtures, ['env', 'init', `--out=${outPath}`], {
        envInitInputSeam: {
          stdinIsTty: () => true,
          promptChoice: async (question) => {
            questionsAsked.push(question);
            return answers.shift();
          },
        },
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(questionsAsked).toHaveLength(2);
    expect(questionsAsked[0]).toContain('Which secrets backend');
    expect(questionsAsked[1]).toContain('Which KMS');
    expect(fixtures.state.files.get(outPath)).toContain('KINDGI_SECRETS_GCP_PROJECT_ID');
  });

  test('interactive: user declines (returns undefined) → exit 1 with "Cancelled"', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'init', `--out=${join(packDir, '.env.example')}`], {
        envInitInputSeam: {
          stdinIsTty: () => true,
          promptChoice: async () => undefined,
        },
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Cancelled');
  });

  test('missing --secrets-backend + no TTY → exit 2 (fails without prompting)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['env', 'init', `--out=${join(packDir, '.env.example')}`], {
        envInitInputSeam: {
          stdinIsTty: () => false,
          promptChoice: async () => {
            throw new Error('should not prompt on non-TTY');
          },
        },
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--secrets-backend is required');
  });
});

// ---------- --env=local: the project's own env files ----------

describe('kindgi env --env=local — the project env files', () => {
  const dotEnv = () => join(packDir, '.env');
  const dotEnvLocal = () => join(packDir, '.env.local');

  test('list merges .env < .env.local, names the winning file, marks KINDGI_* as runtime', async () => {
    const fixtures = makeFixtures({
      [dotEnv()]: 'A=base\nB=base\nKINDGI_DATABASE_URL=postgres://k\n',
      [dotEnvLocal()]: 'B=local\n',
    });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'list', '--env=local', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as {
      envFiles: Array<{ file: string; exists: boolean }>;
      values: Array<{ key: string; file?: string; runtime: boolean }>;
    };
    expect(summary.envFiles).toEqual([
      { file: '.env', exists: true },
      { file: '.env.local', exists: true },
    ]);
    const byKey = Object.fromEntries(summary.values.map((v) => [v.key, v]));
    expect(byKey.A?.file).toBe('.env');
    expect(byKey.B?.file).toBe('.env.local');
    expect(byKey.KINDGI_DATABASE_URL?.runtime).toBe(true);
  });

  test('set writes .env.local and never touches the host .env', async () => {
    const hostEnv = '# app\nDATABASE_URL="postgres://app"\n';
    const fixtures = makeFixtures({ [dotEnv()]: hostEnv });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'set', 'NEW_KEY', 'v', '--env=local', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.files.get(dotEnv())).toBe(hostEnv);
    expect(fixtures.state.files.get(dotEnvLocal())).toBe('NEW_KEY=v\n');
  });

  test('a key set in .env needs --force; --force writes an override to .env.local', async () => {
    const fixtures = makeFixtures({ [dotEnv()]: 'KEY=from-env\n' });
    const refused = await runCli(
      baseInputs(fixtures, ['env', 'set', 'KEY', 'mine', '--env=local', `--path=${packDir}`]),
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('already set in .env');
    expect(refused.stderr).toContain('override to .env.local');
    const forced = await runCli(
      baseInputs(fixtures, [
        'env',
        'set',
        'KEY',
        'mine',
        '--force',
        '--env=local',
        `--path=${packDir}`,
      ]),
    );
    expect(forced.exitCode).toBe(0);
    expect(fixtures.state.files.get(dotEnv())).toBe('KEY=from-env\n');
    expect(fixtures.state.files.get(dotEnvLocal())).toBe('KEY=mine\n');
  });

  test('unset removes from .env.local and says the key is still set in .env', async () => {
    const fixtures = makeFixtures({ [dotEnv()]: 'KEY=base\n', [dotEnvLocal()]: 'KEY=local\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'unset', 'KEY', '--env=local', `--path=${packDir}`]),
    );
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.files.get(dotEnvLocal())).toBe('');
    expect(fixtures.state.files.get(dotEnv())).toBe('KEY=base\n');
    expect((JSON.parse(out.stdout) as { stillDefinedIn?: string }).stillDefinedIn).toBe('.env');
    expect(out.stderr).toContain('still set in .env');
  });

  test('dev.envFiles in kindgi.config.ts picks the files', async () => {
    const fixtures = makeFixtures({ [join(packDir, '.env.dev')]: 'X=dev\n' });
    const out = await runCli(
      baseInputs(fixtures, ['env', 'list', '--env=local', `--path=${packDir}`], {
        buildConfigLoader: async () => ({ dev: { envFiles: ['.env', '.env.dev'] } }),
      }),
    );
    const summary = JSON.parse(out.stdout) as { values: Array<{ key: string; file?: string }> };
    expect(summary.values).toEqual([expect.objectContaining({ key: 'X', file: '.env.dev' })]);
  });

  test('a malformed dev.envFiles is an error', async () => {
    const out = await runCli(
      baseInputs(makeFixtures(), ['env', 'list', '--env=local', `--path=${packDir}`], {
        buildConfigLoader: async () => ({ dev: { envFiles: 'not-a-list' } }),
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('dev.envFiles');
  });
});

// ---------- env plan ----------

describe('kindgi env plan', () => {
  const declaring = (production: unknown) => async () => ({
    pack: { id: 'acme.app', version: '1.0.0' },
    env: { required: ['DATABASE_URL'], optional: ['LOG_LEVEL'] },
    environments: { production: { env: production } },
  });

  test('prints the Terraform input, and the plan on stderr', async () => {
    const out = await runCli(
      baseInputs(makeFixtures(), ['env', 'plan', '--env=production', `--path=${packDir}`], {
        buildConfigLoader: declaring({
          DATABASE_URL: { secret: 'acme-db-url', version: '3' },
          LOG_LEVEL: 'info',
        }),
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      env: { LOG_LEVEL: 'info' },
      secret_env: { DATABASE_URL: { secret: 'acme-db-url', version: '3' } },
    });
    expect(out.stderr).toContain("The pack service's env in production:");
    expect(out.stderr).toContain('secret acme-db-url:3');
  });

  test('--format=gcloud prints the flags', async () => {
    const out = await runCli(
      baseInputs(
        makeFixtures(),
        ['env', 'plan', '--env=production', '--format=gcloud', `--path=${packDir}`],
        {
          buildConfigLoader: declaring({
            DATABASE_URL: { secret: 'acme-db-url', version: '3' },
            LOG_LEVEL: 'info',
          }),
        },
      ),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(
      '--update-env-vars=LOG_LEVEL=info \\\n--update-secrets=DATABASE_URL=acme-db-url:3\n',
    );
  });

  test('exits 1 naming a required name without a value, or a secret in the clear', async () => {
    const missing = await runCli(
      baseInputs(makeFixtures(), ['env', 'plan', '--env=production', `--path=${packDir}`], {
        buildConfigLoader: declaring({ LOG_LEVEL: 'info' }),
      }),
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(
      '✗ DATABASE_URL is required and has no value in environments.production.env',
    );

    const clear = await runCli(
      baseInputs(makeFixtures(), ['env', 'plan', '--env=production', `--path=${packDir}`], {
        buildConfigLoader: declaring({ DATABASE_URL: 'postgres://app:s3cret@db/app' }),
      }),
    );
    expect(clear.exitCode).toBe(1);
    expect(clear.stderr).toContain("DATABASE_URL's value has a credential in it");
    expect(clear.stderr).not.toContain('s3cret');
  });

  test('refuses an unknown --format', async () => {
    const out = await runCli(
      baseInputs(makeFixtures(), ['env', 'plan', '--format=yaml', `--path=${packDir}`], {
        buildConfigLoader: declaring({}),
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--format is terraform or gcloud, not "yaml"');
  });
});
