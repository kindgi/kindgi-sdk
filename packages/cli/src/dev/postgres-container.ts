// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The bundled Postgres with plain `docker`, for a Docker engine without
 * `docker compose` (common on a bare Linux engine). `kindgi dev` starts
 * the same container the compose file defines, read from that file:
 *
 *   - the same names: the container (`kindgi-dev_postgres`), its data
 *     volume (`kindgi-dev_postgres-data`) and the network (`kindgi-dev`),
 *     so the data is shared whichever way it was started;
 *   - the same image, environment, command, healthcheck, and the port
 *     published to a random host port on loopback (`127.0.0.1`): the
 *     password is a fixed dev one, so the database must not be reachable
 *     from the LAN;
 *   - the compose project's labels on what it creates, so
 *     `docker compose -p kindgi-dev` (`up --no-recreate`, `port`,
 *     `down -v`) takes them as its own once compose is installed.
 *
 * An existing container is reused as it is, whichever way it was
 * started: started if stopped, never recreated or removed, since
 * another `kindgi dev` may be using it.
 */

import { parse as parseYaml } from 'yaml';

import { type DockerOutcome, docker } from './runtime-container.js';

/** Runs one `docker` command (`runtime-container.ts`'s `docker`); tests hand in a fake. */
export type DockerRunner = (args: readonly string[]) => Promise<DockerOutcome>;

/** The bundled Postgres's container, as the compose file defines it. */
export interface PostgresContainerSpec {
  /** The compose project (`kindgi-dev`) and service (`postgres`) it belongs to. */
  readonly project: string;
  readonly service: string;
  /** `container_name`. */
  readonly name: string;
  readonly image: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  /** The named volume: its key in the compose file, its Docker name, and where it's mounted. */
  readonly volume: { readonly key: string; readonly name: string; readonly target: string };
  /** The network: its key in the compose file (`default`) and its Docker name. */
  readonly network: { readonly key: string; readonly name: string };
  /** The container port, published to a random host port. */
  readonly port: number;
  /**
   * The host address it's published on (`127.0.0.1`: loopback only, as
   * the password is a fixed dev one); all of the host's when absent.
   */
  readonly hostIp?: string;
  readonly healthcheck: {
    /** Run by the container's shell (`CMD-SHELL`). */
    readonly command: string;
    readonly interval?: string;
    readonly timeout?: string;
    readonly retries?: number;
    readonly startPeriod?: string;
  };
}

/** The service keys the plain-docker start carries over; any other is refused. */
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  'image',
  'container_name',
  'environment',
  'command',
  'volumes',
  'ports',
  'healthcheck',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * The container `service` defines in a compose file, for `docker run`.
 * Strict: a key or shape the plain-docker start can't carry over throws,
 * so the two ways of starting it never drift apart silently.
 */
export function postgresSpecFromCompose(
  composeYaml: string,
  project: string,
  service = 'postgres',
): PostgresContainerSpec {
  const unsupported = (what: string): Error =>
    new Error(
      `the compose file's ${service} service: ${what}, which a plain docker start can't carry over`,
    );
  const file: unknown = parseYaml(composeYaml);
  if (!isRecord(file) || !isRecord(file.services)) throw unsupported('no services');
  const svc = file.services[service];
  if (!isRecord(svc)) throw unsupported('not defined');
  for (const key of Object.keys(svc)) {
    if (!SERVICE_KEYS.has(key)) throw unsupported(`sets \`${key}\``);
  }
  if (typeof svc.image !== 'string') throw unsupported('no image');
  if (typeof svc.container_name !== 'string') throw unsupported('no container_name');

  const environment: Record<string, string> = {};
  if (svc.environment !== undefined) {
    if (!isRecord(svc.environment)) throw unsupported('environment is not a map');
    for (const [name, value] of Object.entries(svc.environment)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw unsupported(`environment ${name} has no value`);
      }
      environment[name] = String(value);
    }
  }

  const command = svc.command ?? [];
  if (!isStringList(command)) throw unsupported('command is not a list of strings');

  if (!isStringList(svc.volumes) || svc.volumes.length !== 1) {
    throw unsupported('not exactly one volume');
  }
  const mount = svc.volumes[0] ?? '';
  const [volumeKey, target, ...rest] = mount.split(':');
  const volumes = isRecord(file.volumes) ? file.volumes : {};
  const volumeDef = volumes[volumeKey ?? ''];
  if (
    volumeKey === undefined ||
    target === undefined ||
    rest.length > 0 ||
    volumeDef === undefined
  ) {
    throw unsupported(`volume ${mount} is not a named volume`);
  }
  const volumeName =
    isRecord(volumeDef) && typeof volumeDef.name === 'string'
      ? volumeDef.name
      : `${project}_${volumeKey}`;

  // `5432` or `127.0.0.1::5432`: a random host port, on one address or all.
  const published =
    isStringList(svc.ports) && svc.ports.length === 1
      ? /^(?:(\d{1,3}(?:\.\d{1,3}){3})::)?(\d+)$/.exec(svc.ports[0] ?? '')
      : null;
  if (published === null) {
    throw unsupported('not exactly one port published to a random host port');
  }
  const hostIp = published[1];
  const port = Number(published[2]);

  const networks = isRecord(file.networks) ? file.networks : {};
  for (const key of Object.keys(networks)) {
    if (key !== 'default') throw unsupported(`network ${key}`);
  }
  const defaultNetwork = networks.default;
  const networkName =
    isRecord(defaultNetwork) && typeof defaultNetwork.name === 'string'
      ? defaultNetwork.name
      : `${project}_default`;

  const hc = svc.healthcheck;
  if (!isRecord(hc)) throw unsupported('no healthcheck');
  const test = hc.test;
  const healthCommand =
    typeof test === 'string'
      ? test
      : isStringList(test) && test.length === 2 && test[0] === 'CMD-SHELL'
        ? test[1]
        : undefined;
  if (healthCommand === undefined) throw unsupported('healthcheck test is not CMD-SHELL');
  for (const key of Object.keys(hc)) {
    if (!['test', 'interval', 'timeout', 'retries', 'start_period'].includes(key)) {
      throw unsupported(`healthcheck sets \`${key}\``);
    }
  }
  const duration = (key: string): string | undefined => {
    const value = hc[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw unsupported(`healthcheck ${key} is not a duration`);
    return value;
  };
  if (hc.retries !== undefined && typeof hc.retries !== 'number') {
    throw unsupported('healthcheck retries is not a number');
  }
  const interval = duration('interval');
  const timeout = duration('timeout');
  const startPeriod = duration('start_period');

  return {
    project,
    service,
    name: svc.container_name,
    image: svc.image,
    environment,
    command,
    volume: { key: volumeKey, name: volumeName, target },
    network: { key: 'default', name: networkName },
    port,
    ...(hostIp !== undefined && { hostIp }),
    healthcheck: {
      command: healthCommand,
      ...(interval !== undefined && { interval }),
      ...(timeout !== undefined && { timeout }),
      ...(typeof hc.retries === 'number' && { retries: hc.retries }),
      ...(startPeriod !== undefined && { startPeriod }),
    },
  };
}

/**
 * The compose project's labels for the container: compose finds a
 * project's containers by them. The config hash is left empty, so compose
 * takes the definition as changed: `--no-recreate` reuses the container,
 * and only a recreate asked for (`--recreate-services`) replaces it.
 */
function containerLabels(spec: PostgresContainerSpec): string[] {
  return [
    `com.docker.compose.project=${spec.project}`,
    `com.docker.compose.service=${spec.service}`,
    'com.docker.compose.oneoff=False',
    'com.docker.compose.container-number=1',
    'com.docker.compose.config-hash=',
  ];
}

function labelArgs(labels: readonly string[]): string[] {
  return labels.flatMap((label) => ['--label', label]);
}

/** The `docker run` arguments for the container the compose file defines. */
export function postgresRunArgs(spec: PostgresContainerSpec): string[] {
  const args = ['run', '--detach', '--name', spec.name, ...labelArgs(containerLabels(spec))];
  // On the project's network under its service name, as compose attaches it.
  args.push('--network', spec.network.name, '--network-alias', spec.service);
  args.push('--volume', `${spec.volume.name}:${spec.volume.target}`);
  // `127.0.0.1::5432`: a random host port, on loopback only when the
  // compose file says so (a fixed dev password stays off the LAN).
  args.push(
    '--publish',
    spec.hostIp === undefined ? String(spec.port) : `${spec.hostIp}::${spec.port}`,
  );
  for (const [name, value] of Object.entries(spec.environment)) {
    args.push('--env', `${name}=${value}`);
  }
  const hc = spec.healthcheck;
  args.push('--health-cmd', hc.command);
  if (hc.interval !== undefined) args.push('--health-interval', hc.interval);
  if (hc.timeout !== undefined) args.push('--health-timeout', hc.timeout);
  if (hc.retries !== undefined) args.push('--health-retries', String(hc.retries));
  if (hc.startPeriod !== undefined) args.push('--health-start-period', hc.startPeriod);
  args.push(spec.image, ...spec.command);
  return args;
}

/**
 * The host port in `docker port` / `docker compose port` output
 * (`0.0.0.0:51741`, or `[::]:51741`); `undefined` when there is none.
 */
export function hostPortOf(portOutput: string): number | undefined {
  const line = portOutput.trim().split('\n')[0] ?? '';
  const port = Number(line.slice(line.lastIndexOf(':') + 1));
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join('\n');
}

function failure(command: string, outcome: DockerOutcome): string {
  const detail = lastLines(outcome.stderr);
  return `\`${command}\` failed (exit ${outcome.code ?? 'spawn error'})${detail === '' ? '' : `: ${detail}`}`;
}

/** What `startPostgresContainer` found: the host port, and whether it made, started or reused the container. */
export type PostgresContainerStart =
  | {
      readonly kind: 'ok';
      readonly port: number;
      /** `created`: none existed; `started`: it was stopped; `running`: reused as it was. */
      readonly container: 'created' | 'started' | 'running';
    }
  | { readonly kind: 'error'; readonly message: string };

/** Create the network or volume when it's missing; an existing one is used as it is. */
async function ensureResource(
  kind: 'network' | 'volume',
  name: string,
  labels: readonly string[],
  run: DockerRunner,
): Promise<string | undefined> {
  if ((await run([kind, 'inspect', name])).code === 0) return undefined;
  const created = await run([kind, 'create', ...labelArgs(labels), name]);
  if (created.code === 0) return undefined;
  // Another kindgi dev made it meanwhile.
  if ((await run([kind, 'inspect', name])).code === 0) return undefined;
  return failure(`docker ${kind} create ${name}`, created);
}

/**
 * The container's status (`docker container inspect`), or `missing`; an
 * error when docker can't tell.
 */
async function containerStatus(
  name: string,
  run: DockerRunner,
): Promise<{ readonly status: string } | { readonly error: string }> {
  const inspected = await run(['container', 'inspect', '--format', '{{.State.Status}}', name]);
  if (inspected.code === 0) return { status: inspected.stdout.trim() };
  if (inspected.code !== null && /no such (container|object)/i.test(inspected.stderr)) {
    return { status: 'missing' };
  }
  return { error: failure(`docker container inspect ${name}`, inspected) };
}

/** Reuse an existing container as it is: start it when it's stopped. */
async function reuseContainer(
  name: string,
  status: string,
  run: DockerRunner,
): Promise<
  | { readonly kind: 'reused'; readonly container: 'started' | 'running' }
  | { readonly kind: 'error'; readonly message: string }
> {
  if (status === 'running' || status === 'restarting')
    return { kind: 'reused', container: 'running' };
  if (status === 'created' || status === 'exited') {
    const started = await run(['start', name]);
    return started.code === 0
      ? { kind: 'reused', container: 'started' }
      : { kind: 'error', message: failure(`docker start ${name}`, started) };
  }
  if (status === 'paused') {
    return {
      kind: 'error',
      message: `${name} is paused: unpause it (docker unpause ${name}), then run kindgi dev again`,
    };
  }
  return { kind: 'error', message: `${name} is ${status}` };
}

/**
 * Wait until the container is healthy (or running, without a
 * healthcheck), as `docker compose up --wait` does; an error when it
 * turns unhealthy or stops.
 */
async function waitHealthy(
  name: string,
  run: DockerRunner,
  wait: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<string | undefined> {
  const deadline = Date.now() + wait.timeoutMs;
  const format = '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}';
  for (;;) {
    const inspected = await run(['container', 'inspect', '--format', format, name]);
    if (inspected.code !== 0) return failure(`docker container inspect ${name}`, inspected);
    const [status, health] = inspected.stdout.trim().split(/\s+/);
    if (status === 'running' && (health === undefined || health === 'healthy')) return undefined;
    const stopped = status === 'exited' || status === 'dead';
    if (stopped || health === 'unhealthy' || Date.now() > deadline) {
      const what = stopped
        ? `stopped while starting (${status})`
        : health === 'unhealthy'
          ? 'is unhealthy'
          : `wasn't healthy after ${Math.round(wait.timeoutMs / 1000)}s`;
      const logs = await run(['logs', '--tail', '15', name]);
      const tail = lastLines(`${logs.stdout}\n${logs.stderr}`, 15);
      return `${name} ${what}${tail === '' ? '' : `:\n${tail}`}`;
    }
    await new Promise((r) => setTimeout(r, wait.pollMs));
  }
}

/**
 * Start the container `spec` defines with plain `docker`, wait until it's
 * healthy, and read its host port back:
 *
 *   - none exists: create the network and the volume when missing, then
 *     `docker run` it;
 *   - it exists, whichever way it was started: reuse it as it is, and
 *     start it when it's stopped. It is never recreated or removed.
 */
export async function startPostgresContainer(
  spec: PostgresContainerSpec,
  run: DockerRunner = docker,
  wait: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<PostgresContainerStart> {
  const found = await containerStatus(spec.name, run);
  if ('error' in found) return { kind: 'error', message: found.error };

  let status = found.status;
  let container: 'created' | 'started' | 'running' | undefined;
  if (status === 'missing') {
    const project = `com.docker.compose.project=${spec.project}`;
    const network = await ensureResource(
      'network',
      spec.network.name,
      [project, `com.docker.compose.network=${spec.network.key}`],
      run,
    );
    if (network !== undefined) return { kind: 'error', message: network };
    const volume = await ensureResource(
      'volume',
      spec.volume.name,
      [project, `com.docker.compose.volume=${spec.volume.key}`],
      run,
    );
    if (volume !== undefined) return { kind: 'error', message: volume };
    const created = await run(postgresRunArgs(spec));
    if (created.code === 0) {
      container = 'created';
    } else {
      // Another kindgi dev made it meanwhile: reuse that one.
      const again = await containerStatus(spec.name, run);
      if ('error' in again || again.status === 'missing') {
        return { kind: 'error', message: failure(`docker run --name ${spec.name}`, created) };
      }
      status = again.status;
    }
  }
  if (container === undefined) {
    const reused = await reuseContainer(spec.name, status, run);
    if (reused.kind === 'error') return reused;
    container = reused.container;
  }

  const unhealthy = await waitHealthy(spec.name, run, {
    timeoutMs: wait.timeoutMs ?? 120_000,
    pollMs: wait.pollMs ?? 500,
  });
  if (unhealthy !== undefined) return { kind: 'error', message: unhealthy };

  const published = await run(['port', spec.name, String(spec.port)]);
  const port = published.code === 0 ? hostPortOf(published.stdout) : undefined;
  if (port === undefined) {
    return { kind: 'error', message: failure(`docker port ${spec.name} ${spec.port}`, published) };
  }
  return { kind: 'ok', port, container };
}
