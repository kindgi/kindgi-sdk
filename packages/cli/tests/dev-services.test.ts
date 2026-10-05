// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { startServicesReal } from '../src/dev/defaults.js';
import {
  type DockerRunner,
  hostPortOf,
  postgresRunArgs,
  postgresSpecFromCompose,
  startPostgresContainer,
} from '../src/dev/postgres-container.js';

const COMPOSE_YAML = readFileSync(
  new URL('../src/dev/docker-compose.dev.yml', import.meta.url),
  'utf8',
);
const SPEC = postgresSpecFromCompose(COMPOSE_YAML, 'kindgi-dev');

describe('hostPortOf', () => {
  test.each([
    ['0.0.0.0:51741\n', 51741],
    ['[::]:51741\n', 51741],
    ['0.0.0.0:51741\n[::]:51741\n', 51741],
    ['127.0.0.1:5432', 5432],
  ])('%j → %d', (output, port) => {
    expect(hostPortOf(output)).toBe(port);
  });

  test.each([[''], ['\n'], ['no port here'], [':0']])('%j → undefined', (output) => {
    expect(hostPortOf(output)).toBeUndefined();
  });
});

describe('the bundled Postgres, as plain docker runs it', () => {
  test('read from the compose file: the same names, image, settings and healthcheck', () => {
    expect(SPEC).toEqual({
      project: 'kindgi-dev',
      service: 'postgres',
      name: 'kindgi-dev_postgres',
      image: 'pgvector/pgvector:pg16',
      environment: {
        POSTGRES_USER: 'kindgi',
        POSTGRES_PASSWORD: 'kindgi_dev_only',
        POSTGRES_DB: 'kindgi',
        POSTGRES_INITDB_ARGS: '--data-checksums',
      },
      command: [
        'postgres',
        '-c',
        'max_connections=200',
        '-c',
        'shared_buffers=256MB',
        '-c',
        'wal_level=logical',
      ],
      volume: {
        key: 'kindgi-dev-postgres-data',
        name: 'kindgi-dev_postgres-data',
        target: '/var/lib/postgresql/data',
      },
      network: { key: 'default', name: 'kindgi-dev' },
      port: 5432,
      hostIp: '127.0.0.1',
      healthcheck: {
        command: 'pg_isready -U kindgi -d kindgi',
        interval: '5s',
        timeout: '5s',
        retries: 10,
      },
    });
  });

  test('docker run: the compose labels, the network, the volume, a random loopback port', () => {
    expect(postgresRunArgs(SPEC)).toEqual([
      'run',
      '--detach',
      '--name',
      'kindgi-dev_postgres',
      '--label',
      'com.docker.compose.project=kindgi-dev',
      '--label',
      'com.docker.compose.service=postgres',
      '--label',
      'com.docker.compose.oneoff=False',
      '--label',
      'com.docker.compose.container-number=1',
      '--label',
      'com.docker.compose.config-hash=',
      '--network',
      'kindgi-dev',
      '--network-alias',
      'postgres',
      '--volume',
      'kindgi-dev_postgres-data:/var/lib/postgresql/data',
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_USER=kindgi',
      '--env',
      'POSTGRES_PASSWORD=kindgi_dev_only',
      '--env',
      'POSTGRES_DB=kindgi',
      '--env',
      'POSTGRES_INITDB_ARGS=--data-checksums',
      '--health-cmd',
      'pg_isready -U kindgi -d kindgi',
      '--health-interval',
      '5s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '10',
      'pgvector/pgvector:pg16',
      'postgres',
      '-c',
      'max_connections=200',
      '-c',
      'shared_buffers=256MB',
      '-c',
      'wal_level=logical',
    ]);
  });

  test('published on loopback only: a fixed dev password stays off the LAN', () => {
    expect(COMPOSE_YAML).toContain('- "127.0.0.1::5432"');
    expect(SPEC.hostIp).toBe('127.0.0.1');
    const args = postgresRunArgs(SPEC);
    expect(args[args.indexOf('--publish') + 1]).toBe('127.0.0.1::5432');
    // A compose file publishing on every address carries over as such.
    const everywhere = postgresSpecFromCompose(
      COMPOSE_YAML.replace('- "127.0.0.1::5432"', '- "5432"'),
      'kindgi-dev',
    );
    expect(everywhere.hostIp).toBeUndefined();
    expect(postgresRunArgs(everywhere)).toContain('5432');
  });

  test('a compose key plain docker would drop is refused, not ignored', () => {
    const withShm = COMPOSE_YAML.replace(
      '    container_name: kindgi-dev_postgres\n',
      '    container_name: kindgi-dev_postgres\n    shm_size: 1gb\n',
    );
    expect(() => postgresSpecFromCompose(withShm, 'kindgi-dev')).toThrow(/sets `shm_size`/);
    const hostPort = COMPOSE_YAML.replace('- "127.0.0.1::5432"', '- "127.0.0.1:5432:5432"');
    expect(hostPort).not.toBe(COMPOSE_YAML);
    expect(() => postgresSpecFromCompose(hostPort, 'kindgi-dev')).toThrow(/random host port/);
  });
});

// ---------- a fake docker ----------

interface FakeContainer {
  status: string;
  /** Health per inspect, the last one repeating. */
  health: string[];
}

interface FakeDockerState {
  /** `docker` isn't installed: every command fails to spawn. */
  readonly cli?: boolean;
  /** The engine answers. */
  readonly engine?: boolean;
  /** The compose plugin is installed. */
  readonly compose?: boolean;
  readonly containers?: Record<string, FakeContainer>;
  readonly networks?: readonly string[];
  readonly volumes?: readonly string[];
  /** `docker run` fails: another kindgi dev made the container meanwhile. */
  readonly runConflict?: boolean;
}

/** A Docker engine in memory: what `docker` answers, and every command run. */
function fakeDocker(state: FakeDockerState = {}) {
  const calls: string[][] = [];
  const containers = new Map(Object.entries(structuredClone(state.containers ?? {})));
  const networks = new Set(state.networks ?? []);
  const volumes = new Set(state.volumes ?? []);
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string) => ({ code: 1, stdout: '', stderr });
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    if (state.cli === false) return { code: null, stdout: '', stderr: 'spawn docker ENOENT' };
    const [cmd, sub] = args;
    const last = args.at(-1) ?? '';
    if (cmd === 'compose') {
      if (state.compose !== true) return fail("docker: 'compose' is not a docker command.");
      if (sub === 'version') return ok('Docker Compose version v5.1.1\n');
      if (args.includes('port')) return ok('127.0.0.1:51741\n');
      return ok();
    }
    if (state.engine === false) {
      return fail(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      );
    }
    if (cmd === 'version') return ok('29.4.0\n');
    if (cmd === 'container' && sub === 'inspect') {
      const c = containers.get(last);
      if (c === undefined) return fail(`Error response from daemon: No such container: ${last}`);
      if (!args.some((a) => a.includes('Health'))) return ok(`${c.status}\n`);
      const health = c.health.length > 1 ? c.health.shift() : c.health[0];
      return ok(`${c.status} ${health ?? ''}\n`);
    }
    if (cmd === 'network' || cmd === 'volume') {
      const set = cmd === 'network' ? networks : volumes;
      if (sub === 'inspect') return set.has(last) ? ok('[]') : fail(`no such ${cmd}: ${last}`);
      if (sub === 'create') {
        set.add(last);
        return ok(last);
      }
    }
    if (cmd === 'run') {
      const name = args[args.indexOf('--name') + 1] ?? '';
      if (state.runConflict === true) {
        containers.set(name, { status: 'running', health: ['healthy'] });
        return fail(`Conflict. The container name "/${name}" is already in use`);
      }
      containers.set(name, { status: 'running', health: ['starting', 'healthy'] });
      return ok('abc123\n');
    }
    if (cmd === 'start') {
      const c = containers.get(last);
      if (c === undefined) return fail(`No such container: ${last}`);
      c.status = 'running';
      return ok(last);
    }
    if (cmd === 'port') return ok('127.0.0.1:55432\n');
    if (cmd === 'logs') return { code: 0, stdout: '', stderr: 'FATAL: could not start\n' };
    return fail(`unexpected: docker ${args.join(' ')}`);
  };
  return { run, calls };
}

/** Commands that make, change or remove something: none may run on what exists. */
function changes(calls: readonly string[][]): string[][] {
  return calls.filter(
    ([cmd, sub]) =>
      !['version', 'port', 'logs'].includes(cmd ?? '') &&
      !(['container', 'network', 'volume'].includes(cmd ?? '') && sub === 'inspect'),
  );
}

const RUNNING = { 'kindgi-dev_postgres': { status: 'running', health: ['healthy'] } };

describe('startServicesReal: docker compose, else plain docker', () => {
  test('compose present: the compose path, unchanged', async () => {
    const d = fakeDocker({ compose: true });
    const out = await startServicesReal({ recreate: false }, d.run);
    expect(out).toEqual({
      kind: 'ok',
      handle: {
        databaseUrl: 'postgres://kindgi:kindgi_dev_only@127.0.0.1:51741/kindgi?sslmode=disable',
        services: ['postgres'],
        startedWith: 'docker compose',
        // Each project's database in it (project-database.test.ts).
        projectDatabases: expect.objectContaining({ ensure: expect.any(Function) }),
      },
    });
    expect(d.calls.map((c) => c.filter((a) => !a.endsWith('docker-compose.dev.yml')))).toEqual([
      ['compose', 'version'],
      ['compose', '-f', '-p', 'kindgi-dev', 'up', '-d', '--wait', '--no-recreate', 'postgres'],
      ['compose', '-f', '-p', 'kindgi-dev', 'port', 'postgres', '5432'],
    ]);
    // The bundled compose file, wherever the CLI is installed.
    expect(d.calls[1]?.[2]).toMatch(/docker-compose\.dev\.yml$/);

    const recreate = fakeDocker({ compose: true });
    await startServicesReal({ recreate: true }, recreate.run);
    expect(recreate.calls[1]).not.toContain('--no-recreate');
  });

  test('compose missing: plain docker makes the same container, volume and network', async () => {
    const d = fakeDocker();
    const out = await startServicesReal({ recreate: false }, d.run);
    expect(out).toEqual({
      kind: 'ok',
      handle: {
        databaseUrl: 'postgres://kindgi:kindgi_dev_only@127.0.0.1:55432/kindgi?sslmode=disable',
        services: ['postgres'],
        startedWith: 'docker',
        // Each project's database in it (project-database.test.ts).
        projectDatabases: expect.objectContaining({ ensure: expect.any(Function) }),
      },
    });
    expect(changes(d.calls)).toEqual([
      ['compose', 'version'],
      [
        'network',
        'create',
        '--label',
        'com.docker.compose.project=kindgi-dev',
        '--label',
        'com.docker.compose.network=default',
        'kindgi-dev',
      ],
      [
        'volume',
        'create',
        '--label',
        'com.docker.compose.project=kindgi-dev',
        '--label',
        'com.docker.compose.volume=kindgi-dev-postgres-data',
        'kindgi-dev_postgres-data',
      ],
      postgresRunArgs(SPEC),
    ]);
    // Waited for the healthcheck, then read the host port back.
    expect(d.calls.at(-1)).toEqual(['port', 'kindgi-dev_postgres', '5432']);
  });

  test('an existing network and volume are used as they are', async () => {
    const d = fakeDocker({ networks: ['kindgi-dev'], volumes: ['kindgi-dev_postgres-data'] });
    expect((await startServicesReal({ recreate: false }, d.run)).kind).toBe('ok');
    expect(changes(d.calls)).toEqual([['compose', 'version'], postgresRunArgs(SPEC)]);
  });

  test('an existing running container is reused, untouched', async () => {
    const d = fakeDocker({ containers: RUNNING });
    const out = await startServicesReal({ recreate: false }, d.run);
    expect(out).toMatchObject({ kind: 'ok', handle: { startedWith: 'docker' } });
    expect(changes(d.calls)).toEqual([['compose', 'version']]);
  });

  test('a stopped one is started, never recreated', async () => {
    const d = fakeDocker({
      containers: { 'kindgi-dev_postgres': { status: 'exited', health: ['healthy'] } },
    });
    const out = await startServicesReal({ recreate: false }, d.run);
    expect(out).toMatchObject({ kind: 'ok', handle: { startedWith: 'docker' } });
    expect(changes(d.calls)).toEqual([
      ['compose', 'version'],
      ['start', 'kindgi-dev_postgres'],
    ]);
  });

  test('--recreate-services without compose: reused as it is, and the developer is told', async () => {
    const d = fakeDocker({ containers: RUNNING });
    const out = await startServicesReal({ recreate: true }, d.run);
    if (out.kind !== 'ok') throw new Error(`expected ok, got ${out.kind}`);
    expect(out.handle.notes).toEqual([
      '--recreate-services needs docker compose: the existing kindgi-dev_postgres is reused as it is. To recreate it, remove it (docker rm -f kindgi-dev_postgres; its data stays in the kindgi-dev_postgres-data volume) and run kindgi dev again.',
    ]);
    expect(changes(d.calls)).toEqual([['compose', 'version']]);

    // None existed: it's made from the current definition, nothing to say.
    const fresh = await startServicesReal({ recreate: true }, fakeDocker().run);
    if (fresh.kind !== 'ok') throw new Error(`expected ok, got ${fresh.kind}`);
    expect(fresh.handle.notes).toBeUndefined();
  });

  test('docker not installed, or its engine not answering: unavailable, with why', async () => {
    expect(await startServicesReal({ recreate: false }, fakeDocker({ cli: false }).run)).toEqual({
      kind: 'unavailable',
      reason: "Docker isn't available: spawn docker ENOENT",
    });
    expect(await startServicesReal({ recreate: false }, fakeDocker({ engine: false }).run)).toEqual(
      {
        kind: 'unavailable',
        reason:
          "Docker isn't available: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      },
    );
  });
});

describe('startPostgresContainer', () => {
  const FAST = { pollMs: 1, timeoutMs: 1_000 };

  test('another kindgi dev made it meanwhile: that one is reused', async () => {
    const d = fakeDocker({ runConflict: true });
    expect(await startPostgresContainer(SPEC, d.run, FAST)).toEqual({
      kind: 'ok',
      port: 55432,
      container: 'running',
    });
    expect(d.calls.filter(([cmd]) => cmd === 'rm' || cmd === 'start')).toEqual([]);
  });

  test('an unhealthy container is an error with its last log lines', async () => {
    const d = fakeDocker({
      containers: {
        'kindgi-dev_postgres': { status: 'running', health: ['starting', 'unhealthy'] },
      },
    });
    expect(await startPostgresContainer(SPEC, d.run, FAST)).toEqual({
      kind: 'error',
      message: 'kindgi-dev_postgres is unhealthy:\nFATAL: could not start',
    });
    expect(changes(d.calls)).toEqual([]);
  });

  test('a paused container is left paused, with how to go on', async () => {
    const d = fakeDocker({
      containers: { 'kindgi-dev_postgres': { status: 'paused', health: ['healthy'] } },
    });
    expect(await startPostgresContainer(SPEC, d.run, FAST)).toEqual({
      kind: 'error',
      message:
        'kindgi-dev_postgres is paused: unpause it (docker unpause kindgi-dev_postgres), then run kindgi dev again',
    });
    expect(changes(d.calls)).toEqual([]);
  });
});
