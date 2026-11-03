// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deployments get` and `list`, through the client. `get` says a
 * deployment's pack service as it is now: when it runs on the values it was
 * last given (`endpoint.packEnvProblem`), why, since when, and what to do,
 * with the env and project the lines name taken from the pack-env answer
 * and the deployment, never fixed. A deployment with nothing held, or from
 * a server before the field, gets no such line and no pack-env read.
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

type Answer = (arg: unknown) => Promise<unknown>;

const unexpected: Answer = async () => {
  throw new Error('not expected');
};

async function run(
  argv: readonly string[],
  answers: {
    readonly get?: Answer;
    readonly list?: Answer;
    readonly packEnv?: Answer;
    readonly projects?: Answer;
  },
) {
  const asked = {
    get: [] as unknown[],
    list: [] as unknown[],
    packEnv: [] as unknown[],
    projects: [] as unknown[],
  };
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        deployments: {
          get: async (id: unknown) => {
            asked.get.push(id);
            return (answers.get ?? unexpected)(id);
          },
          list: async (filter: unknown) => {
            asked.list.push(filter);
            return (answers.list ?? unexpected)(filter);
          },
          packEnv: async (id: unknown) => {
            asked.packEnv.push(id);
            return (answers.packEnv ?? unexpected)(id);
          },
        },
        projects: {
          list: async (query: unknown) => {
            asked.projects.push(query);
            return (answers.projects ?? unexpected)(query);
          },
        },
      }) as never,
  });
  return { out, asked };
}

const DEPLOYMENT = {
  deploymentId: 'dep-acme-1',
  tenantId: 't-acme',
  imageRef: 'registry.example.com/acme/pack@sha256:abc123',
  imageDigest: 'abc123',
  artifactVersion: '1.4.0',
  indexHash: 'idx-1',
  signerKeyId: 'key-acme',
  signerPublicKey: 'pk',
  signature: 'sig',
  publishedAt: '2026-10-18T09:00:00.000Z',
  activatedAt: '2026-10-18T09:12:00.000Z',
  projectId: 'prj-acme',
  packEnv: { required: ['API_BASE'], optional: ['REGION'] },
  primitives: { tools: 3, guardrails: 1, agents: 2, flows: 1 },
  endpoint: { status: 'ready', since: '2026-10-18T09:13:05.000Z' },
};

/** A pack service held on its last values, by `code`, recorded at 10:02. */
function held(code: string, over: Record<string, unknown> = {}) {
  return {
    ...DEPLOYMENT,
    ...over,
    endpoint: {
      status: 'ready',
      since: '2026-10-18T09:13:05.000Z',
      packEnvProblem: { code, since: '2026-10-18T10:02:00.000Z' },
    },
  };
}

const HEAD = [
  'Deployment dep-acme-1 (artifact 1.4.0), activated 2026-10-18T09:12:00.000Z',
  '  Project: prj-acme',
  '  Image: registry.example.com/acme/pack@sha256:abc123',
  '  Ships: 3 tools, 1 guardrail, 2 agents, 1 flow',
];
const HELD_SERVICE =
  '  Pack service: ready since 2026-10-18T09:13:05.000Z, on the values it was last given';

const MISSING = {
  name: 'API_BASE',
  required: true,
  kind: null,
  scope: null,
  missing: true,
  problem: 'missing',
};
const SECRET_ONLY = {
  name: 'ACME_TOKEN',
  required: true,
  kind: 'secret',
  scope: { kind: 'project', id: 'prj-acme' },
  missing: false,
  problem: 'secret-not-yet',
};
/** Set only as a secret where the server gives a pack service its secrets: nothing in the way. */
const SECRET_GIVEN = {
  name: 'ACME_TOKEN',
  required: true,
  kind: 'secret',
  scope: { kind: 'project', id: 'prj-acme' },
  missing: false,
};
const BOTH_WAYS = {
  name: 'SHOP_URL',
  required: false,
  kind: 'env',
  scope: { kind: 'tenant' },
  missing: false,
  problem: 'ambiguous',
  secretScope: { kind: 'project', id: 'prj-acme' },
};
const SET = {
  name: 'REGION',
  required: false,
  kind: 'env',
  scope: { kind: 'project', id: 'prj-acme' },
  missing: false,
};

const packEnvAt =
  (envName: string, ...data: readonly unknown[]): Answer =>
  async () => ({ envName, data });

const lines = (...l: readonly string[]) => `${l.join('\n')}\n`;

describe('kindgi deployments get', () => {
  test('a ready pack service with nothing held: the deployment, ready since when, and no pack-env read', async () => {
    const { out, asked } = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => DEPLOYMENT,
    });
    expect(out.exitCode).toBe(0);
    expect(asked.get).toEqual(['dep-acme-1']);
    expect(asked.packEnv).toEqual([]);
    expect(out.stdout).toBe(lines(...HEAD, '  Pack service: ready since 2026-10-18T09:13:05.000Z'));
    expect(out.stderr).toBe('');
  });

  test('what keeps the build: one a line, after its pack service; nothing, said so', async () => {
    const keptFor = [
      { kind: 'agent', id: 'acme.reply-drafter', version: '3', registered: true, held: true },
      { kind: 'flow', id: 'acme.triage', version: '2', held: true },
      { kind: 'guardrail', id: 'acme.no-pii', registered: true },
      { kind: 'tool', id: 'acme.lookup' },
      { kind: 'tool', id: 'acme.search', version: '1.2.0', registered: true },
      { kind: 'workflow', id: 'acme.later' },
    ];
    const ready = '  Pack service: ready since 2026-10-18T09:13:05.000Z';
    const kept = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => ({ ...DEPLOYMENT, endpoint: { ...DEPLOYMENT.endpoint, keptFor } }),
    });
    expect(kept.out.exitCode).toBe(0);
    expect(kept.out.stdout).toBe(
      lines(
        ...HEAD,
        ready,
        '  Kept for:',
        '    agent acme.reply-drafter 3: registered, held by a pin or a run',
        '    flow acme.triage 2: held by a pin or a run',
        '    guardrail acme.no-pii: registered',
        '    tool acme.lookup: deployed without a version, until a newer build ships it',
        '    tool acme.search 1.2.0: registered',
        '    workflow acme.later',
      ),
    );
    const none = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => ({ ...DEPLOYMENT, endpoint: { ...DEPLOYMENT.endpoint, keptFor: [] } }),
    });
    expect(none.out.stdout).toBe(lines(...HEAD, ready, '  Kept for: nothing'));
  });

  test('an older server: no packEnvProblem, or no pack service at all: no held line, and no pack-env read', async () => {
    // A server from before the field, routing per deployment: the endpoint as it was.
    const before = {
      ...DEPLOYMENT,
      endpoint: { status: 'ready', since: '2026-10-18T09:13:05.000Z' },
    };
    // One that runs no pack service per deployment, from before projects and pack env.
    const { projectId: _p, packEnv: _e, endpoint: _s, ...plain } = DEPLOYMENT;
    for (const [record, service] of [
      [before, ['  Pack service: ready since 2026-10-18T09:13:05.000Z']],
      [plain, []],
    ] as const) {
      const { out, asked } = await run(['deployments', 'get', 'dep-acme-1'], {
        get: async () => record,
      });
      expect(out.exitCode).toBe(0);
      expect(asked.packEnv).toEqual([]);
      expect(out.stdout).not.toContain('!');
      expect(out.stdout).not.toContain('last given');
      if (record === plain) {
        expect(out.stdout).toBe(
          lines(HEAD[0] as string, '  Project: none named', ...HEAD.slice(2), ...service),
        );
      } else {
        expect(out.stdout).toBe(lines(...HEAD, ...service));
      }
    }
  });

  test("held on a name that isn't set, served at prod: why and since when, then the line that sets it, at the deployment's project", async () => {
    const { out, asked } = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-missing'),
      packEnv: packEnvAt('prod', MISSING, SET),
    });
    expect(out.exitCode).toBe(0);
    expect(asked.packEnv).toEqual(['dep-acme-1']);
    expect(out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        "    ! Since 2026-10-18T10:02:00.000Z: a name the pack needs in its env isn't set (pack-env-missing).",
        "      API_BASE isn't set for prod. Set it with `kindgi env set NAME <value> --scope=project:prj-acme --env=prod`.",
      ),
    );
  });

  test('pack-env-update-failed: given the newest values and not started with them, tried again for an hour; setting a name again, at the env the answer names', async () => {
    for (const envName of ['prod', 'staging']) {
      const { out } = await run(['deployments', 'get', 'dep-acme-1'], {
        get: async () => held('pack-env-update-failed'),
        packEnv: packEnvAt(envName, SET),
      });
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe(
        lines(
          ...HEAD,
          HELD_SERVICE,
          "    ! Since 2026-10-18T10:02:00.000Z: its newest values were given to it, but it didn't start with them. It's tried again for an hour from then (pack-env-update-failed).",
          `      Setting one of its names again tries again: \`kindgi env set NAME <value> --scope=project:prj-acme --env=${envName}\`.`,
        ),
      );
    }
  });

  test('set only as a secret, or both ways: their words, then what each name needs', async () => {
    const secretOnly = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-secret-not-yet'),
      packEnv: packEnvAt('prod', SECRET_ONLY),
    });
    expect(secretOnly.out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        '    ! Since 2026-10-18T10:02:00.000Z: a name the pack reads from its env is set only as a secret (pack-env-secret-not-yet).',
        "      ACME_TOKEN is set only as a secret, which this server keeps out of a pack service's environment: a tool reads it per call (`ctx.secrets`).",
      ),
    );
    const bothWays = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-ambiguous'),
      packEnv: packEnvAt('prod', BOTH_WAYS),
    });
    expect(bothWays.out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        '    ! Since 2026-10-18T10:02:00.000Z: a name the pack reads from its env is set more than one way: as a plain value, a secret or a cloud secret (pack-env-ambiguous).',
        "      SHOP_URL is set both as a secret (project prj-acme) and as a plain value (tenant): remove one, so it's clear which the pack service gets.",
      ),
    );
  });

  test("newly set only as a secret, or a secret the platform can't read: their words, and no line to run", async () => {
    const redeploy = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-secret-redeploy'),
      packEnv: packEnvAt('prod', SECRET_GIVEN),
    });
    expect(redeploy.out.exitCode).toBe(0);
    expect(redeploy.out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        "    ! Since 2026-10-18T10:02:00.000Z: a name the pack reads from its env is newly set only as a secret, which this pack service can't be given. Build the pack again and deploy that build: the new deployment's pack service can be given it (pack-env-secret-redeploy).",
      ),
    );
    const unreadable = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-secret-unreadable'),
      packEnv: packEnvAt('prod', SECRET_GIVEN),
    });
    expect(unreadable.out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        "    ! Since 2026-10-18T10:02:00.000Z: a secret the pack reads from its env can't be read just now: the platform's team is told, and it's tried again (pack-env-secret-unreadable).",
      ),
    );
  });

  test("no project named: 'none named', and the lines a tenant-wide deploy prints", async () => {
    const { projectId: _p, ...noProject } = held('pack-env-missing');
    const missing = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => noProject,
      packEnv: packEnvAt('prod', MISSING),
    });
    expect(missing.out.stdout).toBe(
      lines(
        HEAD[0] as string,
        '  Project: none named',
        ...HEAD.slice(2),
        HELD_SERVICE,
        "    ! Since 2026-10-18T10:02:00.000Z: a name the pack needs in its env isn't set (pack-env-missing).",
        "      API_BASE isn't set for prod. Set it with `kindgi env set NAME <value> --scope=tenant --env=prod`.",
      ),
    );
    const { projectId: _q, ...failedNoProject } = held('pack-env-update-failed');
    const failed = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => failedNoProject,
      packEnv: packEnvAt('prod'),
    });
    expect(failed.out.stdout).toContain(
      '      Setting one of its names again tries again: `kindgi env set NAME <value> --scope=tenant --env=prod`.\n',
    );
  });

  test("where its names are set can't be read: why and since when, then why it couldn't be read, without a line to run", async () => {
    const { out, asked } = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-update-failed'),
      packEnv: async () => {
        throw new KindgiApiError(
          fromWire({ code: 'forbidden', message: 'Not allowed', details: {} }, 403),
        );
      },
    });
    expect(out.exitCode).toBe(0);
    expect(asked.packEnv).toEqual(['dep-acme-1']);
    expect(out.stdout).toBe(
      lines(
        ...HEAD,
        HELD_SERVICE,
        "    ! Since 2026-10-18T10:02:00.000Z: its newest values were given to it, but it didn't start with them. It's tried again for an hour from then (pack-env-update-failed).",
        "      Couldn't read where each value is set: Not allowed (forbidden)",
      ),
    );
  });

  test("a server that doesn't give pack services their env, or is older: nothing more is said", async () => {
    for (const [body, status] of [
      [{ code: 'pack-env-not-served', message: 'Not served', details: {} }, 501],
      [{ code: 'route-not-found', message: 'No such route', details: {} }, 404],
    ] as const) {
      const { out, asked } = await run(['deployments', 'get', 'dep-acme-1'], {
        get: async () => held('pack-env-update-failed'),
        packEnv: async () => {
          throw new KindgiApiError(fromWire(body, status));
        },
      });
      expect(out.exitCode).toBe(0);
      expect(asked.packEnv).toEqual(['dep-acme-1']);
      expect(out.stdout).toBe(
        lines(
          ...HEAD,
          HELD_SERVICE,
          "    ! Since 2026-10-18T10:02:00.000Z: its newest values were given to it, but it didn't start with them. It's tried again for an hour from then (pack-env-update-failed).",
        ),
      );
    }
  });

  test('a code a later runtime names: said by its code', async () => {
    const { out } = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-quota'),
      packEnv: packEnvAt('prod', SET),
    });
    expect(out.stdout).toBe(
      lines(...HEAD, HELD_SERVICE, '    ! Since 2026-10-18T10:02:00.000Z: pack-env-quota.'),
    );
    // A code a pending one has words for, but not one a held one does: by its code too.
    const notHeld = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('service-start-failed'),
      packEnv: packEnvAt('prod', SET),
    });
    expect(notHeld.out.stdout).toBe(
      lines(...HEAD, HELD_SERVICE, '    ! Since 2026-10-18T10:02:00.000Z: service-start-failed.'),
    );
  });

  test('--json and --raw: the deployment as the API answers it, packEnvProblem in it; no pack-env read', async () => {
    const record = held('pack-env-update-failed');
    const json = await run(['deployments', 'get', 'dep-acme-1', '--json'], {
      get: async () => record,
    });
    expect(json.out.exitCode).toBe(0);
    expect(JSON.parse(json.out.stdout)).toEqual(record);
    expect(json.asked.packEnv).toEqual([]);
    const raw = await run(['deployments', 'get', 'dep-acme-1', '--raw'], {
      get: async () => record,
    });
    expect(raw.out.stdout).toBe(`${JSON.stringify(record)}\n`);
  });

  test('--table: the same lines', async () => {
    const plain = await run(['deployments', 'get', 'dep-acme-1'], {
      get: async () => held('pack-env-missing'),
      packEnv: packEnvAt('prod', MISSING),
    });
    const table = await run(['deployments', 'get', 'dep-acme-1', '--table'], {
      get: async () => held('pack-env-missing'),
      packEnv: packEnvAt('prod', MISSING),
    });
    expect(table.out.stdout).toBe(plain.out.stdout);
  });

  test("pending on a pack-env code, or cleared and waiting on one: the lines deploy prints while it waits, at the env the server reads and the deployment's project", async () => {
    const at = (endpoint: Record<string, unknown>) => async () => ({ ...DEPLOYMENT, endpoint });
    const since = '2026-10-18T09:13:05.000Z';
    const problem = { code: 'pack-env-missing', since };
    const fix =
      "      API_BASE isn't set for staging. Set it with `kindgi env set NAME <value> --scope=project:prj-acme --env=staging`.";

    const pending = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'pending', since, problem }),
      packEnv: packEnvAt('staging', MISSING),
    });
    expect(pending.out.exitCode).toBe(0);
    expect(pending.asked.packEnv).toEqual(['dep-acme-1']);
    expect(pending.out.stdout).toBe(
      lines(
        ...HEAD,
        `  Pack service: pending since ${since}: a name the pack needs in its env isn't set (pack-env-missing)`,
        fix,
      ),
    );

    const waiting = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'cleared', since, waiting: true, problem }),
      packEnv: packEnvAt('staging', MISSING),
    });
    expect(waiting.asked.packEnv).toEqual(['dep-acme-1']);
    expect(waiting.out.stdout).toBe(
      lines(
        ...HEAD,
        `  Pack service: cleared since ${since}, waiting for one again: a name the pack needs in its env isn't set (pack-env-missing)`,
        fix,
      ),
    );
  });

  test("pending, cleared and waiting, or cleared for good: why, in deploy's words", async () => {
    const at = (endpoint: Record<string, unknown>) => async () => ({ ...DEPLOYMENT, endpoint });
    const since = '2026-10-18T09:13:05.000Z';
    const problem = (code: string) => ({ code, since });

    const pending = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'pending', since, problem: problem('capacity-unavailable') }),
    });
    expect(pending.out.stdout).toBe(
      lines(
        ...HEAD,
        `  Pack service: pending since ${since}: there is no room for another pack service just now (capacity-unavailable)`,
      ),
    );
    expect(pending.asked.packEnv).toEqual([]);

    const waiting = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'cleared', since, waiting: true }),
    });
    expect(waiting.out.stdout).toBe(
      lines(...HEAD, `  Pack service: cleared since ${since}, waiting for one again`),
    );

    const superseded = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'cleared', since, retired: 'superseded' }),
    });
    expect(superseded.out.stdout).toBe(
      lines(
        ...HEAD,
        `  Pack service: cleared since ${since}: no new call needs it, or a later deploy into its project ships every tool version and check it does (superseded)`,
      ),
    );

    const cleared = await run(['deployments', 'get', 'dep-acme-1'], {
      get: at({ status: 'cleared', since }),
    });
    expect(cleared.out.stdout).toBe(lines(...HEAD, `  Pack service: cleared since ${since}`));
  });

  test('no deployment by that id: the error on stderr, exit 1, nothing on stdout', async () => {
    const { out } = await run(['deployments', 'get', 'dep-gone'], {
      get: async () => {
        throw new KindgiApiError(
          fromWire(
            { code: 'deployment-not-found', message: 'No deployment "dep-gone"', details: {} },
            404,
          ),
        );
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('No deployment "dep-gone"');
  });
});

describe('kindgi deployments list', () => {
  const PAGE = {
    data: [
      held('pack-env-update-failed', { deploymentId: 'dep-acme-3' }),
      {
        ...DEPLOYMENT,
        deploymentId: 'dep-acme-2',
        endpoint: {
          status: 'pending',
          since: '2026-10-18T09:13:05.000Z',
          problem: { code: 'capacity-unavailable', since: '2026-10-18T09:13:05.000Z' },
        },
      },
      DEPLOYMENT,
      {
        ...DEPLOYMENT,
        deploymentId: 'dep-acme-0',
        endpoint: { status: 'cleared', since: '2026-10-18T09:13:05.000Z', retired: 'superseded' },
      },
      {
        ...DEPLOYMENT,
        deploymentId: 'dep-acme-w',
        endpoint: { status: 'cleared', since: '2026-10-18T09:13:05.000Z', waiting: true },
      },
      (({ projectId: _p, endpoint: _e, ...rest }) => ({ ...rest, deploymentId: 'dep-acme-p' }))(
        DEPLOYMENT,
      ),
    ],
    hasMore: true,
    nextCursor: 'c2',
  };

  test('a page as JSON, with the filters as the API names them', async () => {
    const { out, asked } = await run(
      [
        'deployments',
        'list',
        '--image-ref-prefix=registry.example.com/acme/',
        '--signer-key-id=key-acme',
        '--limit=5',
        '--cursor=c1',
      ],
      { list: async () => PAGE },
    );
    expect(out.exitCode).toBe(0);
    expect(asked.list).toEqual([
      {
        limit: 5,
        cursor: 'c1',
        imageRefPrefix: 'registry.example.com/acme/',
        signerKeyId: 'key-acme',
      },
    ]);
    expect(JSON.parse(out.stdout)).toEqual(PAGE);
    const bare = await run(['deployments', 'list'], { list: async () => PAGE });
    expect(bare.asked.list).toEqual([{}]);
  });

  test("--table: each one's pack service, a held one with its code; the next page's cursor on stderr", async () => {
    const { out } = await run(['deployments', 'list', '--table'], { list: async () => PAGE });
    expect(out.exitCode).toBe(0);
    const rows = out.stdout.split('\n');
    expect(rows[0]).toMatch(/^DEPLOYMENT +VERSION +PROJECT +ACTIVATED +PACK SERVICE$/);
    const row = (id: string) => (rows.find((r) => r.startsWith(`${id} `)) ?? '').trimEnd();
    expect(row('dep-acme-3')).toMatch(
      /^dep-acme-3 +1\.4\.0 +prj-acme +2026-10-18T09:12:00\.000Z +ready, held: pack-env-update-failed$/,
    );
    expect(row('dep-acme-2')).toMatch(/ pending: capacity-unavailable$/);
    expect(row('dep-acme-1')).toMatch(/ 2026-10-18T09:12:00\.000Z +ready$/);
    expect(row('dep-acme-0')).toMatch(/ cleared: superseded$/);
    expect(row('dep-acme-w')).toMatch(/ cleared, waiting$/);
    expect(row('dep-acme-p')).toMatch(/^dep-acme-p +1\.4\.0 +2026-10-18T09:12:00\.000Z$/);
    expect(out.stderr).toBe('Next page: --cursor=c2\n');
  });

  describe('--project and --pack', () => {
    const DEFAULT_ID = '0b9a6f1e-5c2d-4e8a-9f3b-1a2b3c4d5e6f';
    const STAGING_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const PACK_ID = 'com.acme.shop';
    const PROJECTS = {
      data: [
        { id: DEFAULT_ID, slug: 'default', name: 'Default', orgId: 'org-acme' },
        { id: STAGING_ID, slug: 'staging', name: 'Staging', orgId: 'org-acme' },
        { id: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a', slug: 'shop', orgId: 'org-acme' },
        { id: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b', slug: 'shop', orgId: 'org-acme-eu' },
      ],
      hasMore: false,
    };

    /** A runtime with the filters: the page says which it applied, an empty one too. */
    const filtered =
      (data: readonly unknown[] = []): Answer =>
      async (filter) => {
        const { projectId, packId } = filter as { projectId?: string; packId?: string };
        return {
          data,
          hasMore: false,
          ...(projectId !== undefined && { projectId }),
          ...(packId !== undefined && { packId }),
        };
      };
    /** A runtime before them: every deployment, and nothing on the page about a filter. */
    const unfiltered: Answer = async () => ({ data: [DEPLOYMENT], hasMore: false });

    test('a project id is the projectId filter as it is, beside the others; the projects are not read', async () => {
      const { out, asked } = await run(
        ['deployments', 'list', `--project=${STAGING_ID}`, '--signer-key-id=key-acme', '--limit=5'],
        { list: filtered() },
      );
      expect(out.exitCode).toBe(0);
      expect(asked.list).toEqual([{ limit: 5, signerKeyId: 'key-acme', projectId: STAGING_ID }]);
      expect(asked.projects).toEqual([]);
      expect(JSON.parse(out.stdout)).toEqual({ data: [], hasMore: false, projectId: STAGING_ID });
    });

    test("a slug: the id of the project that has it; the rows as the API answers them, another project's too", async () => {
      // The runtime filters: a row it answers is printed, whichever project it names.
      const data = [{ ...DEPLOYMENT, projectId: DEFAULT_ID }];
      const { out, asked } = await run(['deployments', 'list', '--project=staging'], {
        list: filtered(data),
        projects: async () => PROJECTS,
      });
      expect(out.exitCode).toBe(0);
      expect(asked.list).toEqual([{ projectId: STAGING_ID }]);
      expect(JSON.parse(out.stdout)).toEqual({ data, hasMore: false, projectId: STAGING_ID });
    });

    test("the default project's id: its deployments and those that name no project, as the API answers them", async () => {
      const data = [
        { ...DEPLOYMENT, deploymentId: 'dep-acme-d', projectId: DEFAULT_ID },
        (({ projectId: _p, ...rest }) => ({ ...rest, deploymentId: 'dep-acme-n' }))(DEPLOYMENT),
      ];
      const json = await run(['deployments', 'list', `--project=${DEFAULT_ID}`], {
        list: filtered(data),
      });
      expect(json.asked.list).toEqual([{ projectId: DEFAULT_ID }]);
      expect(JSON.parse(json.out.stdout)).toEqual({ data, hasMore: false, projectId: DEFAULT_ID });

      const { out } = await run(['deployments', 'list', '--project=default', '--table'], {
        list: filtered(data),
        projects: async () => PROJECTS,
      });
      expect(out.exitCode).toBe(0);
      const rows = out.stdout.split('\n');
      const row = (id: string) => (rows.find((r) => r.startsWith(`${id} `)) ?? '').trimEnd();
      expect(row('dep-acme-d')).toMatch(
        new RegExp(`^dep-acme-d +1\\.4\\.0 +${DEFAULT_ID} +2026-10-18T09:12:00\\.000Z +ready$`),
      );
      expect(row('dep-acme-n')).toMatch(/^dep-acme-n +1\.4\.0 +2026-10-18T09:12:00\.000Z +ready$/);
    });

    test("a pack id is the packId filter as it is; the page's own pack id with it", async () => {
      const { out, asked } = await run(['deployments', 'list', `--pack=${PACK_ID}`], {
        list: filtered([DEPLOYMENT]),
      });
      expect(out.exitCode).toBe(0);
      expect(asked.list).toEqual([{ packId: PACK_ID }]);
      expect(asked.projects).toEqual([]);
      expect(JSON.parse(out.stdout)).toEqual({
        data: [DEPLOYMENT],
        hasMore: false,
        packId: PACK_ID,
      });
    });

    test('both: the two filters in one list', async () => {
      const { out, asked } = await run(
        ['deployments', 'list', '--project=staging', `--pack=${PACK_ID}`],
        { list: filtered(), projects: async () => PROJECTS },
      );
      expect(out.exitCode).toBe(0);
      expect(asked.list).toEqual([{ projectId: STAGING_ID, packId: PACK_ID }]);
    });

    test('a slug no project has, or one two orgs share: a usage error, exit 2, and no list', async () => {
      const none = await run(['deployments', 'list', '--project=prod'], {
        projects: async () => PROJECTS,
      });
      expect(none.out.exitCode).toBe(2);
      expect(none.out.stderr).toContain('No project of this workspace has the slug "prod"');
      expect(none.asked.list).toEqual([]);

      const two = await run(['deployments', 'list', '--project=shop'], {
        projects: async () => PROJECTS,
      });
      expect(two.out.exitCode).toBe(2);
      expect(two.out.stderr).toContain('"shop" is the slug of 2 projects, in different orgs');
      expect(two.asked.list).toEqual([]);
    });

    test('a runtime that lists them all, its page naming no filter: the release it needs, exit 1, nothing printed', async () => {
      for (const [flag, argv] of [
        ['project', [`--project=${STAGING_ID}`]],
        ['pack', [`--pack=${PACK_ID}`]],
        ['pack', [`--project=${STAGING_ID}`, `--pack=${PACK_ID}`, '--table']],
      ] as const) {
        const answer: Answer =
          argv.length === 1
            ? unfiltered
            : async () => ({ data: [DEPLOYMENT], hasMore: false, projectId: STAGING_ID });
        const { out } = await run(['deployments', 'list', ...argv], { list: answer });
        expect(out.exitCode).toBe(1);
        expect(out.stdout).toBe('');
        expect(out.stderr).toBe(`Error: --${flag} needs a runtime on Kindgi 0.1.9 or later.\n`);
      }
    });
  });
});
