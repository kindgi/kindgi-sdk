// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * On a runtime that keeps its values under one env (whoami's `servedEnv`),
 * `--env` naming one of the pack's environments with a `project` is that
 * project, under the env the runtime serves (`value-target.ts`): for
 * `kindgi secrets`, `kindgi env --scope`, `env pull` and
 * `providers register --preset`. Anywhere else, `--env` is the env, as
 * before. (`deploy`: deploy.test.ts.)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SecretsValueInputSeam } from '../src/commands/secrets.js';
import type { EnvRunners } from '../src/env/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { type PackEnvironments, type ServedEnv, resolveValueTarget } from '../src/value-target.js';

const REFUSES: ServedEnv = { envName: 'prod', refusesOtherEnvs: true };
const TAKES_ANY: ServedEnv = { envName: 'prod', refusesOtherEnvs: false };

const STAGING_1 = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const PROD = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';

/** staging-1 names its project by slug, prod by id; qa names none. */
const CONFIG = {
  environments: {
    'staging-1': { project: 'acme-staging-1' },
    prod: { project: PROD },
    qa: {},
  },
};
const ENVIRONMENTS: PackEnvironments = {
  'staging-1': 'acme-staging-1',
  prod: PROD,
  qa: undefined,
};
const PROJECTS = [
  { id: STAGING_1, name: 'Acme staging 1', slug: 'acme-staging-1' },
  { id: PROD, name: 'Acme', slug: 'acme' },
];
const NOTE = `Environment staging-1: project acme-staging-1 (${STAGING_1}), values under prod.\n`;
const REFUSAL = (what: string, env: string) =>
  `env-not-served: this runtime keeps its values under \`prod\` only, so ${what} under \`${env}\` would never be read. Use --env=prod, or leave --env out.\n`;
const LISTED = `The pack's environments: staging-1 (project acme-staging-1), prod (project ${PROD}). --env=<one of them> stores a value in its project.\n`;

describe('resolveValueTarget with the pack environments', () => {
  const at = (
    flag: string | undefined,
    opts: {
      readonly write?: boolean;
      readonly scope?: string;
      readonly served?: ServedEnv;
      readonly environments?: PackEnvironments;
    } = {},
  ) =>
    resolveValueTarget({
      flag,
      served: opts.served ?? REFUSES,
      write: opts.write ?? true,
      what: 'a secret',
      environments: opts.environments ?? ENVIRONMENTS,
      ...(opts.scope !== undefined && { scope: opts.scope }),
    });

  test('an environment with a project: that project, under the env the runtime serves, for a read or a write', () => {
    for (const write of [true, false]) {
      expect(at('staging-1', { write })).toEqual({
        kind: 'ok',
        envName: 'prod',
        from: 'environment',
        environment: { name: 'staging-1', projectRef: 'acme-staging-1' },
      });
    }
    expect(at('prod')).toEqual({
      kind: 'ok',
      envName: 'prod',
      from: 'environment',
      environment: { name: 'prod', projectRef: PROD },
    });
    expect(at(undefined)).toEqual({ kind: 'ok', envName: 'prod', from: 'served' });
  });

  test('a --scope with it may only name its project', () => {
    for (const scope of ['project', `project:${OTHER}`]) {
      expect(at('staging-1', { scope })).toMatchObject({ kind: 'ok', from: 'environment' });
    }
    expect(at('staging-1', { scope: 'tenant' })).toEqual({
      kind: 'refused',
      stderr:
        "--env=staging-1 is the pack's environment staging-1, so its scope is its project, acme-staging-1, not tenant. For a value every environment without its own reads, leave --env out (--scope=tenant).\n",
    });
    expect(at('staging-1', { scope: 'org:org-acme' })).toMatchObject({ kind: 'refused' });
  });

  test('a write under an environment with no project, or one the pack lacks: refused, saying which have one', () => {
    expect(at('qa')).toEqual({
      kind: 'refused',
      stderr: `${REFUSAL('a secret', 'qa')}The pack's environment qa names no project: add \`environments.qa.project\` to kindgi.config.ts, and --env=qa stores values in that project.\n${LISTED}`,
    });
    expect(at('staging')).toEqual({
      kind: 'refused',
      stderr: `${REFUSAL('a secret', 'staging')}${LISTED}`,
    });
    expect(at('staging', { environments: { qa: undefined } })).toEqual({
      kind: 'refused',
      stderr: `${REFUSAL('a secret', 'staging')}No environment in the pack's config names a project: add \`environments.<name>.project\` to kindgi.config.ts, and --env=<name> stores values in that project.\n`,
    });
  });

  test('`local` gets its own hint, not the environments', () => {
    const refused = at('local');
    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' && refused.stderr).not.toContain('environments');
  });

  test('a read under a name with no project is that env, to find what was stored before', () => {
    expect(at('qa', { write: false })).toEqual({ kind: 'ok', envName: 'qa', from: 'flag' });
  });

  test('anywhere else, --env is the env, whatever the pack names', () => {
    for (const served of [TAKES_ANY, undefined]) {
      expect(
        resolveValueTarget({
          flag: 'staging-1',
          served,
          write: true,
          what: 'a secret',
          environments: ENVIRONMENTS,
        }),
      ).toEqual({ kind: 'ok', envName: 'staging-1', from: 'flag' });
    }
  });
});

// ---------- through the commands ----------

let packDir: string;
const files = new Map<string, string>();

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-env-project-'));
  files.clear();
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

/** A runtime answering whoami with `served` and the projects with `projects`, recording each call. */
function runtime(served: ServedEnv | undefined, projects: readonly unknown[] = PROJECTS) {
  const calls: [string, Record<string, unknown>][] = [];
  const record =
    (op: string, answer: (input: Record<string, unknown>) => unknown) =>
    async (input: Record<string, unknown> = {}) => {
      calls.push([op, input]);
      return answer(input);
    };
  const client = {
    identity: {
      whoami: async () => ({
        tenantId: 't-1',
        scopes: [],
        ...(served !== undefined && { servedEnv: served }),
      }),
    },
    projects: { list: record('projects.list', () => ({ data: projects, hasMore: false })) },
    secrets: {
      set: record('secrets.set', (input) => ({
        kind: 'ok',
        record: { ...input, currentVersion: 1, createdAt: 'x', updatedAt: 'x' },
        versionId: 1,
      })),
      list: record('secrets.list', () => ({ data: [] })),
    },
    env: {
      get: record('env.get', () => null),
      set: record('env.set', (input) => ({ kind: 'ok', record: { ...input, revision: 1 } })),
      list: record('env.list', () => ({
        data: [{ name: 'ACME_REGION', value: 'eu', revision: 1, updatedAt: 'x' }],
      })),
    },
    providers: {
      register: record('providers.register', (input) => ({
        providerId: (input.metadata as { id: string }).id,
      })),
    },
  };
  return { calls, clientFactory: (() => client) as never };
}

/** Where each call of `op` went: its scope and env. */
const sentTo = (rt: ReturnType<typeof runtime>, op: string) =>
  rt.calls.filter(([o]) => o === op).map(([, i]) => [i.scope, i.envName]);

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

function cli(
  rt: ReturnType<typeof runtime>,
  argv: readonly string[],
  /** The pack config, or what loading it throws. */
  config: { readonly [k: string]: unknown } | Error = CONFIG,
) {
  const inputs: RunCliInputs = {
    argv: [...argv, '--url=https://api.acme.example', '--token=t'],
    env: {},
    cwd: packDir,
    home: packDir,
    envRunners,
    secretsInputSeam: seam,
    clientFactory: rt.clientFactory,
    buildConfigLoader: async () => {
      if (config instanceof Error) throw config;
      return config;
    },
  };
  return runCli(inputs);
}

const AT_STAGING_1 = [{ kind: 'project', projectId: STAGING_1 }, 'prod'];

describe('kindgi secrets: --env naming a pack environment, on a runtime that keeps its values under one env', () => {
  test("set: the environment's project, under the env the runtime serves, with no --scope", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'set', 'stripe.key', '--env=staging-1', '--from-stdin']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr.startsWith(NOTE)).toBe(true);
    expect(sentTo(rt, 'secrets.set')).toEqual([AT_STAGING_1]);
    expect(rt.calls.filter(([op]) => op === 'projects.list')).toHaveLength(1);
  });

  test('an environment that names its project by id: no projects are listed', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'set', 'stripe.key', '--env=prod', '--from-stdin']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr.startsWith(`Environment prod: project ${PROD}, values under prod.\n`)).toBe(
      true,
    );
    expect(sentTo(rt, 'secrets.set')).toEqual([[{ kind: 'project', projectId: PROD }, 'prod']]);
    expect(rt.calls.some(([op]) => op === 'projects.list')).toBe(false);
  });

  test("a read is the environment's project too", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'list', '--env=staging-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(sentTo(rt, 'secrets.list')).toEqual([AT_STAGING_1]);
  });

  test("--scope=project, or the project's own id, is the same; another scope is refused, and nothing is sent", async () => {
    for (const scope of ['--scope=project', `--scope=project:${STAGING_1}`]) {
      const rt = runtime(REFUSES);
      const out = await cli(rt, [
        'secrets',
        'set',
        'stripe.key',
        '--env=staging-1',
        scope,
        '--from-stdin',
      ]);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(sentTo(rt, 'secrets.set')).toEqual([AT_STAGING_1]);
    }
    const tenant = runtime(REFUSES);
    const wide = await cli(tenant, [
      'secrets',
      'set',
      'stripe.key',
      '--env=staging-1',
      '--scope=tenant',
      '--from-stdin',
    ]);
    expect(wide.exitCode).toBe(2);
    expect(wide.stderr).toContain('so its scope is its project, acme-staging-1, not tenant');
    expect(sentTo(tenant, 'secrets.set')).toEqual([]);
    const other = runtime(REFUSES);
    const mismatch = await cli(other, [
      'secrets',
      'set',
      'stripe.key',
      '--env=staging-1',
      `--scope=project:${OTHER}`,
      '--from-stdin',
    ]);
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stderr).toBe(
      `--env=staging-1 is the pack's environment staging-1, project acme-staging-1 (${STAGING_1}), but --scope names project ${OTHER}. Name one: --env=staging-1 with --scope=project, or --scope=project:${OTHER} without --env.\n`,
    );
    expect(sentTo(other, 'secrets.set')).toEqual([]);
    const empty = runtime(REFUSES);
    const malformed = await cli(empty, [
      'secrets',
      'set',
      'stripe.key',
      '--env=staging-1',
      '--scope=project:',
      '--from-stdin',
    ]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toBe(
      'Malformed --scope: expected --scope=project:<projectId>, got "project:".\n',
    );
    expect(empty.calls).toEqual([]);
  });

  test('a name with no project is sent as given: a value stored there before', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'list', '--env=staging', '--scope=tenant']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(sentTo(rt, 'secrets.list')).toEqual([[{ kind: 'tenant' }, 'staging']]);
  });

  test('a slug that names no project, or two, is refused before anything is sent', async () => {
    const none = runtime(REFUSES, []);
    const missing = await cli(none, [
      'secrets',
      'set',
      'stripe.key',
      '--env=staging-1',
      '--from-stdin',
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toBe(
      'The pack\'s environment staging-1: No project of this tenant has the slug "acme-staging-1". `kindgi projects list` shows them; pass a project id instead.\n',
    );
    expect(sentTo(none, 'secrets.set')).toEqual([]);
    const two = runtime(REFUSES, [
      { id: STAGING_1, name: 'Acme staging 1', slug: 'acme-staging-1', orgId: 'org-a' },
      { id: OTHER, name: 'Acme staging 1', slug: 'acme-staging-1', orgId: 'org-b' },
    ]);
    const both = await cli(two, [
      'secrets',
      'set',
      'stripe.key',
      '--env=staging-1',
      '--from-stdin',
    ]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain('"acme-staging-1" is the slug of 2 projects, in different orgs');
    expect(sentTo(two, 'secrets.set')).toEqual([]);
  });

  test("pull writes the environment's own manifest", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['secrets', 'pull', '--env=staging-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(sentTo(rt, 'secrets.list')).toEqual([AT_STAGING_1]);
    expect([...files.keys()]).toEqual([`${packDir}/.secrets/staging-1/manifest.json`]);
  });

  test('on a runtime that takes any env, or names none: --env is the env, as before', async () => {
    for (const served of [TAKES_ANY, undefined]) {
      const rt = runtime(served);
      const out = await cli(rt, [
        'secrets',
        'set',
        'stripe.key',
        '--env=staging-1',
        '--scope=tenant',
        '--from-stdin',
      ]);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stderr).not.toContain('Environment staging-1');
      expect(sentTo(rt, 'secrets.set')).toEqual([[{ kind: 'tenant' }, 'staging-1']]);
      expect(rt.calls.some(([op]) => op === 'projects.list')).toBe(false);
    }
  });
});

describe('kindgi env: --env naming a pack environment, on a runtime that keeps its values under one env', () => {
  test("set with --scope=project: the environment's project, under the env the runtime serves", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, [
      'env',
      'set',
      'ACME_REGION',
      'eu',
      '--env=staging-1',
      '--scope=project',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr.startsWith(NOTE)).toBe(true);
    expect(sentTo(rt, 'env.set')).toEqual([AT_STAGING_1]);
  });

  test("without --scope, `kindgi env set` edits the pack's env files, as before: nothing is sent", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['env', 'set', 'ACME_REGION', 'eu', '--env=staging-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(rt.calls).toEqual([]);
  });

  test('--scope=project with no pack environment named is refused, naming the form that names one', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['env', 'set', 'ACME_REGION', 'eu', '--scope=project']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(
      "--scope=project alone is the project of the pack's environment --env names, on a runtime that keeps its values under one env. Here, name the project: --scope=project:<projectId>.\n",
    );
    expect(sentTo(rt, 'env.set')).toEqual([]);
  });

  test("pull with no --scope: the environment's project, into its own .env file", async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['env', 'pull', '--env=staging-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(sentTo(rt, 'env.list')).toEqual([AT_STAGING_1]);
    expect(out.stderr).toContain(`for env=prod, scope=project:${STAGING_1}`);
    expect(JSON.parse(out.stdout).envFilePath).toMatch(/\.env\.staging-1$/);
  });

  test('pull with no --scope and no pack environment named: --scope is required, as before', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, ['env', 'pull']);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Missing required flag: --scope=<kind>[:id].');
    expect(sentTo(rt, 'env.list')).toEqual([]);
  });

  test('a credential set this way is pointed to `kindgi secrets set` with the same --env', async () => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, [
      'env',
      'set',
      'ACME_API_TOKEN',
      'x',
      '--env=staging-1',
      '--scope=project',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(
      'Store a credential as a secret: kindgi secrets set ACME_API_TOKEN --env=staging-1\n',
    );
  });
});

describe('kindgi env set|list|unset without --scope: one line for an environment with a project, from the config alone', () => {
  /** The same environments, with staging-1 naming no project. */
  const UNMAPPED = { environments: { ...CONFIG.environments, 'staging-1': {} } };
  const line = (lead: string, action: string) =>
    `  ${lead} --scope=project ${action} the staging-1 environment's project, acme-staging-1, on a runtime that keeps its values under one env.\n`;

  test.each([
    [
      'set',
      ['env', 'set', 'ACME_REGION', 'eu', '--env=staging-1'],
      line("ACME_REGION went to .env.staging-1, the pack's env file.", 'sets it in'),
    ],
    [
      'list',
      ['env', 'list', '--env=staging-1'],
      line("These are the pack's env files' values.", 'lists the values of'),
    ],
    [
      'unset',
      ['env', 'unset', 'ACME_REGION', '--env=staging-1'],
      line(".env.staging-1 is the pack's env file.", 'removes it from'),
    ],
  ])(
    '%s: the line when the environment has a project, none when it has none; stdout the same',
    async (_, argv, expected) => {
      for (const json of [[], ['--json']]) {
        const rt = runtime(REFUSES);
        files.clear();
        const mapped = await cli(rt, [...argv, ...json]);
        files.clear();
        const unmapped = await cli(rt, [...argv, ...json], UNMAPPED);
        expect(mapped.exitCode, mapped.stderr).toBe(0);
        expect(unmapped.exitCode, unmapped.stderr).toBe(0);
        expect(mapped.stderr).toContain(expected);
        expect(unmapped.stderr).not.toContain('--scope=project');
        expect(mapped.stderr.replace(expected, '')).toBe(unmapped.stderr);
        expect(mapped.stdout).toBe(unmapped.stdout);
        expect(rt.calls).toEqual([]);
      }
    },
  );
});

describe("a pack config that can't be read, on a runtime that keeps its values under one env", () => {
  const BROKEN = new Error('kindgi.config.ts: Unexpected token');
  const REFUSED =
    "Couldn't read the pack config: kindgi.config.ts: Unexpected token\nOn this runtime, --env=staging-1 may name one of the pack's environments, whose values are in its project, so nothing was sent. Fix the config and run this again.\n";

  test.each([
    ['a secrets read', ['secrets', 'list', '--env=staging-1', '--scope=tenant']],
    ['a secrets write', ['secrets', 'set', 'stripe.key', '--env=staging-1', '--from-stdin']],
    ['an env read', ['env', 'list', `--scope=project:${STAGING_1}`, '--env=staging-1']],
  ])('%s is refused, saying why, and nothing is sent', async (_, argv) => {
    const rt = runtime(REFUSES);
    const out = await cli(rt, argv, BROKEN);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe(REFUSED);
    expect(rt.calls).toEqual([]);
  });

  test('on a runtime that takes any env, --env is the env, as before', async () => {
    const rt = runtime(TAKES_ANY);
    const out = await cli(rt, ['secrets', 'list', '--env=staging-1', '--scope=tenant'], BROKEN);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(sentTo(rt, 'secrets.list')).toEqual([[{ kind: 'tenant' }, 'staging-1']]);
  });
});

describe('kindgi providers register --preset: --env naming a pack environment', () => {
  test("the key under the env the runtime serves, with a line on storing it per environment; the project isn't looked up", async () => {
    const rt = runtime(REFUSES, []);
    const out = await cli(rt, ['providers', 'register', '--preset=anthropic', '--env=staging-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(rt.calls.some(([op]) => op === 'projects.list')).toBe(false);
    expect(
      rt.calls.filter(([op]) => op === 'providers.register').map(([, i]) => i.secret_ref),
    ).toEqual([{ envName: 'prod', name: 'ANTHROPIC_API_KEY' }]);
    expect(out.stderr).toContain(
      "Store the key per environment: `kindgi secrets set ANTHROPIC_API_KEY --env=staging-1`, and the same with each other environment's name.\n",
    );
  });
});
