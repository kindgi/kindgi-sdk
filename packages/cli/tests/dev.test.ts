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

import type { EnsureOutcome, ProjectDatabases } from '../src/dev/project-database.js';
import type { DevProject, ProjectOutcome } from '../src/dev/project.js';
import type {
  DevRunners,
  ExternalPackage,
  IndexResult,
  PackBuild,
  RunningApiServer,
  StartServicesResult,
  WatchHandle,
} from '../src/dev/runners.js';
import { RuntimeStartStopped } from '../src/dev/runtime-container.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';

/** vi.waitFor's own default (1 s) is too short on a loaded machine; a passing wait returns as soon as it holds. */
const WAIT = { timeout: 15_000 } as const;

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
  /** A code change: the bundler reports a rebuild (default: an empty one). */
  triggerChange: (build?: PackBuild) => void;
  /** An env-file change (the second watcher). */
  triggerEnvChange: () => void;
  /** A watch failed, as both `watchPack` watchers hear it. */
  triggerWatchFailure: (error: Error) => void;
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
  /** How often the pack service was told it's closing (`beginClose`). */
  readonly packBeginCloses: () => number;
  /** What the stop took down, in order: `runtime: stopping` / `runtime: gone`, `watcher`, `pack service`. */
  readonly stopOrder: string[];
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
    /** What the boot build loads from `node_modules` (default: not reported). */
    readonly externals?: readonly ExternalPackage[];
    /** The runtime serves the console (`/console/`), as the runtime image does. */
    readonly consoleMounted?: boolean;
    /** Disposing the builder fails (a shutdown step that throws). */
    readonly disposeFails?: boolean;
    /** Stopping the runtime fails at once. */
    readonly shutdownFails?: boolean;
  } = {},
): Fixtures {
  const pythonChecks: (readonly string[])[] = [];
  const stopOrder: string[] = [];
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
    ...(opts.consoleMounted === true && { consoleMounted: true }),
    shutdownCount: 0,
    shutdown: async () => {
      server.shutdownCount += 1;
      // As `docker stop`: under way at once, done a while later.
      stopOrder.push('runtime: stopping');
      if (opts.shutdownFails === true) throw new Error('docker stop failed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      stopOrder.push('runtime: gone');
    },
  };

  const captureIndexerCalls: string[] = [];
  const indexOutcomes = outcomes;

  const captureWatchCalls: { packDir: string; debounceMs?: number }[] = [];
  const onChangeRefs: (() => void)[] = [];
  const watchFailedRefs: ((error: unknown) => void)[] = [];
  let rebuildRef: ((build: PackBuild) => void) | undefined;
  const watchHandle: FakeWatchHandle = {
    closeCount: 0,
    close: async () => {
      watchHandle.closeCount += 1;
      stopOrder.push('watcher');
    },
  };

  const packStarts: string[] = [];
  const published: (readonly [string, string])[] = [];
  let packStops = 0;
  let packBeginCloses = 0;
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
          stopOrder.push('pack service');
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
        beginClose: () => {
          packBeginCloses += 1;
        },
      };
    },
    createPackBuilder: (builderOpts) => {
      builderCodes.push(builderOpts.code);
      return {
        build: async () => ({
          kind: 'ok',
          bundleMap: FIXTURE_BUNDLES,
          ...(opts.externals !== undefined && { externals: opts.externals }),
        }),
        watch: async (onBuild) => {
          rebuildRef = onBuild;
        },
        syncEntries: async () => false,
        dispose: async () => {
          if (opts.disposeFails === true) throw new Error('dispose failed');
        },
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
      if (watchOpts?.onWatchFailed !== undefined) watchFailedRefs.push(watchOpts.onWatchFailed);
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
    triggerChange: (build) => rebuildRef?.(build ?? { kind: 'ok', bundleMap: {} }),
    triggerEnvChange: () => onChangeRefs[1]?.(),
    triggerWatchFailure: (error) => {
      for (const failed of watchFailedRefs) failed(error);
    },
    agentDefineCalls: [],
    guardrailAuthorCalls: [],
    flowDefineCalls: [],
    providers: [...(opts.providers ?? [DEV_ECHO_ROW])],
    fetchCalls: [],
    packStarts,
    published,
    packStops: () => packStops,
    packBeginCloses: () => packBeginCloses,
    stopOrder,
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
      list: vi.fn(async () => ({ data: [...fixtures.providers], hasMore: false })),
      register: vi.fn(async (input: { readonly metadata: unknown }) => {
        (fixtures.providers as unknown[]).push(input.metadata);
        return {};
      }),
      unregister: vi.fn(async (id: string) => {
        const all = fixtures.providers as { readonly id: string }[];
        all.splice(
          all.findIndex((p) => p.id === id),
          1,
        );
        return {};
      }),
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

/** Collect what `kindgi dev` writes live to stderr; `restore` puts stderr back. */
function captureStderr(): { readonly writes: string[]; restore(): void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
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
    expect(out.stderr).toContain("couldn't start the bundled one: start-services runner not wired");
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

  test('exports: the key file when KINDGI_EXPORT_SIGNING_KEY_PATH is set; a missing one refuses', async () => {
    const keyPath = join(packDir, 'export-signing.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_EXPORT_SIGNING_KEY_PATH: keyPath },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    // The key file is handed to the runtime (mounted): its key id holds across restarts.
    expect(spy.mock.calls[0]?.[0]?.exportSigningKeyPath).toBe(keyPath);
    const missing = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_EXPORT_SIGNING_KEY_PATH: join(packDir, 'no.pem') },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('KINDGI_EXPORT_SIGNING_KEY_PATH must be the absolute path');
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

  test('[[tool.kindgi.providers]] in pyproject.toml are registered on boot', async () => {
    await pythonPack(
      '\n[[tool.kindgi.providers]]\npreset = "gemini"\nproject = "acme-gcp"\nmodels = ["gemini-3.8-flash"]\nmaxOutputTokens = 16384\n',
    );
    const fixtures = makeFixtures();
    const { writes, restore } = captureStderr();
    try {
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(0);
    } finally {
      restore();
    }
    expect(writes.join('')).toContain('Providers from pyproject.toml:\n    ✓ gemini: registered\n');
    expect(fixtures.providers).toContainEqual(
      expect.objectContaining({
        id: 'gemini',
        models: [expect.objectContaining({ name: 'gemini-3.8-flash', maxOutputTokens: 16384 })],
      }),
    );
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
      'Providers          dev-echo (fallback) — canned replies; for a real model: set an LLM provider key, then npx --no kindgi providers register --preset=<anthropic|gemini-api|groq|openai|openrouter>',
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

  test('providers the config declares are registered on boot, and left alone on the next', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.ts'),
      "export default { pack: { id: 'my-pack', version: '0.1.0' }, providers: [{ preset: 'anthropic' }, { preset: 'gemini', project: 'acme-gcp', models: ['gemini-3.5-flash-lite'] }] };\n",
      'utf8',
    );
    const fixtures = makeFixtures();
    const boot = async (): Promise<string> => {
      const { writes, restore } = captureStderr();
      try {
        const out = await runCli({
          ...baseInputs(fixtures),
          argv: ['dev', '--no-watch', `--path=${packDir}`],
        });
        expect(out.exitCode).toBe(0);
        return writes.join('') + out.stderr;
      } finally {
        restore();
      }
    };
    const first = await boot();
    expect(first).toContain('Providers from kindgi.config.ts:\n');
    expect(first).toContain('  ✓ gemini: registered\n');
    // Its key isn't in the env files: one line, and the boot goes on.
    expect(first).toContain(
      '  ⚠ anthropic: not registered: ANTHROPIC_API_KEY is not in .env, .env.local. Set it (npx --no kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant), then restart kindgi dev',
    );
    expect(first).toContain(
      'Providers          dev-echo (fallback) · gemini (gemini-3.5-flash-lite)\n',
    );
    const record = JSON.parse(
      await readFile(join(packDir, '.kindgi', 'dev', 'providers.json'), 'utf8'),
    ) as { readonly runtimes: Record<string, Record<string, unknown>> };
    expect(Object.keys(record.runtimes)).toEqual(['localhost:5432/db tenant tenant-abc']);
    expect(Object.keys(record.runtimes['localhost:5432/db tenant tenant-abc'] ?? {})).toEqual([
      'gemini',
    ]);

    await writeFile(join(packDir, '.env'), 'ANTHROPIC_API_KEY=sk-test\n');
    const second = await boot();
    expect(second).toContain('  · gemini: unchanged\n');
    expect(second).toContain('  ✓ anthropic: registered\n');
  });

  test('a malformed provider in the config stops the boot before anything starts', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.ts'),
      "export default { pack: { id: 'my-pack', version: '0.1.0' }, providers: [{ preset: 'anthropic', model: 'claude-haiku-4-5' }] };\n",
      'utf8',
    );
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'kindgi dev: `providers` in kindgi.config.ts: entry 1: a preset takes',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  test('with no providers, the banner says turns fail until one is registered', async () => {
    const fixtures = makeFixtures({ providers: [] });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.stderr).toContain(
      'Providers          none — agent turns fail until one is registered: set an LLM provider key, then npx --no kindgi providers register --preset=<anthropic|gemini-api|groq|openai|openrouter>',
    );
  });

  test('--json: a JSON summary on stdout with server + boot report', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
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

  test('without --json or --raw, stdout stays empty: the output is for people', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--no-watch: single boot + register cycle complete.');
    const raw = await runCli({
      ...baseInputs(makeFixtures()),
      argv: ['dev', '--no-watch', '--raw', `--path=${packDir}`],
    });
    expect(JSON.parse(raw.stdout)).toMatchObject({ boot: { ok: true } });
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

describe('kindgi dev — the PyPI CLI (kindgi-cli)', () => {
  test('a TypeScript pack is refused before anything starts, naming the npm CLI', async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const out = await runCli({
      ...baseInputs(fixtures),
      env: { ...baseInputs(fixtures).env, KINDGI_CLI_INSTALL: 'pypi' },
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('This kindgi is the PyPI build (kindgi-cli), for Python packs');
    expect(out.stderr).toContain('npm install --save-dev @kindgi/cli');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('kindgi dev — a stop before the runtime serves (T176)', () => {
  test('Ctrl+C while it waits for the runtime: it stops at once, exit 130, not an error', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures();
    const seen: (AbortSignal | undefined)[] = [];
    const runners: DevRunners = {
      ...fixtures.runners,
      startApiServer: async (opts) => {
        seen.push(opts.signal);
        // The runtime never serves: the wait ends only on the stop.
        await new Promise<void>((resolve) =>
          opts.signal?.addEventListener('abort', () => resolve()),
        );
        throw new RuntimeStartStopped();
      },
    };
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal, devRunners: runners }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1), WAIT);
    expect(seen[0]).toBe(controller.signal);
    controller.abort();
    const out = await promise;
    expect(out.exitCode).toBe(130);
    expect(out.stderr).toContain('kindgi dev stopped before the Kindgi runtime served.');
    expect(out.stderr).not.toContain("couldn't start the Kindgi runtime");
  });
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
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);

    // One boot-time index run.
    expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(1);
    // Watch registered with the correct dir.
    expect(fixtures.captureWatchCalls[0]?.packDir).toBe(packDir);

    // Fire a change — background re-index should happen.
    fixtures.triggerChange();
    await vi.waitFor(
      () => expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );

    // Abort → command completes gracefully.
    controller.abort();
    // The pack service is told it's closing the moment the stop arrives,
    // before anything is awaited: a child that dies now isn't restarted.
    expect(fixtures.packBeginCloses()).toBe(1);
    const out = await promise;
    expect(out.exitCode).toBe(0);
    expect(fixtures.watchHandle.closeCount).toBe(2);
    expect(fixtures.server.shutdownCount).toBe(1);
  });

  test('the watchers close while the runtime stops; a change seen while stopping starts nothing', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ outcomes: [defaultHappyOutcome()] });
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    const indexed = fixtures.captureIndexerCalls.length;
    controller.abort();
    // The watchers are still open while the runtime shuts down: what they
    // report now is ignored.
    fixtures.triggerChange();
    fixtures.triggerEnvChange();
    const out = await promise;
    expect(out.exitCode).toBe(0);
    expect(fixtures.captureIndexerCalls).toHaveLength(indexed);
    // Closing a recursive watcher holds the loop for a second or more on
    // macOS: it happens while the runtime's container stops, not before.
    expect(fixtures.stopOrder).toEqual([
      'runtime: stopping',
      'watcher',
      'watcher',
      'runtime: gone',
      'pack service',
    ]);
  });

  test('a failed file watch is said once, whichever watchers hear it', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ outcomes: [defaultHappyOutcome()] });
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      fixtures.triggerWatchFailure(new Error('the watch of /pack ended'));
      fixtures.triggerWatchFailure(new Error('too many open files'));
      const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(lines.match(/file watch failed/g)).toHaveLength(1);
      expect(lines).toContain(
        '⚠ file watch failed (the watch of /pack ended): changes are picked up by the once-a-second scan',
      );
    } finally {
      stderr.mockRestore();
    }
    controller.abort();
    expect((await promise).exitCode).toBe(0);
  });

  test("a runtime that won't stop still has the watchers and the pack service closed", async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ outcomes: [defaultHappyOutcome()], shutdownFails: true });
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    controller.abort();
    const out = await promise;
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('docker stop failed');
    expect(fixtures.stopOrder).toEqual(['runtime: stopping', 'watcher', 'watcher', 'pack service']);
  });

  test('a shutdown step that fails still shuts the runtime and the pack service down', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ outcomes: [defaultHappyOutcome()], disposeFails: true });
    const promise = runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    controller.abort();
    const out = await promise;
    expect(out.exitCode).not.toBe(0);
    // The runtime (its container) and the pack service went down anyway.
    expect(fixtures.server.shutdownCount).toBe(1);
    expect(fixtures.packStops()).toBe(1);
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
      argv: ['dev', '--json', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    fixtures.triggerChange();
    await vi.waitFor(
      () => expect(fixtures.captureIndexerCalls.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
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
      argv: ['dev', '--json', `--path=${packDir}`],
    });
    await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
    fixtures.triggerChange();
    await vi.waitFor(() => expect(releaseTick).toBeDefined(), WAIT);

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

  test('Ctrl+C prints one "stopped" line: no boot banner again, no JSON', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({
      outcomes: [
        { kind: 'err', code: 'discovery-empty', message: 'Indexer discovered zero files' },
      ],
    });
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      const promise = runCli({
        ...baseInputs(fixtures, { stopSignal: controller.signal }),
        argv: ['dev', `--path=${packDir}`],
      });
      await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
      writes.length = 0;
      controller.abort();
      out = await promise;
    } finally {
      restore();
    }
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('');
    expect(writes.join('')).toBe('  Stopping kindgi dev... stopped.\n');
    expect(fixtures.server.shutdownCount).toBe(1);
  });

  test('a line printed while stopping starts on its own line', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures();
    let releaseTick: (() => void) | undefined;
    const runIndexer = fixtures.runners.runIndexer;
    const devRunners: DevRunners = {
      ...fixtures.runners,
      runIndexer: async (dir, out, opts) => {
        if (fixtures.captureIndexerCalls.length === 0) return runIndexer(dir, out, opts);
        const outcome = await runIndexer(dir, out, opts);
        await new Promise<void>((resolve) => {
          releaseTick = resolve;
        });
        return outcome;
      },
    };
    const { writes, restore } = captureStderr();
    try {
      const promise = runCli({
        ...baseInputs(fixtures, { stopSignal: controller.signal, devRunners }),
        argv: ['dev', `--path=${packDir}`],
      });
      await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2), WAIT);
      fixtures.triggerChange();
      await vi.waitFor(() => expect(releaseTick).toBeDefined(), WAIT);
      writes.length = 0;
      controller.abort();
      await new Promise((r) => setTimeout(r, 20));
      releaseTick?.();
      await promise;
    } finally {
      restore();
    }
    const log = writes.join('');
    expect(log.startsWith('  Stopping kindgi dev...\n  ')).toBe(true);
    expect(log).toContain('✓ loaded');
    expect(log.endsWith('  kindgi dev stopped.\n')).toBe(true);
  });

  test('--json in watch mode: the summary reports an empty pack as ok, not as an indexer error', async () => {
    const controller = new AbortController();
    controller.abort();
    const fixtures = makeFixtures({
      outcomes: [
        { kind: 'err', code: 'discovery-empty', message: 'Indexer discovered zero files' },
      ],
    });
    const out = await runCli({
      ...baseInputs(fixtures, { stopSignal: controller.signal }),
      argv: ['dev', '--json', `--path=${packDir}`],
    });
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed.boot).toEqual({
      ok: true,
      empty: true,
      counts: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
      registered: 0,
      failed: [],
    });
    expect(out.stderr).toBe('');
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

describe("kindgi dev — imports a deployed pack wouldn't have", () => {
  const WARNING = 'which package.json lists only in devDependencies';
  const ms: ExternalPackage = { name: 'ms', importers: ['tools/clock/index.ts'] };
  const nanoid: ExternalPackage = { name: 'nanoid', importers: ['lib/ids.ts', 'tools/a.ts'] };
  const build = (...externals: ExternalPackage[]): PackBuild => ({
    kind: 'ok',
    bundleMap: FIXTURE_BUNDLES,
    externals,
  });
  const manifest = (deps: {
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  }): Promise<void> =>
    writeFile(join(packDir, 'package.json'), JSON.stringify({ name: 'acme-app', ...deps }), 'utf8');
  /** The live lines naming `text`, and the exit output too. */
  const linesWith = (writes: readonly string[], out: { stderr: string }, text: string) =>
    [...writes, out.stderr]
      .join('')
      .split('\n')
      .filter((line) => line.includes(text));

  test('a package in devDependencies only warns once at boot, naming the file that imports it', async () => {
    await manifest({ dependencies: { zod: '^4.0.0' }, devDependencies: { ms: '^2.1.3' } });
    const fixtures = makeFixtures({ externals: [ms, { name: 'zod', importers: ['tools/a.ts'] }] });
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', `--path=${packDir}`],
      });
    } finally {
      restore();
    }
    expect(out.exitCode).toBe(0);
    expect(linesWith(writes, out, WARNING)).toEqual([
      "    ⚠ The pack imports ms (in tools/clock/index.ts), which package.json lists only in devDependencies: a deployed pack installs production dependencies only, so it won't load there. Move it to dependencies (kindgi build refuses until then).",
    ]);
  });

  test('a package in dependencies, or in both sections, does not warn', async () => {
    await manifest({
      dependencies: { ms: '^2.1.3', nanoid: '^5.0.0' },
      devDependencies: { nanoid: '^5.0.0', vitest: '^3.0.0' },
    });
    const fixtures = makeFixtures({ externals: [ms, nanoid] });
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
      });
    } finally {
      restore();
    }
    expect(linesWith(writes, out, WARNING)).toEqual([]);
    expect(JSON.parse(out.stdout)).toMatchObject({ devOnlyImports: [] });
  });

  test('--json carries the dev-only imports with their files', async () => {
    await manifest({ devDependencies: { ms: '^2.1.3', nanoid: '^5.0.0' } });
    const fixtures = makeFixtures({ externals: [ms, nanoid] });
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
      });
    } finally {
      restore();
    }
    expect(JSON.parse(out.stdout).devOnlyImports).toEqual([ms, nanoid]);
    // Both in one warning.
    expect(linesWith(writes, out, WARNING)).toEqual([
      expect.stringContaining(
        'The pack imports ms (in tools/clock/index.ts), nanoid (in lib/ids.ts, tools/a.ts), which',
      ),
    ]);
    expect(linesWith(writes, out, WARNING)[0]).toContain("so they won't load there. Move them");
  });

  test('on a save: a new one warns, the same ones stay quiet, one moved to dependencies is reported', async () => {
    await manifest({ devDependencies: { ms: '^2.1.3', nanoid: '^5.0.0' } });
    const controller = new AbortController();
    const fixtures = makeFixtures({ externals: [ms] });
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      const promise = runCli({
        ...baseInputs(fixtures, { stopSignal: controller.signal }),
        argv: ['dev', '--json', `--path=${packDir}`],
      });
      await vi.waitFor(() => expect(fixtures.captureWatchCalls).toHaveLength(2));
      expect(linesWith(writes, { stderr: '' }, 'The pack imports ms')).toHaveLength(1);

      // A save that imports nanoid too: a warning for nanoid only.
      fixtures.triggerChange(build(ms, nanoid));
      await vi.waitFor(() => expect(fixtures.captureIndexerCalls).toHaveLength(2));
      expect(linesWith(writes, { stderr: '' }, WARNING)).toEqual([
        expect.stringContaining('The pack imports ms (in tools/clock/index.ts), which'),
        expect.stringContaining('The pack imports nanoid (in lib/ids.ts, tools/a.ts), which'),
      ]);

      // The same imports again (another save, an env-file change): nothing new.
      fixtures.triggerChange(build(ms, nanoid));
      await vi.waitFor(() => expect(fixtures.captureIndexerCalls).toHaveLength(3));
      fixtures.triggerEnvChange();
      await vi.waitFor(() => expect(fixtures.captureIndexerCalls).toHaveLength(4));
      expect(linesWith(writes, { stderr: '' }, WARNING)).toHaveLength(2);

      // ms moves to dependencies: the next refresh says so, once.
      await manifest({ dependencies: { ms: '^2.1.3' }, devDependencies: { nanoid: '^5.0.0' } });
      fixtures.triggerChange(build(ms, nanoid));
      await vi.waitFor(() => expect(fixtures.captureIndexerCalls).toHaveLength(5));
      fixtures.triggerChange(build(ms, nanoid));
      await vi.waitFor(() => expect(fixtures.captureIndexerCalls).toHaveLength(6));
      controller.abort();
      out = await promise;
    } finally {
      restore();
    }
    expect(linesWith(writes, out, WARNING)).toHaveLength(2);
    expect(linesWith(writes, out, 'no longer imports')).toEqual([
      '    ✓ The pack no longer imports ms from devDependencies only.',
    ]);
    // Where the pack stood when kindgi dev stopped.
    expect(JSON.parse(out.stdout).devOnlyImports).toEqual([nanoid]);
  });

  test("the builder gets the pack's config: a pack image bundles it, so its imports count", async () => {
    const fixtures = makeFixtures();
    const spy = vi.spyOn(fixtures.runners, 'createPackBuilder');
    await runCli({ ...baseInputs(fixtures), argv: ['dev', '--no-watch', `--path=${packDir}`] });
    expect(spy.mock.calls[0]?.[0]?.configPath).toBe(join(packDir, 'kindgi.config.ts'));
  });

  test('a Python pack is not checked', async () => {
    await rm(join(packDir, 'kindgi.config.ts'));
    await writeFile(
      join(packDir, 'pyproject.toml'),
      '[project]\nname = "my-pack"\n\n[tool.kindgi.pack]\nid = "my-pack"\nversion = "0.1.0"\n',
      'utf8',
    );
    await manifest({ devDependencies: { ms: '^2.1.3' } });
    const fixtures = makeFixtures({ externals: [ms] });
    const spy = vi.spyOn(fixtures.runners, 'createPackBuilder');
    const { writes, restore } = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
      });
    } finally {
      restore();
    }
    expect(out.exitCode).toBe(0);
    expect(spy.mock.calls[0]?.[0]?.configPath).toBeUndefined();
    expect(linesWith(writes, out, WARNING)).toEqual([]);
    expect(JSON.parse(out.stdout)).not.toHaveProperty('devOnlyImports');
  });
});

describe("kindgi dev — the runtime's pack-service warning", () => {
  const WARNING =
    "  ⚠ Pack service at http://127.0.0.1:50523 isn't answering (pack-service-unavailable: The pack service is busy or draining). The server is up; pack tools and checks fail until it answers.";

  /** Boot with a runtime that prints `WARNING`, as the runtime's boot probe does. */
  async function bootWith(outcome: IndexResult): Promise<string> {
    const fixtures = makeFixtures({ outcomes: [outcome] });
    const devRunners: DevRunners = {
      ...fixtures.runners,
      startApiServer: async (opts) => {
        opts.onLog?.('Kindgi API server listening on http://localhost:4000');
        opts.onLog?.(WARNING);
        return fixtures.server;
      },
    };
    const { writes, restore } = captureStderr();
    try {
      await runCli({
        ...baseInputs(fixtures, { devRunners }),
        argv: ['dev', '--no-watch', `--path=${packDir}`],
      });
    } finally {
      restore();
    }
    return writes.join('');
  }

  test('a pack with no primitives yet: the output says there are none yet', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.ts'),
      "export default { pack: { id: 'my-pack', version: '0.1.0' }, discovery: { tools: 'kindgi/tools/**/*.ts' } };\n",
      'utf8',
    );
    const log = await bootWith({
      kind: 'err',
      code: 'discovery-empty',
      message: 'Indexer discovered zero files',
    });
    expect(log).toContain('[runtime] Kindgi API server listening');
    expect(log).toContain('  No primitives yet — add a tool or agent under ');
    expect(log).toContain('kindgi/tools/; it registers on save.');
  });

  test('a pack with primitives whose service is down: the warning stays', async () => {
    const log = await bootWith(defaultHappyOutcome());
    expect(log).toContain(`[runtime] ${WARNING}`);
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
  function withServices(outcome?: StartServicesResult) {
    const fixtures = makeFixtures();
    const calls: { recreate: boolean }[] = [];
    const runners = {
      ...fixtures.runners,
      startServices: async (options: { readonly recreate: boolean }) => {
        calls.push({ ...options });
        return (
          outcome ?? {
            kind: 'ok' as const,
            handle: {
              databaseUrl: 'postgres://kindgi@127.0.0.1:5432/kindgi',
              services: ['postgres'],
              startedWith: 'docker compose' as const,
            },
          }
        );
      },
    };
    return { fixtures: { ...fixtures, runners }, calls };
  }

  test('the output says how Postgres started: docker compose, or plain docker without it', async () => {
    const viaCompose = withServices();
    const composeErr = captureStderr();
    try {
      const out = await runCli({
        ...baseInputs(viaCompose.fixtures),
        env: {},
        argv: ['dev', '--no-watch', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(0);
    } finally {
      composeErr.restore();
    }
    expect(composeErr.writes.join('')).toContain('✓ Postgres: started with docker compose\n');

    const viaDocker = withServices({
      kind: 'ok',
      handle: {
        databaseUrl: 'postgres://kindgi@127.0.0.1:55432/kindgi',
        services: ['postgres'],
        startedWith: 'docker',
        notes: [
          '--recreate-services needs docker compose: the existing kindgi-dev_postgres is reused as it is.',
        ],
      },
    });
    const spy = vi.spyOn(viaDocker.fixtures.runners, 'startApiServer');
    const dockerErr = captureStderr();
    try {
      const out = await runCli({
        ...baseInputs(viaDocker.fixtures),
        env: {},
        argv: ['dev', '--no-watch', '--recreate-services', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(0);
    } finally {
      dockerErr.restore();
    }
    const written = dockerErr.writes.join('');
    expect(written).toContain("✓ Postgres: started with docker (docker compose isn't available)\n");
    expect(written).toContain(
      '⚠ --recreate-services needs docker compose: the existing kindgi-dev_postgres is reused as it is.',
    );
    expect(spy.mock.calls[0]?.[0]?.databaseUrl).toBe('postgres://kindgi@127.0.0.1:55432/kindgi');
  });

  test('without docker: one error naming the options, install Docker or --database-url', async () => {
    const { fixtures } = withServices({
      kind: 'unavailable',
      reason: "Docker isn't available: spawn docker ENOENT",
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      env: {},
      argv: ['dev', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi dev needs Postgres, and couldn't start the bundled one: Docker isn't available: spawn docker ENOENT\n\nOptions:\n  1. Install Docker (Docker Desktop, or Docker Engine on Linux) and make sure it runs: kindgi dev then starts the bundled Postgres itself, with `docker compose` when it's there and plain `docker` otherwise.\n  2. Use your own Postgres (16, with pgvector): pass --database-url=<url>, or set KINDGI_DATABASE_URL.\n",
    );
  });

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

describe('kindgi dev — a database per project', () => {
  const PROJECT: DevProject = {
    name: 'acme',
    nameFrom: 'repository',
    root: '/work/acme',
    database: 'kindgi_acme',
    tenantId: '7a1c0000-0000-5000-8000-00000000aaaa',
    userId: '7a1c0000-0000-5000-8000-00000000bbbb',
  };

  /**
   * The fixture's runners with the bundled services started, their project
   * databases faked, and the project and terminal seams set.
   */
  function withProjectDatabase(
    options: {
      readonly ensure?: EnsureOutcome;
      readonly project?: ProjectOutcome;
      readonly interactive?: boolean;
      readonly answer?: boolean;
      /** The bundled Postgres's host port (it can change between boots). */
      readonly port?: number;
      /** Another boot's fixtures: the same runtime, providers and all. */
      readonly base?: ReturnType<typeof makeFixtures>;
    } = {},
  ) {
    const fixtures = options.base ?? makeFixtures();
    const calls: string[] = [];
    const resolveInputs: { packDir: string; configured: unknown }[] = [];
    const questions: string[] = [];
    const projectDatabases: ProjectDatabases = {
      urlFor: (database) => `postgres://kindgi@127.0.0.1:${options.port ?? 5432}/${database}`,
      ensure: async (project, cliVersion) => {
        calls.push(`ensure ${project.database} ${cliVersion}`);
        return options.ensure ?? { kind: 'created' };
      },
      drop: async (database) => {
        calls.push(`drop ${database}`);
        return { ok: true };
      },
      exists: async () => true,
    };
    const runners: DevRunners = {
      ...fixtures.runners,
      startServices: async () => ({
        kind: 'ok' as const,
        handle: {
          databaseUrl: `postgres://kindgi@127.0.0.1:${options.port ?? 5432}/kindgi`,
          services: ['postgres'],
          startedWith: 'docker compose' as const,
          projectDatabases,
        },
      }),
      resolveProject: async (input) => {
        resolveInputs.push({ ...input });
        return options.project ?? { kind: 'ok', project: PROJECT };
      },
      interactive: () => options.interactive ?? false,
      confirm: async (question) => {
        questions.push(question);
        return options.answer ?? false;
      },
    };
    return { fixtures: { ...fixtures, runners }, calls, resolveInputs, questions };
  }

  async function boot(
    fixtures: ReturnType<typeof withProjectDatabase>['fixtures'],
    argv: readonly string[] = [],
    env: Record<string, string> = {},
  ) {
    const spy = vi.spyOn(fixtures.runners, 'startApiServer');
    const { writes, restore } = captureStderr();
    try {
      const out = await runCli({
        ...baseInputs(fixtures),
        env,
        argv: ['dev', '--no-watch', `--path=${packDir}`, ...argv],
      });
      return { out, opts: spy.mock.calls[0]?.[0], log: writes.join('') };
    } finally {
      restore();
    }
  }

  const GEMINI_CONFIG =
    "export default { pack: { id: 'my-pack', version: '0.1.0' }, providers: [{ preset: 'gemini', project: 'acme-gcp', models: ['gemini-3.5-flash-lite'] }] };\n";
  // A provider this pack registered reads `unchanged` next boot; one it
  // doesn't know as its own reads as someone else's.
  const OWN = 'gemini (unchanged)';
  const NOT_OWN = 'not from kindgi.config.ts';

  test("the bundled Postgres on another port next boot: this pack's providers are still its own", async () => {
    await writeFile(join(packDir, 'kindgi.config.ts'), GEMINI_CONFIG, 'utf8');
    const base = makeFixtures();
    const first = await boot(withProjectDatabase({ port: 58091, base }).fixtures);
    expect(first.log).toContain('  ✓ gemini: registered\n');

    const second = await boot(
      withProjectDatabase({ port: 62374, base, ensure: { kind: 'exists' } }).fixtures,
    );
    expect(second.log).toContain(OWN);
    expect(second.log).not.toContain(NOT_OWN);
  });

  test("a 0.1.3 record (keyed on the bundled Postgres's port) is adopted: the provider is still this pack's", async () => {
    await writeFile(join(packDir, 'kindgi.config.ts'), GEMINI_CONFIG, 'utf8');
    const base = makeFixtures();
    await boot(withProjectDatabase({ base }).fixtures);
    const recordPath = join(packDir, '.kindgi', 'dev', 'providers.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      readonly runtimes: Record<string, unknown>;
    };
    const tenant = 'tenant-abc'; // the runtime's (the fixtures')
    const entries = record.runtimes[`bundled kindgi_acme tenant ${tenant}`];
    expect(entries).toBeDefined();
    // As 0.1.3 wrote it.
    await writeFile(
      recordPath,
      JSON.stringify({
        v: 1,
        runtimes: { [`127.0.0.1:58091/kindgi_acme tenant ${tenant}`]: entries },
      }),
    );

    const next = await boot(withProjectDatabase({ base, ensure: { kind: 'exists' } }).fixtures);
    expect(next.log).toContain(OWN);
    expect(next.log).not.toContain(NOT_OWN);
    expect(Object.keys(JSON.parse(await readFile(recordPath, 'utf8')).runtimes)).toEqual([
      `bundled kindgi_acme tenant ${tenant}`,
    ]);
  });

  test("the runtime gets the project's database and its dev tenant and user", async () => {
    const { fixtures, calls } = withProjectDatabase();
    const { out, opts, log } = await boot(fixtures);
    expect(out.exitCode).toBe(0);
    expect(opts?.databaseUrl).toBe('postgres://kindgi@127.0.0.1:5432/kindgi_acme');
    expect(opts?.tenantId).toBe(PROJECT.tenantId);
    expect(opts?.userId).toBe(PROJECT.userId);
    expect(calls).toEqual([`ensure kindgi_acme ${CLI_VERSION}`]);
    expect(log).toContain(
      "✓ Project: acme (the git repository's name; set `project` in the Kindgi config to name it)\n",
    );
    expect(log).toContain(
      '✓ Database: kindgi_acme (created) in the bundled Postgres; to use your own: --database-url\n',
    );
    expect(log).toContain('  Project    acme · database kindgi_acme');
  });

  test('a restart keeps the tenant and token; `project` in the config reaches the resolver', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.ts'),
      "export default { pack: { id: 'my-pack', version: '0.1.0' }, project: 'acme-app' };\n",
      'utf8',
    );
    const first = withProjectDatabase();
    await boot(first.fixtures);
    expect(first.resolveInputs[0]).toEqual({ packDir, configured: 'acme-app' });
    const persisted = JSON.parse(await readFile(join(packDir, '.kindgirc.json'), 'utf8')) as {
      token: string;
    };
    const second = withProjectDatabase({ ensure: { kind: 'exists' } });
    const two = await boot(second.fixtures);
    expect(two.out.exitCode).toBe(0);
    expect(two.opts?.tenantId).toBe(PROJECT.tenantId);
    expect(two.opts?.token).toBe(persisted.token);
    expect(two.log).toContain('✓ Database: kindgi_acme in the bundled Postgres');
    expect(two.log).not.toContain('(created)');
  });

  test("the first boot after the shared `kindgi` database says, once, that this project's data starts fresh", async () => {
    await writeFile(
      join(packDir, '.kindgirc.json'),
      JSON.stringify({ token: 'kgi_bt_old', tenantId: 'shared-tenant', userId: 'shared-user' }),
    );
    const created = withProjectDatabase();
    const { opts, log } = await boot(created.fixtures);
    expect(opts?.tenantId).toBe(PROJECT.tenantId);
    expect(log).toContain(
      '  This project now has its own database, kindgi_acme. The old shared `kindgi` database is left as it is: projects on an older Kindgi still use it. Providers and reviewers are set up once per project: set them up here again.',
    );
    const again = withProjectDatabase({ ensure: { kind: 'exists' } });
    expect((await boot(again.fixtures)).log).not.toContain('now has its own database');
  });

  test('another folder owns a database of the same name: refused, naming the way out', async () => {
    const message =
      'the database kindgi_acme belongs to /elsewhere/acme, another folder whose project is also named "acme". Give this one its own name: set `project` in kindgi.config.ts (or `project` under [tool.kindgi] in pyproject.toml), or pass --database-url.';
    const { fixtures } = withProjectDatabase({ ensure: { kind: 'refused', message } });
    const { out, opts } = await boot(fixtures);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(`kindgi dev: ${message}\n`);
    expect(opts).toBeUndefined();
  });

  test('a moved project adopts its database, and says from where', async () => {
    const { fixtures } = withProjectDatabase({
      ensure: { kind: 'adopted', previousRoot: '/old/acme' },
    });
    const { out, log } = await boot(fixtures);
    expect(out.exitCode).toBe(0);
    expect(log).toContain(
      "  kindgi_acme was /old/acme's, a folder that's gone: it's this folder's now",
    );
  });

  test('an invalid `project` stops the boot', async () => {
    const message =
      '`project` in the Kindgi config must be a name with at least one letter or digit, e.g. "acme-app".';
    const { fixtures, calls } = withProjectDatabase({ project: { kind: 'invalid', message } });
    const { out } = await boot(fixtures);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(`kindgi dev: ${message}\n`);
    expect(calls).toEqual([]);
  });

  test('a worktree says so on the project line', async () => {
    const { fixtures } = withProjectDatabase({
      project: {
        kind: 'ok',
        project: { ...PROJECT, worktree: 'acme-login', database: 'kindgi_acme__acme_login' },
      },
    });
    const { opts, log } = await boot(fixtures);
    expect(opts?.databaseUrl).toBe('postgres://kindgi@127.0.0.1:5432/kindgi_acme__acme_login');
    expect(log).toContain('; git worktree acme-login)\n');
  });

  describe('--reset', () => {
    test('with no terminal to ask on and no --yes: nothing is dropped', async () => {
      const { fixtures, calls, questions } = withProjectDatabase({ interactive: false });
      const { out, opts } = await boot(fixtures, ['--reset']);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toBe(
        "kindgi dev --reset would drop kindgi_acme, and there's no terminal to ask on. Run it with --yes to drop it.\n",
      );
      expect(calls).toEqual([]);
      expect(questions).toEqual([]);
      expect(opts).toBeUndefined();
    });

    test('asked and declined: nothing is dropped', async () => {
      const { fixtures, calls, questions } = withProjectDatabase({
        interactive: true,
        answer: false,
      });
      const { out } = await boot(fixtures, ['--reset']);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toBe('kindgi dev --reset: nothing dropped.\n');
      expect(questions).toEqual([
        "Reset project acme? This drops the database kindgi_acme: every pack's dev data in it (runs, approvals, providers, secrets stored there). [y/N] ",
      ]);
      expect(calls).toEqual([]);
    });

    test('asked and confirmed: dropped, made again, and a new token', async () => {
      await writeFile(
        join(packDir, '.kindgirc.json'),
        JSON.stringify({ token: 'kgi_bt_old', tenantId: PROJECT.tenantId, userId: PROJECT.userId }),
      );
      const { fixtures, calls } = withProjectDatabase({ interactive: true, answer: true });
      const { out, opts, log } = await boot(fixtures, ['--reset']);
      expect(out.exitCode).toBe(0);
      expect(calls).toEqual(['drop kindgi_acme', `ensure kindgi_acme ${CLI_VERSION}`]);
      expect(log).toContain('🧹 --reset: dropped kindgi_acme\n');
      expect(log).not.toContain('now has its own database');
      // The project's tenant stays the project's; the token is new.
      expect(opts?.tenantId).toBe(PROJECT.tenantId);
      expect(opts?.token).not.toBe('kgi_bt_old');
    });

    test('--yes drops it without asking, with no terminal', async () => {
      const { fixtures, calls, questions } = withProjectDatabase({ interactive: false });
      const { out } = await boot(fixtures, ['--reset', '--yes']);
      expect(out.exitCode).toBe(0);
      expect(questions).toEqual([]);
      expect(calls[0]).toBe('drop kindgi_acme');
    });

    test('a database named with --database-url is never dropped', async () => {
      const { fixtures, calls } = withProjectDatabase({ interactive: true, answer: true });
      const { out, opts, log } = await boot(fixtures, [
        '--reset',
        '--yes',
        '--database-url=postgres://me@db.internal/mine',
      ]);
      expect(out.exitCode).toBe(0);
      expect(calls).toEqual([]);
      expect(opts?.databaseUrl).toBe('postgres://me@db.internal/mine');
      expect(log).toContain('  --reset: the database you gave is left as it is (never dropped)\n');
    });
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

describe("kindgi dev — the runtime's port (T218)", () => {
  /** The fixture's runners, with `taken` ports in use and the bundled Postgres counted. */
  function withPorts(taken: readonly number[]) {
    const fixtures = makeFixtures();
    const asked: { packDir: string; port: number }[] = [];
    const started: number[] = [];
    let servicesStarted = 0;
    const runners: DevRunners = {
      ...fixtures.runners,
      runtimePortInUse: async (input) => {
        asked.push({ ...input });
        return taken.includes(input.port);
      },
      startApiServer: async (opts) => {
        started.push(opts.port);
        return fixtures.server;
      },
      startServices: async () => {
        servicesStarted += 1;
        return {
          kind: 'ok',
          handle: {
            databaseUrl: 'postgres://kindgi@127.0.0.1:5432/kindgi',
            services: ['postgres'],
            startedWith: 'docker compose',
          },
        };
      },
    };
    return {
      fixtures: { ...fixtures, runners },
      asked,
      started,
      servicesStarted: () => servicesStarted,
    };
  }

  async function dev(fixtures: Fixtures, flags: readonly string[]) {
    const err = captureStderr();
    try {
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', `--path=${packDir}`, ...flags],
      });
      return { out, live: err.writes.join('') };
    } finally {
      err.restore();
    }
  }

  test('free: the runtime starts on 4000, and nothing is said', async () => {
    const ports = withPorts([]);
    const { out, live } = await dev(ports.fixtures, []);
    expect(out.exitCode).toBe(0);
    expect(ports.asked).toEqual([{ packDir, port: 4000 }]);
    expect(ports.started).toEqual([4000]);
    expect(live).not.toContain('is in use');
  });

  test('4000 taken (another kindgi dev): the next free port, named on the way', async () => {
    const ports = withPorts([4000, 4001]);
    const { out, live } = await dev(ports.fixtures, []);
    expect(out.exitCode).toBe(0);
    expect(ports.started).toEqual([4002]);
    expect(live).toContain('⚠ port 4000 is in use (another kindgi dev?): using 4002\n');
  });

  test('a --port that is taken is refused before Postgres starts or the pack is bundled', async () => {
    const ports = withPorts([4301]);
    const out = await runCli({
      ...baseInputs(ports.fixtures),
      env: {},
      argv: ['dev', '--no-watch', `--path=${packDir}`, '--port=4301'],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi dev: port 4301 is in use. Pick another with --port, or stop what's using it.\n",
    );
    expect(ports.servicesStarted()).toBe(0);
    expect(ports.fixtures.captureIndexerCalls).toEqual([]);
    expect(ports.started).toEqual([]);
  });

  test('a free --port is used as given', async () => {
    const ports = withPorts([4000]);
    const { out } = await dev(ports.fixtures, ['--port=4301']);
    expect(out.exitCode).toBe(0);
    expect(ports.started).toEqual([4301]);
  });

  test('every port from 4000 on taken: it asks for --port', async () => {
    const ports = withPorts(Array.from({ length: 200 }, (_, i) => 4000 + i));
    const { out } = await dev(ports.fixtures, []);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      'kindgi dev: ports 4000 to 4100 are all in use. Pick a free one with --port.\n',
    );
    expect(ports.started).toEqual([]);
  });

  test('--runtime-url and --port=0: no check (the runtime has its own port; 0 is any)', async () => {
    const attached = withPorts([4000]);
    const run = await dev(attached.fixtures, ['--runtime-url=http://127.0.0.1:4000']);
    expect(run.out.exitCode).toBe(0);
    expect(attached.asked).toEqual([]);

    const any = withPorts([4000]);
    expect((await dev(any.fixtures, ['--port=0'])).out.exitCode).toBe(0);
    expect(any.asked).toEqual([]);
    expect(any.started).toEqual([0]);
  });
});

describe('kindgi dev — the console (T374)', () => {
  test('the ready block leads with the console and how to sign in; the exit banner and --json name it', async () => {
    const fixtures = makeFixtures({ consoleMounted: true });
    const err = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
      });
    } finally {
      err.restore();
    }
    expect(out.exitCode).toBe(0);
    const up = err.writes.join('').split('✓ Kindgi is up')[1] ?? '';
    const consoleAt = up.indexOf(
      '    Console    http://localhost:4000/console/   (open in your browser)\n',
    );
    expect(consoleAt).toBeGreaterThan(-1);
    // First: the URL a person opens is the console's, not the API's bare address.
    expect(consoleAt).toBeLessThan(up.indexOf('    API        http://localhost:4000\n'));
    expect(up).toContain(
      '               Sign in: "Sign in as seeded user" on the sign-in page (the dev token, below)\n',
    );
    expect(out.stderr).toContain('    Console            http://localhost:4000/console/');
    expect(JSON.parse(out.stdout).consoleUrl).toBe('http://localhost:4000/console/');
  });

  test('a runtime without a console: no console lines, no consoleUrl', async () => {
    const fixtures = makeFixtures();
    const err = captureStderr();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      out = await runCli({
        ...baseInputs(fixtures),
        argv: ['dev', '--no-watch', '--json', `--path=${packDir}`],
      });
    } finally {
      err.restore();
    }
    expect(err.writes.join('')).not.toContain('Console');
    expect(out.stderr).not.toContain('Console');
    expect(JSON.parse(out.stdout).consoleUrl).toBeUndefined();
  });

  test('--open opens the console in the browser once Kindgi is up', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ consoleMounted: true });
    const opened: string[] = [];
    const err = captureStderr();
    try {
      const promise = runCli({
        ...baseInputs(fixtures, {
          stopSignal: controller.signal,
          openUrl: async (url) => {
            opened.push(url);
            return { ok: true };
          },
        }),
        argv: ['dev', '--open', `--path=${packDir}`],
      });
      await vi.waitFor(() => expect(opened).toEqual(['http://localhost:4000/console/']), WAIT);
      controller.abort();
      expect((await promise).exitCode).toBe(0);
    } finally {
      err.restore();
    }
    expect(err.writes.join('')).toContain('    Opened the console in your browser.\n');
  });

  test('--open with no browser to start: says to open the URL yourself, and keeps running', async () => {
    const controller = new AbortController();
    const fixtures = makeFixtures({ consoleMounted: true });
    const err = captureStderr();
    try {
      const promise = runCli({
        ...baseInputs(fixtures, {
          stopSignal: controller.signal,
          openUrl: async () => ({ ok: false, reason: 'xdg-open: ENOENT' }),
        }),
        argv: ['dev', '--open', `--path=${packDir}`],
      });
      await vi.waitFor(
        () => expect(err.writes.join('')).toContain("Couldn't open a browser (xdg-open: ENOENT)"),
        WAIT,
      );
      controller.abort();
      expect((await promise).exitCode).toBe(0);
    } finally {
      err.restore();
    }
  });

  test('--open with --no-watch is refused: the runtime stops as kindgi dev exits', async () => {
    const fixtures = makeFixtures({ consoleMounted: true });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['dev', '--open', '--no-watch', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Contradictory flags: --open and --no-watch');
    expect(fixtures.server.shutdownCount).toBe(0);
  });
});
