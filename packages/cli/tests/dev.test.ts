// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev` tests. Every side effect flows through the injectable
 * `DevRunners` seam so these tests never boot Postgres, never call
 * `fs.watch`, and never touch a real `runIndexer`.
 *
 * Test-fake `DevRunners`:
 *   - `startApiServer` — returns a fixed baseUrl / tenant / token.
 *     `shutdown()` records a call so we can assert graceful teardown.
 *   - `runIndexer` — returns a canned `IndexResult`. Configurable per
 *     test to simulate happy path + failure paths.
 *   - `watchPack` — captures the `onChange` callback so tests can
 *     invoke it manually + assert re-index behavior.
 *
 * The SDK client is faked via the standard `clientFactory` seam on
 * `runCli`; the fake collects `agents.define` / `guardrails.author` /
 * `flows.define` calls so registration is observable.
 *
 * Tool registrations go over `fetch` (SDK gap — no
 * `client.tools.define`); the test hands in a mock `fetchImpl` and
 * asserts against captured requests.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  DevRunners,
  IndexResult,
  PackBuild,
  RunningApiServer,
  WatchHandle,
} from '../src/dev/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';

let cwd: string;
let home: string;
let packDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
  packDir = join(cwd, 'sample-pack');
  await mkdir(packDir, { recursive: true });
  // Minimal `kindgi.config.ts` — `kindgi dev` refuses to boot
  // without one. Real content doesn't matter because the fake
  // `runIndexer` is what parses it.
  await writeFile(
    join(packDir, 'kindgi.config.ts'),
    "export default { pack: { id: 'my-pack', version: '0.1.0' } };\n",
    'utf8',
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

// ---------- fake DevRunners ----------

interface FakeServer extends RunningApiServer {
  shutdownCount: number;
}

interface FakeWatchHandle extends WatchHandle {
  closeCount: number;
}

interface Fixtures {
  readonly runners: DevRunners;
  readonly server: FakeServer;
  readonly indexOutcomes: IndexResult[];
  captureIndexerCalls: string[];
  captureWatchCalls: { readonly packDir: string; readonly debounceMs?: number }[];
  /** A code change: the bundler reports a rebuild. */
  triggerChange: () => void;
  /** An env-file change (the second watcher). */
  triggerEnvChange: () => void;
  readonly watchHandle: FakeWatchHandle;
  readonly agentDefineCalls: unknown[];
  readonly guardrailAuthorCalls: unknown[];
  readonly flowDefineCalls: unknown[];
  /** What `providers.list` returns to the banner. */
  readonly providers: readonly unknown[];
  readonly fetchCalls: { readonly url: string; readonly body: unknown }[];
  /** Index paths the fake pack service was started on, in order. */
  readonly packStarts: string[];
  /** `[staged, index]` pairs published, in order. */
  readonly published: (readonly [string, string])[];
  readonly packStops: () => number;
  /** Interpreters `checkPackPython` was asked about. */
  readonly pythonChecks: (readonly string[])[];
  /** The `PackCode` each of the pack service, the builder and the indexer got. */
  readonly serviceCodes: unknown[];
  readonly builderCodes: unknown[];
  readonly indexerCodes: unknown[];
}

function makeFixtures(
  opts: {
    readonly outcomes?: IndexResult[];
    readonly startFails?: boolean;
    /** The fake pack service fails to boot with these problems. */
    readonly packBootProblems?: readonly string[];
    /** The pack's Python fails its check with this message. */
    readonly pythonProblem?: string;
    /** The tenant's providers (default: the dev-echo fallback). */
    readonly providers?: readonly unknown[];
  } = {},
): Fixtures {
  const pythonChecks: (readonly string[])[] = [];
  const serviceCodes: unknown[] = [];
  const builderCodes: unknown[] = [];
  const indexerCodes: unknown[] = [];
  const outcomes: IndexResult[] =
    opts.outcomes && opts.outcomes.length > 0 ? [...opts.outcomes] : [defaultHappyOutcome()];

  const server: FakeServer = {
    baseUrl: 'http://localhost:4000',
    port: 4000,
    tenantId: 'tenant-abc',
    userId: 'user-abc',
    defaultProjectId: 'project-default',
    token: 'kgi_bt_test-token',
    banner: 'Kindgi API server listening on http://localhost:4000',
    shutdownCount: 0,
    shutdown: async () => {
      server.shutdownCount += 1;
    },
  };

  const captureIndexerCalls: string[] = [];
  const indexOutcomes = outcomes;

  const captureWatchCalls: { packDir: string; debounceMs?: number }[] = [];
  const onChangeRefs: (() => void)[] = [];
  let rebuildRef: ((build: PackBuild) => void) | undefined;
  const watchHandle: FakeWatchHandle = {
    closeCount: 0,
    close: async () => {
      watchHandle.closeCount += 1;
    },
  };

  const packStarts: string[] = [];
  const published: (readonly [string, string])[] = [];
  let packStops = 0;
  const unavailable = {
    kind: 'err',
    error: { code: 'pack-service-unavailable', message: 'fake' },
  } as const;

  const runners: DevRunners = {
    checkPackPython: async (python) => {
      pythonChecks.push(python);
      return opts.pythonProblem !== undefined
        ? { kind: 'err', message: opts.pythonProblem }
        : { kind: 'ok', value: 'Python 3.13 · kindgi test' };
    },
    createPackService: (serviceOpts) => {
      serviceCodes.push(serviceOpts.code);
      return {
        token: 'fake-token',
        relay: {
          serving: () => false,
          forward: async () => ({ kind: 'unavailable', reason: 'fake' }),
        },
        listen: async () => ({ url: 'http://127.0.0.1:1', port: 1 }),
        close: async () => {
          packStops += 1;
        },
        transport: {
          target: 'fake-pack',
          send: async () => unavailable,
          info: async () => unavailable,
        },
        start: async (indexPath) => {
          packStarts.push(indexPath);
          return opts.packBootProblems !== undefined
            ? { kind: 'err', error: { problems: opts.packBootProblems } }
            : { kind: 'ok', value: { port: 1 } };
        },
        stop: async () => {
          packStops += 1;
        },
      };
    },
    createPackBuilder: (builderOpts) => {
      builderCodes.push(builderOpts.code);
      return {
        build: async () => ({ kind: 'ok', bundleMap: FIXTURE_BUNDLES }),
        watch: async (onBuild) => {
          rebuildRef = onBuild;
        },
        syncEntries: async () => false,
        dispose: async () => {},
      };
    },
    publishIndex: async (staged, index) => {
      published.push([staged, index]);
    },
    startApiServer: async () => {
      if (opts.startFails === true) {
        throw new Error('mock start failure');
      }
      return server;
    },
    runIndexer: async (dir: string, _out, indexerOpts) => {
      captureIndexerCalls.push(dir);
      indexerCodes.push(indexerOpts?.code);
      // Consume the outcome list in order; last outcome sticks.
      return indexOutcomes.length > 1
        ? (indexOutcomes.shift() as IndexResult)
        : (indexOutcomes[0] as IndexResult);
    },
    watchPack: async (dir, onChange, watchOpts) => {
      captureWatchCalls.push({
        packDir: dir,
        ...(watchOpts?.debounceMs !== undefined && { debounceMs: watchOpts.debounceMs }),
      });
      onChangeRefs.push(onChange);
      return watchHandle;
    },
  };

  return {
    runners,
    server,
    indexOutcomes,
    captureIndexerCalls,
    captureWatchCalls,
    watchHandle,
    triggerChange: () => rebuildRef?.({ kind: 'ok', bundleMap: {} }),
    triggerEnvChange: () => onChangeRefs[1]?.(),
    agentDefineCalls: [],
    guardrailAuthorCalls: [],
    flowDefineCalls: [],
    providers: opts.providers ?? [DEV_ECHO_ROW],
    fetchCalls: [],
    packStarts,
    published,
    packStops: () => packStops,
    pythonChecks,
    serviceCodes,
    builderCodes,
    indexerCodes,
  };
}

/** The fake bundler's output for `defaultHappyOutcome`'s pack. */
const FIXTURE_BUNDLES: Readonly<Record<string, string>> = {
  'tools/echo/index.ts': '.kindgi/dev/dist/tools/echo/index.mjs',
  'guardrails/response-not-empty/index.ts':
    '.kindgi/dev/dist/guardrails/response-not-empty/index.mjs',
};

function defaultHappyOutcome(): IndexResult {
  return {
    kind: 'ok',
    packId: 'my-pack',
    packVersion: '0.1.0',
    counts: { tools: 1, guardrails: 1, agents: 1, flows: 1 },
    fileErrors: [],
    index: {
      v: 1,
      packId: 'my-pack',
      packVersion: '0.1.0',
      tools: [
        {
          id: 'my-pack.echo',
          description: 'echoes',
          input: { type: 'object' },
          output: { type: 'object' },
          modulePath: 'tools/echo/index.ts',
        },
      ],
      guardrails: [
        {
          id: 'my-pack.response-not-empty',
          kind: 'zero-llm',
          action: { 'on-violation': 'block' },
          checkModulePath: 'guardrails/response-not-empty/index.ts',
        },
      ],
      agents: [
        {
          id: 'my-pack.echo-agent',
          version: '0.1.0',
          name: 'Echo Agent',
          instructions: 'do echo',
          capabilities: [],
          tools: [{ id: 'my-pack.echo', version: '1.0.0' }],
          modulePath: 'agents/echo-agent/index.ts',
        },
      ],
      flows: [
        {
          id: 'my-pack.echo-flow',
          version: '0.1.0',
          nodes: [{ id: 'echo', kind: 'tool', ref: 'my-pack.echo' }],
          edges: [
            { id: 'e1', from: '$start', to: 'echo' },
            { id: 'e2', from: 'echo', to: '$end' },
          ],
          kernelPayloadVersion: 1,
          modulePath: 'flows/echo-flow/index.ts',
        },
      ],
    },
  };
}

// ---------- fake SDK client + fetch ----------

function makeFakeClient(fixtures: Fixtures): unknown {
  return {
    agents: {
      define: vi.fn(async (spec: unknown) => {
        fixtures.agentDefineCalls.push(spec);
        return 'agent-id' as unknown;
      }),
    },
    guardrails: {
      author: vi.fn(async (spec: unknown) => {
        fixtures.guardrailAuthorCalls.push(spec);
        return { guardrailId: 'inv-id' } as unknown;
      }),
    },
    flows: {
      define: vi.fn(async (spec: unknown) => {
        fixtures.flowDefineCalls.push(spec);
        return { flowId: 'g', version: '0.1.0' } as unknown;
      }),
    },
    providers: {
      list: vi.fn(async () => ({ data: fixtures.providers, hasMore: false })),
    },
  };
}

const DEV_ECHO_ROW = {
  id: 'dev-echo',
  region: 'local',
  models: [{ name: 'dev-echo-v1' }],
  fallback: true,
};

function makeFakeFetch(
  fixtures: Fixtures,
  opts: { readonly toolStatus?: number } = {},
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    let body: unknown = undefined;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    fixtures.fetchCalls.push({ url: url.toString(), body });
    return new Response(JSON.stringify({}), { status: opts.toolStatus ?? 201 });
  }) as unknown as typeof fetch;
}

function baseInputs(
  fixtures: Fixtures,
  extra: Partial<RunCliInputs> = {},
  fetchOpts: { readonly toolStatus?: number } = {},
): RunCliInputs {
  return {
    argv: [],
    env: { KINDGI_DATABASE_URL: 'postgres://user:pass@localhost:5432/db' },
    cwd,
    home,
    devRunners: fixtures.runners,
    fetchImpl: makeFakeFetch(fixtures, fetchOpts),
    clientFactory: () => makeFakeClient(fixtures) as never,
    ...extra,
  };
}

// ---------- tests ----------

describe('kindgi dev — argument validation', () => {
  test('missing KINDGI_DATABASE_URL + no --database-url → clear error', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      env: {},
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('kindgi dev needs Postgres');
    expect(out.stderr).toContain('KINDGI_DATABASE_URL');
    // Test's DevRunners fixture has no `startServices` wired, so the
    // auto-start path bails out with "start-services runner not wired"
    // and the hint falls back to the docker + manual paths.
    expect(out.stderr).toContain('Auto-start not available');
  });

  test("host app's un-prefixed DATABASE_URL is ignored — never boots Kindgi against it", async () => {
    // Kindgi embedded in an existing app shares that app's env. The
    // app's own DATABASE_URL must not become Kindgi's database.
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      env: { DATABASE_URL: 'postgres://host-app/db' },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('kindgi dev needs Postgres');
    expect(spy).not.toHaveBeenCalled();
  });

  test('--port must parse as an integer 0..65535', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--port=99999', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Invalid --port');
  });

  test('--watch and --no-watch together → contradictory-flags error', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--watch', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Contradictory flags');
  });

  test('missing kindgi.config.ts → refuse with a helpful hint', async () => {
    const fixtures = makeFixtures();
    const empty = await mkdtemp(join(tmpdir(), 'kindgi-empty-'));
    try {
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', `--path=${empty}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('could not find a kindgi.config.ts');
      expect(out.stderr).toContain('kindgi init');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('kindgi dev — the project env files', () => {
  const writeConfig = (extra = ''): Promise<void> =>
    writeFile(
      join(packDir, 'kindgi.config.ts'),
      `export default { pack: { id: 'my-pack', version: '0.1.0' }${extra} };\n`,
      'utf8',
    );

  test('KINDGI_DATABASE_URL in .env boots Kindgi; the host DATABASE_URL beside it is ignored', async () => {
    await writeFile(
      join(packDir, '.env'),
      'DATABASE_URL=postgres://host-app/db\nKINDGI_DATABASE_URL=postgres://kindgi/db\n',
    );
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    await runCli({
      ...baseInputs(fixtures),
      env: {},
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(spy.mock.calls[0]?.[0]?.databaseUrl).toBe('postgres://kindgi/db');
  });

  test('the shell beats the env files for runtime config', async () => {
    await writeFile(join(packDir, '.env'), 'KINDGI_DATABASE_URL=postgres://from-file/db\n');
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    await runCli({
      ...baseInputs(fixtures),
      env: { KINDGI_DATABASE_URL: 'postgres://from-shell/db' },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(spy.mock.calls[0]?.[0]?.databaseUrl).toBe('postgres://from-shell/db');
  });

  test('the runtime gets dev.envFiles and the CLI env (for ${VAR} fallback)', async () => {
    await writeConfig(", dev: { envFiles: ['.env', '.env.dev'] }");
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const env = { KINDGI_DATABASE_URL: 'postgres://x/db', HOME: '/h' };
    await runCli({
      ...baseInputs(fixtures),
      env,
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    const opts = spy.mock.calls[0]?.[0];
    expect(opts?.localEnvFiles).toEqual(['.env', '.env.dev']);
    expect(opts?.hostEnv).toEqual(env);
  });

  test('boot log reports files and counts, never values', async () => {
    await writeFile(
      join(packDir, '.env'),
      'ANTHROPIC_API_KEY=sk-secret-value\nKINDGI_X=1\nbad line\n',
    );
    const fixtures = makeFixtures();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    } finally {
      spy.mockRestore();
    }
    const log = writes.join('');
    expect(log).toContain('env files: .env — 1 name(s) for the pack');
    expect(log).toContain('.env:3: ignored');
    expect(log).not.toContain('sk-secret-value');
    expect(log).not.toContain('bad line');
  });

  test('public run tokens: the runtime makes the key; KINDGI_CORS_ORIGINS from the env files', async () => {
    await writeFile(join(packDir, '.env'), 'KINDGI_CORS_ORIGINS=http://localhost:3000\n');
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    const opts = spy.mock.calls[0]?.[0];
    expect(opts?.publicRunTokenKeyPath).toBeUndefined();
    expect(opts?.corsOrigins).toEqual(['http://localhost:3000']);
    expect(out.stderr).toContain(
      'Browser origins    http://localhost:3000 (browsers may follow runs with public run tokens)',
    );
  });

  test('the live "Kindgi is up" block names the browser origins, not only the exit banner', async () => {
    const fixtures = makeFixtures();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runCli({
        ...baseInputs(fixtures),
        env: { ...baseInputs(fixtures).env, KINDGI_CORS_ORIGINS: 'http://localhost:3000' },
        argv: ['dev', '--no-watch', `--path=${packDir}`],
      });
      await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    } finally {
      spy.mockRestore();
    }
    const log = writes.join('');
    expect(log).toContain(
      '  Origins    http://localhost:3000 (browsers may follow runs with public run tokens)',
    );
    expect(log).toContain(
      '  Origins    none (set KINDGI_CORS_ORIGINS so a browser app can follow runs)',
    );
  });

  test('public run tokens: the key file when KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH is set', async () => {
    const keyPath = join(packDir, 'public-token.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const first = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH: keyPath },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(first.exitCode).toBe(0);
    const again = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH: keyPath },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(again.exitCode).toBe(0);
    // The key file is handed to the runtime (mounted), so tokens survive a restart.
    const paths = spy.mock.calls.map((call) => call[0]?.publicRunTokenKeyPath);
    expect(paths).toEqual([keyPath, keyPath]);
    expect(spy.mock.calls[0]?.[0]?.corsOrigins).toBeUndefined();
  });

  test('a malformed KINDGI_CORS_ORIGINS refuses to boot', async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_CORS_ORIGINS: 'http://localhost:3000/app' },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('KINDGI_CORS_ORIGINS entries must be exact origins');
    expect(spy).not.toHaveBeenCalled();
  });

  test('a malformed dev.envFiles refuses to boot', async () => {
    await writeConfig(', dev: { envFiles: [] }');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('dev.envFiles');
  });
});

describe('kindgi dev — a Python pack', () => {
  async function pythonPack(extra = ''): Promise<void> {
    await rm(join(packDir, 'kindgi.config.ts'));
    await writeFile(
      join(packDir, 'pyproject.toml'),
      `[project]\nname = "my-pack"\n\n[tool.kindgi.pack]\nid = "my-pack"\nversion = "0.1.0"\n${extra}`,
      'utf8',
    );
  }

  test("[tool.kindgi] in pyproject.toml: the pack's Python indexes and serves it", async () => {
    await pythonPack('\n[tool.kindgi.dev]\npython = ["uv", "run", "python"]\n');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    const code = { language: 'python', python: ['uv', 'run', 'python'] };
    expect(fixtures.pythonChecks).toEqual([['uv', 'run', 'python']]);
    expect(fixtures.serviceCodes).toEqual([code]);
    expect(fixtures.builderCodes).toEqual([code]);
    expect(fixtures.indexerCodes).toEqual([code]);
  });

  test("without dev.python, the pack's .venv, else python3", async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(fixtures.pythonChecks).toEqual([['python3']]);

    await mkdir(join(packDir, '.venv', 'bin'), { recursive: true });
    await writeFile(join(packDir, '.venv', 'bin', 'python'), '', 'utf8');
    const again = makeFixtures();
    await runCli({ ...baseInputs(again), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(again.pythonChecks).toEqual([[join(packDir, '.venv', 'bin', 'python')]]);
  });

  test('a Python that cannot import kindgi stops the boot with the reason', async () => {
    await pythonPack();
    const fixtures = makeFixtures({
      pythonProblem: "the pack's Python (python3) cannot import kindgi",
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('cannot import kindgi');
    expect(fixtures.serviceCodes).toEqual([]);
  });

  test('a pyproject.toml without [tool.kindgi] is not a pack', async () => {
    await rm(join(packDir, 'kindgi.config.ts'));
    await writeFile(join(packDir, 'pyproject.toml'), '[project]\nname = "app"\n', 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('[tool.kindgi]');
  });

  test('a Node pack keeps the Node pack code', async () => {
    const fixtures = makeFixtures();
    await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(fixtures.serviceCodes).toEqual([{ language: 'node' }]);
    expect(fixtures.pythonChecks).toEqual([]);
  });
});

describe('kindgi dev — boot flow (no watch)', () => {
  test('boots api-server + registers every primitive in one cycle', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    // All four pack primitives served from disk in dev — the api-
    // server's Disk*RegistryBinding reads index.json directly. Zero
    // wire calls from the CLI's register loop.
    expect(fixtures.fetchCalls).toHaveLength(0);
    expect(fixtures.agentDefineCalls).toHaveLength(0);
    expect(fixtures.guardrailAuthorCalls).toHaveLength(0);
    expect(fixtures.flowDefineCalls).toHaveLength(0);
    // Server booted then shut down cleanly.
    expect(fixtures.server.shutdownCount).toBe(1);
  });

  // Removed: 'strips indexer-only fields (checkModulePath /
  // kernelPayloadVersion)'. Since the disk-binding switch, no
  // pack primitive wire body crosses register.ts — the
  // transformation this test used to guard has moved into each
  // disk binding's `to<Primitive>` helper (guardrail's
  // `checkModulePath → codeArtifactRef.filesystem`, flow's
  // `kernelPayloadVersion` dropped). If deploy path adds a shared
  // transformation helper, add coverage there.

  test('prints the boot banner to stderr with primitive counts', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.stderr).toContain('Starting Kindgi locally');
    expect(out.stderr).toContain('http://localhost:4000');
    expect(out.stderr).toContain('kgi_bt_test-token');
    expect(out.stderr).toContain('1 tools');
    expect(out.stderr).toContain('1 guardrails');
    expect(out.stderr).toContain('1 agents');
    expect(out.stderr).toContain('1 flows');
    expect(out.stderr).toContain(
      'Providers          dev-echo (fallback) — canned replies; for a real model: npx --no kindgi providers register --preset=anthropic',
    );
  });

  test('the providers line lists real providers with their models, fallbacks marked', async () => {
    const fixtures = makeFixtures({
      providers: [
        { id: 'anthropic', region: 'unspecified', models: [{ name: 'claude-haiku-4-5' }] },
        DEV_ECHO_ROW,
      ],
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.stderr).toContain(
      'Providers          anthropic (claude-haiku-4-5) · dev-echo (fallback)\n',
    );
  });

  test('with no providers, the banner says turns fail until one is registered', async () => {
    const fixtures = makeFixtures({ providers: [] });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.stderr).toContain(
      'Providers          none — agent turns fail until one is registered: npx --no kindgi providers register --preset=anthropic',
    );
  });

  test('emits JSON summary to stdout with server + boot report', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    const parsed = JSON.parse(out.stdout) as {
      readonly apiUrl?: string;
      readonly tenantId?: string;
      readonly boot?: { readonly ok?: boolean; readonly counts?: unknown };
    };
    expect(parsed.apiUrl).toBe('http://localhost:4000');
    expect(parsed.tenantId).toBe('tenant-abc');
    expect(parsed.boot?.ok).toBe(true);
    expect(parsed.boot?.counts).toEqual({ tools: 1, guardrails: 1, agents: 1, flows: 1 });
  });

  test('dev-echo is a provider like any other — there is no flag for it', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', '--no-dev-echo', `--path=${packDir}`],
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unknown option '--no-dev-echo'");
  });

  test('an empty pack is not an error — the banner says where primitives go', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.ts'),
      "export default { pack: { id: 'my-pack', version: '0.1.0' }, discovery: { tools: 'kindgi/tools/**/*.ts', agents: 'kindgi/agents/**/*.ts' } };\n",
      'utf8',
    );
    const fixtures = makeFixtures({
      outcomes: [
        { kind: 'err', code: 'discovery-empty', message: 'Indexer discovered zero files' },
      ],
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('No primitives yet');
    expect(out.stderr).toContain('kindgi/agents/');
    expect(out.stderr).toContain('kindgi/tools/');
    expect(out.stderr).not.toContain('Indexer failed');
  });

  test('indexer failure keeps the process green + surfaces error in banner', async () => {
    const fixtures = makeFixtures({
      outcomes: [
        {
          kind: 'err',
          code: 'file-import-failed',
          message: 'SyntaxError in tools/echo.ts',
        },
      ],
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    // Exit 0 — server was up; the indexer error is a compile-loop
    // concern, not a boot failure.
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('Indexer failed');
    expect(out.stderr).toContain('file-import-failed');
    // Server still shut down cleanly.
    expect(fixtures.server.shutdownCount).toBe(1);
    // No primitive got registered.
    expect(fixtures.fetchCalls).toHaveLength(0);
    expect(fixtures.agentDefineCalls).toHaveLength(0);
  });

  test("the pack's code loads into the pack service before its index is published", async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    const staged = join(packDir, '.kindgi', 'dev', 'index.next.json');
    const packIndex = join(packDir, '.kindgi', 'dev', 'index.next.pack.json');
    expect(fixtures.packStarts).toEqual([packIndex]);
    // The pack service's copy of the index loads the bundles.
    const loaded = JSON.parse(await readFile(packIndex, 'utf8')) as {
      tools: { modulePath: string }[];
      guardrails: { checkModulePath: string }[];
    };
    expect(loaded.tools.map((t) => t.modulePath)).toEqual([
      '.kindgi/dev/dist/tools/echo/index.mjs',
    ]);
    expect(loaded.guardrails.map((g) => g.checkModulePath)).toEqual([
      '.kindgi/dev/dist/guardrails/response-not-empty/index.mjs',
    ]);
    expect(fixtures.published).toEqual([[staged, join(packDir, '.kindgi', 'dev', 'index.json')]]);
    expect(fixtures.packStops()).toBe(1);
  });

  test('pack code that fails to load is reported, and its index is not published', async () => {
    const fixtures = makeFixtures({ packBootProblems: ['my-pack.echo: Unexpected token'] });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('pack-service-boot-failed');
    expect(out.stderr).toContain('my-pack.echo: Unexpected token');
    expect(fixtures.published).toEqual([]);
  });

  test('api-server boot failure → exit 1 with message', async () => {
    const fixtures = makeFixtures({ startFails: true });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("couldn't start the Kindgi runtime");
    expect(out.stderr).toContain('mock start failure');
  });

  // Removed: 'tool POST returning 409 counts as already-registered success'.
  // Since the disk-binding switch, every primitive is served from
  // disk and the CLI never POSTs them — there's no 409 path to test.
  // The fixture's `toolStatus: 409` option is unused.
});

describe('kindgi dev — watch flow', () => {
  test('boots watcher, fires re-index on onChange, closes on abort signal', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({
      outcomes: [defaultHappyOutcome(), defaultHappyOutcome()],
    });

    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });

    // Wait for boot to reach the watch stage (condition-based, not a fixed
    // sleep — boot time varies with machine load).
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2));

    // One boot-time index run.
    expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(1);
    // Watch registered with the correct dir.
    expect(fixtures.captureWatchCalls[0]?.packDir).toBe(packDir);

    // Fire a change — background re-index should happen.
    fixtures.triggerChange();
    await vi.waitFor(() => expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(2));

    // Abort → command completes gracefully.
    controller.abort();
    const out = await promise;
    expect(out.exitCode).toBe(0);
    expect(fixtures.watchHandle.closeCount).toBe(2);
    expect(fixtures.server.shutdownCount).toBe(1);
  });

  test('watch tick after indexer failure keeps the server up + records lastWatch error', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({
      outcomes: [
        defaultHappyOutcome(),
        {
          kind: 'err',
          code: 'ambiguous-kind',
          message: 'tools/broken.ts default export does not match a primitive',
          filePath: 'tools/broken.ts',
        },
      ],
    });
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2));
    fixtures.triggerChange();
    await vi.waitFor(() => expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    const out = await promise;
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      readonly watchTicks?: number;
      readonly lastWatch?: { readonly ok?: boolean; readonly indexerError?: unknown };
    };
    expect(parsed.watchTicks).toBeGreaterThanOrEqual(1);
    expect(parsed.lastWatch?.ok).toBe(false);
    expect(parsed.lastWatch?.indexerError).toMatchObject({
      code: 'ambiguous-kind',
      filePath: 'tools/broken.ts',
    });
    // Server still up + then shut down.
    expect(fixtures.server.shutdownCount).toBe(1);
  });

  test('abort mid-re-index drains the in-flight tick before shutting the server down', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures();
    let releaseTick: (() => void) | undefined;
    let shutdownCountWhenTickFinished: number | undefined;
    const runIndexer = fixtures.runners.runIndexer;
    const devRunners: DevRunners = {
      ...fixtures.runners,
      runIndexer: async (dir) => {
        // Boot-time index runs normally; the watch tick blocks until released.
        if (fixtures.captureIndexerCalls.length === 0) return runIndexer(dir);
        const gate = new Promise<void>((resolve) => {
          releaseTick = resolve;
        });
        const outcome = await runIndexer(dir);
        await gate;
        shutdownCountWhenTickFinished = fixtures.server.shutdownCount;
        return outcome;
      },
    };
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal, devRunners }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2));
    fixtures.triggerChange();
    await vi.waitFor(() => expect(releaseTick).toBeDefined());

    controller.abort();
    // Shutdown must wait for the tick: give it a chance to (wrongly) proceed.
    await new Promise((r) => setTimeout(r, 20));
    expect(fixtures.server.shutdownCount).toBe(0);

    releaseTick?.();
    const out = await promise;
    expect(out.exitCode).toBe(0);
    expect(shutdownCountWhenTickFinished).toBe(0);
    expect(fixtures.server.shutdownCount).toBe(1);
    const parsed = JSON.parse(out.stdout) as { readonly lastWatch?: { readonly ok?: boolean } };
    expect(parsed.lastWatch?.ok).toBe(true);
  });

  test('pre-aborted stopSignal shuts down immediately without a watch tick', async () => {
    const controller = new AbortController();
    controller.abort();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    // Watch was still set up (we don't skip watch setup based on
    // pre-aborted signal — the caller passed --watch by default).
    // Two watchers: primitive files added or removed, and the env files.
    expect(fixtures.captureWatchCalls).toHaveLength(2);
    expect(fixtures.watchHandle.closeCount).toBe(2);
    expect(fixtures.server.shutdownCount).toBe(1);
  });
});

describe("kindgi dev — the pack service's front across boots", () => {
  test('the saved port and token go back to the pack service; .kindgirc.json is 0600', async () => {
    const token = 'a'.repeat(40);
    await writeFile(
      join(packDir, '.kindgirc.json'),
      JSON.stringify({
        token: 'kgi_bt_test-token',
        packServicePort: 4242,
        packServiceToken: token,
      }),
    );
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'createPackService');
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ port: 4242, token });
    const saved = JSON.parse(await readFile(join(packDir, '.kindgirc.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // The fixture's front: its port and token, for the next boot.
    expect(saved).toMatchObject({ packServicePort: 1, packServiceToken: 'fake-token' });
    expect((await stat(join(packDir, '.kindgirc.json'))).mode & 0o777).toBe(0o600);
  });

  test('a saved token that is too short is not reused', async () => {
    await writeFile(
      join(packDir, '.kindgirc.json'),
      JSON.stringify({ packServicePort: 4242, packServiceToken: 'short' }),
    );
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'createPackService');
    await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(spy.mock.calls[0]?.[0]?.token).toBeUndefined();
    expect(spy.mock.calls[0]?.[0]?.port).toBe(4242);
  });
});

describe('kindgi dev — the shared services and --reset', () => {
  /** The fixture's runners, with the bundled services started (no KINDGI_DATABASE_URL). */
  function withServices() {
    const fixtures = makeFixtures();
    const calls: { recreate: boolean }[] = [];
    const runners = {
      ...fixtures.runners,
      startServices: async (options: { readonly recreate: boolean }) => {
        calls.push({ ...options });
        return {
          kind: 'ok' as const,
          handle: {
            databaseUrl: 'postgres://kindgi@127.0.0.1:5432/kindgi',
            services: ['postgres'],
          },
        };
      },
    };
    return { fixtures: { ...fixtures, runners }, calls };
  }

  test('the shared Postgres is reused as it is, unless --recreate-services', async () => {
    const reuse = withServices();
    const first = await runCli({
      ...baseInputs(reuse.fixtures),
      env: {},
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(first.exitCode).toBe(0);
    expect(reuse.calls).toEqual([{ recreate: false }]);

    const recreate = withServices();
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let second: Awaited<ReturnType<typeof runCli>>;
    try {
      second = await runCli({
        ...baseInputs(recreate.fixtures),
        env: {},
        argv: ['dev', '--no-watch', '--recreate-services', `--path=${packDir}`],
      });
    } finally {
      stderr.mockRestore();
    }
    expect(second.exitCode).toBe(0);
    expect(recreate.calls).toEqual([{ recreate: true }]);
    expect(writes.join('')).toContain('--recreate-services: the shared Postgres may be recreated');
  });

  test('--reset starts this pack fresh (a new tenant and token) and leaves the services alone', async () => {
    await writeFile(
      join(packDir, '.kindgirc.json'),
      JSON.stringify({ token: 'kgi_bt_old', tenantId: 'old-tenant', userId: 'old-user' }),
    );
    const { fixtures, calls } = withServices();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      env: {},
      argv: ['dev', '--no-watch', '--reset', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    const opts = spy.mock.calls[0]?.[0];
    expect(opts?.tenantId).not.toBe('old-tenant');
    expect(opts?.token).not.toBe('kgi_bt_old');
    expect(opts?.userId).not.toBe('old-user');
    // Started as on any boot: reused, never recreated or removed.
    expect(calls).toEqual([{ recreate: false }]);
  });
});

describe('kindgi dev — flag precedence', () => {
  test('--database-url flag beats KINDGI_DATABASE_URL env', async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    await runCli({
      ...baseInputs(fixtures),
      env: { KINDGI_DATABASE_URL: 'postgres://from-env/db' },
      argv: ['dev', '--no-watch', '--database-url=postgres://from-flag/db', `--path=${packDir}`],
    });
    const call = spy.mock.calls[0]?.[0];
    expect(call?.databaseUrl).toBe('postgres://from-flag/db');
  });

  test("the next boot gets the previous boot's tenant, token and user back", async () => {
    const first = makeFixtures();
    await runCli({ ...baseInputs(first), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    const rc = JSON.parse(await readFile(join(packDir, '.kindgirc.json'), 'utf8'));
    expect(rc).toMatchObject({
      tenantId: 'tenant-abc',
      token: 'kgi_bt_test-token',
      userId: 'user-abc',
    });

    const second = makeFixtures();
    const spy = vi.spyOn(second.runners, 'startApiServer');
    await runCli({ ...baseInputs(second), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-abc',
      token: 'kgi_bt_test-token',
      userId: 'user-abc',
    });
  });

  test('--dev-token alone keeps the previous tenant and user', async () => {
    const first = makeFixtures();
    await runCli({ ...baseInputs(first), argv: ['dev', '--no-watch', `--path=${packDir}`] });

    const second = makeFixtures();
    const spy = vi.spyOn(second.runners, 'startApiServer');
    await runCli({
      ...baseInputs(second),
      argv: ['dev', '--no-watch', '--dev-token=kgi_bt_pinned', `--path=${packDir}`],
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-abc',
      token: 'kgi_bt_pinned',
      userId: 'user-abc',
    });
  });

  test("--tenant for another tenant keeps the previous token, not the previous tenant's user", async () => {
    const first = makeFixtures();
    await runCli({ ...baseInputs(first), argv: ['dev', '--no-watch', `--path=${packDir}`] });

    const second = makeFixtures();
    const spy = vi.spyOn(second.runners, 'startApiServer');
    await runCli({
      ...baseInputs(second),
      argv: ['dev', '--no-watch', '--tenant=other-tenant', `--path=${packDir}`],
    });
    const call = spy.mock.calls[0]?.[0];
    expect(call).toMatchObject({ tenantId: 'other-tenant', token: 'kgi_bt_test-token' });
    // A user of its own, made for this tenant: not the previous tenant's (user-abc).
    expect(call?.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.userId).not.toBe('user-abc');
  });

  test('--tenant + --dev-token seed the api-server call', async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    await runCli({
      ...baseInputs(fixtures),
      argv: [
        'dev',
        '--no-watch',
        '--tenant=pinned-tenant',
        '--dev-token=kgi_bt_pinned',
        `--path=${packDir}`,
      ],
    });
    const call = spy.mock.calls[0]?.[0];
    expect(call?.tenantId).toBe('pinned-tenant');
    expect(call?.token).toBe('kgi_bt_pinned');
  });

  test('--port picks the port on the api-server call', async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--port=4500', '--no-watch', `--path=${packDir}`],
    });
    const call = spy.mock.calls[0]?.[0];
    expect(call?.port).toBe(4500);
  });
});
