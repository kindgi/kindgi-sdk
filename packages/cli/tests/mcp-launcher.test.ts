// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `kindgi mcp-launch` — the generic subprocess wrapper.
 * Pure functions (parseLauncherArgs, parseEnvMapFlag, parseSecretRef,
 * resolveSecrets, applyHostRemap, buildChildCommand) are exercised
 * directly. The `runLauncher` glue is covered end-to-end with an
 * injected `spawn` seam so no real child processes are launched.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  applyHostRemap,
  buildChildCommand,
  parseEnvMapFlag,
  parseLauncherArgs,
  parseSecretRef,
  resolveSecrets,
  runLauncher,
} from '../src/mcp/launcher.js';

// ---------------------------------------------------------------------
// parseSecretRef
// ---------------------------------------------------------------------

describe('parseSecretRef', () => {
  test('parses tenant scope', () => {
    expect(parseSecretRef('secret:MY_KEY@local:tenant')).toEqual({
      name: 'MY_KEY',
      envName: 'local',
      scopeKind: 'tenant',
    });
  });

  test('parses project scope with id', () => {
    expect(parseSecretRef('secret:MY_KEY@prod:project:pack-a')).toEqual({
      name: 'MY_KEY',
      envName: 'prod',
      scopeKind: 'project',
      scopeId: 'pack-a',
    });
  });

  test('parses org scope with id', () => {
    expect(parseSecretRef('secret:MY_KEY@prod:org:acme')).toEqual({
      name: 'MY_KEY',
      envName: 'prod',
      scopeKind: 'org',
      scopeId: 'acme',
    });
  });

  test('rejects missing `secret:` prefix', () => {
    expect(parseSecretRef('MY_KEY@local:tenant')).toBeNull();
  });

  test('rejects tenant scope with extra id', () => {
    expect(parseSecretRef('secret:MY_KEY@local:tenant:extra')).toBeNull();
  });

  test('rejects org scope without id', () => {
    expect(parseSecretRef('secret:MY_KEY@local:org')).toBeNull();
  });

  test('rejects unknown scope kind', () => {
    expect(parseSecretRef('secret:MY_KEY@local:cluster')).toBeNull();
  });

  test('rejects empty envName', () => {
    expect(parseSecretRef('secret:MY_KEY@:tenant')).toBeNull();
  });

  test('rejects empty scopeId on project scope', () => {
    expect(parseSecretRef('secret:MY_KEY@local:project:')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// parseEnvMapFlag
// ---------------------------------------------------------------------

describe('parseEnvMapFlag', () => {
  test('parses `VAR=secret:NAME@env:scope`', () => {
    expect(parseEnvMapFlag('DATABASE_URI=secret:MY_KEY@local:tenant')).toEqual({
      child: 'DATABASE_URI',
      ref: { name: 'MY_KEY', envName: 'local', scopeKind: 'tenant' },
    });
  });

  test('rejects value without `=`', () => {
    expect(parseEnvMapFlag('DATABASE_URI')).toBeNull();
  });

  test('rejects empty child var name', () => {
    expect(parseEnvMapFlag('=secret:MY_KEY@local:tenant')).toBeNull();
  });

  test('rejects malformed secret ref', () => {
    expect(parseEnvMapFlag('DATABASE_URI=not-a-secret-ref')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// parseLauncherArgs
// ---------------------------------------------------------------------

describe('parseLauncherArgs', () => {
  test('parses a complete npx invocation', () => {
    const result = parseLauncherArgs([
      '--runtime=npx',
      '--package=@modelcontextprotocol/server-github',
      '--env-map=GITHUB_TOKEN=secret:GITHUB_PAT@local:tenant',
      '--pack-dir=/some/pack',
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.args).toEqual({
      runtime: 'npx',
      package: '@modelcontextprotocol/server-github',
      envMap: [
        {
          child: 'GITHUB_TOKEN',
          ref: { name: 'GITHUB_PAT', envName: 'local', scopeKind: 'tenant' },
        },
      ],
      packDir: '/some/pack',
      passthroughArgs: [],
    });
  });

  test('parses docker with host-remap and passthrough args', () => {
    const result = parseLauncherArgs([
      '--runtime=docker',
      '--package=crystaldba/postgres-mcp',
      '--env-map=DATABASE_URI=secret:GRIEVANCE_DB_URL@local:tenant',
      '--host-remap=docker-desktop',
      '--',
      '--access-mode=restricted',
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.args.runtime).toBe('docker');
    expect(result.args.hostRemap).toBe('docker-desktop');
    expect(result.args.passthroughArgs).toEqual(['--access-mode=restricted']);
  });

  test('multiple --env-map flags accumulate', () => {
    const result = parseLauncherArgs([
      '--runtime=npx',
      '--package=some-mcp',
      '--env-map=A=secret:X@local:tenant',
      '--env-map=B=secret:Y@local:tenant',
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.args.envMap).toHaveLength(2);
    expect(result.args.envMap[0]?.child).toBe('A');
    expect(result.args.envMap[1]?.child).toBe('B');
  });

  test('rejects missing --runtime', () => {
    const result = parseLauncherArgs(['--package=some-mcp']);
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('--runtime');
  });

  test('rejects unknown --runtime', () => {
    const result = parseLauncherArgs(['--runtime=python', '--package=some-mcp']);
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('python');
  });

  test('rejects missing --package', () => {
    const result = parseLauncherArgs(['--runtime=npx']);
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('--package');
  });

  test('rejects malformed --env-map', () => {
    const result = parseLauncherArgs(['--runtime=npx', '--package=some-mcp', '--env-map=garbage']);
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('--env-map');
  });

  test('rejects unknown --host-remap', () => {
    const result = parseLauncherArgs([
      '--runtime=docker',
      '--package=some-mcp',
      '--host-remap=magic',
    ]);
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('magic');
  });
});

// ---------------------------------------------------------------------
// resolveSecrets
// ---------------------------------------------------------------------

describe('resolveSecrets', () => {
  let packDir: string;

  beforeEach(async () => {
    packDir = await mkdtemp(join(tmpdir(), 'kindgi-mcp-launcher-'));
  });

  afterEach(async () => {
    await rm(packDir, { recursive: true, force: true });
  });

  const realReadFile = async (path: string) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(path, 'utf8');
  };

  test('resolves a single secret from .env.local', async () => {
    await writeFile(
      join(packDir, '.env.local'),
      'GRIEVANCE_DB_URL=postgres://u:p@127.0.0.1:5432/bb\n',
    );
    const result = await resolveSecrets(
      [
        {
          child: 'DATABASE_URI',
          ref: { name: 'GRIEVANCE_DB_URL', envName: 'local', scopeKind: 'tenant' },
        },
      ],
      packDir,
      realReadFile,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.env).toEqual({ DATABASE_URI: 'postgres://u:p@127.0.0.1:5432/bb' });
  });

  test('resolves multiple secrets for one env — each env file read once', async () => {
    await writeFile(join(packDir, '.env.local'), 'A=1\nB=2\n');
    const readSpy = vi.fn(realReadFile);
    const result = await resolveSecrets(
      [
        { child: 'A_CHILD', ref: { name: 'A', envName: 'local', scopeKind: 'tenant' } },
        { child: 'B_CHILD', ref: { name: 'B', envName: 'local', scopeKind: 'tenant' } },
      ],
      packDir,
      readSpy,
    );
    expect(result.kind).toBe('ok');
    // `local` reads `.env` and `.env.local` — once each, for both secrets.
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  test('local: a secret in the project .env resolves; .env.local overrides it', async () => {
    await writeFile(join(packDir, '.env'), 'A=from-env\nB=from-env\n');
    await writeFile(join(packDir, '.env.local'), 'B=from-local\n');
    const result = await resolveSecrets(
      [
        { child: 'A_CHILD', ref: { name: 'A', envName: 'local', scopeKind: 'tenant' } },
        { child: 'B_CHILD', ref: { name: 'B', envName: 'local', scopeKind: 'tenant' } },
      ],
      packDir,
      realReadFile,
    );
    expect(result).toEqual({ kind: 'ok', env: { A_CHILD: 'from-env', B_CHILD: 'from-local' } });
  });

  test('local with dev.envFiles reads the configured files', async () => {
    await writeFile(join(packDir, '.env.dev'), 'A=dev\n');
    const result = await resolveSecrets(
      [{ child: 'A_CHILD', ref: { name: 'A', envName: 'local', scopeKind: 'tenant' } }],
      packDir,
      realReadFile,
      { localEnvFiles: ['.env', '.env.dev'] },
    );
    expect(result).toEqual({ kind: 'ok', env: { A_CHILD: 'dev' } });
  });

  test('KINDGI_* runtime names never resolve as MCP secrets', async () => {
    await writeFile(join(packDir, '.env'), 'KINDGI_API_TOKEN=kgi_bt_x\n');
    const result = await resolveSecrets(
      [{ child: 'T', ref: { name: 'KINDGI_API_TOKEN', envName: 'local', scopeKind: 'tenant' } }],
      packDir,
      realReadFile,
    );
    expect(result.kind).toBe('err');
  });

  test('errs when none of the env files exist', async () => {
    const result = await resolveSecrets(
      [{ child: 'X', ref: { name: 'X', envName: 'local', scopeKind: 'tenant' } }],
      packDir,
      realReadFile,
    );
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('No env files for env "local"');
    expect(result.message).toContain('.env, .env.local');
    expect(result.message).toContain('kindgi secrets set');
  });

  test('errs when secret name is not in the env file', async () => {
    await writeFile(join(packDir, '.env.local'), 'AAA=1\nBBB=2\n');
    const result = await resolveSecrets(
      [{ child: 'X', ref: { name: 'MISSING', envName: 'local', scopeKind: 'tenant' } }],
      packDir,
      realReadFile,
    );
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('MISSING');
    expect(result.message).toContain('AAA, BBB'); // available list
  });
});

// ---------------------------------------------------------------------
// applyHostRemap
// ---------------------------------------------------------------------

describe('applyHostRemap', () => {
  test('rewrites @localhost:port', () => {
    expect(applyHostRemap('postgres://u:p@localhost:5432/db', 'docker-desktop')).toBe(
      'postgres://u:p@host.docker.internal:5432/db',
    );
  });

  test('rewrites @127.0.0.1:port', () => {
    expect(applyHostRemap('postgres://u:p@127.0.0.1:5432/db', 'docker-desktop')).toBe(
      'postgres://u:p@host.docker.internal:5432/db',
    );
  });

  test('leaves non-matching hosts alone', () => {
    expect(applyHostRemap('postgres://u:p@db.example.com:5432/db', 'docker-desktop')).toBe(
      'postgres://u:p@db.example.com:5432/db',
    );
  });

  test('undefined mode is a no-op', () => {
    expect(applyHostRemap('postgres://u:p@localhost:5432/db', undefined)).toBe(
      'postgres://u:p@localhost:5432/db',
    );
  });

  test('only matches at `@` boundary (not accidentally in a password)', () => {
    // Value that CONTAINS "localhost" but not at the `@host` boundary shouldn't remap.
    expect(applyHostRemap('some-thing-localhost-thing', 'docker-desktop')).toBe(
      'some-thing-localhost-thing',
    );
  });
});

// ---------------------------------------------------------------------
// buildChildCommand
// ---------------------------------------------------------------------

describe('buildChildCommand', () => {
  test('npx runtime uses `npx -y <package> <passthrough>`', () => {
    const cmd = buildChildCommand(
      {
        runtime: 'npx',
        package: '@modelcontextprotocol/server-github',
        envMap: [],
        packDir: '/tmp',
        passthroughArgs: ['--verbose'],
      },
      { GITHUB_TOKEN: 'ghp_xxx' },
    );
    expect(cmd.cmd).toBe('npx');
    expect(cmd.args).toEqual(['-y', '@modelcontextprotocol/server-github', '--verbose']);
    expect(cmd.extraEnv).toEqual({ GITHUB_TOKEN: 'ghp_xxx' });
  });

  test('docker runtime uses `docker run -i --rm -e VAR ... <image>`', () => {
    const cmd = buildChildCommand(
      {
        runtime: 'docker',
        package: 'crystaldba/postgres-mcp',
        envMap: [],
        packDir: '/tmp',
        passthroughArgs: ['--access-mode=restricted'],
      },
      { DATABASE_URI: 'postgres://u:p@db/db', LOG_LEVEL: 'debug' },
    );
    expect(cmd.cmd).toBe('docker');
    expect(cmd.args).toEqual([
      'run',
      '-i',
      '--rm',
      '-e',
      'DATABASE_URI',
      '-e',
      'LOG_LEVEL',
      'crystaldba/postgres-mcp',
      '--access-mode=restricted',
    ]);
    expect(cmd.extraEnv).toEqual({
      DATABASE_URI: 'postgres://u:p@db/db',
      LOG_LEVEL: 'debug',
    });
  });

  test('docker + host-remap rewrites localhost in env values', () => {
    const cmd = buildChildCommand(
      {
        runtime: 'docker',
        package: 'crystaldba/postgres-mcp',
        envMap: [],
        packDir: '/tmp',
        hostRemap: 'docker-desktop',
        passthroughArgs: [],
      },
      { DATABASE_URI: 'postgres://u:p@localhost:5433/bb' },
    );
    expect(cmd.extraEnv.DATABASE_URI).toBe('postgres://u:p@host.docker.internal:5433/bb');
  });

  test('npx + host-remap does NOT rewrite (host-remap is docker-only)', () => {
    const cmd = buildChildCommand(
      {
        runtime: 'npx',
        package: 'some-mcp',
        envMap: [],
        packDir: '/tmp',
        hostRemap: 'docker-desktop',
        passthroughArgs: [],
      },
      { DATABASE_URI: 'postgres://u:p@localhost:5433/bb' },
    );
    expect(cmd.extraEnv.DATABASE_URI).toBe('postgres://u:p@localhost:5433/bb');
  });
});

// ---------------------------------------------------------------------
// runLauncher — end-to-end with mocked spawn
// ---------------------------------------------------------------------

interface MockChild extends EventEmitter {
  killed: boolean;
  kill: (sig?: NodeJS.Signals) => boolean;
}

function makeMockChild(): MockChild {
  const emitter = new EventEmitter() as MockChild;
  emitter.killed = false;
  emitter.kill = () => {
    emitter.killed = true;
    return true;
  };
  return emitter;
}

describe('runLauncher', () => {
  let packDir: string;

  beforeEach(async () => {
    packDir = await mkdtemp(join(tmpdir(), 'kindgi-mcp-launcher-run-'));
  });

  afterEach(async () => {
    await rm(packDir, { recursive: true, force: true });
  });

  test('bad argv → exit 2, stderr explains', async () => {
    const stderr = vi.fn();
    const code = await runLauncher(['--runtime=magic'], {
      stderr,
      onSignal: () => () => {},
    });
    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls[0]?.[0]).toContain('magic');
  });

  test('missing secret → exit 3', async () => {
    const stderr = vi.fn();
    const code = await runLauncher(
      [
        '--runtime=npx',
        '--package=some-mcp',
        '--env-map=X=secret:MISSING@local:tenant',
        `--pack-dir=${packDir}`,
      ],
      {
        stderr,
        onSignal: () => () => {},
      },
    );
    expect(code).toBe(3);
    expect(stderr.mock.calls[0]?.[0]).toContain('No env files for env "local"');
  });

  test('happy path — spawn called with correct args, child exit propagated', async () => {
    await writeFile(join(packDir, '.env.local'), 'GITHUB_PAT=ghp_abc\n');
    const mockChild = makeMockChild();
    const spawnSpy = vi.fn().mockReturnValue(mockChild);

    const promise = runLauncher(
      [
        '--runtime=npx',
        '--package=@modelcontextprotocol/server-github',
        '--env-map=GITHUB_TOKEN=secret:GITHUB_PAT@local:tenant',
        `--pack-dir=${packDir}`,
      ],
      {
        spawn: spawnSpy as never,
        onSignal: () => () => {},
      },
    );

    // Wait until the launcher subscribes to child events before emitting exit.
    await vi.waitFor(() => expect(mockChild.listenerCount('exit')).toBeGreaterThan(0));
    mockChild.emit('exit', 0, null);
    const code = await promise;

    expect(code).toBe(0);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSpy.mock.calls[0]!;
    expect(cmd).toBe('npx');
    expect(args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect((opts as { env: Record<string, string> }).env.GITHUB_TOKEN).toBe('ghp_abc');
  });

  test('child killed by SIGTERM → exit 128 + 15', async () => {
    await writeFile(join(packDir, '.env.local'), 'GITHUB_PAT=ghp_abc\n');
    const mockChild = makeMockChild();
    const spawnSpy = vi.fn().mockReturnValue(mockChild);

    const promise = runLauncher(
      [
        '--runtime=npx',
        '--package=some-mcp',
        '--env-map=X=secret:GITHUB_PAT@local:tenant',
        `--pack-dir=${packDir}`,
      ],
      {
        spawn: spawnSpy as never,
        onSignal: () => () => {},
      },
    );

    await vi.waitFor(() => expect(mockChild.listenerCount('exit')).toBeGreaterThan(0));
    mockChild.emit('exit', null, 'SIGTERM');
    expect(await promise).toBe(128 + 15);
  });

  test('signal handler forwards signals to child', async () => {
    await writeFile(join(packDir, '.env.local'), 'X=1\n');
    const mockChild = makeMockChild();
    const killSpy = vi.spyOn(mockChild, 'kill');
    const spawnSpy = vi.fn().mockReturnValue(mockChild);
    let signalHandler: ((sig: NodeJS.Signals) => void) | undefined;

    const promise = runLauncher(
      [
        '--runtime=npx',
        '--package=some-mcp',
        '--env-map=Y=secret:X@local:tenant',
        `--pack-dir=${packDir}`,
      ],
      {
        spawn: spawnSpy as never,
        onSignal: (handler) => {
          signalHandler = handler;
          return () => {};
        },
      },
    );

    // Wait until the launcher has subscribed both signal + exit before firing.
    await vi.waitFor(() => expect(signalHandler).toBeDefined());
    signalHandler?.('SIGINT');
    expect(killSpy).toHaveBeenCalledWith('SIGINT');

    // Complete the child so promise resolves.
    await vi.waitFor(() => expect(mockChild.listenerCount('exit')).toBeGreaterThan(0));
    mockChild.emit('exit', 0, null);
    await promise;
  });
});
