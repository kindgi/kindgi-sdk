// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi secrets` tests. Mocks the SDK via `clientFactory` +
 * substitutes the `secretsInputSeam` for value-input UX. Never touches
 * a real TTY / stdin / disk (the manifest write goes through the
 * standard `envRunners` in-memory stub used by env tests).
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SecretsValueInputSeam } from '../src/commands/secrets.js';
import type { EnvRunners } from '../src/env/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { PromptCancelled, type TtySeam } from '../src/terminal-input.js';

let packDir: string;

interface Fixtures {
  runners: EnvRunners;
  readonly state: {
    files: Map<string, string>;
    listCalls: unknown[];
    setCalls: unknown[];
    rotateCalls: unknown[];
    revokeCalls: unknown[];
    getCalls: unknown[];
  };
  readonly seam: SecretsValueInputSeam;
  ttyPromptedFor: string[];
}

function makeFixtures(
  overrides: { readonly ttyValues?: readonly string[]; readonly stdinValue?: string } = {},
): Fixtures {
  const files = new Map<string, string>();
  const ttyPromptedFor: string[] = [];
  const state: Fixtures['state'] = {
    files,
    listCalls: [],
    setCalls: [],
    rotateCalls: [],
    revokeCalls: [],
    getCalls: [],
  };
  const runners: EnvRunners = {
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, contents) => {
      files.set(path, contents);
    },
  };
  const ttyValuesQueue = [...(overrides.ttyValues ?? [])];
  const seam: SecretsValueInputSeam = {
    tty: {
      promptHidden: async (prompt) => {
        ttyPromptedFor.push(prompt);
        const v = ttyValuesQueue.shift();
        if (v === undefined) {
          throw new Error(`No fixture TTY value queued for prompt "${prompt}"`);
        }
        return v;
      },
      close: () => {
        /* no-op */
      },
    },
    stdinIsTty: () => true,
    ...(overrides.stdinValue !== undefined && {
      readStdin: async () => overrides.stdinValue!,
    }),
  };
  return { runners, state, seam, ttyPromptedFor };
}

interface FakeSecretsShape {
  readonly list?: (args: unknown) => Promise<unknown>;
  readonly get?: (args: unknown) => Promise<unknown>;
  readonly set?: (args: unknown) => Promise<unknown>;
  readonly rotate?: (args: unknown) => Promise<unknown>;
  readonly revoke?: (args: unknown) => Promise<unknown>;
  readonly getVersion?: (args: unknown) => Promise<unknown>;
  readonly listVersions?: (args: unknown) => Promise<unknown>;
}

function makeFakeClient(secrets: FakeSecretsShape, envClient?: unknown): unknown {
  return { secrets, env: envClient ?? {} };
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
    secretsInputSeam: fixtures.seam,
    ...extras,
  };
}

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-cli-secrets-'));
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

// The tenant the fake server answers with: the bearer's, which the CLI never sends.
const SERVER_TENANT = '8f34192d-53bb-4fc2-bfb8-9094157b2404';

// ---------- scope + env validation ----------

describe('kindgi secrets — scope + env flag validation', () => {
  test('rejects missing --env with helpful message', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['secrets', 'list', '--scope=tenant']));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--env');
  });

  test('rejects missing --scope with helpful message', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(baseInputs(fixtures, ['secrets', 'list', '--env=staging']));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--scope=<kind>[:id]');
  });

  test('rejects malformed --scope=org (missing id)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['secrets', 'list', '--env=staging', '--scope=org']),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--scope=org:<orgId>');
  });

  test('rejects --scope=tenant:extra (tenant carries no id)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli(
      baseInputs(fixtures, ['secrets', 'list', '--env=staging', '--scope=tenant:foo']),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('tenant');
  });
});

// ---------- list ----------

describe('kindgi secrets list', () => {
  test('threads scope + env through the SDK', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        list: async (args: unknown) => {
          fixtures.state.listCalls.push(args);
          return { data: [{ name: 'stripe.key', currentVersion: 1 }] };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'list',
        '--env=staging',
        '--scope=project:m4',
        '--include-revoked',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const call = fixtures.state.listCalls[0] as {
      scope: { kind: string; projectId?: string };
      envName: string;
      includeRevoked?: boolean;
    };
    expect(call.scope.kind).toBe('project');
    expect(call.scope.projectId).toBe('m4');
    expect(call.envName).toBe('staging');
    expect(call.includeRevoked).toBe(true);
  });
});

// ---------- get ----------

describe('kindgi secrets get', () => {
  test('returns metadata (no value in output)', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        get: async (args: unknown) => {
          fixtures.state.getCalls.push(args);
          return {
            scope: { kind: 'tenant', tenantId: SERVER_TENANT },
            envName: 'staging',
            name: 'stripe.key',
            currentVersion: 5,
            createdAt: '2026-09-01T00:00:00Z',
            updatedAt: '2026-09-22T00:00:00Z',
          };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'get',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).not.toContain('value');
    expect(out.stdout).toContain('stripe.key');
  });

  test('exits 1 on null result (no such secret)', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        get: async () => null,
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'get',
        'missing',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No secret');
  });
});

// ---------- set — TTY prompt path ----------

describe('kindgi secrets set — TTY prompt', () => {
  test('prompts twice, matches values, calls SDK.set', async () => {
    const fixtures = makeFixtures({
      ttyValues: ['sk_live_x', 'sk_live_x'],
    });
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async (args: unknown) => {
          fixtures.state.setCalls.push(args);
          return {
            kind: 'ok',
            record: {
              name: 'stripe.key',
              scope: { kind: 'tenant', tenantId: SERVER_TENANT },
              envName: 'staging',
              currentVersion: 1,
              createdAt: '2026-09-22T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
            versionId: 1,
          };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.ttyPromptedFor.length).toBe(2);
    expect(fixtures.ttyPromptedFor[1]).toContain('confirm');
    const call = fixtures.state.setCalls[0] as { value: string };
    expect(call.value).toBe('sk_live_x');
    // NEVER echo value.
    expect(out.stdout).not.toContain('sk_live_x');
    expect(out.stderr).not.toContain('sk_live_x');
  });

  test('rejects on TTY mismatch', async () => {
    const fixtures = makeFixtures({
      ttyValues: ['sk_live_x', 'DIFFERENT'],
    });
    const clientFactory = (): unknown => makeFakeClient({});
    const out = await runCli({
      ...baseInputs(fixtures, ['secrets', 'set', 'stripe.key', '--env=staging', '--scope=tenant']),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('did not match');
  });

  test('Ctrl+C at the prompt cancels, writing nothing', async () => {
    const fixtures = makeFixtures();
    let closed = false;
    (fixtures.seam as { tty?: TtySeam }).tty = {
      promptHidden: async () => {
        throw new PromptCancelled();
      },
      close: () => {
        closed = true;
      },
    };
    const setCalls: unknown[] = [];
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async (args) => {
          setCalls.push(args);
          return {};
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, ['secrets', 'set', 'stripe.key', '--env=staging', '--scope=tenant']),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Cancelled.\n');
    expect(closed).toBe(true);
    expect(setCalls).toEqual([]);
  });

  test('rejects when stdin is not a TTY and --from-stdin absent', async () => {
    const fixtures = makeFixtures();
    // Force non-TTY.
    (fixtures.seam as { stdinIsTty?: () => boolean }).stdinIsTty = () => false;
    const clientFactory = (): unknown => makeFakeClient({});
    const out = await runCli({
      ...baseInputs(fixtures, ['secrets', 'set', 'stripe.key', '--env=staging', '--scope=tenant']),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('non-TTY stdin');
    expect(out.stderr).toContain('--from-stdin');
  });
});

// ---------- set — --from-stdin ----------

describe('kindgi secrets set — --from-stdin', () => {
  test('reads value from stdin', async () => {
    const fixtures = makeFixtures({ stdinValue: 'sk_live_x\n' });
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async (args: unknown) => {
          fixtures.state.setCalls.push(args);
          return {
            kind: 'ok',
            record: {
              name: 'stripe.key',
              scope: { kind: 'tenant', tenantId: SERVER_TENANT },
              envName: 'staging',
              currentVersion: 1,
              createdAt: '2026-09-22T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
            versionId: 1,
          };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--from-stdin',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const call = fixtures.state.setCalls[0] as { value: string };
    expect(call.value).toBe('sk_live_x');
  });
});

describe("kindgi secrets set --app (the app's env file)", () => {
  test('sends appEnvFile, and says where it went', async () => {
    const fixtures = makeFixtures({ stdinValue: 'whsec_x\n' });
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async (args: unknown) => {
          fixtures.state.setCalls.push(args);
          return {
            kind: 'ok',
            record: {
              name: 'ACME_WEBHOOK_SECRET',
              scope: { kind: 'tenant', tenantId: SERVER_TENANT },
              envName: 'local',
              currentVersion: 1,
              createdAt: '2026-10-10T00:00:00Z',
              updatedAt: '2026-10-10T00:00:00Z',
            },
            versionId: 1,
          };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'ACME_WEBHOOK_SECRET',
        '--env=local',
        '--scope=tenant',
        '--from-stdin',
        '--app',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.setCalls[0]).toMatchObject({ appEnvFile: true });
    expect(out.stderr).toContain(
      "Set ACME_WEBHOOK_SECRET at tenant in local, in your app's env file.",
    );
    expect(out.stderr + out.stdout).not.toContain('whsec_x');
  });

  test('without --app: no appEnvFile on the call', async () => {
    const fixtures = makeFixtures({ stdinValue: 'v\n' });
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async (args: unknown) => {
          fixtures.state.setCalls.push(args);
          return {
            kind: 'ok',
            record: {
              name: 'K',
              scope: { kind: 'tenant', tenantId: SERVER_TENANT },
              envName: 'local',
              currentVersion: 1,
              createdAt: '2026-10-10T00:00:00Z',
              updatedAt: '2026-10-10T00:00:00Z',
            },
            versionId: 1,
          };
        },
      });
    await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'K',
        '--env=local',
        '--scope=tenant',
        '--from-stdin',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(fixtures.state.setCalls[0]).not.toHaveProperty('appEnvFile');
  });
});

// ---------- copy ----------

describe("kindgi secrets copy (Kindgi's own copy; the app's files untouched)", () => {
  const SECRET = 'sk-ant-never-shown';
  const providersClient = (
    checks: Record<string, { secretRef?: { envName: string; name: string } }>,
  ): unknown => ({
    secrets: {},
    env: {},
    providers: {
      list: async () => ({ data: Object.keys(checks).map((id) => ({ id })), hasMore: false }),
      check: async (id: string) => checks[id] ?? {},
    },
  });
  const copy = (args: readonly string[], clientFactory?: () => unknown) =>
    runCli({
      ...baseInputs(makeFixtures(), [
        'secrets',
        'copy',
        ...args,
        '--url=https://api.example.com',
        '--token=t',
      ]),
      ...(clientFactory !== undefined && { clientFactory: clientFactory as never }),
    });

  test('a named key: copied to .kindgi/secrets.env; .env.local byte-identical; the notice, never the value', async () => {
    const app = `# mine\nANTHROPIC_API_KEY=${SECRET}\nSTORE_URL=s\n`;
    await writeFile(join(packDir, '.env.local'), app);
    const out = await copy(['ANTHROPIC_API_KEY']);

    expect(out.exitCode, out.stderr).toBe(0);
    expect(await readFile(join(packDir, '.kindgi', 'secrets.env'), 'utf8')).toBe(
      `ANTHROPIC_API_KEY=${SECRET}\n`,
    );
    expect(await readFile(join(packDir, '.env.local'), 'utf8')).toBe(app);
    expect(out.stderr).toContain(
      '✓ Copied ANTHROPIC_API_KEY from .env.local to .kindgi/secrets.env.',
    );
    expect(out.stderr).toContain(
      "It's still in .env.local: removing it is your call, since it's your app's file.",
    );
    expect(out.stderr).toContain('If your app uses ANTHROPIC_API_KEY itself, keep it there.');
    expect(JSON.parse(out.stdout)).toMatchObject({
      kindgiFile: '.kindgi/secrets.env',
      names: [{ name: 'ANTHROPIC_API_KEY', appFiles: ['.env.local'], copied: true }],
    });
    expect(out.stdout + out.stderr).not.toContain(SECRET);
  });

  test("no names: the runtime's providers' keys (their check's secretRef), and only those", async () => {
    await writeFile(join(packDir, '.env.local'), `ACME_CLAUDE_KEY=${SECRET}\nSTORE_URL=s\n`);
    const out = await copy([], () =>
      providersClient({
        'my-claude': { secretRef: { envName: 'local', name: 'ACME_CLAUDE_KEY' } },
      }),
    );

    expect(out.exitCode, out.stderr).toBe(0);
    expect(await readFile(join(packDir, '.kindgi', 'secrets.env'), 'utf8')).toBe(
      `ACME_CLAUDE_KEY=${SECRET}\n`,
    );
  });

  test('the same name, two values: Kindgi keeps its own key, the app keeps its own', async () => {
    await writeFile(join(packDir, '.env.local'), 'ANTHROPIC_API_KEY=app-key\n');
    await mkdir(join(packDir, '.kindgi'), { recursive: true });
    await writeFile(join(packDir, '.kindgi', 'secrets.env'), 'ANTHROPIC_API_KEY=kindgi-key\n');
    const out = await copy(['ANTHROPIC_API_KEY']);

    expect(out.stderr).toContain(
      'ANTHROPIC_API_KEY: Kindgi has its own key in .kindgi/secrets.env and uses it first; your app keeps the one in .env.local.',
    );
    expect(await readFile(join(packDir, '.kindgi', 'secrets.env'), 'utf8')).toBe(
      'ANTHROPIC_API_KEY=kindgi-key\n',
    );
  });

  test.skipIf(!hasGit())(
    'a key in a git-tracked .env: rotate it, since it is in the history',
    async () => {
      await writeFile(join(packDir, '.env'), `ANTHROPIC_API_KEY=${SECRET}\n`);
      execFileSync('git', ['init', '-q'], { cwd: packDir });
      execFileSync('git', ['add', '.env'], { cwd: packDir });
      const out = await copy(['ANTHROPIC_API_KEY']);

      expect(out.stderr).toContain(
        "⚠ .env is tracked by git, so ANTHROPIC_API_KEY is in your repository's history: rotate it with its provider.",
      );
      expect(JSON.parse(out.stdout).names[0].trackedByGit).toEqual(['.env']);
    },
  );

  test('no names and no runtime: said so, and nothing guessed', async () => {
    await writeFile(join(packDir, '.env.local'), `ANTHROPIC_API_KEY=${SECRET}\n`);
    const out = await copy([], () => ({
      secrets: {},
      env: {},
      providers: {
        list: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    }));

    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain("Couldn't reach Kindgi's runtime");
    expect(out.stderr).toContain("No model provider's key is in your app's env files");
    await expect(readFile(join(packDir, '.kindgi', 'secrets.env'), 'utf8')).rejects.toThrow();
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- set — --from-file mode check ----------

describe('kindgi secrets set — --from-file mode check', () => {
  test('rejects file with 0644 mode (group/world readable)', async () => {
    const fixtures = makeFixtures();
    (fixtures.seam as { statFile?: (p: string) => Promise<{ mode: number }> }).statFile =
      async () => ({ mode: 0o100644 });
    (fixtures.seam as { readFileAt?: (p: string) => Promise<string> }).readFileAt = async () =>
      'sk_live_x\n';
    const clientFactory = (): unknown => makeFakeClient({});
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--from-file',
        '/tmp/whatever',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('0644');
    expect(out.stderr).toContain('chmod 600');
  });

  test('accepts file with 0600 mode', async () => {
    const fixtures = makeFixtures();
    (fixtures.seam as { statFile?: (p: string) => Promise<{ mode: number }> }).statFile =
      async () => ({ mode: 0o100600 });
    (fixtures.seam as { readFileAt?: (p: string) => Promise<string> }).readFileAt = async () =>
      'sk_live_x';
    const clientFactory = (): unknown =>
      makeFakeClient({
        set: async () => ({
          kind: 'ok',
          record: {
            name: 'x',
            scope: { kind: 'tenant', tenantId: SERVER_TENANT },
            envName: 'staging',
            currentVersion: 1,
            createdAt: '2026-09-22T00:00:00Z',
            updatedAt: '2026-09-22T00:00:00Z',
          },
          versionId: 1,
        }),
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'x',
        '--env=staging',
        '--scope=tenant',
        '--from-file',
        '/tmp/whatever',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
  });

  test('rejects --from-stdin + --from-file combined', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown => makeFakeClient({});
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'set',
        'x',
        '--env=staging',
        '--scope=tenant',
        '--from-stdin',
        '--from-file',
        '/tmp/whatever',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Mutually exclusive');
  });
});

// ---------- rotate ----------

describe('kindgi secrets rotate', () => {
  test('reports success on ok outcome', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        rotate: async (args: unknown) => {
          fixtures.state.rotateCalls.push(args);
          return { kind: 'ok', newVersionId: 6, oldVersionId: 5 };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'rotate',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain('Rotated stripe.key');
    expect(out.stderr).toContain('v6');
    const call = fixtures.state.rotateCalls[0] as { mode: string };
    expect(call.mode).toBe('wait-for-complete');
  });

  test('exits 1 with hint on timeout outcome', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        rotate: async () => ({
          kind: 'timeout',
          rotationId: 'rot-42',
          statusUrl: '/v1/secrets/x/rotations/rot-42',
        }),
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'rotate',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('rotation still in progress');
    expect(out.stderr).toContain('rot-42');
  });

  test('exits 1 on failed outcome', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        rotate: async () => ({ kind: 'failed', error: 'Lambda timed out' }),
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'rotate',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Rotation failed');
    expect(out.stderr).toContain('Lambda timed out');
  });

  test('--no-wait threads mode:raw into SDK', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        rotate: async (args: unknown) => {
          fixtures.state.rotateCalls.push(args);
          return {
            kind: 'raw',
            response: {
              kind: 'async',
              rotationId: 'r',
              statusUrl: '/x',
              eventsUrl: '/x/events',
            },
          };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'rotate',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--no-wait',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const call = fixtures.state.rotateCalls[0] as { mode: string };
    expect(call.mode).toBe('raw');
    expect(out.stdout).toContain('rotationId');
  });
});

// ---------- revoke ----------

describe('kindgi secrets revoke', () => {
  test('threads --hard + --reason to SDK', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        revoke: async (args: unknown) => {
          fixtures.state.revokeCalls.push(args);
          return { revoked: true, hard: true };
        },
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'revoke',
        'stripe.key',
        '--env=staging',
        '--scope=tenant',
        '--hard',
        '--reason=compromised',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain('HARD-revoked');
    const call = fixtures.state.revokeCalls[0] as { hard?: boolean; reason?: string };
    expect(call.hard).toBe(true);
    expect(call.reason).toBe('compromised');
  });
});

// ---------- pull ----------

describe('kindgi secrets pull', () => {
  test('writes metadata manifest to .secrets/<envName>/manifest.json', async () => {
    const fixtures = makeFixtures();
    const clientFactory = (): unknown =>
      makeFakeClient({
        list: async () => ({
          data: [
            {
              scope: { kind: 'tenant', tenantId: SERVER_TENANT },
              envName: 'staging',
              name: 'stripe.key',
              currentVersion: 3,
              createdAt: '2026-09-01T00:00:00Z',
              updatedAt: '2026-09-22T00:00:00Z',
            },
          ],
        }),
      });
    const out = await runCli({
      ...baseInputs(fixtures, [
        'secrets',
        'pull',
        '--env=staging',
        '--scope=tenant',
        `--path=${packDir}`,
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: clientFactory as never,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const manifestPath = `${packDir}/.secrets/staging/manifest.json`;
    const manifest = JSON.parse(fixtures.state.files.get(manifestPath) ?? '{}') as {
      secrets: readonly { name: string; currentVersion: number }[];
    };
    expect(manifest.secrets[0]?.name).toBe('stripe.key');
    expect(manifest.secrets[0]?.currentVersion).toBe(3);
    // Confirm no `value` field ever crossed into the manifest.
    expect(fixtures.state.files.get(manifestPath)).not.toContain('"value"');
  });
});

// ---------- what the output says the scope is ----------

describe('kindgi secrets — the scope it prints and sends', () => {
  const okRecord = (scope: unknown) => ({
    kind: 'ok',
    record: {
      name: 'stripe.key',
      scope,
      envName: 'staging',
      currentVersion: 1,
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
    },
    versionId: 1,
  });
  const run = (fixtures: Fixtures, secrets: FakeSecretsShape, args: readonly string[]) =>
    runCli({
      ...baseInputs(fixtures, [
        'secrets',
        ...args,
        '--env=staging',
        '--url=https://api.example.com',
        '--token=t',
      ]),
      clientFactory: (() => makeFakeClient(secrets)) as never,
    });

  test('set prints the scope the server wrote to, its tenant included, and sends no tenant', async () => {
    const fixtures = makeFixtures({ stdinValue: 'sk_live_x' });
    const out = await run(
      fixtures,
      {
        set: async (args: unknown) => {
          fixtures.state.setCalls.push(args);
          return okRecord({ kind: 'tenant', tenantId: SERVER_TENANT });
        },
      },
      ['set', 'stripe.key', '--scope=tenant', '--from-stdin'],
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect((fixtures.state.setCalls[0] as { scope: unknown }).scope).toEqual({ kind: 'tenant' });
    expect(JSON.parse(out.stdout)).toMatchObject({
      name: 'stripe.key',
      scope: { kind: 'tenant', tenantId: SERVER_TENANT },
      versionId: 1,
    });
    expect(`${out.stdout}${out.stderr}`).not.toContain('session-tenant');
  });

  test('an org or project scope is sent as its kind and id', async () => {
    for (const [flag, sent] of [
      ['--scope=org:o1', { kind: 'org', orgId: 'o1' }],
      ['--scope=project:p1', { kind: 'project', projectId: 'p1' }],
    ] as const) {
      const fixtures = makeFixtures({ stdinValue: 'sk_live_x' });
      const out = await run(
        fixtures,
        {
          set: async (args: unknown) => {
            fixtures.state.setCalls.push(args);
            return okRecord({ ...sent, tenantId: SERVER_TENANT });
          },
        },
        ['set', 'stripe.key', flag, '--from-stdin'],
      );
      expect(out.exitCode, out.stderr).toBe(0);
      expect((fixtures.state.setCalls[0] as { scope: unknown }).scope).toEqual(sent);
      expect(JSON.parse(out.stdout).scope).toEqual({ ...sent, tenantId: SERVER_TENANT });
    }
  });

  test('revoke, rotate and pull print the scope they were given, with no tenant', async () => {
    const fixtures = makeFixtures();
    const revoked = await run(fixtures, { revoke: async () => ({ revoked: true, hard: false }) }, [
      'revoke',
      'stripe.key',
      '--scope=org:o1',
    ]);
    expect(revoked.exitCode, revoked.stderr).toBe(0);
    expect(JSON.parse(revoked.stdout).scope).toEqual({ kind: 'org', orgId: 'o1' });

    const rotated = await run(
      fixtures,
      { rotate: async () => ({ kind: 'ok', newVersionId: 2, oldVersionId: 1 }) },
      ['rotate', 'stripe.key', '--scope=tenant'],
    );
    expect(rotated.exitCode, rotated.stderr).toBe(0);
    expect(JSON.parse(rotated.stdout).scope).toEqual({ kind: 'tenant' });

    const pulled = await run(fixtures, { list: async () => ({ data: [] }) }, [
      'pull',
      '--scope=project:p1',
      `--path=${packDir}`,
    ]);
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    const manifest = [...fixtures.state.files.values()].map((v) => JSON.parse(v))[0];
    expect(manifest.scope).toEqual({ kind: 'project', projectId: 'p1' });
    for (const out of [revoked, rotated, pulled]) {
      expect(`${out.stdout}${out.stderr}`).not.toContain('session-tenant');
    }
  });

  test('a secret that already exists is an error, not "Set"', async () => {
    const fixtures = makeFixtures({ stdinValue: 'sk_live_x' });
    const out = await run(
      fixtures,
      { set: async () => ({ kind: 'already-exists', currentVersion: 3 }) },
      ['set', 'stripe.key', '--scope=tenant', '--from-stdin'],
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('stripe.key already exists (version 3)');
    expect(out.stderr).not.toContain('Set stripe.key');
  });
});
