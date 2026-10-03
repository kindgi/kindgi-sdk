// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi mcp-launch` — the subprocess wrapper that spawns an MCP
 * server with secrets injected from the pack's env files — the same
 * files, read the same way, as Kindgi's dev-mode `SecretBinding`
 * (`@kindgi/secrets-dotenv`): for `local`, the project's `.env` then
 * `.env.local` (or `dev.envFiles`); otherwise `.env.<envName>`.
 *
 * Design goals:
 *   - **Generic** — no per-server logic. Works for any Node package
 *     invocable via `npx`, or any Docker image, that reads its
 *     credentials from environment variables.
 *   - **Portable across MCP clients** — a `.mcp.json` entry running the
 *     project's `kindgi mcp-launch …` (via its package manager, e.g.
 *     `pnpm exec kindgi`) works identically for Claude Code, Cursor,
 *     VS Code, Claude Desktop, Windsurf, or anything else that speaks
 *     the MCP config shape.
 *   - **Secrets stay outside the model's context** — the DB URL /
 *     token flows: SecretBinding → this process's memory → child
 *     process's env. Never in argv (visible via `ps aux`); never in
 *     `.mcp.json` (visible via any Read tool the model calls).
 *
 * Argv shape:
 *
 *     kindgi mcp-launch \
 *       --runtime=<npx|docker> \
 *       --package=<npm-package-or-docker-image> \
 *       --env-map=VAR=secret:NAME@envName:scopeKind[:scopeId] \  (repeatable)
 *       [--pack-dir=<abs-path>] \
 *       [--host-remap=docker-desktop] \
 *       -- <passthrough args forwarded to the child process>
 *
 * `--host-remap=docker-desktop` rewrites `localhost` / `127.0.0.1` in
 * resolved secret VALUES to `host.docker.internal` — the Mac/Windows
 * Docker escape hatch. Only applied when the runtime is `docker`.
 *
 * Exit codes:
 *   - 0 (or child's exit code) — child ran to completion
 *   - 2 — argv parse error
 *   - 3 — secret resolution error (missing env file, missing secret)
 *   - 4 — spawn error (child couldn't start)
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { parseArgs as nodeParseArgs } from 'node:util';

import { type PackEnv, displayEnvPath, packValues, readPackEnv } from '@kindgi/secrets-dotenv';

import { type LocalEnvSettings, loadLocalEnvSettings } from '../env/project-env.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type Runtime = 'npx' | 'docker';
export type HostRemap = 'docker-desktop';
export type ScopeKind = 'tenant' | 'org' | 'project';

export interface SecretRef {
  readonly name: string;
  readonly envName: string;
  readonly scopeKind: ScopeKind;
  readonly scopeId?: string;
}

export interface EnvMapEntry {
  readonly child: string;
  readonly ref: SecretRef;
}

export interface ParsedLauncherArgs {
  readonly runtime: Runtime;
  readonly package: string;
  readonly envMap: readonly EnvMapEntry[];
  readonly packDir: string;
  readonly hostRemap?: HostRemap;
  readonly passthroughArgs: readonly string[];
}

export type ParseResult =
  | { readonly kind: 'ok'; readonly args: ParsedLauncherArgs }
  | { readonly kind: 'err'; readonly message: string };

export type ResolveResult =
  | { readonly kind: 'ok'; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: 'err'; readonly message: string };

export interface ChildCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------

const RUNTIMES = new Set<Runtime>(['npx', 'docker']);
const HOST_REMAPS = new Set<HostRemap>(['docker-desktop']);

/**
 * Parse a single `--env-map` value: `VAR=secret:NAME@envName:scopeKind[:scopeId]`.
 * Returns null on malformed input; caller decides error phrasing.
 */
export function parseEnvMapFlag(raw: string): EnvMapEntry | null {
  const eq = raw.indexOf('=');
  if (eq <= 0) return null;
  const child = raw.slice(0, eq).trim();
  if (child === '') return null;
  const refRaw = raw.slice(eq + 1);
  const ref = parseSecretRef(refRaw);
  if (ref === null) return null;
  return { child, ref };
}

/**
 * Parse a secret reference: `secret:NAME@envName:scopeKind[:scopeId]`.
 *
 *   - `secret:GRIEVANCE_DB_URL@local:tenant`
 *   - `secret:X@local:project:pack-a`
 *   - `secret:X@local:org:acme`
 */
export function parseSecretRef(raw: string): SecretRef | null {
  if (!raw.startsWith('secret:')) return null;
  const body = raw.slice('secret:'.length);
  const atSign = body.indexOf('@');
  if (atSign <= 0) return null;
  const name = body.slice(0, atSign);
  const tail = body.slice(atSign + 1);
  const parts = tail.split(':');
  if (parts.length < 2) return null;
  const envName = parts[0];
  const scopeKind = parts[1] as ScopeKind;
  if (envName === undefined || envName === '') return null;
  if (scopeKind !== 'tenant' && scopeKind !== 'org' && scopeKind !== 'project') return null;
  if (scopeKind === 'tenant') {
    if (parts.length !== 2) return null;
    return { name, envName, scopeKind };
  }
  // org / project must carry a scopeId
  if (parts.length !== 3) return null;
  const scopeId = parts[2];
  if (scopeId === undefined || scopeId === '') return null;
  return { name, envName, scopeKind, scopeId };
}

/**
 * Parse the full launcher argv. Everything after a bare `--` token is
 * treated as passthrough to the child.
 */
export function parseLauncherArgs(argv: readonly string[]): ParseResult {
  const dashDash = argv.indexOf('--');
  const launcherArgv = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const passthroughArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : [];

  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({
      args: [...launcherArgv],
      options: {
        runtime: { type: 'string' },
        package: { type: 'string' },
        'env-map': { type: 'string', multiple: true },
        'pack-dir': { type: 'string' },
        'host-remap': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    return { kind: 'err', message: `Bad launcher argv: ${(err as Error).message}` };
  }

  const runtimeRaw = parsed.values.runtime;
  if (typeof runtimeRaw !== 'string') {
    return { kind: 'err', message: 'Missing required --runtime=<npx|docker>' };
  }
  if (!RUNTIMES.has(runtimeRaw as Runtime)) {
    return {
      kind: 'err',
      message: `Invalid --runtime "${runtimeRaw}". Accepted: npx, docker.`,
    };
  }
  const runtime = runtimeRaw as Runtime;

  const packageName = parsed.values.package;
  if (typeof packageName !== 'string' || packageName === '') {
    return { kind: 'err', message: 'Missing required --package=<npm-package-or-docker-image>' };
  }

  const envMapRaws = (parsed.values['env-map'] as string[] | undefined) ?? [];
  const envMap: EnvMapEntry[] = [];
  for (const raw of envMapRaws) {
    const entry = parseEnvMapFlag(raw);
    if (entry === null) {
      return {
        kind: 'err',
        message: `Bad --env-map "${raw}". Expected VAR=secret:NAME@envName:scopeKind[:scopeId].`,
      };
    }
    envMap.push(entry);
  }

  const packDir = (parsed.values['pack-dir'] as string | undefined) ?? process.cwd();

  const hostRemapRaw = parsed.values['host-remap'] as string | undefined;
  let hostRemap: HostRemap | undefined;
  if (hostRemapRaw !== undefined) {
    if (!HOST_REMAPS.has(hostRemapRaw as HostRemap)) {
      return {
        kind: 'err',
        message: `Invalid --host-remap "${hostRemapRaw}". Accepted: docker-desktop.`,
      };
    }
    hostRemap = hostRemapRaw as HostRemap;
  }

  return {
    kind: 'ok',
    args: {
      runtime,
      package: packageName,
      envMap,
      packDir,
      ...(hostRemap !== undefined && { hostRemap }),
      passthroughArgs,
    },
  };
}

// ---------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------

/**
 * Resolve every env-map entry against the pack's env files for its
 * environment (`@kindgi/secrets-dotenv`'s `readPackEnv`). Each
 * environment's files are read once. The dev store is scope-blind, so
 * `scopeKind` / `scopeId` are recorded but not used for lookup;
 * `KINDGI_*` names are runtime config and never resolve here.
 */
export async function resolveSecrets(
  entries: readonly EnvMapEntry[],
  packDir: string,
  readFile: (path: string) => Promise<string>,
  options: { readonly localEnvFiles?: readonly string[] } = {},
): Promise<ResolveResult> {
  const byEnv = new Map<string, PackEnv>();
  const readOrNull = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const load = async (envName: string): Promise<PackEnv> => {
    const cached = byEnv.get(envName);
    if (cached !== undefined) return cached;
    const env = await readPackEnv({
      packDir,
      envName,
      readFile: readOrNull,
      ...(options.localEnvFiles !== undefined && { localEnvFiles: options.localEnvFiles }),
    });
    byEnv.set(envName, env);
    return env;
  };
  const label = (paths: readonly string[]): string =>
    paths.map((p) => displayEnvPath(packDir, p)).join(', ');

  const resolved: Record<string, string> = {};
  for (const entry of entries) {
    const { name, envName, scopeKind, scopeId } = entry.ref;
    let env: PackEnv;
    try {
      env = await load(envName);
    } catch (err) {
      return {
        kind: 'err',
        message: `Failed to read env files for "${envName}": ${(err as Error).message}`,
      };
    }
    const setHint = `Run \`kindgi secrets set ${name} --env=${envName} --scope=${scopeKind}${scopeId !== undefined ? `:${scopeId}` : ''}\` first.`;
    if (env.present.length === 0) {
      return {
        kind: 'err',
        message: `No env files for env "${envName}" at ${packDir} (looked for ${label(env.files.read)}). ${setHint}`,
      };
    }
    const secrets = packValues(env.values);
    if (!Object.hasOwn(secrets, name)) {
      return {
        kind: 'err',
        message: `Secret "${name}" not found in ${label(env.present)}. Available: ${Object.keys(secrets).sort().join(', ') || '(none)'}. ${setHint}`,
      };
    }
    resolved[entry.child] = secrets[name] as string;
  }

  return { kind: 'ok', env: resolved };
}

// ---------------------------------------------------------------------
// Host remap — Docker-Desktop escape hatch for localhost DBs
// ---------------------------------------------------------------------

/**
 * Rewrite `localhost` / `127.0.0.1` in a value to `host.docker.internal`
 * when `mode === 'docker-desktop'`. Applied to every resolved secret
 * value before injecting into the child's env, but only when the child
 * is a Docker container (the launcher decides at call time).
 *
 * Not URL-parsing-based; we don't want to shred a value we don't
 * understand. Simple string replacement on the two known host tokens.
 * Real edge cases (nested URLs, IPv6 `::1`) can be added if a real
 * consumer surfaces them.
 */
export function applyHostRemap(value: string, mode: HostRemap | undefined): string {
  if (mode !== 'docker-desktop') return value;
  return value
    .replace(/@localhost([:/])/g, '@host.docker.internal$1')
    .replace(/@127\.0\.0\.1([:/])/g, '@host.docker.internal$1');
}

// ---------------------------------------------------------------------
// Build the child command
// ---------------------------------------------------------------------

/**
 * Compose the (cmd, args, extraEnv) triple to spawn. Deterministic —
 * no side effects — so it's trivially testable. Docker-runtime host
 * remap is applied here because it's per-value transformation.
 */
export function buildChildCommand(
  parsed: ParsedLauncherArgs,
  resolvedEnv: Readonly<Record<string, string>>,
): ChildCommand {
  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedEnv)) {
    remapped[key] = parsed.runtime === 'docker' ? applyHostRemap(value, parsed.hostRemap) : value;
  }

  if (parsed.runtime === 'npx') {
    return {
      cmd: 'npx',
      args: ['-y', parsed.package, ...parsed.passthroughArgs],
      extraEnv: remapped,
    };
  }

  // docker
  const passthroughEnvFlags: string[] = [];
  for (const key of Object.keys(remapped).sort()) {
    passthroughEnvFlags.push('-e', key);
  }
  return {
    cmd: 'docker',
    args: ['run', '-i', '--rm', ...passthroughEnvFlags, parsed.package, ...parsed.passthroughArgs],
    extraEnv: remapped,
  };
}

// ---------------------------------------------------------------------
// Runner — glue
// ---------------------------------------------------------------------

export interface RunLauncherDeps {
  readonly readFile: (path: string) => Promise<string>;
  /** `dev.envFiles` from the pack's `kindgi.config.ts`. */
  readonly localEnvSettings: (packDir: string) => Promise<LocalEnvSettings>;
  readonly spawn: typeof nodeSpawn;
  readonly stderr: (msg: string) => void;
  readonly onSignal: (handler: (sig: NodeJS.Signals) => void) => () => void;
}

const DEFAULT_DEPS: RunLauncherDeps = {
  readFile: (path) => nodeReadFile(path, 'utf8'),
  localEnvSettings: (packDir) => loadLocalEnvSettings({ buildConfigLoader: undefined }, packDir),
  spawn: nodeSpawn,
  stderr: (msg) => process.stderr.write(msg),
  onSignal: (handler) => {
    const wrapped = (sig: NodeJS.Signals) => handler(sig);
    process.on('SIGINT', wrapped);
    process.on('SIGTERM', wrapped);
    return () => {
      process.off('SIGINT', wrapped);
      process.off('SIGTERM', wrapped);
    };
  },
};

/**
 * Run the launcher end-to-end. Returns the effective exit code so a
 * caller (the CLI) can `process.exit(code)`.
 */
export async function runLauncher(
  argv: readonly string[],
  overrides: Partial<RunLauncherDeps> = {},
): Promise<number> {
  const deps: RunLauncherDeps = { ...DEFAULT_DEPS, ...overrides };

  const parsed = parseLauncherArgs(argv);
  if (parsed.kind === 'err') {
    deps.stderr(`kindgi mcp-launch: ${parsed.message}\n`);
    return 2;
  }

  const settings = await deps.localEnvSettings(parsed.args.packDir);
  if (settings.kind === 'error') {
    deps.stderr(`kindgi mcp-launch: ${settings.message}\n`);
    return 3;
  }
  const resolved = await resolveSecrets(parsed.args.envMap, parsed.args.packDir, deps.readFile, {
    ...(settings.localEnvFiles !== undefined && { localEnvFiles: settings.localEnvFiles }),
  });
  if (resolved.kind === 'err') {
    deps.stderr(`kindgi mcp-launch: ${resolved.message}\n`);
    return 3;
  }

  const child = buildChildCommand(parsed.args, resolved.env);

  let subprocess: ReturnType<typeof nodeSpawn>;
  try {
    subprocess = deps.spawn(child.cmd, [...child.args], {
      env: { ...process.env, ...child.extraEnv },
      stdio: 'inherit',
    });
  } catch (err) {
    deps.stderr(`kindgi mcp-launch: spawn failed: ${(err as Error).message}\n`);
    return 4;
  }

  const unsubscribe = deps.onSignal((sig) => {
    if (!subprocess.killed) subprocess.kill(sig);
  });

  return await new Promise<number>((resolve) => {
    subprocess.once('exit', (code, signal) => {
      unsubscribe();
      if (code !== null) return resolve(code);
      // Killed by signal — mirror shell convention (128 + signal number)
      const signalNum = signal !== null ? signalNumber(signal) : 0;
      return resolve(128 + signalNum);
    });
    subprocess.once('error', (err) => {
      unsubscribe();
      deps.stderr(`kindgi mcp-launch: child error: ${err.message}\n`);
      return resolve(4);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  // Minimal table — matches shell convention. Only entries we're
  // likely to see; unknowns fall back to 0 (128 = "killed by unknown").
  switch (signal) {
    case 'SIGHUP':
      return 1;
    case 'SIGINT':
      return 2;
    case 'SIGQUIT':
      return 3;
    case 'SIGKILL':
      return 9;
    case 'SIGTERM':
      return 15;
    default:
      return 0;
  }
}
