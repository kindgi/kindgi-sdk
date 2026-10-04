// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi secrets` tests. Mocks the SDK via `clientFactory` +
 * substitutes the `secretsInputSeam` for value-input UX. Never touches
 * a real TTY / stdin / disk (the manifest write goes through the
 * standard `envRunners` in-memory stub used by env tests).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
            scope: { kind: 'tenant', tenantId: 'session-tenant' },
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
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
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
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
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
            scope: { kind: 'tenant', tenantId: 'session-tenant' },
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
              scope: { kind: 'tenant', tenantId: 'session-tenant' },
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
