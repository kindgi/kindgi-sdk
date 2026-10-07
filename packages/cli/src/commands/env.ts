// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi env` — per-environment value management.
 *
 * Local-first: `list` / `set` / `unset` operate on `.env.<envName>`
 * files sitting next to `kindgi.config.ts`, which is exactly the
 * shape `kindgi deploy`'s secrets-sync warning path detects today.
 * `pull` bridges to the API's dedicated `/v1/env/*` surface.
 *
 * Subcommands:
 *   - `list [--env <name>] [--reveal] [--force-reveal] [--path <dir>]`
 *   - `set <KEY> <VALUE> [--env <name>] [--force] [--path <dir>]`
 *   - `unset <KEY> [--env <name>] [--path <dir>]`
 *   - `pull [--env <name>] --scope=<kind>[:id] [--path <dir>] [--overwrite-existing]`
 *
 * Every filesystem side-effect flows through `EnvRunners` so tests
 * substitute stubs. `kindgi.config.ts` loading reuses the same
 * `buildConfigLoader` seam `kindgi build` + `kindgi deploy`
 * already thread — one config loader, one test-injection point.
 */

import { isAbsolute, join, resolve } from 'node:path';
import * as readline from 'node:readline';
import type { ReadStream } from 'node:tty';

import { type LayeredEnv, readEnvLayers } from '@kindgi/dotenv-file';
import { type EnvTarget, envVarsForTarget, renderEnvExample } from '@kindgi/env-schema';
import type { Scope } from '@kindgi/platform';
import { displayEnvPath, isRuntimeKey, resolvePackEnvFiles } from '@kindgi/secrets-dotenv';
import type { EnvName } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import {
  describePackEnvPlan,
  planPackEnv,
  renderGcloud,
  renderTerraform,
} from '../env/pack-env-plan.js';
import { ENV_KEY_REGEX } from '../env/parser.js';
import { describeEnvDiagnostics, loadLocalEnvSettings } from '../env/project-env.js';
import type { EnvRunners } from '../env/runners.js';
import { EnvValueNotRepresentableError, setKey, unsetKey } from '../env/writer.js';
import { renderJson } from '../output.js';
import type { PackConfigRecord } from '../pack-config.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

// ---------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------

/**
 * Keys the CLI refuses to write / unset via `kindgi env`: framework
 * runtime config, which is always `KINDGI_*`-prefixed (see
 * `@kindgi/env-schema`). Every un-prefixed name — `DATABASE_URL`
 * included — belongs to the pack's agents or the host application.
 * `kindgi env` is per-pack per-env; framework globals live in the
 * shell's own env / secret manager.
 */
export const REFUSED_KEY_PREFIXES: readonly string[] = ['KINDGI_'];

export function isRefusedKey(key: string): boolean {
  for (const prefix of REFUSED_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------

interface ResolvedPaths {
  readonly packDir: string;
  readonly envName: string;
  /** Where writes land — the highest-precedence file for this environment. */
  readonly envFilePath: string;
  /** Every file read for this environment, lowest precedence first. */
  readonly readPaths: readonly string[];
  readonly config: PackConfigRecord | undefined;
}

type PathsOutcome =
  | { readonly kind: 'ok'; readonly paths: ResolvedPaths }
  | (CommandResult & { readonly kind: 'error' });

/**
 * The env files for `--env` (default `staging`). `local` is the
 * project's own files (`.env`, `.env.local`, or `dev.envFiles`); any
 * other environment is `.env.<envName>`.
 */
async function resolvePaths(ctx: CommandContext): Promise<PathsOutcome> {
  const pathFlag = ctx.options.path;
  const rawPath = typeof pathFlag === 'string' && pathFlag !== '' ? pathFlag : ctx.cwd;
  const packDir = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
  const envFlag = ctx.options.env;
  const envName = typeof envFlag === 'string' && envFlag !== '' ? envFlag : 'staging';
  const settings = await loadLocalEnvSettings(ctx, packDir);
  if (settings.kind === 'error') {
    return { kind: 'error', stderr: `kindgi env: ${settings.message}\n`, exitCode: 1 };
  }
  const files = resolvePackEnvFiles({
    packDir,
    envName,
    ...(settings.localEnvFiles !== undefined && { localEnvFiles: settings.localEnvFiles }),
  });
  return {
    kind: 'ok',
    paths: {
      packDir,
      envName,
      envFilePath: files.write,
      readPaths: files.read,
      config: settings.config,
    },
  };
}

/** Read every file for the environment as one merged, expanded view. */
async function readFileView(
  ctx: CommandContext,
  runners: EnvRunners,
  paths: ResolvedPaths,
): Promise<LayeredEnv> {
  const layers = await Promise.all(
    paths.readPaths.map(async (source) => ({ source, contents: await runners.readFile(source) })),
  );
  return readEnvLayers(layers, { env: ctx.env });
}

const shown = (paths: ResolvedPaths, file: string): string => displayEnvPath(paths.packDir, file);

function pickRunners(
  ctx: CommandContext,
):
  | { readonly kind: 'ok'; readonly runners: EnvRunners }
  | (CommandResult & { readonly kind: 'error' }) {
  if (ctx.envRunners !== undefined) return { kind: 'ok', runners: ctx.envRunners };
  return {
    kind: 'error',
    stderr:
      'Internal error: kindgi env requires env runners to be wired. ' +
      'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
    exitCode: 1,
  };
}

/**
 * `environments.<envName>.env` from `kindgi.config.ts`. A missing or
 * unloadable config contributes nothing — `kindgi env list` still
 * shows the env files.
 */
function configEnvBlock(
  config: PackConfigRecord | undefined,
  envName: string,
): Record<string, string> {
  if (config === undefined) return {};
  const envs = (config.environments ?? {}) as Record<string, Record<string, unknown>>;
  const block = envs[envName];
  if (block === undefined || typeof block !== 'object') return {};
  const env = block.env;
  if (env === undefined || typeof env !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------
// `kindgi env list`
// ---------------------------------------------------------------------

const listCmd: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List resolved env values for the target env (merges config + .env.<envName>).',
  usage: 'kindgi env list [--env <name>] [--reveal] [--force-reveal] [--path <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        "The environment: `local` is the project's own env files, any other name its `.env.<name>`. Default: `staging`.",
    },
    reveal: {
      type: 'boolean',
      description:
        "Print the values instead of redacting them. Refused when stdout isn't a terminal (a file, a pipe), unless `--force-reveal` is also given.",
    },
    'force-reveal': {
      type: 'boolean',
      description:
        "With `--reveal`, print the values even when stdout isn't a terminal (a file, a pipe, CI).",
    },
    path: {
      type: 'string',
      description: 'The pack root, where the env files are. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const resolved = await resolvePaths(ctx);
    if (resolved.kind === 'error') return resolved;
    const paths = resolved.paths;
    const reveal = ctx.options.reveal === true;
    const forceReveal = ctx.options['force-reveal'] === true;

    // Reveal gate: the values go to stdout, so stdout must be a terminal
    // (not a file or a pipe) unless --force-reveal says otherwise.
    const stdoutIsTty = typeof process.stdout.isTTY === 'boolean' ? process.stdout.isTTY : false;
    if (reveal && !stdoutIsTty && !forceReveal) {
      return {
        kind: 'error',
        stderr:
          'kindgi env list --reveal refuses to emit values to a non-TTY without ' +
          '--force-reveal. Piping raw secrets to a log file / CI capture is almost ' +
          'always accidental.\n',
        exitCode: 1,
      };
    }

    const view = await readFileView(ctx, runners, paths);
    const rows = listRows(paths, view, configEnvBlock(paths.config, paths.envName), reveal);
    const warnings = describeEnvDiagnostics(paths.packDir, view.diagnostics);

    const summary = {
      envName: paths.envName,
      packDir: paths.packDir,
      envFilePath: paths.envFilePath,
      envFiles: paths.readPaths.map((p) => ({
        file: shown(paths, p),
        exists: view.present.includes(p),
      })),
      reveal,
      count: rows.length,
      values: rows,
      ...(warnings.length > 0 && { warnings }),
    };

    const bannerLines = listBanner(paths.envName, summary.envFiles, reveal, rows, warnings);
    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: `${bannerLines.join('\n')}\n` },
    };
  },
};

interface ListRow {
  readonly key: string;
  readonly value: string;
  readonly source: 'env-file' | 'config';
  readonly file?: string;
  readonly runtime: boolean;
  readonly inFile: boolean;
  readonly inConfig: boolean;
}

/**
 * One row per key. The env files override `environments.<name>.env`
 * entries — the same shape `kindgi deploy`'s secrets-sync path uses.
 */
function listRows(
  paths: ResolvedPaths,
  view: LayeredEnv,
  configBlock: Readonly<Record<string, string>>,
  reveal: boolean,
): ListRow[] {
  const keys = new Set([...Object.keys(configBlock), ...Object.keys(view.values)]);
  return [...keys].sort().map((key) => {
    const inFile = Object.hasOwn(view.values, key);
    const rawValue = (inFile ? view.values[key] : configBlock[key]) ?? '';
    return {
      key,
      value: reveal ? rawValue : redact(rawValue),
      source: inFile ? 'env-file' : 'config',
      ...(inFile && { file: shown(paths, view.origin[key] ?? '') }),
      runtime: isRuntimeKey(key),
      inFile,
      inConfig: Object.hasOwn(configBlock, key),
    };
  });
}

function listBanner(
  envName: string,
  envFiles: readonly { readonly file: string; readonly exists: boolean }[],
  reveal: boolean,
  rows: readonly ListRow[],
  warnings: readonly string[],
): string[] {
  const lines: string[] = ['', `  Environment: ${envName}`];
  for (const f of envFiles) {
    lines.push(`  Env file:    ${f.file}${f.exists ? '' : '  (does not exist)'}`);
  }
  lines.push(`  Reveal:      ${reveal ? 'YES (values shown)' : 'NO (redacted; --reveal to show)'}`);
  lines.push('');
  lines.push(rows.length === 0 ? '  (no keys resolved)' : `  ${rows.length} key(s):`);
  for (const row of rows) {
    const where = row.file ?? row.source;
    const tag = row.runtime ? `${where}, Kindgi runtime` : where;
    lines.push(`    ${row.key.padEnd(24, ' ')} ${row.value}    [${tag}]`);
  }
  if (warnings.length > 0) {
    lines.push('', `  ⚠ ${warnings.length} warning(s):`, ...warnings.map((w) => `      ${w}`));
  }
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------------
// `kindgi env set <KEY> <VALUE>`
// ---------------------------------------------------------------------

const setCmd: LeafCommand = {
  kind: 'leaf',
  name: 'set',
  description: 'Set a KEY=VALUE in .env.<envName>. Refuses to overwrite unless --force.',
  usage: 'kindgi env set <KEY> <VALUE> [--env <name>] [--force] [--path <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        "The environment: `local` is the project's own env files, any other name its `.env.<name>`. Default: `staging`.",
    },
    force: {
      type: 'boolean',
      description:
        'Change a key an env file already sets: overwrite it, or override a lower-precedence file. By default `set` refuses.',
    },
    path: {
      type: 'string',
      description: 'The pack root, where the env files are. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const key = ctx.positionals[0];
    const value = ctx.positionals[1];
    if (typeof key !== 'string' || key === '') {
      return {
        kind: 'error',
        stderr:
          'Missing required argument: <KEY>.\n' +
          'Usage: kindgi env set <KEY> <VALUE> [--env <name>] [--force]\n',
        exitCode: 2,
      };
    }
    if (typeof value !== 'string') {
      return {
        kind: 'error',
        stderr:
          'Missing required argument: <VALUE>.\n' +
          'Usage: kindgi env set <KEY> <VALUE> [--env <name>] [--force]\n',
        exitCode: 2,
      };
    }
    if (!ENV_KEY_REGEX.test(key)) {
      return {
        kind: 'error',
        stderr: `Invalid KEY: "${key}". Must match ${ENV_KEY_REGEX.source} — POSIX-shell env-var shape (upper-snake, starting with letter or underscore).\n`,
        exitCode: 1,
      };
    }
    if (isRefusedKey(key)) {
      return {
        kind: 'error',
        stderr: `kindgi env refuses to manage "${key}" — reserved for framework runtime config.\nReserved prefixes: ${REFUSED_KEY_PREFIXES.join(', ')}.\nSet framework env directly (e.g. via your shell / secrets manager); .env.<envName> is for pack-level values.\n`,
        exitCode: 1,
      };
    }

    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const resolved = await resolvePaths(ctx);
    if (resolved.kind === 'error') return resolved;
    const paths = resolved.paths;
    const view = await readFileView(ctx, runners, paths);
    const raw = (await runners.readFile(paths.envFilePath)) ?? '';
    if (ctx.options.force !== true) {
      const refusal = refuseExistingKey(paths, view, key);
      if (refusal !== undefined) return refusal;
    }
    const next = trySetKey(raw, key, value);
    if (next.kind === 'error') return next;
    await runners.writeFile(paths.envFilePath, next.contents);

    const summary = {
      envName: paths.envName,
      envFilePath: paths.envFilePath,
      key,
      overwritten: next.overwritten,
      created: raw === '',
    };
    const banner = [
      '',
      `  ✓ ${next.overwritten ? 'Updated' : 'Wrote'} ${key} in ${paths.envFilePath}`,
      '',
    ].join('\n');
    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: `${banner}\n` },
    };
  },
};

/** Refuse to change a key some env file already defines (unless --force). */
function refuseExistingKey(
  paths: ResolvedPaths,
  view: LayeredEnv,
  key: string,
): (CommandResult & { readonly kind: 'error' }) | undefined {
  if (!Object.hasOwn(view.values, key)) return undefined;
  const definedIn = view.origin[key] ?? paths.envFilePath;
  const effect =
    definedIn === paths.envFilePath
      ? 'overwrite it'
      : `write an override to ${shown(paths, paths.envFilePath)}, which takes precedence`;
  return {
    kind: 'error',
    stderr:
      `kindgi env set refuses to change ${key}, already set in ${shown(paths, definedIn)} ` +
      `(value: ${redact(view.values[key] ?? '')}). Re-run with --force to ${effect}.\n`,
    exitCode: 1,
  };
}

function trySetKey(
  raw: string,
  key: string,
  value: string,
):
  | ({ readonly kind: 'ok' } & ReturnType<typeof setKey>)
  | (CommandResult & { readonly kind: 'error' }) {
  try {
    return { kind: 'ok', ...setKey(raw, key, value) };
  } catch (err) {
    if (!(err instanceof EnvValueNotRepresentableError)) throw err;
    return { kind: 'error', stderr: `kindgi env set: ${err.message}\n`, exitCode: 1 };
  }
}

// ---------------------------------------------------------------------
// `kindgi env unset <KEY>`
// ---------------------------------------------------------------------

const unsetCmd: LeafCommand = {
  kind: 'leaf',
  name: 'unset',
  description: 'Remove KEY from .env.<envName>. Idempotent — no error if the key is absent.',
  usage: 'kindgi env unset <KEY> [--env <name>] [--path <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        "The environment: `local` is the project's own env files, any other name its `.env.<name>`. Default: `staging`.",
    },
    path: {
      type: 'string',
      description: 'The pack root, where the env files are. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const key = ctx.positionals[0];
    if (typeof key !== 'string' || key === '') {
      return {
        kind: 'error',
        stderr:
          'Missing required argument: <KEY>.\n' + 'Usage: kindgi env unset <KEY> [--env <name>]\n',
        exitCode: 2,
      };
    }
    if (isRefusedKey(key)) {
      return {
        kind: 'error',
        stderr: `kindgi env refuses to manage "${key}" — reserved for framework runtime config.\n`,
        exitCode: 1,
      };
    }

    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const resolved = await resolvePaths(ctx);
    if (resolved.kind === 'error') return resolved;
    const paths = resolved.paths;
    const raw = await runners.readFile(paths.envFilePath);
    // Idempotent: a missing file means nothing to remove.
    const next = raw === null ? { contents: '', removed: false } : unsetKey(raw, key);
    if (raw !== null) await runners.writeFile(paths.envFilePath, next.contents);

    // Kindgi edits only the file it writes to. A lower-precedence file
    // (e.g. the app's own `.env`) that still defines the key is left
    // alone — say so, because the key is still set.
    const after = await readFileView(ctx, runners, paths);
    const stillDefinedIn = Object.hasOwn(after.values, key)
      ? shown(paths, after.origin[key] ?? '')
      : undefined;
    const summary = {
      envName: paths.envName,
      envFilePath: paths.envFilePath,
      key,
      removed: next.removed,
      ...(raw === null && { note: 'file did not exist' }),
      ...(stillDefinedIn !== undefined && { stillDefinedIn }),
    };
    const still =
      stillDefinedIn !== undefined
        ? `  ! ${key} is still set in ${stillDefinedIn} — kindgi env only edits ${shown(paths, paths.envFilePath)}.\n`
        : '';
    const outcome =
      raw === null
        ? `${paths.envFilePath} does not exist — no change.`
        : next.removed
          ? `Removed ${key} from ${paths.envFilePath}`
          : `${key} was not present in ${paths.envFilePath} — no change.`;
    const banner = `\n  ✓ ${outcome}\n${still}\n`;
    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: banner },
    };
  },
};

// ---------------------------------------------------------------------
// `kindgi env pull` — WIRED via /v1/env/*
// ---------------------------------------------------------------------

/**
 * Fold pulled values into the write target. A key any env file already
 * defines is skipped unless `overwrite`; runtime (`KINDGI_*`) and
 * non-POSIX names are always skipped.
 */
function mergeRemote(
  raw: string,
  existing: Readonly<Record<string, string>>,
  remote: readonly { readonly name: string; readonly value: string }[],
  overwrite: boolean,
): { contents: string; added: string[]; overwritten: string[]; skipped: string[] } {
  let contents = raw;
  const added: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const rec of remote) {
    const writable = !isRefusedKey(rec.name) && ENV_KEY_REGEX.test(rec.name);
    if (!writable || (Object.hasOwn(existing, rec.name) && !overwrite)) {
      skipped.push(rec.name);
      continue;
    }
    const next = setKey(contents, rec.name, rec.value);
    contents = next.contents;
    (next.overwritten ? overwritten : added).push(rec.name);
  }
  return { contents, added, overwritten, skipped };
}

const pullCmd: LeafCommand = {
  kind: 'leaf',
  name: 'pull',
  description:
    'Fetch remote env values via /v1/env/* and merge into .env.<envName>. Requires --scope.',
  usage: 'kindgi env pull [--env <name>] --scope=<kind>[:id] [--path <dir>] [--overwrite-existing]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        "The environment to pull, written to its `.env.<name>` (`local`: the project's own env files). Default: `staging`.",
    },
    path: {
      type: 'string',
      description: 'The pack root, where the env files are. Default: the current directory.',
    },
    scope: {
      type: 'string',
      description:
        'Whose values to pull: `tenant`, `org:<orgId>` or `project:<projectId>`. Required.',
    },
    'overwrite-existing': {
      type: 'boolean',
      description: 'Replace keys an env file already sets. By default they are skipped.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const runnersOutcome = pickRunners(ctx);
    if (runnersOutcome.kind === 'error') return runnersOutcome;
    const runners = runnersOutcome.runners;

    const resolved = await resolvePaths(ctx);
    if (resolved.kind === 'error') return resolved;
    const paths = resolved.paths;
    const scopeResult = parseScope(stringFlag(ctx, 'scope'));
    if (scopeResult.kind === 'err') {
      return { kind: 'error', stderr: scopeResult.stderr, exitCode: 2 };
    }
    const overwrite = ctx.options['overwrite-existing'] === true;

    try {
      const remote = await pullAllPages(
        ctx,
        scopeResult.scope,
        paths.envName as unknown as EnvName,
      );
      const raw = (await runners.readFile(paths.envFilePath)) ?? '';
      const existing = (await readFileView(ctx, runners, paths)).values;
      const { contents, added, overwritten, skipped } = mergeRemote(
        raw,
        existing,
        remote,
        overwrite,
      );
      if (contents !== raw) {
        await runners.writeFile(paths.envFilePath, contents);
      }
      const summary = {
        envName: paths.envName,
        envFilePath: paths.envFilePath,
        fetched: remote.length,
        added: added.length,
        overwritten: overwritten.length,
        skipped: skipped.length,
        keys: { added, overwritten, skipped },
      };
      const banner = [
        '',
        `  Pulled ${remote.length} remote env value(s) for env=${paths.envName}, scope=${describeScope(scopeResult.scope)}.`,
        `    added:       ${added.length}`,
        `    overwritten: ${overwritten.length}  ${overwrite ? '' : '(pass --overwrite-existing to replace)'}`,
        `    skipped:     ${skipped.length}`,
        '',
      ].join('\n');
      const rendered = renderJson(summary, ctx.globals.format);
      return {
        kind: 'ok',
        rendered: { stdout: rendered.stdout, stderr: `${banner}\n` },
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi env pull');
    }
  },
};

interface EnvPullRecord {
  readonly name: string;
  readonly value: string;
}

async function pullAllPages(
  ctx: CommandContext,
  scope: Scope,
  envName: EnvName,
): Promise<readonly EnvPullRecord[]> {
  const out: EnvPullRecord[] = [];
  let cursor: string | undefined;
  const env = ctx.client().env;
  for (let i = 0; i < 1_000; i += 1) {
    const page = await env.list({
      scope,
      envName,
      ...(cursor !== undefined && { cursor: cursor as never }),
    });
    for (const rec of page.data) out.push({ name: rec.name, value: rec.value });
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor as unknown as string;
  }
  return out;
}

type ScopeParseResult =
  | { readonly kind: 'ok'; readonly scope: Scope }
  | { readonly kind: 'err'; readonly stderr: string };

function parseScope(raw: string | undefined): ScopeParseResult {
  if (raw === undefined) {
    return {
      kind: 'err',
      stderr:
        'Missing required flag: --scope=<kind>[:id].\n' +
        'Accepted forms:\n  --scope=tenant\n  --scope=org:<orgId>\n  --scope=project:<projectId>\n',
    };
  }
  const [kind, id] = raw.split(':');
  const tenantId = 'session-tenant' as unknown as Scope extends { tenantId: infer T } ? T : never;
  if (kind === 'tenant') {
    if (id !== undefined && id !== '') {
      return { kind: 'err', stderr: `Malformed --scope: tenant carries no id, got "${raw}".\n` };
    }
    return { kind: 'ok', scope: { kind: 'tenant', tenantId } };
  }
  if (kind === 'org') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=org:<orgId>, got "${raw}".\n`,
      };
    }
    return { kind: 'ok', scope: { kind: 'org', tenantId, orgId: id as never } };
  }
  if (kind === 'project') {
    if (id === undefined || id === '') {
      return {
        kind: 'err',
        stderr: `Malformed --scope: expected --scope=project:<projectId>, got "${raw}".\n`,
      };
    }
    return { kind: 'ok', scope: { kind: 'project', tenantId, projectId: id as never } };
  }
  return {
    kind: 'err',
    stderr: `Unknown --scope kind "${String(kind)}". Accepted: tenant, org:<orgId>, project:<projectId>.\n`,
  };
}

function describeScope(scope: Scope): string {
  if (scope.kind === 'tenant') return 'tenant';
  if (scope.kind === 'org') return `org:${scope.orgId as unknown as string}`;
  return `project:${scope.projectId as unknown as string}`;
}

// ---------------------------------------------------------------------
// init — scaffold `.env.example` for a deployment target
// ---------------------------------------------------------------------

/**
 * TTY seam for the interactive picker. Tests inject fixtures; production
 * leaves undefined and we spin up a real `readline.Interface`.
 */
export interface EnvInitInputSeam {
  /**
   * Prompt the user with a labeled multiple-choice question. Returns
   * the selected value. `undefined` return signals the user declined
   * / EOF / cancelled — caller decides what to do.
   */
  readonly promptChoice?: (
    question: string,
    choices: readonly string[],
  ) => Promise<string | undefined>;
  /** Injectable TTY-check for stdin. Tests force TTY / non-TTY. */
  readonly stdinIsTty?: () => boolean;
}

const SECRETS_BACKEND_CHOICES = ['none', 'postgres', 'secret-manager'] as const;
const SECRETS_BACKEND_KMS_CHOICES = ['gcp', 'aws', 'libsodium', 'vault'] as const;

const initCmd: LeafCommand = {
  kind: 'leaf',
  name: 'init',
  description:
    'Scaffold `.env.example` for a deployment target. Interactive prompt when flags omit an axis and stdin is a TTY.',
  usage:
    'kindgi env init [--secrets-backend=<none|postgres|secret-manager>] [--kms=<gcp|aws|libsodium|vault>] [--out=<path>] [--force] [--non-interactive]',
  optionSpec: {
    'secrets-backend': {
      type: 'string' as const,
      description:
        "The deployment's secrets backend: `none`, `postgres` or `secret-manager`. Asked for when omitted on a terminal.",
    },
    kms: {
      type: 'string' as const,
      description:
        'The KMS for the `postgres` or `secret-manager` backend: `gcp`, `aws`, `libsodium` or `vault`. Asked for when needed and omitted.',
    },
    out: {
      type: 'string' as const,
      description: 'Where to write the file. Default: `.env.example` in the current directory.',
    },
    force: {
      type: 'boolean' as const,
      description: 'Overwrite an existing file at the output path. By default `init` refuses.',
    },
    'non-interactive': {
      type: 'boolean' as const,
      description: 'Never prompt: fail when `--secrets-backend`, or a needed `--kms`, is missing.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const runnersRes = pickRunners(ctx);
    if (runnersRes.kind === 'error') return runnersRes;

    const backendFlag = stringFlag(ctx, 'secrets-backend');
    const kmsFlag = stringFlag(ctx, 'kms');
    const outFlag = stringFlag(ctx, 'out');
    const outPath =
      outFlag !== undefined && outFlag !== '' ? outFlag : join(ctx.cwd, '.env.example');
    const nonInteractive = ctx.options['non-interactive'] === true;

    // Validate flag values up-front.
    if (backendFlag !== undefined && !SECRETS_BACKEND_CHOICES.includes(backendFlag as never)) {
      return {
        kind: 'error',
        stderr: `--secrets-backend must be one of: ${SECRETS_BACKEND_CHOICES.join(', ')}. Got "${backendFlag}".\n`,
        exitCode: 2,
      };
    }
    if (kmsFlag !== undefined && !SECRETS_BACKEND_KMS_CHOICES.includes(kmsFlag as never)) {
      return {
        kind: 'error',
        stderr: `--kms must be one of: ${SECRETS_BACKEND_KMS_CHOICES.join(', ')}. Got "${kmsFlag}".\n`,
        exitCode: 2,
      };
    }

    // Resolve missing axes via interactive prompt or fail loud.
    const seam = ctx.envInitInputSeam ?? {};
    const stdinIsTty = seam.stdinIsTty ?? (() => Boolean((process.stdin as ReadStream).isTTY));

    let backend = backendFlag as EnvTarget['secretsBackend'] | undefined;
    let kms = kmsFlag as EnvTarget['secretsBackendKms'] | undefined;

    if (backend === undefined) {
      if (nonInteractive || !stdinIsTty()) {
        return {
          kind: 'error',
          stderr: `--secrets-backend is required in non-interactive mode. Choices: ${SECRETS_BACKEND_CHOICES.join(', ')}.\n`,
          exitCode: 2,
        };
      }
      const pick = await promptOnce(
        seam,
        'Which secrets backend?',
        SECRETS_BACKEND_CHOICES as unknown as readonly string[],
      );
      if (pick === undefined) {
        return { kind: 'error', stderr: 'Cancelled.\n', exitCode: 1 };
      }
      backend = pick as EnvTarget['secretsBackend'];
    }

    // Only prompt for KMS if backend needs it.
    const needsKms = backend === 'postgres' || backend === 'secret-manager';
    if (needsKms && kms === undefined) {
      if (nonInteractive || !stdinIsTty()) {
        return {
          kind: 'error',
          stderr: `--kms is required when --secrets-backend=${backend}. Choices: ${SECRETS_BACKEND_KMS_CHOICES.join(', ')}.\n`,
          exitCode: 2,
        };
      }
      const pick = await promptOnce(
        seam,
        `Which KMS / vendor for backend=${backend}?`,
        SECRETS_BACKEND_KMS_CHOICES as unknown as readonly string[],
      );
      if (pick === undefined) {
        return { kind: 'error', stderr: 'Cancelled.\n', exitCode: 1 };
      }
      kms = pick as EnvTarget['secretsBackendKms'];
    }

    const target: EnvTarget = {
      ...(backend !== undefined && { secretsBackend: backend }),
      ...(kms !== undefined && { secretsBackendKms: kms }),
    };

    // Refuse to overwrite an existing file unless --force.
    if (ctx.options.force !== true) {
      const existing = await runnersRes.runners.readFile(outPath);
      if (existing !== null) {
        return {
          kind: 'error',
          stderr: `Refusing to overwrite existing ${outPath}. Pass --force to replace it.\n`,
          exitCode: 1,
        };
      }
    }

    const vars = envVarsForTarget(target);
    const body = renderEnvExample(vars);
    try {
      await runnersRes.runners.writeFile(outPath, body);
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi env init');
    }

    const summary = {
      outPath,
      target,
      varsWritten: vars.length,
    };
    return {
      kind: 'ok',
      rendered: {
        stdout: renderJson(summary, ctx.globals.format).stdout,
        stderr: `\n  Wrote ${vars.length} env-var entries → ${outPath}\n  Target: ${JSON.stringify(target)}\n\n`,
      },
    };
  },
};

async function promptOnce(
  seam: EnvInitInputSeam,
  question: string,
  choices: readonly string[],
): Promise<string | undefined> {
  if (seam.promptChoice !== undefined) {
    return seam.promptChoice(question, choices);
  }
  return realPromptChoice(question, choices);
}

async function realPromptChoice(
  question: string,
  choices: readonly string[],
): Promise<string | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    process.stderr.write(`\n${question}\n`);
    for (let i = 0; i < choices.length; i += 1) {
      process.stderr.write(`  ${i + 1}) ${choices[i]}\n`);
    }
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Choose [1-${choices.length}]: `, (raw) => resolve(raw));
    });
    const trimmed = answer.trim();
    // Accept either the number (1-based) or the exact string.
    const asNumber = Number.parseInt(trimmed, 10);
    if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
      return choices[asNumber - 1];
    }
    if (choices.includes(trimmed)) return trimmed;
    return undefined;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------
// Group registration
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// `kindgi env plan`
// ---------------------------------------------------------------------

const planCmd: LeafCommand = {
  kind: 'leaf',
  name: 'plan',
  description:
    'Show the process env a deployed pack service gets in --env: each name the pack declares (env.required / env.optional) and its value or Secret Manager reference from environments.<name>.env. Prints Terraform input (default) or gcloud flags; exits 1 when a required name has no value or a secret is given in the clear.',
  usage: 'kindgi env plan [--env <name>] [--format=terraform|gcloud] [--path <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        'The environment to plan, from `environments.<name>.env` in `kindgi.config.ts`. Default: `staging`.',
    },
    format: {
      type: 'string',
      description:
        "The output: `terraform` (default) for Terraform input, or `gcloud` for `--update-env-vars` / `--update-secrets` flags (they add or replace the listed names, and leave the service's other variables alone).",
    },
    path: {
      type: 'string',
      description: 'The pack root, where `kindgi.config.ts` is. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const format = stringFlag(ctx, 'format') ?? 'terraform';
    if (format !== 'terraform' && format !== 'gcloud') {
      return {
        kind: 'error',
        stderr: `kindgi env plan: --format is terraform or gcloud, not "${format}"\n`,
        exitCode: 1,
      };
    }
    const resolved = await resolvePaths(ctx);
    if (resolved.kind === 'error') return resolved;
    const planned = planPackEnv(resolved.paths.config, resolved.paths.envName);
    if (planned.kind === 'err') {
      return { kind: 'error', stderr: `kindgi env plan: ${planned.message}\n`, exitCode: 1 };
    }
    const plan = planned.plan;
    const stdout = format === 'terraform' ? renderTerraform(plan) : renderGcloud(plan);
    const stderr = `${describePackEnvPlan(plan).join('\n')}\n`;
    const blocked = plan.missing.length > 0 || plan.problems.length > 0;
    return blocked
      ? { kind: 'error', stderr, exitCode: 1 }
      : { kind: 'ok', rendered: { stdout, stderr } };
  },
};

export const envCommand: Command = {
  kind: 'group',
  name: 'env',
  description: 'Manage per-environment values that resolve into `needs.env` at deploy time.',
  subcommands: [listCmd, setCmd, unsetCmd, pullCmd, initCmd, planCmd],
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function redact(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(value.length - 4, 3))}${value.slice(-2)}`;
}
