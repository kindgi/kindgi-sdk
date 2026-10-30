// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi promote --from=<env> --to=<env>`: it finds the pack's deployment
 * serving in `--from`, asks what would move and prints it, prints each
 * value not set in `--to` with the command that sets it, and promotes only
 * when every one is.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
  { id: 'p-prod', name: 'Prod', slug: 'prod' },
];

const CONFIG = {
  pack: { id: 'acme.shop' },
  environments: { staging: { project: 'staging' }, prod: { project: 'prod' } },
};

const deployment = (id: string, extra: Record<string, unknown> = {}) => ({
  deploymentId: id,
  imageDigest: `sha256:${'a'.repeat(64)}`,
  artifactVersion: '20261018.1',
  activatedAt: '2026-10-18T08:00:00.000Z',
  ...extra,
});

const MOVES = {
  packId: 'acme.shop',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  agents: [
    { id: 'acme.matcher', version: '1.0.0' },
    { id: 'acme.matcher', version: '1.0.2', carried: true },
  ],
  flows: [{ id: 'acme.checkout', version: '2.0.0' }],
  tools: [{ id: 'acme.lookup', version: '1.1.0' }],
  guardrails: [{ id: 'acme.pii' }],
};

const READY_CHECK = {
  moves: MOVES,
  values: [],
  nextEnvironment: { projectId: 'p-prod', position: 1 },
  leftBehind: [{ kind: 'agent', id: 'acme.matcher', version: '1.1.1', from: '1.1.0' }],
};

const NOT_READY = [
  {
    name: 'ACME_TOKEN',
    kind: 'secret',
    neededBy: { type: 'tool', id: 'acme.lookup', version: '1.1.0' },
    problem: 'missing',
  },
  {
    name: 'SHOP_URL',
    kind: 'pack-env',
    neededBy: { type: 'pack', id: 'acme.shop' },
    problem: 'missing',
  },
  {
    name: 'API_BASE',
    kind: 'pack-env',
    neededBy: { type: 'pack', id: 'acme.shop' },
    foundAt: 'project',
    problem: 'ambiguous',
  },
  {
    name: 'ACME_MODEL_KEY',
    kind: 'model-key',
    neededBy: { type: 'provider', id: 'acme-llm' },
    foundAt: 'tenant',
    problem: 'revoked',
  },
  {
    name: 'LATER',
    kind: 'env',
    neededBy: { type: 'agent', id: 'acme.matcher', version: '1.0.0' },
    problem: 'quota',
  },
  {
    name: 'any provider',
    kind: 'model-key',
    neededBy: { type: 'agent', id: 'acme.matcher', version: '1.0.0' },
    problem: 'no-provider',
  },
];

type Call = readonly unknown[];

async function run(
  argv: readonly string[],
  opts: {
    readonly config?: Record<string, unknown>;
    readonly pages?: readonly Record<string, unknown>[];
    readonly check?: unknown;
    readonly promote?: () => unknown;
    /** No pack config: the cwd has none. */
    readonly noPack?: boolean;
    readonly projects?: readonly Record<string, unknown>[];
    /** `agents.pinned.getChange`: a carried version's pin, as a `--wait` reads it. */
    readonly pinnedGet?: (agentId: string, changeId: string) => unknown;
    /** Ctrl-C. */
    readonly stopSignal?: AbortSignal;
  } = {},
) {
  const calls: Call[] = [];
  let page = 0;
  // `--wait`'s clock: each pause moves it on, so a wait takes no time.
  let clock = 0;
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    approvalWaitSeam: {
      now: () => clock,
      pause: async (ms: number) => {
        calls.push(['pause', ms]);
        clock += ms;
      },
    },
    ...(opts.stopSignal !== undefined && { stopSignal: opts.stopSignal }),
    ...(opts.noPack !== true && {
      buildConfigLoader: async () => (opts.config ?? CONFIG) as { readonly [k: string]: unknown },
    }),
    clientFactory: (url: string) => {
      calls.push(['client', url]);
      return {
        agents: {
          pinned: {
            getChange: async (agentId: string, changeId: string) => {
              calls.push(['pinned.getChange', agentId, changeId]);
              return opts.pinnedGet?.(agentId, changeId);
            },
          },
        },
        projects: {
          list: async (...args: unknown[]) => {
            calls.push(['projects.list', ...args]);
            return { data: opts.projects ?? PROJECTS, hasMore: false };
          },
        },
        deployments: {
          list: async (...args: unknown[]) => {
            calls.push(['deployments.list', ...args]);
            const pages = opts.pages ?? [
              {
                data: [deployment('dep-s1')],
                hasMore: false,
                projectId: 'p-staging',
                packId: 'acme.shop',
              },
            ];
            const answer = pages[page] ?? pages[pages.length - 1];
            page += 1;
            return answer;
          },
          promoteCheck: async (...args: unknown[]) => {
            calls.push(['promoteCheck', ...args]);
            return opts.check ?? READY_CHECK;
          },
          promote: async (...args: unknown[]) => {
            calls.push(['promote', ...args]);
            if (opts.promote !== undefined) return opts.promote();
            return { deployment: deployment('dep-prod-1'), created: true, moved: MOVES };
          },
        },
      } as never;
    },
  });
  return { out, calls };
}

const named = (calls: readonly Call[], name: string) => calls.filter((c) => c[0] === name);

describe('kindgi promote', () => {
  test("finds the pack's one deployment serving in --from, prints what moves, then promotes", async () => {
    const { out, calls } = await run([
      'promote',
      '--from=staging',
      '--to=prod',
      '--reason=release 12',
    ]);
    expect(out.exitCode).toBe(0);
    expect(named(calls, 'deployments.list')).toEqual([
      ['deployments.list', { projectId: 'p-staging', packId: 'acme.shop' }],
    ]);
    expect(named(calls, 'promoteCheck')).toEqual([
      ['promoteCheck', 'dep-s1', { toProjectId: 'p-prod' }],
    ]);
    expect(named(calls, 'promote')).toEqual([
      ['promote', 'dep-s1', { toProjectId: 'p-prod', reason: 'release 12' }],
    ]);
    const text = out.stdout;
    expect(text).toContain('What moves from staging to prod (pack acme.shop, build sha256:');
    expect(text).toMatch(/agent +acme\.matcher +1\.0\.2 +carried: an edit made in staging/);
    expect(text).toMatch(/guardrail +acme\.pii/);
    expect(text).toContain(
      "agent acme.matcher 1.1.1: an edit of 1.1.0, which this build doesn't ship",
    );
    expect(text).toContain("Test cases don't move");
    expect(text).toContain('Every value it needs is set in prod.');
    expect(text).toContain('Promoted: deployment dep-prod-1 in prod.');
    // What moves is printed before the result.
    expect(text.indexOf('What moves')).toBeLessThan(text.indexOf('Promoted'));
  });

  test('a deployment whose pack service is gone for good is passed over; one that waits for it again is not', async () => {
    const retired = deployment('dep-old', {
      endpoint: { status: 'cleared', since: 'x', retired: 'superseded' },
    });
    const waiting = deployment('dep-s1', {
      endpoint: { status: 'cleared', since: 'x', waiting: true },
    });
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [
        {
          data: [retired],
          hasMore: true,
          nextCursor: 'c1',
          projectId: 'p-staging',
          packId: 'acme.shop',
        },
        { data: [waiting], hasMore: false, projectId: 'p-staging', packId: 'acme.shop' },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(named(calls, 'deployments.list')[1]).toEqual([
      'deployments.list',
      { projectId: 'p-staging', packId: 'acme.shop', cursor: 'c1' },
    ]);
    expect(named(calls, 'promote')[0]?.[1]).toBe('dep-s1');
  });

  test('values not set in --to: each with the command that sets it, exit 1, nothing promoted', async () => {
    // In a pack too, a value goes at the project's scope under the env the runtime serves, never
    // under the environment's name.
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      check: { ...READY_CHECK, values: NOT_READY, envName: 'production' },
    });
    expect(out.exitCode).toBe(1);
    expect(named(calls, 'promote')).toEqual([]);
    const text = out.stdout;
    expect(text).toContain('What moves from staging to prod');
    expect(text).toContain('Not ready in prod:');
    expect(text).toContain(
      'ACME_TOKEN (secret, for tool acme.lookup 1.1.0): set nowhere a run looks. Set it with `kindgi secrets set ACME_TOKEN --env=production --scope=project:p-prod`.',
    );
    expect(text).toContain(
      "SHOP_URL (pack-env, for the pack's service): set nowhere a run looks. Set it with `kindgi env set SHOP_URL <value> --scope=project:p-prod --env=production`.",
    );
    expect(text).toContain(
      "API_BASE (pack-env, for the pack's service): set both as a secret and as a plain value.",
    );
    expect(text).toContain(
      'ACME_MODEL_KEY (model-key, for provider acme-llm): revoked where a run reads it (the tenant)',
    );
    expect(text).toContain(
      '`kindgi secrets set ACME_MODEL_KEY --env=production --scope=project:p-prod`',
    );
    // A reason a later runtime names is said by its code.
    expect(text).toContain('LATER (env, for agent acme.matcher 1.0.0): not ready (quota).');
    expect(text).toContain(
      'any provider (model-key, for agent acme.matcher 1.0.0): no model provider is registered, so a run has none to call. Register one with `kindgi providers register --preset=<name>` (`kindgi providers presets` lists them), then check again: its key is needed in prod.',
    );
  });

  test('--check prints the same and never promotes: exit 0 when ready, 1 when not', async () => {
    const ready = await run(['promote', '--from=staging', '--to=prod', '--check']);
    expect(ready.out.exitCode).toBe(0);
    expect(ready.out.stdout).toContain('Every value it needs is set in prod.');
    expect(named(ready.calls, 'promote')).toEqual([]);

    const notReady = await run(['promote', '--from=staging', '--to=prod', '--check'], {
      check: { ...READY_CHECK, values: NOT_READY },
    });
    expect(notReady.out.exitCode).toBe(1);
    expect(notReady.out.stdout).toContain('Not ready in prod:');
    expect(named(notReady.calls, 'promote')).toEqual([]);
  });

  test('a value gone missing between the check and the promotion: the refusal’s values, exit 1', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod'], {
      promote: () => {
        throw new KindgiApiError({
          code: 'conflict',
          serverCode: 'promotion-values-not-ready',
          message: 'Values are not ready in the target.',
          reason: 'promotion-values-not-ready',
          fields: { values: [NOT_READY[0]] },
        });
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain('Not ready in prod:');
    expect(out.stdout).toContain('ACME_TOKEN (secret, for tool acme.lookup 1.1.0)');
    expect(out.stdout).not.toContain('Promoted');
  });

  test('the target had the build already: says so', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod'], {
      promote: () => ({ deployment: deployment('dep-prod-0'), created: false, moved: MOVES }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('prod has this build already, as deployment dep-prod-0');
  });

  test('--make-live: asks for it, then prints each agent version live or held by its gate, and each flow version pinned; one not live exits 3', async () => {
    const gate = (status: string) => ({
      status,
      changeId: '00000000-0000-4000-8000-000000000001',
    });
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod', '--make-live'], {
      promote: () => ({
        deployment: deployment('dep-prod-1'),
        created: true,
        moved: MOVES,
        live: [
          { id: 'acme.matcher', version: '1.0.2', pinned: true },
          { id: 'acme.router', version: '2.1.0', pinned: false, gate: gate('pending-approval') },
          { id: 'acme.drafter', version: '0.4.0', pinned: false, gate: gate('refused') },
        ],
        pinnedFlows: [{ id: 'acme.checkout', version: '2.0.0' }],
      }),
    });
    expect(out.exitCode).toBe(3);
    expect(named(calls, 'promote')[0]?.[2]).toMatchObject({
      toProjectId: 'p-prod',
      makeLive: true,
    });
    expect(out.stdout).toContain(
      [
        'Promoted: deployment dep-prod-1 in prod.',
        'Live in prod:',
        '  acme.matcher 1.0.2 — live',
        '  acme.router 2.1.0 — waiting for an approval',
        '  acme.drafter 0.4.0 — held by the gate',
        'Flows pinned in prod:',
        '  acme.checkout 2.0.0',
        '',
      ].join('\n'),
    );
  });

  test('without --make-live, nothing is asked for and no live or pinned lines are printed', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod']);
    expect(named(calls, 'promote')[0]?.[2]).not.toHaveProperty('makeLive');
    expect(out.stdout).not.toContain('Live in');
    expect(out.stdout).not.toContain('Flows pinned in');
  });

  test('--json: the deployment, the check and the promotion, as one object', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod', '--json']);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      deploymentId: 'dep-s1',
      check: READY_CHECK,
      promotion: { deployment: deployment('dep-prod-1'), created: true, moved: MOVES },
    });
  });

  test('several deployments serving: lists them and asks for --deployment, exit 2', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [
        {
          data: [deployment('dep-new'), deployment('dep-older')],
          hasMore: false,
          projectId: 'p-staging',
          packId: 'acme.shop',
        },
      ],
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('2 deployments of acme.shop serve in staging');
    expect(out.stderr).toContain('--deployment=<id>');
    expect(out.stderr).toContain('dep-new');
    expect(out.stderr).toContain('dep-older');
    expect(named(calls, 'promoteCheck')).toEqual([]);
  });

  test('none serving: says so, and why the newest was taken down, exit 1', async () => {
    const none = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [{ data: [], hasMore: false, projectId: 'p-staging', packId: 'acme.shop' }],
    });
    expect(none.out.exitCode).toBe(1);
    expect(none.out.stderr).toContain(
      'No deployment of acme.shop serves in staging. Deploy it there first',
    );
    expect(named(none.calls, 'promoteCheck')).toEqual([]);

    const suspended = (id: string) =>
      deployment(id, { endpoint: { status: 'cleared', since: 'x', retired: 'project-suspended' } });
    const down = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [
        {
          data: [suspended('dep-b'), suspended('dep-a')],
          hasMore: false,
          projectId: 'p-staging',
          packId: 'acme.shop',
        },
      ],
    });
    expect(down.out.exitCode).toBe(1);
    expect(down.out.stderr).toContain('The newest, dep-b, was taken down (project-suspended).');
    expect(named(down.calls, 'promoteCheck')).toEqual([]);
  });

  test('a cleared deployment from a server that says neither waiting nor retired still serves, as the promotion reads it', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [
        {
          data: [deployment('dep-s1', { endpoint: { status: 'cleared', since: 'x' } })],
          hasMore: false,
          projectId: 'p-staging',
          packId: 'acme.shop',
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(named(calls, 'promote')[0]?.[1]).toBe('dep-s1');
  });

  test("a runtime that ignores the list's filters is refused before anything moves", async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      pages: [{ data: [deployment('dep-a'), deployment('dep-b')], hasMore: false }],
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('needs a runtime on Kindgi 0.1.9 or later');
    expect(named(calls, 'promoteCheck')).toEqual([]);
  });

  test('--deployment names the build: no list; without it, a config naming no pack is refused', async () => {
    const config = { environments: CONFIG.environments };
    const given = await run(['promote', '--from=staging', '--to=prod', '--deployment=dep-x'], {
      config,
    });
    expect(given.out.exitCode).toBe(0);
    expect(named(given.calls, 'deployments.list')).toEqual([]);
    expect(named(given.calls, 'promote')[0]?.[1]).toBe('dep-x');

    const missing = await run(['promote', '--from=staging', '--to=prod'], { config });
    expect(missing.out.exitCode).not.toBe(0);
    expect(missing.out.stderr).toContain('pack.id');
    expect(named(missing.calls, 'deployments.list')).toEqual([]);
  });

  test('outside a pack: project slugs, any pack serving there, and each hint names the project and the env the runtime serves', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      noPack: true,
      pages: [{ data: [deployment('dep-s1')], hasMore: false, projectId: 'p-staging' }],
      check: { ...READY_CHECK, values: NOT_READY.slice(0, 2), envName: 'production' },
    });
    expect(out.exitCode).toBe(1);
    expect(named(calls, 'deployments.list')).toEqual([
      ['deployments.list', { projectId: 'p-staging' }],
    ]);
    expect(named(calls, 'promoteCheck')).toEqual([
      ['promoteCheck', 'dep-s1', { toProjectId: 'p-prod' }],
    ]);
    expect(out.stdout).toContain('Not ready in prod:');
    expect(out.stdout).toContain(
      'Set it with `kindgi secrets set ACME_TOKEN --env=production --scope=project:p-prod`.',
    );
    expect(out.stdout).toContain(
      'Set it with `kindgi env set SHOP_URL <value> --scope=project:p-prod --env=production`.',
    );
    expect(named(calls, 'promote')).toEqual([]);

    // A runtime that names no env: what to put there, not a name made up.
    const unnamed = await run(['promote', '--from=staging', '--to=prod', '--check'], {
      noPack: true,
      pages: [{ data: [deployment('dep-s1')], hasMore: false, projectId: 'p-staging' }],
      check: { ...READY_CHECK, values: NOT_READY.slice(0, 1) },
    });
    expect(unnamed.out.stdout).toContain(
      '`kindgi secrets set ACME_TOKEN --env=<the env the runtime serves> --scope=project:p-prod`',
    );
  });

  test('outside a pack, several serving: each with its pack', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod'], {
      noPack: true,
      pages: [
        {
          data: [
            deployment('dep-shop', { packId: 'acme.shop' }),
            deployment('dep-blog', { packId: 'acme.blog' }),
          ],
          hasMore: false,
          projectId: 'p-staging',
        },
      ],
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('2 deployments serve in staging, newest first.');
    expect(out.stderr).toMatch(/PACK +DEPLOYMENT/);
    expect(out.stderr).toMatch(/acme\.blog +dep-blog/);
  });

  test('outside a pack, a slug two projects share is refused before any deployment is read', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod'], {
      noPack: true,
      projects: [...PROJECTS, { id: 'p-prod-eu', name: 'Prod EU', slug: 'prod', orgId: 'o-eu' }],
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('"prod" is the slug of 2 projects');
    expect(named(calls, 'deployments.list')).toEqual([]);
  });

  test('in a pack: --from and --to on another runtime or tenant are refused, naming both; else it goes where a deploy into --from does', async () => {
    const on = (staging: object, prod: object) => ({
      ...CONFIG,
      environments: {
        staging: { project: 'staging', ...staging },
        prod: { project: 'prod', ...prod },
      },
    });
    const split = await run(['promote', '--from=staging', '--to=prod'], {
      config: on({ endpoint: 'https://a.acme.example' }, { endpoint: 'https://b.acme.example' }),
    });
    expect(split.out.exitCode).not.toBe(0);
    expect(split.out.stderr).toContain(
      'environments.staging.endpoint is https://a.acme.example, and environments.prod.endpoint is https://b.acme.example: an environment order lives in one tenant on one runtime',
    );
    expect(split.calls).toEqual([]);

    const tenants = await run(['promote', '--from=staging', '--to=prod'], {
      config: on({ tenantId: 't-acme' }, {}),
    });
    expect(tenants.out.exitCode).not.toBe(0);
    expect(tenants.out.stderr).toContain(
      'environments.staging.tenantId is t-acme, and environments.prod.tenantId is unset',
    );
    expect(tenants.calls).toEqual([]);

    const same = await run(['promote', '--from=staging', '--to=prod', '--check'], {
      config: on(
        { endpoint: 'https://a.acme.example', tenantId: 't-acme' },
        { endpoint: 'https://a.acme.example/', tenantId: 't-acme' },
      ),
    });
    expect(same.out.exitCode).toBe(0);
    const clients = named(same.calls, 'client');
    expect(clients.length).toBeGreaterThan(0);
    expect(clients.every((c) => c[1] === 'https://a.acme.example')).toBe(true);
  });

  test('an environment the config lacks, or a missing --to, is refused', async () => {
    const unknown = await run(['promote', '--from=staging', '--to=qa']);
    expect(unknown.out.exitCode).not.toBe(0);
    expect(unknown.out.stderr).toContain('environments.qa.project');
    expect(named(unknown.calls, 'promoteCheck')).toEqual([]);

    const half = await run(['promote', '--from=staging']);
    expect(half.out.exitCode).not.toBe(0);
    expect(half.out.stderr).toContain('--from=staging --to=prod');
  });
});

describe('kindgi promote --make-live: exit 3 when a carried version does not go live', () => {
  const PROMOTED = { deployment: deployment('dep-prod-1'), created: true, moved: MOVES };
  const gate = (status: string, changeId: string, approvalId?: string) => ({
    status,
    changeId,
    policy: null,
    ...(approvalId !== undefined && { approvalId }),
  });
  const LIVE = {
    id: 'acme.matcher',
    version: '1.0.2',
    pinned: true,
    gate: gate('pinned', 'pr-0'),
  };
  const WAITING = {
    id: 'acme.helper',
    version: '2.1.0',
    pinned: false,
    gate: gate('pending-approval', 'pr-1', 'ap-1'),
  };
  const HELD = {
    id: 'acme.writer',
    version: '3.0.0',
    pinned: false,
    gate: gate('refused', 'pr-2'),
  };
  const WAITING_TOO = {
    id: 'acme.critic',
    version: '1.4.0',
    pinned: false,
    gate: gate('pending-approval', 'pr-3', 'ap-3'),
  };
  const pinOf = (status: string, pin: typeof WAITING = WAITING) => ({
    id: pin.gate.changeId,
    agentId: pin.id,
    toVersion: pin.version,
    status,
    approvalId: pin.gate.approvalId,
  });
  /** `pinned.getChange` answers each read with the next of `statuses`, then the last. */
  const reads = (...statuses: string[]) => {
    let i = 0;
    return () => pinOf(statuses[Math.min(i++, statuses.length - 1)] as string);
  };
  /** `pinned.getChange` for WAITING and WAITING_TOO, each with its own `reads`. */
  const readsOfBoth = (helper: readonly string[], critic: readonly string[]) => {
    const next = { 'pr-1': 0, 'pr-3': 0 } as Record<string, number>;
    return (_agentId: string, changeId: string) => {
      const [pin, statuses] = changeId === 'pr-1' ? [WAITING, helper] : [WAITING_TOO, critic];
      const i = next[changeId] ?? 0;
      next[changeId] = i + 1;
      return pinOf(statuses[Math.min(i, statuses.length - 1)] as string, pin);
    };
  };

  test('every carried version live: exit 0, and makeLive is asked for', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod', '--make-live'], {
      promote: () => ({ ...PROMOTED, live: [LIVE] }),
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(named(calls, 'promote')).toEqual([
      ['promote', 'dep-s1', { toProjectId: 'p-prod', makeLive: true }],
    ]);
    expect(out.stdout).toContain('Live in prod:\n  acme.matcher 1.0.2 — live\n');
  });

  test('one waits for an approval, one is held: each said, exit 3, and nothing waits without --wait', async () => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod', '--make-live'], {
      promote: () => ({ ...PROMOTED, live: [LIVE, WAITING, HELD] }),
    });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain(
      'Live in prod:\n  acme.matcher 1.0.2 — live\n  acme.helper 2.1.0 — waiting for an approval\n  acme.writer 3.0.0 — held by the gate\n',
    );
    expect(named(calls, 'pinned.getChange')).toEqual([]);
  });

  test('--wait: reads the waiting version until it is approved, exit 0, and the answer shows it live', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait=1m', '--json'],
      {
        promote: () => ({ ...PROMOTED, live: [LIVE, WAITING] }),
        pinnedGet: reads('pending-approval', 'pending-approval', 'pinned'),
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(named(calls, 'pinned.getChange')).toEqual([
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.helper', 'pr-1'],
    ]);
    expect(named(calls, 'pause')).toEqual([
      ['pause', 5000],
      ['pause', 5000],
    ]);
    expect(out.stderr).toContain(
      'Waiting up to 1m for approval ap-1 of acme.helper 2.1.0: `kindgi approvals complete ap-1 --decision=approve` approves it.',
    );
    expect(JSON.parse(out.stdout).promotion.live).toEqual([
      LIVE,
      { ...WAITING, pinned: true, gate: { ...WAITING.gate, status: 'pinned' } },
    ]);
  });

  test('--wait: a rejected approval ends the wait, exit 3, said in the text', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod', '--make-live', '--wait'], {
      promote: () => ({ ...PROMOTED, live: [WAITING] }),
      pinnedGet: reads('pending-approval', 'rejected'),
    });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain('  acme.helper 2.1.0 — its approval was rejected\n');
    expect(out.stderr).toContain(
      "Approval ap-1 was rejected: acme.helper 2.1.0 doesn't get pinned.",
    );
    expect(out.stderr).toContain('Waiting up to 1h for approval ap-1');
  });

  test('--wait: a superseded pin ends the wait, exit 3, and both lines say it was approved', async () => {
    const { out } = await run(['promote', '--from=staging', '--to=prod', '--make-live', '--wait'], {
      promote: () => ({ ...PROMOTED, live: [WAITING] }),
      pinnedGet: reads('pending-approval', 'superseded'),
    });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain('  acme.helper 2.1.0 — approved, but superseded\n');
    expect(out.stderr).toContain('acme.helper 2.1.0 was approved, but superseded:');
  });

  test('--wait: the wait runs out, exit 3, and the approval stays open', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait=12s'],
      {
        promote: () => ({ ...PROMOTED, live: [WAITING] }),
        pinnedGet: reads('pending-approval'),
      },
    );
    expect(out.exitCode).toBe(3);
    // 5 s, 5 s, then the 2 s left.
    expect(named(calls, 'pause')).toEqual([
      ['pause', 5000],
      ['pause', 5000],
      ['pause', 2000],
    ]);
    expect(out.stderr).toContain(
      "Still waiting after 12s. Approval ap-1 stays open: once it's approved, acme.helper 2.1.0 is pinned.",
    );
    expect(out.stdout).toContain('  acme.helper 2.1.0 — waiting for an approval\n');
  });

  test('--wait: two waiting versions, each read until it is approved, within one deadline: exit 0', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait=1m', '--json'],
      {
        promote: () => ({ ...PROMOTED, live: [WAITING, WAITING_TOO] }),
        pinnedGet: readsOfBoth(
          ['pending-approval', 'pinned'],
          ['pending-approval', 'pending-approval', 'pinned'],
        ),
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(named(calls, 'pinned.getChange')).toEqual([
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.critic', 'pr-3'],
      ['pinned.getChange', 'acme.critic', 'pr-3'],
      ['pinned.getChange', 'acme.critic', 'pr-3'],
    ]);
    expect(out.stderr).toContain('Waiting up to 1m for approval ap-1 of acme.helper 2.1.0');
    expect(out.stderr).toContain('Waiting up to 1m for approval ap-3 of acme.critic 1.4.0');
    expect(JSON.parse(out.stdout).promotion.live).toEqual([
      { ...WAITING, pinned: true, gate: { ...WAITING.gate, status: 'pinned' } },
      { ...WAITING_TOO, pinned: true, gate: { ...WAITING_TOO.gate, status: 'pinned' } },
    ]);
  });

  test('--wait: the first version takes part of the deadline, so the second waits only what is left: exit 3', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait=12s'],
      {
        promote: () => ({ ...PROMOTED, live: [WAITING, WAITING_TOO] }),
        pinnedGet: readsOfBoth(['pending-approval', 'pinned'], ['pending-approval']),
      },
    );
    expect(out.exitCode).toBe(3);
    // 5 s for the first; then 5 s and the 2 s left of the 12 s for the second.
    expect(named(calls, 'pause')).toEqual([
      ['pause', 5000],
      ['pause', 5000],
      ['pause', 2000],
    ]);
    expect(out.stderr).toContain(
      "Still waiting after 12s. Approval ap-3 stays open: once it's approved, acme.critic 1.4.0 is pinned.",
    );
    expect(out.stdout).toContain(
      '  acme.helper 2.1.0 — live\n  acme.critic 1.4.0 — waiting for an approval\n',
    );
  });

  test('--wait: Ctrl-C stops the wait, not the pin: exit 130, and the approval stays open', async () => {
    const controller = new AbortController();
    const { out } = await run(['promote', '--from=staging', '--to=prod', '--make-live', '--wait'], {
      promote: () => ({ ...PROMOTED, live: [WAITING] }),
      pinnedGet: () => {
        controller.abort();
        return pinOf('pending-approval');
      },
      stopSignal: controller.signal,
    });
    expect(out.exitCode).toBe(130);
    expect(out.stderr).toContain(
      "Stopped waiting. Approval ap-1 stays open: once it's approved, acme.helper 2.1.0 is pinned.",
    );
    expect(out.stdout).toContain('  acme.helper 2.1.0 — waiting for an approval\n');
  });

  test('--wait: 3 failed reads in a row end the wait, exit 1; the versions are printed as last read, and the approval stays open', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait'],
      {
        promote: () => ({ ...PROMOTED, live: [LIVE, WAITING, WAITING_TOO] }),
        pinnedGet: () => {
          throw new KindgiApiError(
            fromWire({ code: 'unavailable', message: 'Down for a moment' }, 503),
          );
        },
      },
    );
    expect(out.exitCode).toBe(1);
    // The first read needs no pause; each read again does. The second version is never read.
    expect(named(calls, 'pinned.getChange')).toEqual([
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.helper', 'pr-1'],
      ['pinned.getChange', 'acme.helper', 'pr-1'],
    ]);
    expect(named(calls, 'pause')).toEqual([
      ['pause', 5000],
      ['pause', 5000],
    ]);
    expect(out.stderr).toContain("Couldn't read the pin of acme.helper 2.1.0 3 times in a row (");
    expect(out.stderr).toContain(
      "). Approval ap-1 stays open: once it's approved, acme.helper 2.1.0 is pinned.",
    );
    expect(out.stdout).toContain(
      'Live in prod:\n  acme.matcher 1.0.2 — live\n  acme.helper 2.1.0 — waiting for an approval\n  acme.critic 1.4.0 — waiting for an approval\n',
    );
  });

  test('--wait: a version held by the gate cannot go live, so nothing waits: exit 3', async () => {
    const { out, calls } = await run(
      ['promote', '--from=staging', '--to=prod', '--make-live', '--wait'],
      { promote: () => ({ ...PROMOTED, live: [WAITING, HELD] }) },
    );
    expect(out.exitCode).toBe(3);
    expect(named(calls, 'pinned.getChange')).toEqual([]);
    expect(out.stderr).toContain(
      'Not waiting: acme.writer 3.0.0 is held by the gate, so not every version goes live.',
    );
  });

  test.each([
    [['--wait']],
    [['--make-live', '--wait', '--check']],
    [['--make-live', '--wait=soon']],
    [['--make-live', '--wait=0m']],
  ])('%j is refused before anything is read: exit 2', async (flags) => {
    const { out, calls } = await run(['promote', '--from=staging', '--to=prod', ...flags]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--wait');
    expect(calls.filter((c) => c[0] !== 'client')).toEqual([]);
  });
});
