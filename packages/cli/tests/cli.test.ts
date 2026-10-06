// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { KindgiClient } from '@kindgi/client';

import { runCli } from '../src/main.js';

/** The versions in the CLI's and the SDK's `package.json`: what a release publishes. */
const cliVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const sdkVersion = (
  JSON.parse(
    readFileSync(createRequire(import.meta.url).resolve('@kindgi/sdk/package.json'), 'utf8'),
  ) as { version: string }
).version;

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

const emptyEnv: Record<string, string | undefined> = {};

function baseInputs(overrides: Partial<Parameters<typeof runCli>[0]> = {}) {
  return {
    argv: [] as readonly string[],
    env: emptyEnv,
    cwd,
    home,
    ...overrides,
  };
}

describe('root-level flags and help', () => {
  test('no args prints root help with exit 0', async () => {
    const out = await runCli(baseInputs());
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('kindgi — command-line interface');
    expect(out.stdout).toContain('runs');
    expect(out.stdout).toContain('version');
    expect(out.stderr).toBe('');
  });

  test("--version prints the version in the CLI's package.json", async () => {
    const out = await runCli(baseInputs({ argv: ['--version'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe(cliVersion);
  });

  test('unknown top-level command exits 2 with root help on stderr', async () => {
    const out = await runCli(baseInputs({ argv: ['bogus'] }));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Unknown command: bogus');
  });

  test('group command without leaf prints group help', async () => {
    const out = await runCli(baseInputs({ argv: ['runs'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('Manage kernel runs');
    expect(out.stdout).toContain('cancel');
  });

  test('unknown flag on a leaf command fails loudly', async () => {
    const out = await runCli(baseInputs({ argv: ['version', '--bogus'] }));
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toLowerCase()).toContain('argument error');
  });
});

describe('version command', () => {
  test('emits CLI + SDK versions as JSON', async () => {
    const out = await runCli(baseInputs({ argv: ['version'] }));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ cli: cliVersion, sdk: sdkVersion });
  });

  test('--raw produces one-line JSON', async () => {
    const out = await runCli(baseInputs({ argv: ['version', '--raw'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(out.stdout)).not.toThrow();
  });

  test('--quiet suppresses stdout', async () => {
    const out = await runCli(baseInputs({ argv: ['version', '--quiet'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
  });

  test('no auth required', async () => {
    const out = await runCli(baseInputs({ argv: ['version'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
  });
});

describe('health command', () => {
  test('succeeds against a fake server', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      expect(String(url)).toBe('https://api.example.com/health');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const out = await runCli(
      baseInputs({
        argv: ['health', '--url=https://api.example.com'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true });
  });

  test('non-200 response fails with non-zero exit code', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('nope', { status: 500 });
    const out = await runCli(
      baseInputs({
        argv: ['health', '--url=https://api.example.com'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('HTTP 500');
  });

  test('requires --url or KINDGI_API_URL', async () => {
    const out = await runCli(baseInputs({ argv: ['health'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toLowerCase()).toContain('api url not configured');
  });
});

describe('config precedence: flag > env > file', () => {
  test('flag overrides env', async () => {
    const readFile = async (path: string): Promise<string | null> => {
      if (path.endsWith('config.json')) {
        return JSON.stringify({ apiUrl: 'https://file.example.com', token: 'file-token' });
      }
      return null;
    };
    const captured: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      captured.push(String(url));
      return new Response('{}', { status: 200 });
    };
    const out = await runCli(
      baseInputs({
        argv: ['health', '--url=https://flag.example.com'],
        env: { KINDGI_API_URL: 'https://env.example.com' },
        fetchImpl: fetchImpl as typeof fetch,
        configReadFile: readFile,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(captured).toEqual(['https://flag.example.com/health']);
  });

  test('env overrides file', async () => {
    const readFile = async (): Promise<string | null> =>
      JSON.stringify({ apiUrl: 'https://file.example.com', token: 'file-token' });
    const captured: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      captured.push(String(url));
      return new Response('{}', { status: 200 });
    };
    const out = await runCli(
      baseInputs({
        argv: ['health'],
        env: { KINDGI_API_URL: 'https://env.example.com' },
        fetchImpl: fetchImpl as typeof fetch,
        configReadFile: readFile,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(captured).toEqual(['https://env.example.com/health']);
  });

  test('falls back to file when neither flag nor env set', async () => {
    const readFile = async (): Promise<string | null> =>
      JSON.stringify({ apiUrl: 'https://file.example.com', token: 'file-token' });
    const captured: string[] = [];
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      captured.push(String(url));
      return new Response('{}', { status: 200 });
    };
    const out = await runCli(
      baseInputs({
        argv: ['health'],
        fetchImpl: fetchImpl as typeof fetch,
        configReadFile: readFile,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(captured).toEqual(['https://file.example.com/health']);
  });
});

describe('stub SDK error surfaces', () => {
  // `runs.get`, `runs.list`, `runs.journal` are all wired end-to-end
  // now. Left as a placeholder describe so a future stubbed verb can
  // reuse the pattern without spinning up new scaffolding.
  test('placeholder — no run verbs currently stubbed', () => {
    expect(true).toBe(true);
  });

  // `providers register` is now wired end-to-end via the SDK; the stub
  // contract that this test used to guard has moved. If a future
  // wire-through regresses a still-stubbed provider verb, add a test
  // for that specific verb here.
});

describe('not-implemented-in-preview SDK errors', () => {
  test('names the command with the kindgi binary', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['runs', 'get', 'run-1', '--url=https://x', '--token=t'],
        clientFactory: () =>
          ({
            runs: {
              get: async () => {
                throw { code: 'not-implemented-in-preview', method: 'runs.get', message: 'stub' };
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Command 'kindgi runs get' is not yet wired");
  });

  test('runs resume says why it is not available, and never calls the runtime', async () => {
    let called = false;
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'resume',
          'run-1',
          '--waitpoint=wp-1',
          '--value={"decided":"approve"}',
          '--url=https://x',
          '--token=t',
        ],
        clientFactory: () =>
          ({
            runs: {
              resume: async () => {
                called = true;
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Command 'kindgi runs resume' is not available");
    expect(out.stderr).toContain('kindgi approvals complete <approval-id> --decision=approve');
    expect(called).toBe(false);
  });

  test.each([
    [['observations', 'list'], "doesn't record supervisor observations yet"],
    [['proposals', 'list'], "doesn't draft or apply supervisor fix proposals yet"],
    [['proposals', 'get', 'p-1'], "doesn't draft or apply supervisor fix proposals yet"],
    [['artifacts', 'list'], "doesn't serve `/v1/artifacts` yet"],
    [['artifacts', 'download', 'blob-1'], 'no artifacts to list, upload, download or delete'],
    [['capabilities', 'list'], "doesn't serve `/v1/capabilities` yet"],
    [['capabilities', 'get', 'tool-use'], 'kindgi providers list --feature=<feature>'],
  ])("%j says why: the group's reason covers each of its commands", async (argv, reason) => {
    const out = await runCli(
      baseInputs({
        argv: [...argv, '--url=https://x', '--token=t'],
        clientFactory: () => ({}) as never,
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(`Command 'kindgi ${argv.slice(0, 2).join(' ')}' is not available`);
    expect(out.stderr).toContain(reason);
  });

  test("tokens create and revoke say the runtime doesn't serve them, and call nothing", async () => {
    for (const argv of [
      ['tokens', 'create'],
      ['tokens', 'revoke', 'tok-1'],
    ]) {
      let called = false;
      const out = await runCli(
        baseInputs({
          argv: [...argv, '--url=https://x', '--token=t'],
          clientFactory: () =>
            ({
              tokens: {
                create: async () => {
                  called = true;
                },
                revoke: async () => {
                  called = true;
                },
              },
            }) as never,
        }),
      );
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(
        `Command 'kindgi ${argv.slice(0, 2).join(' ')}' is not available`,
      );
      expect(out.stderr).toContain("the Kindgi runtime doesn't serve `/v1/tokens` yet");
      expect(called).toBe(false);
    }
  });
});

describe('kindgi runs start', () => {
  test('prints the run it started, as runs get does', async () => {
    const run = { id: 'run-1', status: 'completed', output: { answer: 42 } };
    let started: unknown;
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          '--agent=pack.agent',
          '--input={"x":1}',
          '--url=https://x',
          '--token=t',
        ],
        clientFactory: () =>
          ({
            runs: {
              start: async (input: unknown) => {
                started = input;
                return run;
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode).toBe(0);
    // Started in the background, so its id is known before it finishes.
    expect(started).toEqual({ agent: 'pack.agent', input: { x: 1 }, options: { wait: false } });
    expect(JSON.parse(out.stdout)).toEqual(run);
  });

  test('without --no-wait it follows a run still in progress until it settles', async () => {
    const reads: string[] = [];
    const states = ['running', 'running', 'completed'];
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          '--agent=pack.agent',
          '--input={"x":1}',
          '--url=https://x',
          '--token=t',
        ],
        clientFactory: () =>
          ({
            runs: {
              start: async () => ({ id: 'run-4', status: 'pending', publicAccessToken: 'pat' }),
              get: async (id: string) => {
                reads.push(id);
                const status = states.shift() ?? 'completed';
                return { id, status, ...(status === 'completed' && { output: { answer: 42 } }) };
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(reads).toEqual(['run-4', 'run-4', 'run-4']);
    expect(JSON.parse(out.stdout)).toEqual({
      id: 'run-4',
      status: 'completed',
      output: { answer: 42 },
      publicAccessToken: 'pat',
    });
  });

  test('--no-wait starts it in the background and --dry-run runs only read-only tools', async () => {
    let started: unknown;
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          '--flow=pack.flow',
          '--input={"x":1}',
          '--no-wait',
          '--dry-run',
          '--url=https://x',
          '--token=t',
        ],
        clientFactory: () =>
          ({
            runs: {
              start: async (input: unknown) => {
                started = input;
                return { id: 'run-2', status: 'pending' };
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(started).toEqual({
      flow: 'pack.flow',
      input: { x: 1 },
      options: { wait: false, dryRun: true },
    });
    expect(JSON.parse(out.stdout)).toEqual({ id: 'run-2', status: 'pending' });
  });

  /** `kindgi runs start <flags>` against a client that records what it started. */
  async function start(flags: readonly string[]) {
    const started: unknown[] = [];
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          ...flags,
          '--input={"x":1}',
          '--no-wait',
          '--url=https://x',
          '--token=t',
        ],
        clientFactory: () =>
          ({
            runs: {
              start: async (input: unknown) => {
                started.push(input);
                return { id: 'run-3', status: 'pending' };
              },
            },
          }) as never,
      }),
    );
    return { out, started };
  }

  test('--agent-version and --flow-version name the version to run (T245)', async () => {
    const agent = await start(['--agent=pack.agent', '--agent-version=1.0.0']);
    expect(agent.out.exitCode, agent.out.stderr).toBe(0);
    expect(agent.started).toEqual([
      { agent: 'pack.agent', agentVersion: '1.0.0', input: { x: 1 }, options: { wait: false } },
    ]);
    const flow = await start(['--flow=pack.flow', '--flow-version=2.1.0']);
    expect(flow.out.exitCode, flow.out.stderr).toBe(0);
    expect(flow.started).toEqual([
      { flow: 'pack.flow', flowVersion: '2.1.0', input: { x: 1 }, options: { wait: false } },
    ]);
  });

  test('--project runs it in that project, agent or flow', async () => {
    const agent = await start(['--agent=pack.agent', '--project=p-1']);
    expect(agent.out.exitCode, agent.out.stderr).toBe(0);
    expect(agent.started).toEqual([
      { agent: 'pack.agent', projectId: 'p-1', input: { x: 1 }, options: { wait: false } },
    ]);
    const flow = await start(['--flow=pack.flow', '--project=p-2']);
    expect(flow.started).toEqual([
      { flow: 'pack.flow', projectId: 'p-2', input: { x: 1 }, options: { wait: false } },
    ]);
  });

  test('a version for the other kind is refused, and nothing starts (T245)', async () => {
    for (const [flags, message] of [
      [
        ['--flow=pack.flow', '--agent-version=1.0.0'],
        '--agent-version goes with --agent=<agent-id>',
      ],
      [['--agent=pack.agent', '--flow-version=1.0.0'], '--flow-version goes with --flow=<flow-id>'],
    ] as const) {
      const { out, started } = await start(flags);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain(message);
      expect(started).toEqual([]);
    }
  });
});

describe('missing required arguments', () => {
  test('kindgi runs get without run-id fails', async () => {
    const out = await runCli(baseInputs({ argv: ['runs', 'get', '--url=https://x', '--token=t'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Missing required argument: run-id');
  });

  test('kindgi runs start without --agent/--flow fails', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['runs', 'start', '--input={"x":1}', '--url=https://x', '--token=t'],
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toLowerCase()).toContain('--agent');
  });

  test('kindgi runs start with both --agent and --flow fails', async () => {
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          '--agent=a',
          '--flow=g',
          '--input={"x":1}',
          '--url=https://x',
          '--token=t',
        ],
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('mutually exclusive');
  });
});

describe('kindgi runs start — turn warnings', () => {
  function startWith(output: unknown) {
    return runCli(
      baseInputs({
        argv: ['runs', 'start', '--agent=ledger.echo-agent', '--input={"userMessage":"hi"}'],
        env: { KINDGI_API_URL: 'https://x', KINDGI_API_TOKEN: 't' },
        clientFactory: () =>
          ({
            runs: { start: async () => ({ id: 'run-1', status: 'completed', output }) },
          }) as never,
      }),
    );
  }

  test("a turn's warnings go to stderr; the run still goes to stdout", async () => {
    const out = await startWith({
      warnings: [
        {
          code: 'fallback-provider',
          message:
            'Answered by "dev-echo", a fallback provider: no other registered provider satisfies agent "ledger.echo-agent".',
        },
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe(
      '⚠ Answered by "dev-echo", a fallback provider: no other registered provider satisfies agent "ledger.echo-agent".\n',
    );
    expect(JSON.parse(out.stdout).id).toBe('run-1');
  });

  test('no warnings, nothing on stderr', async () => {
    const out = await startWith({ response: { content: 'Hello, Ada!' } });
    expect(out.stderr).toBe('');
  });
});

describe('kindgi runs start — project and segments', () => {
  test('sends the project and the segment path, in order', async () => {
    const started: unknown[] = [];
    const out = await runCli(
      baseInputs({
        argv: [
          'runs',
          'start',
          '--agent=acme.drafter',
          '--input={"userMessage":"hi"}',
          '--project=p-1',
          '--segment=company:acme',
          '--segment=role:counsel',
          '--no-wait',
        ],
        env: { KINDGI_API_URL: 'https://x', KINDGI_API_TOKEN: 't' },
        clientFactory: () =>
          ({
            runs: {
              start: async (input: unknown) => {
                started.push(input);
                return { id: 'run-1', status: 'pending' };
              },
            },
          }) as never,
      }),
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(started).toEqual([
      expect.objectContaining({
        agent: 'acme.drafter',
        projectId: 'p-1',
        segments: [
          { key: 'company', value: 'acme' },
          { key: 'role', value: 'counsel' },
        ],
      }),
    ]);
  });

  test('a segment without a value fails before the run starts', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['runs', 'start', '--agent=a', '--input={}', '--segment=company'],
        env: { KINDGI_API_URL: 'https://x', KINDGI_API_TOKEN: 't' },
        clientFactory: () => ({ runs: { start: async () => ({}) } }) as never,
      }),
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('key:value');
  });
});

describe('auth login', () => {
  test('persists config and reports the path', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['auth', 'login', '--url=https://api.example.com', '--token=abc'],
      }),
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { wrote?: string; apiUrl?: string };
    expect(parsed.wrote).toContain('config.json');
    expect(parsed.apiUrl).toBe('https://api.example.com');

    // Verify the file is readable next run.
    const out2 = await runCli(
      baseInputs({
        argv: ['auth', 'whoami'],
        fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      }),
    );
    expect(out2.exitCode).toBe(0);
    const parsed2 = JSON.parse(out2.stdout) as {
      tokenSource?: string;
      apiUrlSource?: string;
    };
    expect(parsed2.apiUrlSource).toBe('file');
    expect(parsed2.tokenSource).toBe('file');
  });

  test('whoami checks the token on an authenticated route and shows the identity', async () => {
    await runCli(
      baseInputs({ argv: ['auth', 'login', '--url=https://api.example', '--token=tok'] }),
    );
    const seen: string[] = [];
    const ok = await runCli(
      baseInputs({
        argv: ['auth', 'whoami'],
        fetchImpl: (async (url: string | URL | Request) => {
          seen.push(String(url));
          return new Response(JSON.stringify({ tenantId: 't-1', scopes: ['tenant-admin'] }), {
            status: 200,
          });
        }) as typeof fetch,
      }),
    );
    expect(seen).toEqual(['https://api.example/v1/identity/whoami']);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ identity: { tenantId: 't-1' } });

    const wrong = await runCli(
      baseInputs({
        argv: ['auth', 'whoami'],
        fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
      }),
    );
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain('HTTP 401');
  });

  test('rejects login without --url', async () => {
    const out = await runCli(baseInputs({ argv: ['auth', 'login', '--token=abc'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Missing --url');
  });

  test('rejects login without --token', async () => {
    const out = await runCli(baseInputs({ argv: ['auth', 'login', '--url=https://x'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Missing --token');
  });
});

describe('commands that write into a project', () => {
  /** A client that records the project each write names. */
  function recordingClient(calls: string[]): KindgiClient {
    return {
      projects: {
        getDefault: async () => {
          calls.push('projects.getDefault');
          return { id: 'default-project' };
        },
      },
      agents: {
        define: async (_spec: unknown, options: { projectId: string }) => {
          calls.push(`agents.define ${options.projectId}`);
          return 'agent-1';
        },
      },
      guardrails: {
        author: async (_spec: unknown, options: { projectId: string }) => {
          calls.push(`guardrails.author ${options.projectId}`);
          return { guardrailId: 'guardrail-1' };
        },
      },
    } as unknown as KindgiClient;
  }

  const env = { KINDGI_API_URL: 'https://api.example.com', KINDGI_API_TOKEN: 'token' };

  test.each([
    ['agents', 'publish', 'agents.define'],
    ['guardrails', 'register', 'guardrails.author'],
  ])(
    '%s %s writes into the Default project unless --project names one',
    async (group, verb, call) => {
      const calls: string[] = [];
      const run = (extra: readonly string[]) =>
        runCli(
          baseInputs({
            argv: [group, verb, '--spec={"id":"x"}', ...extra],
            env,
            clientFactory: () => recordingClient(calls),
          }),
        );

      expect((await run([])).exitCode).toBe(0);
      expect(calls).toEqual(['projects.getDefault', `${call} default-project`]);

      calls.length = 0;
      expect((await run(['--project=p-2'])).exitCode).toBe(0);
      expect(calls).toEqual([`${call} p-2`]);
    },
  );
});
