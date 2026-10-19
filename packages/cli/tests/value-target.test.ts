// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The env a value command acts under (`value-target.ts`). On a runtime that
 * keeps its values under one env (whoami's `servedEnv`):
 * `--env` defaults to that one, and a write under another is refused before
 * anything is sent. Except a secret's: a registration made before may still
 * read it there, so `secrets set|rotate` send it and show the runtime's
 * answer. Anywhere else, each command's own default, as before.
 * (`deploy --sync-secrets`: deploy.test.ts.)
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

import type { SecretsValueInputSeam } from '../src/commands/secrets.js';
import type { EnvRunners } from '../src/env/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { type ServedEnv, resolveValueTarget } from '../src/value-target.js';

const REFUSES: ServedEnv = { envName: 'prod', refusesOtherEnvs: true };
const TAKES_ANY: ServedEnv = { envName: 'prod', refusesOtherEnvs: false };
const REFUSAL = (what: string, env: string) =>
  `env-not-served: this runtime keeps its values under \`prod\` only, so ${what} under \`${env}\` would never be read. Use --env=prod, or leave --env out.\n`;
const LOCAL_HINT =
  "`local` is a `kindgi dev` runtime's env: in a pack where `kindgi dev` runs, the CLI talks to that runtime, unless --url or KINDGI_API_URL names another.\n";
/** A provider registered before names its key under `local`: the runtime still takes it there. */
const READ_UNDER_LOCAL = 'ANTHROPIC_API_KEY';

describe('resolveValueTarget', () => {
  test('a runtime that refuses other envs: its env by default; a write under another refused, a read or a delete taken', () => {
    const at = (flag: string | undefined, write: boolean) =>
      resolveValueTarget({ flag, fallback: 'local', served: REFUSES, write, what: 'a secret' });
    expect(at(undefined, true)).toEqual({ kind: 'ok', envName: 'prod', from: 'served' });
    expect(at('prod', true)).toEqual({ kind: 'ok', envName: 'prod', from: 'flag' });
    expect(at('staging', true)).toEqual({
      kind: 'refused',
      stderr: REFUSAL('a secret', 'staging'),
    });
    expect(at('staging', false)).toEqual({ kind: 'ok', envName: 'staging', from: 'flag' });
  });

  test('anywhere else: --env, then the command default, then none', () => {
    for (const served of [TAKES_ANY, undefined]) {
      const at = (flag: string | undefined, fallback?: string) =>
        resolveValueTarget({
          flag,
          ...(fallback !== undefined && { fallback }),
          served,
          write: true,
          what: 'a secret',
        });
      expect(at('staging')).toEqual({ kind: 'ok', envName: 'staging', from: 'flag' });
      expect(at(undefined, 'local')).toEqual({ kind: 'ok', envName: 'local', from: 'default' });
      expect(at(undefined)).toEqual({ kind: 'missing' });
    }
  });

  test("mayOmit: false: the refusal doesn't suggest leaving --env out", () => {
    const target = resolveValueTarget({
      flag: 'staging',
      served: REFUSES,
      write: true,
      what: 'the secrets in .env.staging',
      mayOmit: false,
    });
    expect(target).toEqual({
      kind: 'refused',
      stderr:
        'env-not-served: this runtime keeps its values under `prod` only, so the secrets in .env.staging under `staging` would never be read. Use --env=prod.\n',
    });
  });
});

// ---------- through the commands ----------

let packDir: string;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-value-target-'));
  await writeFile(
    join(packDir, 'kindgi.config.ts'),
    "export default { pack: { id: 'acme-pack', version: '0.1.0' } };\n",
    'utf8',
  );
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

/**
 * A runtime answering whoami with `served`, recording every other call. One
 * that refuses other envs refuses a secret under another env as the server
 * does (`409 env-not-served`), unless it's the key a provider reads there.
 */
function runtime(served: ServedEnv | undefined) {
  const calls: [string, Record<string, unknown>][] = [];
  const record = (op: string) => async (input: Record<string, unknown>) => {
    calls.push([op, input]);
    if (
      (op === 'secrets.set' || op === 'secrets.rotate') &&
      served?.refusesOtherEnvs === true &&
      input.envName !== served.envName &&
      !(input.envName === 'local' && input.name === READ_UNDER_LOCAL)
    ) {
      throw new KindgiApiError({
        code: 'conflict',
        reason: 'env-not-served',
        message: `This runtime keeps its values under \`prod\` only, so the secret \`${String(input.name)}\` under \`${String(input.envName)}\` would never be read. Store it under \`prod\``,
        fields: { envName: input.envName, servedEnv: 'prod' },
      });
    }
    return op === 'secrets.set'
      ? {
          kind: 'ok',
          record: { ...input, currentVersion: 1, createdAt: 'x', updatedAt: 'x' },
          versionId: 1,
        }
      : op === 'env.set'
        ? { kind: 'ok', record: { ...input, revision: 1 } }
        : op === 'secrets.list' || op === 'env.list'
          ? { data: [] }
          : op === 'secrets.revoke'
            ? { revoked: true, hard: false }
            : { providerId: (input.metadata as { id: string }).id };
  };
  const client = {
    identity: {
      whoami: async () => ({
        tenantId: 't-1',
        scopes: [],
        ...(served !== undefined && { servedEnv: served }),
      }),
    },
    secrets: {
      set: record('secrets.set'),
      rotate: record('secrets.rotate'),
      list: record('secrets.list'),
      revoke: record('secrets.revoke'),
    },
    env: { get: async () => null, set: record('env.set'), list: record('env.list') },
    providers: { register: record('providers.register') },
  };
  return { calls, clientFactory: (() => client) as never };
}

const files = new Map<string, string>();
const envRunners: EnvRunners = {
  readFile: async (path) => files.get(path) ?? null,
  writeFile: async (path, contents) => {
    files.set(path, contents);
  },
};
const seam: SecretsValueInputSeam = {
  tty: {
    promptHidden: async () => {
      throw new Error('no prompt in these tests');
    },
    close: () => {
      /* no-op */
    },
  },
  stdinIsTty: () => false,
  readStdin: async () => 'sk_test_x\n',
};

function cli(rt: ReturnType<typeof runtime>, argv: readonly string[]) {
  const inputs: RunCliInputs = {
    argv: [...argv, '--url=https://api.acme.example', '--token=t'],
    env: {},
    cwd: packDir,
    home: packDir,
    envRunners,
    secretsInputSeam: seam,
    clientFactory: rt.clientFactory,
  };
  return runCli(inputs);
}

describe('kindgi secrets on a runtime that refuses other envs', () => {
  test('set with no --env: under the env it serves', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'set', 'stripe.key', '--scope=tenant', '--from-stdin']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([['secrets.set', 'prod']]);
    expect(JSON.parse(out.stdout)).toMatchObject({ envName: 'prod' });
  });

  test('set under another env: sent, so the key a provider registered before still reads there is written', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, [
      'secrets',
      'set',
      READ_UNDER_LOCAL,
      '--env=local',
      '--scope=tenant',
      '--from-stdin',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(rt.calls.map(([op, i]) => [op, i.envName, i.name])).toEqual([
      ['secrets.set', 'local', READ_UNDER_LOCAL],
    ]);
  });

  test("set or rotate under another env nothing reads: the runtime's refusal, with where `local` is", async () => {
    const rt = runtime(REFUSES);
    const set = await cli(rt, [
      'secrets',
      'set',
      'stripe.key',
      '--env=local',
      '--scope=tenant',
      '--from-stdin',
    ]);
    expect(set.exitCode).toBe(1);
    expect(set.stderr).toBe(
      `Error [env-not-served]: This runtime keeps its values under \`prod\` only, so the secret \`stripe.key\` under \`local\` would never be read. Store it under \`prod\`\n${LOCAL_HINT}`,
    );
    const rotated = await cli(rt, [
      'secrets',
      'rotate',
      'stripe.key',
      '--env=staging',
      '--scope=tenant',
      '--from-stdin',
    ]);
    expect(rotated.exitCode).toBe(1);
    expect(rotated.stderr).toBe(
      'Error [env-not-served]: This runtime keeps its values under `prod` only, so the secret `stripe.key` under `staging` would never be read. Store it under `prod`\n',
    );
    expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([
      ['secrets.set', 'local'],
      ['secrets.rotate', 'staging'],
    ]);
  });

  test('list or revoke under another env: sent, to find and remove a value stored before', async () => {
    const rt = runtime(REFUSES);
    const listed = await cli(rt, ['secrets', 'list', '--env=staging', '--scope=tenant']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const revoked = await cli(rt, [
      'secrets',
      'revoke',
      'stripe.key',
      '--env=staging',
      '--scope=tenant',
    ]);
    expect(revoked.exitCode, revoked.stderr).toBe(0);
    expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([
      ['secrets.list', 'staging'],
      ['secrets.revoke', 'staging'],
    ]);
  });

  test("a kindgi.config.ts that isn't a pack config: --env refused, nothing sent; without --env, the env it serves", async () => {
    await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
    const rt = runtime(REFUSES);
    const refused = await cli(rt, ['secrets', 'list', '--env=staging', '--scope=tenant']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toMatch(
      /^Couldn't read the pack config: .*'pack' field is missing or not an object\nOn this runtime, --env=staging may name one of the pack's environments, whose values are in its project, so nothing was sent\. Fix the config and run this again\.\n$/,
    );
    expect(rt.calls).toEqual([]);
    const served = await cli(rt, ['secrets', 'list', '--scope=tenant']);
    expect(served.exitCode, served.stderr).toBe(0);
    expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([['secrets.list', 'prod']]);
  });

  test('a runtime that names no served env, or takes any: --env is required, and any is sent', async () => {
    for (const served of [undefined, TAKES_ANY]) {
      const rt = runtime(served);
      const missing = await cli(rt, ['secrets', 'set', 'k', '--scope=tenant', '--from-stdin']);
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain('Missing required flag: --env=<name>.');
      const set = await cli(rt, [
        'secrets',
        'set',
        'k',
        '--env=staging',
        '--scope=tenant',
        '--from-stdin',
      ]);
      expect(set.exitCode, set.stderr).toBe(0);
      expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([['secrets.set', 'staging']]);
    }
  });
});

describe('kindgi env --scope on a runtime that refuses other envs', () => {
  test('set with no --env: under the env it serves; under another: refused, nothing sent', async () => {
    const rt = runtime(REFUSES);
    const set = await cli(rt, ['env', 'set', 'ACME_REGION', 'eu', '--scope=tenant']);
    expect(set.exitCode, set.stderr).toBe(0);
    expect(set.stderr).toContain('at tenant in env prod');
    const refused = await cli(rt, [
      'env',
      'set',
      'ACME_REGION',
      'eu',
      '--scope=tenant',
      '--env=local',
    ]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe(`${REFUSAL('an env value', 'local')}${LOCAL_HINT}`);
    expect(rt.calls.map(([op, i]) => [op, i.envName])).toEqual([['env.set', 'prod']]);
  });

  test('pull with no --env: the env it serves, into its .env file; elsewhere `staging`, as before', async () => {
    const served = runtime(REFUSES);
    const pulled = await cli(served, ['env', 'pull', '--scope=tenant']);
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    expect(pulled.stderr).toContain('for env=prod');
    const plain = runtime(undefined);
    const before = await cli(plain, ['env', 'pull', '--scope=tenant']);
    expect(before.exitCode, before.stderr).toBe(0);
    expect(before.stderr).toContain('for env=staging');
    expect([...served.calls, ...plain.calls].map(([op, i]) => [op, i.envName])).toEqual([
      ['env.list', 'prod'],
      ['env.list', 'staging'],
    ]);
  });

  test('a runtime that names no served env: --env is required, as before', async () => {
    const rt = runtime(undefined);
    const out = await cli(rt, ['env', 'set', 'ACME_REGION', 'eu', '--scope=tenant']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Missing required flag: --env=<name>.');
    expect(rt.calls).toEqual([]);
  });
});

describe('kindgi providers register --preset on a runtime that refuses other envs', () => {
  const secretRef = (rt: ReturnType<typeof runtime>) =>
    rt.calls.map(([op, i]) => [op, i.secret_ref]);

  test('with no --env: the key under the env it serves, not `local`', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['providers', 'register', '--preset=anthropic']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(secretRef(rt)).toEqual([
      ['providers.register', { envName: 'prod', name: 'ANTHROPIC_API_KEY' }],
    ]);
  });

  test('--env=local: refused, and nothing is registered', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['providers', 'register', '--preset=anthropic', '--env=local']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(
      `${REFUSAL("a provider's key", 'local')}\`local\` is a \`kindgi dev\` runtime's env: in a pack where \`kindgi dev\` runs, the CLI talks to that runtime, unless --url or KINDGI_API_URL names another.`,
    );
    expect(rt.calls).toEqual([]);
  });

  test('a runtime that names no served env: `local`, as before', async () => {
    // Under `local` the preset first looks for the key in the pack's env files.
    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-acme-test\n', 'utf8');
    const rt = runtime(undefined);
    const out = await cli(rt, ['providers', 'register', '--preset=anthropic']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(secretRef(rt)).toEqual([
      ['providers.register', { envName: 'local', name: 'ANTHROPIC_API_KEY' }],
    ]);
  });
});
