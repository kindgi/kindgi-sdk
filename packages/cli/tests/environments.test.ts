// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi environments list / set / clear`: the order projects go live
 * through. `set` names environments from the pack config, resolving
 * `environments.<name>.project` the way `kindgi deploy --project` resolves a
 * project; `--projects` takes ids or slugs directly, outside a pack.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { projectOfEnv } from '../src/commands/build.js';
import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const PROJECTS = [
  { id: 'p-staging', name: 'Staging', slug: 'staging' },
  { id: 'p-default', name: 'Default', slug: 'default', isDefault: true },
];

/** prod maps to the Default's slug — the Default is ordered like any project. */
const CONFIG = {
  environments: {
    staging: { project: 'staging' },
    prod: { project: 'default' },
  },
};

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

type Call = readonly unknown[];

async function run(
  argv: readonly string[],
  opts: {
    readonly projects?: readonly unknown[];
    readonly order?: unknown;
    readonly config?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    ...(opts.config !== undefined && {
      buildConfigLoader: async () => opts.config as { readonly [k: string]: unknown },
    }),
    clientFactory: () =>
      ({
        projects: {
          list: async (...args: unknown[]) => {
            calls.push(['projects.list', ...args]);
            return { data: opts.projects ?? [], hasMore: false };
          },
        },
        environmentOrders: {
          getTenantOrder: async (...args: unknown[]) => {
            calls.push(['getTenantOrder', ...args]);
            return opts.order ?? { parent: { kind: 'tenant' }, entries: [] };
          },
          getOrgOrder: async (...args: unknown[]) => {
            calls.push(['getOrgOrder', ...args]);
            return opts.order ?? { parent: { kind: 'org', orgId: args[0] }, entries: [] };
          },
          setTenantOrder: async (...args: unknown[]) => {
            calls.push(['setTenantOrder', ...args]);
            return { parent: { kind: 'tenant' }, entries: [] };
          },
          setOrgOrder: async (...args: unknown[]) => {
            calls.push(['setOrgOrder', ...args]);
            return { parent: { kind: 'org', orgId: args[0] }, entries: [] };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('projectOfEnv', () => {
  test("reads environments.<name>.project, the Default's slug like any other", () => {
    expect(projectOfEnv(CONFIG, 'prod')).toBe('default');
    expect(projectOfEnv(CONFIG, 'staging')).toBe('staging');
  });

  test('undefined for an unknown environment, a missing project, or no config', () => {
    expect(projectOfEnv(CONFIG, 'qa')).toBeUndefined();
    expect(projectOfEnv({ environments: { x: {} } }, 'x')).toBeUndefined();
    expect(projectOfEnv(undefined, 'prod')).toBeUndefined();
  });
});

describe('kindgi environments set', () => {
  test('resolves environment names through the pack config; the Default can be last', async () => {
    const { out, calls } = await run(['environments', 'set', 'staging', 'prod'], {
      projects: PROJECTS,
      config: CONFIG,
    });
    expect(out.exitCode).toBe(0);
    expect(calls.find((c) => c[0] === 'setTenantOrder')).toEqual([
      'setTenantOrder',
      { projectIds: ['p-staging', 'p-default'] },
    ]);
  });

  test('--projects takes ids directly, without listing projects', async () => {
    const { out, calls } = await run(['environments', 'set', `--projects=${UUID_A},${UUID_B}`]);
    expect(out.exitCode).toBe(0);
    expect(calls.some((c) => c[0] === 'projects.list')).toBe(false);
    expect(calls.find((c) => c[0] === 'setTenantOrder')).toEqual([
      'setTenantOrder',
      { projectIds: [UUID_A, UUID_B] },
    ]);
  });

  test('an environment the config lacks is refused, naming a TS pack’s kindgi.config.ts', async () => {
    await writeFile(join(cwd, 'kindgi.config.ts'), 'export default {};\n');
    const { out, calls } = await run(['environments', 'set', 'staging', 'qa'], {
      projects: PROJECTS,
      config: CONFIG,
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('qa');
    expect(out.stderr).toContain('kindgi.config.ts');
    expect(calls.some((c) => c[0] === 'setTenantOrder')).toBe(false);
  });

  test('the refusal names a non-TS pack’s config file: a Python pack’s pyproject.toml', async () => {
    await writeFile(join(cwd, 'pyproject.toml'), '[tool.kindgi]\nname = "p"\n');
    const { out } = await run(['environments', 'set', 'staging', 'qa'], {
      projects: PROJECTS,
      config: CONFIG,
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('pyproject.toml');
    expect(out.stderr).not.toContain('kindgi.config.ts');
  });

  test('a slug shared by projects in two orgs is refused, naming them', async () => {
    const dup = [
      { id: 'p-a', name: 'A', slug: 'shared', orgId: 'o1' },
      { id: 'p-b', name: 'B', slug: 'shared', orgId: 'o2' },
    ];
    const { out } = await run(['environments', 'set', '--projects=shared,other'], {
      projects: dup,
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('p-a');
    expect(out.stderr).toContain('p-b');
  });

  test("a renamed project's old slug is refused with its new one, naming where it was given", async () => {
    const renamed = [
      { id: 'p-staging', name: 'Staging', slug: 'staging', formerSlugs: ['stage'] },
      { id: 'p-default', name: 'Default', slug: 'default', isDefault: true, formerSlugs: [] },
    ];
    const flag = await run(['environments', 'set', '--projects=stage,default'], {
      projects: renamed,
    });
    expect(flag.out.exitCode).toBe(2);
    expect(flag.out.stderr).toContain(
      '"stage" was the slug of project p-staging (Staging) until it was renamed to "staging". Change --projects to "staging" or to the project\'s id.',
    );
    expect(flag.calls.some((c) => c[0] === 'setTenantOrder')).toBe(false);

    const pack = await run(['environments', 'set', 'staging', 'prod'], {
      projects: renamed,
      config: { environments: { staging: { project: 'stage' }, prod: { project: 'default' } } },
    });
    expect(pack.out.exitCode).toBe(2);
    expect(pack.out.stderr).toContain(
      'Change environments.staging.project to "staging" or to the project\'s id.',
    );
    expect(pack.calls.some((c) => c[0] === 'setTenantOrder')).toBe(false);
  });

  test('--org sets an org order', async () => {
    const { out, calls } = await run([
      'environments',
      'set',
      '--org=o1',
      `--projects=${UUID_A},${UUID_B}`,
    ]);
    expect(out.exitCode).toBe(0);
    expect(calls.find((c) => c[0] === 'setOrgOrder')).toEqual([
      'setOrgOrder',
      'o1',
      { projectIds: [UUID_A, UUID_B] },
    ]);
  });
});

describe('kindgi environments clear', () => {
  test('clears the tenant order with []', async () => {
    const { out, calls } = await run(['environments', 'clear']);
    expect(out.exitCode).toBe(0);
    expect(calls.find((c) => c[0] === 'setTenantOrder')).toEqual([
      'setTenantOrder',
      { projectIds: [] },
    ]);
  });

  test('--org clears an org order', async () => {
    const { out, calls } = await run(['environments', 'clear', '--org=o9']);
    expect(out.exitCode).toBe(0);
    expect(calls.find((c) => c[0] === 'setOrgOrder')).toEqual([
      'setOrgOrder',
      'o9',
      { projectIds: [] },
    ]);
  });
});

describe('kindgi environments list', () => {
  const order = {
    parent: { kind: 'tenant' },
    entries: [
      { position: 0, projectId: 'p-staging' },
      { position: 1, projectId: 'p-default' },
      { position: 2 },
    ],
  };

  test('prints the order as JSON by default', async () => {
    const { out, calls } = await run(['environments', 'list'], { order });
    expect(out.exitCode).toBe(0);
    expect(calls.some((c) => c[0] === 'getTenantOrder')).toBe(true);
    expect(out.stdout).toContain('p-staging');
    expect(out.stdout).toContain('p-default');
  });

  test('--table names each environment from the pack config, hiding what it cannot read', async () => {
    const { out } = await run(['environments', 'list', '--table'], {
      order,
      projects: PROJECTS,
      config: CONFIG,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('POSITION');
    expect(out.stdout).toContain('ENVIRONMENT');
    expect(out.stdout).toContain('prod'); // the label for p-default (prod -> default)
    expect(out.stdout).toContain('(hidden)'); // position 2 has no readable project
  });

  test('--org lists an org order', async () => {
    const { out, calls } = await run(['environments', 'list', '--org=o1'], { order });
    expect(out.exitCode).toBe(0);
    expect(calls.find((c) => c[0] === 'getOrgOrder')).toEqual(['getOrgOrder', 'o1']);
  });
});
