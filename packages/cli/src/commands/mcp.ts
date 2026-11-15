// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi mcp` — add / list / remove / presets subcommands that
 * manipulate `.mcp.json` at the pack root, plus the top-level
 * `kindgi mcp-launch` dispatcher that MCP clients (Claude Code,
 * Cursor, …) invoke as a subprocess. `add` with a connection preset
 * (`hubspot`, `asana`) instead registers the vendor's own MCP server at
 * the runtime, signed in as a connection.
 *
 * See:
 *   - `packages/cli/src/mcp/launcher.ts` — the launcher itself
 *   - `packages/cli/src/mcp/preset-loader.ts` — how presets load
 *   - `packages/cli/src/mcp/presets/README.md` — how to author a preset
 *   - `packages/cli/src/mcp/preset-types.ts` — audit metadata (`PresetAudit`)
 *
 * Design notes:
 *
 *   - `.mcp.json` at the pack root IS the canonical file. Claude Code
 *     reads it natively. Other clients (Cursor, VS Code, Windsurf,
 *     Claude Desktop) can bridge via their own small skill/rule that
 *     symlinks or copies this file into their expected location.
 *     There is NO `kindgi mcp sync` — the launcher invocation is
 *     client-agnostic, and the file's contents are the same shape every
 *     client accepts.
 *
 *   - The entry runs the PROJECT'S `kindgi` through its package manager
 *     (`pnpm exec kindgi mcp-launch …`, `npx --no -- kindgi …`, …) — the CLI
 *     is a project devDependency, never assumed on PATH, and never
 *     downloaded at spawn time. A Python pack has no npm project, so its
 *     entries run the `kindgi` on PATH.
 *
 *   - Server-name defaulting: `--secret=GRIEVANCE_DB_URL` becomes
 *     server name `grievance_db` (lowercase, non-alphanumeric → `_`,
 *     trailing `_url`/`_uri`/`_key`/`_token`/`_pat`/`_secret`/`_password`
 *     stripped). Override with `--server-name=<label>`.
 *
 *   - `mcp-launch` uses `--` in its `.mcp.json` args so the CLI's
 *     strict `parseArgs` treats every launcher flag as a positional.
 *     The launcher parses its own argv from scratch — matching the
 *     shape `packages/cli/src/mcp/launcher.ts:parseLauncherArgs`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { type KindgiConfig, packLanguage } from '@kindgi/handler-runtime';
import {
  describeUnreadable,
  displayEnvPath,
  packValues,
  readPackEnv,
} from '@kindgi/secrets-dotenv';

import type {
  Connection,
  KindgiClient,
  ListConnectionsFilter,
  RegisterMcpEndpointInput,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { loadLocalEnvSettings } from '../env/project-env.js';
import { extractKindgiError } from '../errors.js';
import { runLauncher } from '../mcp/launcher.js';
import {
  defaultPresetsRoot,
  getPreset,
  listPresetSummaries,
  loadPresets,
} from '../mcp/preset-loader.js';
import {
  type ConnectionPreset,
  type LaunchedPreset,
  type Preset,
  isConnectionPreset,
} from '../mcp/preset-types.js';
import { renderJson, successNote } from '../output.js';
import { type BinRunner, binCommand, detectBinRunner } from '../package-manager.js';
import { commandResultFromThrown, givenFlag, requiredPositional, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

// ---------------------------------------------------------------------
// `.mcp.json` shape — the canonical config every MCP client reads.
// ---------------------------------------------------------------------

interface McpJson {
  readonly mcpServers?: Readonly<Record<string, McpServerEntry>>;
  // Any keys we don't know about are preserved verbatim on write.
  readonly [key: string]: unknown;
}

interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function resolvePackDir(ctx: CommandContext): string {
  const flag = stringFlag(ctx, 'path');
  if (flag === undefined || flag === '') return ctx.cwd;
  return isAbsolute(flag) ? flag : resolve(ctx.cwd, flag);
}

async function readMcpJson(packDir: string): Promise<McpJson> {
  const path = join(packDir, '.mcp.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`.mcp.json at ${path} is not a JSON object`);
    }
    return parsed as McpJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeMcpJson(packDir: string, next: McpJson): Promise<string> {
  const path = join(packDir, '.mcp.json');
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Turn `GRIEVANCE_DB_URL` into `grievance_db` — lowercase, replace
 * non-alphanumeric with `_`, collapse repeats, strip trailing common
 * secret suffixes. Falls back to `kind` if the result is empty.
 */
export function defaultServerName(secretName: string, kind: string): string {
  let out = secretName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  for (const suffix of ['url', 'uri', 'key', 'token', 'pat', 'secret', 'password']) {
    if (out === suffix) {
      out = '';
      break;
    }
    if (out.endsWith(`_${suffix}`)) {
      out = out.slice(0, -(suffix.length + 1));
      break;
    }
  }
  out = out.replace(/^_+|_+$/g, '');
  return out === '' ? kind : out;
}

interface ScopeShape {
  readonly kind: 'tenant' | 'org' | 'project';
  readonly id?: string;
  readonly raw: string;
}

function parseScopeShape(raw: string): ScopeShape | null {
  const parts = raw.split(':');
  const kind = parts[0];
  if (kind !== 'tenant' && kind !== 'org' && kind !== 'project') return null;
  if (kind === 'tenant') {
    if (parts.length !== 1) return null;
    return { kind, raw };
  }
  const id = parts[1];
  if (parts.length !== 2 || id === undefined || id === '') return null;
  return { kind, id, raw };
}

/**
 * Build the `.mcp.json` server entry from a preset + user inputs. The
 * command runs the project-local `kindgi mcp-launch -- <launcher-flags>`
 * via `runner` (see `binCommand`) — a Python pack's runs the `kindgi` on
 * `PATH`. The `--` protects the launcher's flags
 * from the CLI's strict argv parser (see design note at top of file).
 */
export function buildMcpServerEntry(
  preset: LaunchedPreset,
  secretName: string,
  envName: string,
  scope: ScopeShape,
  runner: BinRunner,
): McpServerEntry {
  const launcherFlags: string[] = [`--runtime=${preset.runtime}`, `--package=${preset.package}`];
  for (const entry of preset.envMap) {
    // Only `$SECRET` is supported today; loader rejects everything else.
    const value = entry.from === '$SECRET' ? secretName : secretName;
    const scopeSuffix = scope.id !== undefined ? `:${scope.id}` : '';
    launcherFlags.push(
      `--env-map=${entry.child}=secret:${value}@${envName}:${scope.kind}${scopeSuffix}`,
    );
  }
  if (preset.hostRemap !== undefined) {
    launcherFlags.push(`--host-remap=${preset.hostRemap}`);
  }
  const kindgiArgs: string[] = ['mcp-launch', '--', ...launcherFlags];
  if (preset.defaultArgs.length > 0) {
    kindgiArgs.push('--', ...preset.defaultArgs);
  }
  const run = binCommand(runner, 'kindgi', kindgiArgs);
  return { command: run.command, args: [...run.args] };
}

// ---------------------------------------------------------------------
// `kindgi mcp add`
// ---------------------------------------------------------------------

const addCmd: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Add an MCP server from a preset. A preset the launcher runs goes into .mcp.json, with its secret read at start. A connection preset (`hubspot`, `asana`) is the vendor's own server: it's registered at the runtime, and signs in as each person's own connection to the app, or the company's (`--as company`).",
  usage:
    'kindgi mcp add <KIND> [--secret=<name>] [--as=<person|company>] [--env=<name>] [--scope=<kind>[:id]] [--server-name=<label>] [--path=<pack-dir>] [--force]',
  optionSpec: {
    secret: {
      type: 'string' as const,
      description:
        "The secret's name in the pack's env files for `--env`; the server gets its value at start, never `.mcp.json`. Required for a preset the launcher runs; a connection preset has none.",
    },
    as: {
      type: 'string' as const,
      description:
        "A connection preset's sign-in: `person`, each person's own connection to the app, or `company`, the company's. Its tools are listed with your own connection, or the company's. Only for a connection preset.",
    },
    env: {
      type: 'string' as const,
      description:
        "The environment whose env files hold the secret. Default: `local`. For a connection preset: the env of the connection its tools are listed with, needed only when there's one in more than one env.",
    },
    scope: {
      type: 'string' as const,
      description:
        "The secret's scope, recorded in the entry, or a connection preset's endpoint's scope at the runtime: `tenant` (default), `org:<id>` or `project:<id>`.",
    },
    'server-name': {
      type: 'string' as const,
      description:
        "The entry's name in `.mcp.json`. Default: derived from `--secret` (`MY_DB_URL` becomes `my_db`). For a connection preset: the endpoint's id at the runtime, by default the preset's kind.",
    },
    path: {
      type: 'string' as const,
      description:
        'The pack root, where `.mcp.json` is. Default: the current directory. Not for a connection preset.',
    },
    force: {
      type: 'boolean' as const,
      description:
        'Replace an entry with the same name, or, for a connection preset, an endpoint with the same id. By default `add` refuses.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    let kind: string;
    try {
      kind = requiredPositional(ctx, 0, 'KIND');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }
    const resolved = await resolvePreset(ctx, kind);
    if (resolved.kind === 'error') return resolved.result;
    const { preset } = resolved;
    if (isConnectionPreset(preset)) return addConnectionPreset(ctx, preset);
    const secretName = stringFlag(ctx, 'secret');
    if (secretName === undefined || secretName === '') {
      return {
        kind: 'error',
        stderr: 'Missing required --secret=<name>.\n',
        exitCode: 2,
      };
    }
    const envName = stringFlag(ctx, 'env') ?? 'local';
    const scopeRaw = stringFlag(ctx, 'scope') ?? 'tenant';
    const scope = parseScopeShape(scopeRaw);
    if (scope === null) {
      return {
        kind: 'error',
        stderr: `Bad --scope "${scopeRaw}". Accepted: tenant | org:<id> | project:<id>.\n`,
        exitCode: 2,
      };
    }

    const packDir = resolvePackDir(ctx);

    // Verify the secret is present in the env files for <envName>. Fails
    // loud with a fix pointer so the user isn't left wondering why the
    // launcher will fail at MCP-server spawn time.
    const setHint = `Run \`kindgi secrets set ${secretName} --env=${envName} --scope=${scope.raw}\` first.`;
    const settings = await loadLocalEnvSettings(ctx, packDir);
    if (settings.kind === 'error') {
      return { kind: 'error', stderr: `kindgi mcp: ${settings.message}\n`, exitCode: 2 };
    }
    const env = await readPackEnv({
      packDir,
      envName,
      ...(settings.localEnvFiles !== undefined && { localEnvFiles: settings.localEnvFiles }),
      env: ctx.env,
    });
    const label = (paths: readonly string[]): string =>
      paths.map((p) => displayEnvPath(packDir, p)).join(', ');
    if (env.unreadable.length > 0 && !Object.hasOwn(packValues(env.values), secretName)) {
      return {
        kind: 'error',
        stderr: `Couldn't check that ${secretName} is set: can't read ${describeUnreadable(packDir, env.unreadable)}. Run \`kindgi mcp add\` in a terminal of your own, where the env files can be read.\n`,
        exitCode: 1,
      };
    }
    if (env.present.length === 0) {
      return {
        kind: 'error',
        stderr: `No env files for env "${envName}" at ${packDir} (looked for ${label(env.files.read)}). ${setHint}\n`,
        exitCode: 2,
      };
    }
    const secrets = packValues(env.values);
    if (!Object.hasOwn(secrets, secretName)) {
      const available = Object.keys(secrets).sort().join(', ');
      return {
        kind: 'error',
        stderr: `Secret "${secretName}" not in ${label(env.present)}. Available: ${available === '' ? '(none)' : available}. ${setHint}\n`,
        exitCode: 2,
      };
    }

    const serverName = stringFlag(ctx, 'server-name') ?? defaultServerName(secretName, kind);
    const force = ctx.options.force === true;

    const mcpJson = await readMcpJson(packDir);
    const servers = { ...(mcpJson.mcpServers ?? {}) };
    if (servers[serverName] !== undefined && !force) {
      return {
        kind: 'error',
        stderr: `Server "${serverName}" already in .mcp.json. Re-run with --force to overwrite, or pick a different --server-name.\n`,
        exitCode: 1,
      };
    }
    const language =
      settings.config !== undefined ? packLanguage(settings.config as KindgiConfig) : 'node';
    const runner = await detectBinRunner(packDir, language, undefined, ctx.env);
    servers[serverName] = buildMcpServerEntry(preset, secretName, envName, scope, runner);
    const next: McpJson = { ...mcpJson, mcpServers: servers };
    const path = await writeMcpJson(packDir, next);

    const addRendered = renderJson(
      {
        serverName,
        preset: preset.kind,
        package: preset.package,
        runtime: preset.runtime,
        secret: secretName,
        envName,
        scope: scope.raw,
        audit: preset.audit,
        path,
      },
      ctx.globals.format,
    );
    return {
      kind: 'ok',
      rendered: {
        stdout: addRendered.stdout,
        stderr: successNote(
          ctx.globals.format,
          `\n  Added "${serverName}" (preset ${preset.kind}) to .mcp.json.\n  Restart your MCP client (Claude Code, Cursor, ...) to activate.\n\n`,
        ),
      },
    };
  },
};

/**
 * The preset `kind` names, or why `add` stops: no such preset, or `--as`
 * given for a preset the launcher runs.
 */
async function resolvePreset(
  ctx: CommandContext,
  kind: string,
): Promise<
  | { readonly kind: 'ok'; readonly preset: Preset }
  | { readonly kind: 'error'; readonly result: CommandResult }
> {
  const presetsResult = await loadPresets();
  if (presetsResult.kind === 'err') {
    return {
      kind: 'error',
      result: { kind: 'error', stderr: `${presetsResult.message}\n`, exitCode: 1 },
    };
  }
  const { presets } = presetsResult;
  const preset = getPreset(presets, kind);
  if (preset === null) {
    const available = Object.keys(presets).sort().join(', ');
    return {
      kind: 'error',
      result: usageError(
        `No preset "${kind}". Available: ${available === '' ? '(none)' : available}.`,
      ),
    };
  }
  if (ctx.options.as !== undefined && !isConnectionPreset(preset)) {
    const connectionKinds = Object.values(presets)
      .filter(isConnectionPreset)
      .map((p) => p.kind)
      .sort()
      .join(', ');
    return {
      kind: 'error',
      result: usageError(
        `--as is only for a connection preset (${connectionKinds}). "${kind}" is run by the launcher with the secret you name with --secret.`,
      ),
    };
  }
  return { kind: 'ok', preset };
}

// ---------------------------------------------------------------------
// `kindgi mcp add` with a connection preset
// ---------------------------------------------------------------------

type SignInAs = 'person' | 'company';

/** The flags only a preset the launcher runs takes. */
const LAUNCHED_ONLY_FLAGS = ['secret', 'path'] as const;

function usageError(message: string): CommandResult {
  return { kind: 'error', stderr: `${message}\n`, exitCode: 2 };
}

/**
 * Register a connection preset's server at the runtime the CLI points at,
 * with `auth: { scheme: 'connection', app, as }`, its tools listed with
 * the caller's own connection to the app (`--as person`) or the
 * company's (`--as company`). Nothing goes into `.mcp.json`: the runtime
 * reaches the vendor's server, a local MCP client never does.
 */
async function addConnectionPreset(
  ctx: CommandContext,
  preset: ConnectionPreset,
): Promise<CommandResult> {
  for (const flag of LAUNCHED_ONLY_FLAGS) {
    if (ctx.options[flag] !== undefined) {
      return usageError(
        `--${flag} is for a preset the launcher runs. "${preset.kind}" is ${preset.name}'s own server: it signs in as a ${preset.name} connection, and is registered at the runtime.`,
      );
    }
  }
  const asRaw = givenFlag(ctx, 'as') ?? 'person';
  if (asRaw !== 'person' && asRaw !== 'company') {
    return usageError(`Bad --as "${asRaw}". Accepted: person | company.`);
  }
  const as: SignInAs = asRaw;
  const scopeRaw = stringFlag(ctx, 'scope') ?? 'tenant';
  const scope = parseScopeShape(scopeRaw);
  if (scope === null) {
    return usageError(`Bad --scope "${scopeRaw}". Accepted: tenant | org:<id> | project:<id>.`);
  }
  const endpointId = givenFlag(ctx, 'server-name') ?? preset.kind;
  const envName = givenFlag(ctx, 'env');
  try {
    const client = ctx.client();
    const found = await catalogConnection(client, preset, as, envName);
    if (found.kind === 'none') return { kind: 'error', stderr: `${found.message}\n`, exitCode: 1 };
    const { connection } = found;
    const registered = await registerEndpoint(
      client,
      {
        endpointId,
        name: preset.name,
        transport: 'streamable-http',
        config: { transport: 'streamable-http', url: preset.url },
        auth: { scheme: 'connection', app: preset.app, as },
        catalogConnectionId: connection.connectionId,
        scope: scopeRef(scope),
      },
      ctx.options.force === true,
    );
    if (registered === 'already-registered') {
      return {
        kind: 'error',
        stderr: `Endpoint "${endpointId}" is already registered. Re-run with --force to replace it, or pick a different --server-name.\n`,
        exitCode: 1,
      };
    }
    const rendered = renderJson(
      {
        endpointId,
        preset: preset.kind,
        app: preset.app,
        as,
        url: preset.url,
        scope: scope.raw,
        catalogConnectionId: connection.connectionId,
        replaced: registered === 'replaced',
      },
      ctx.globals.format,
    );
    return {
      kind: 'ok',
      rendered: {
        stdout: rendered.stdout,
        stderr: successNote(ctx.globals.format, addedNote(preset, endpointId, as, connection)),
      },
    };
  } catch (err) {
    return commandResultFromThrown(err, ctx, 'mcp add');
  }
}

function addedNote(
  preset: ConnectionPreset,
  endpointId: string,
  as: SignInAs,
  connection: Connection,
): string {
  const whose =
    as === 'person'
      ? `each person's own ${preset.name} connection`
      : `the company's ${preset.name} connection`;
  const listedWith = as === 'person' ? 'yours' : "the company's";
  const reconnect =
    connection.state === 'needs-reconnecting'
      ? `\n  That connection needs reconnecting before its tools can be listed: kindgi connections connect ${preset.app} --reconnect=${connection.connectionId}${as === 'company' ? ' --for-company' : ''}`
      : '';
  return `\n  Registered "${endpointId}" (preset ${preset.kind}) at the runtime: it signs in as ${whose}.\n  Its tools are listed with ${listedWith} (${connection.connectionId}).${reconnect}\n\n`;
}

type FoundConnection =
  | { readonly kind: 'found'; readonly connection: Connection }
  | { readonly kind: 'none'; readonly message: string };

/**
 * The connection a connection preset's tools are listed with: the
 * caller's own to the app (`person`) or the company's (`company`), one
 * not being removed. An app whose entry reads no account has one per
 * owner and env, so more than one is more than one env, and `--env`
 * picks the runtime's.
 */
async function catalogConnection(
  client: KindgiClient,
  preset: ConnectionPreset,
  as: SignInAs,
  envName: string | undefined,
): Promise<FoundConnection> {
  const ownerKind = as === 'person' ? 'member' : 'company';
  const listed = await listAllConnections(client, {
    app: preset.app,
    ...(as === 'person' && { owner: 'me' as const }),
    ownerKind,
  });
  const usable = listed.filter(
    (c) =>
      c.app === preset.app &&
      c.owner.kind === ownerKind &&
      (c.state === 'working' || c.state === 'needs-reconnecting') &&
      (envName === undefined || c.envName === envName),
  );
  const whose = as === 'person' ? 'of yours' : "of the company's";
  const [only, ...more] = usable;
  if (only === undefined) {
    const connect = `kindgi connections connect ${preset.app}${as === 'company' ? ' --for-company' : ''}`;
    const inEnv = envName !== undefined ? ` in env "${envName}"` : '';
    return {
      kind: 'none',
      message: `No ${preset.name} connection ${whose}${inEnv} to list its tools with. Run \`${connect}\`${as === 'company' ? ' (a tenant admin)' : ''} first, then this again.`,
    };
  }
  if (more.length === 0) return { kind: 'found', connection: only };
  const envs = [...new Set(usable.map((c) => c.envName))].sort();
  return {
    kind: 'none',
    message:
      envs.length > 1
        ? `More than one ${preset.name} connection ${whose}, in envs ${envs.join(', ')}. Name the runtime's env with --env=<name>.`
        : `More than one ${preset.name} connection ${whose} in env "${envs[0]}": ${usable.map((c) => c.connectionId).join(', ')}. Disconnect the ones not used (\`kindgi connections disconnect <connection-id>\`), then this again.`,
  };
}

/** Every connection `query` lists, page by page. */
async function listAllConnections(
  client: KindgiClient,
  query: Omit<ListConnectionsFilter, 'limit' | 'cursor'>,
): Promise<Connection[]> {
  const listed: Connection[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.connections.list({
      ...query,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    listed.push(...page.data);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return listed;
}

/**
 * Register the endpoint. One already registered under its id is
 * `already-registered`, or, with `force`, unregistered and registered
 * again: `replaced`.
 */
async function registerEndpoint(
  client: KindgiClient,
  input: RegisterMcpEndpointInput,
  force: boolean,
): Promise<'registered' | 'replaced' | 'already-registered'> {
  try {
    await client.mcp.endpoints.register(input);
    return 'registered';
  } catch (err) {
    const wire = extractKindgiError(err);
    const serverCode = wire !== null && 'serverCode' in wire ? wire.serverCode : undefined;
    if (serverCode !== 'mcp-endpoint-already-registered') throw err;
    if (!force) return 'already-registered';
  }
  await client.mcp.endpoints.unregister(input.endpointId);
  await client.mcp.endpoints.register(input);
  return 'replaced';
}

function scopeRef(scope: ScopeShape): RegisterMcpEndpointInput['scope'] {
  if (scope.kind === 'tenant' || scope.id === undefined) return { kind: 'tenant' };
  return scope.kind === 'org'
    ? { kind: 'org', orgId: scope.id }
    : { kind: 'project', projectId: scope.id };
}

// ---------------------------------------------------------------------
// `kindgi mcp list`
// ---------------------------------------------------------------------

const listCmd: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List MCP servers configured in .mcp.json.',
  usage: 'kindgi mcp list [--path=<pack-dir>]',
  optionSpec: {
    path: {
      type: 'string' as const,
      description: 'The pack root, where `.mcp.json` is. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const packDir = resolvePackDir(ctx);
    const mcpJson = await readMcpJson(packDir);
    const servers = mcpJson.mcpServers ?? {};
    const rows = Object.entries(servers)
      .map(([name, entry]) => ({ name, command: entry.command, args: entry.args }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      kind: 'ok',
      rendered: renderJson({ path: join(packDir, '.mcp.json'), servers: rows }, ctx.globals.format),
    };
  },
};

// ---------------------------------------------------------------------
// `kindgi mcp remove`
// ---------------------------------------------------------------------

const removeCmd: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description: 'Remove a server entry from .mcp.json. Idempotent.',
  usage: 'kindgi mcp remove <SERVER_NAME> [--path=<pack-dir>]',
  optionSpec: {
    path: {
      type: 'string' as const,
      description: 'The pack root, where `.mcp.json` is. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    let serverName: string;
    try {
      serverName = requiredPositional(ctx, 0, 'SERVER_NAME');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }
    const packDir = resolvePackDir(ctx);
    const mcpJson = await readMcpJson(packDir);
    const servers = { ...(mcpJson.mcpServers ?? {}) };
    if (servers[serverName] === undefined) {
      const rendered = renderJson({ removed: false, serverName }, ctx.globals.format);
      return {
        kind: 'ok',
        rendered: {
          stdout: rendered.stdout,
          stderr: successNote(
            ctx.globals.format,
            `\n  No server "${serverName}" in .mcp.json (nothing to remove).\n\n`,
          ),
        },
      };
    }
    delete servers[serverName];
    const next: McpJson =
      Object.keys(servers).length === 0
        ? // Drop the empty mcpServers key entirely — leaves .mcp.json
          // tidy when the last server is removed.
          removeKey(mcpJson, 'mcpServers')
        : { ...mcpJson, mcpServers: servers };
    const path = await writeMcpJson(packDir, next);
    const rendered = renderJson({ removed: true, serverName, path }, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: {
        stdout: rendered.stdout,
        stderr: successNote(ctx.globals.format, `\n  Removed "${serverName}" from .mcp.json.\n\n`),
      },
    };
  },
};

function removeKey<T extends Record<string, unknown>>(obj: T, key: keyof T): T {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    next[k] = v;
  }
  return next as T;
}

// ---------------------------------------------------------------------
// `kindgi mcp presets`
// ---------------------------------------------------------------------

const presetsCmd: LeafCommand = {
  kind: 'leaf',
  name: 'presets',
  description:
    'List the MCP presets shipped with the CLI: the ones the launcher runs, and the connection presets (`auth: connection`).',
  usage: 'kindgi mcp presets',
  optionSpec: {},
  run: async (ctx): Promise<CommandResult> => {
    const result = await loadPresets();
    if (result.kind === 'err') {
      return { kind: 'error', stderr: `${result.message}\n`, exitCode: 1 };
    }
    return {
      kind: 'ok',
      rendered: renderJson(
        {
          root: defaultPresetsRoot(),
          presets: listPresetSummaries(result.presets),
        },
        ctx.globals.format,
      ),
    };
  },
};

// ---------------------------------------------------------------------
// The `mcp` group
// ---------------------------------------------------------------------

export const mcpCommand: Command = {
  kind: 'group',
  name: 'mcp',
  description:
    'Manage MCP servers: entries in .mcp.json (add / list / remove / presets), and connection presets registered at the runtime (add).',
  subcommands: [addCmd, listCmd, removeCmd, presetsCmd],
};

// ---------------------------------------------------------------------
// `kindgi mcp-launch` — top-level launcher dispatcher
// ---------------------------------------------------------------------

/**
 * MCP clients invoke this via `.mcp.json` — the project-local `kindgi`
 * run through the package manager, args `["mcp-launch", "--",
 * <launcher-flags>...]`. Everything after the
 * leading `--` is treated as positional by the CLI's strict parseArgs;
 * `runLauncher` then re-parses those positionals as its own argv.
 *
 * This command owns stdout/stderr for the entire subprocess lifetime —
 * the launcher spawns its child with `stdio: 'inherit'`, so the MCP
 * protocol stream flows: [MCP client] ↔ [kindgi mcp-launch] ↔
 * [MCP server subprocess] transparently.
 */
export const mcpLaunchCommand: LeafCommand = {
  kind: 'leaf',
  name: 'mcp-launch',
  description:
    'Spawn an MCP server subprocess with secrets injected from Kindgi. Invoked by MCP clients via .mcp.json — not for direct use.',
  usage:
    'kindgi mcp-launch -- --runtime=<npx|docker> --package=<name> --env-map=VAR=secret:NAME@env:scope [...] [-- <passthrough>]',
  optionSpec: {},
  run: async (ctx): Promise<CommandResult> => {
    const exitCode = await runLauncher(ctx.positionals);
    return exitCode === 0
      ? { kind: 'ok', rendered: { stdout: '', stderr: '' } }
      : { kind: 'error', stderr: '', exitCode };
  },
};
