// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `kindgi mcp` subcommands + helpers. Drives the real CLI
 * entry (`runCli`) against a tmp pack dir so `.mcp.json` reads/writes
 * hit real filesystem.
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildMcpServerEntry, defaultServerName } from '../src/commands/mcp.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { publishedCliSpec } from '../src/package-manager.js';
import { CLI_VERSION } from '../src/version-info.js';

let packDir: string;

beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-mcp-cli-'));
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
});

afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

function baseInputs(argv: readonly string[], extras: Partial<RunCliInputs> = {}): RunCliInputs {
  return {
    argv,
    env: {},
    cwd: packDir,
    home: '/tmp/fake-home',
    ...extras,
  };
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

describe('defaultServerName', () => {
  test('strips common credential suffixes', () => {
    expect(defaultServerName('GRIEVANCE_DB_URL', 'postgres')).toBe('grievance_db');
    expect(defaultServerName('ANTHROPIC_API_KEY', 'anthropic')).toBe('anthropic_api');
    expect(defaultServerName('GITHUB_PAT', 'github')).toBe('github');
    expect(defaultServerName('SLACK_BOT_TOKEN', 'slack')).toBe('slack_bot');
    expect(defaultServerName('DB_PASSWORD', 'postgres')).toBe('db');
    expect(defaultServerName('WEBHOOK_SECRET', 'webhook')).toBe('webhook');
  });

  test('lowercases and collapses non-alphanumeric', () => {
    expect(defaultServerName('My.Secret-Name', 'x')).toBe('my_secret_name');
  });

  test('falls back to kind on empty result', () => {
    expect(defaultServerName('_URL', 'postgres')).toBe('postgres');
    expect(defaultServerName('', 'github')).toBe('github');
  });
});

describe('buildMcpServerEntry', () => {
  const postgresPreset = {
    kind: 'postgres',
    runtime: 'docker' as const,
    package: 'crystaldba/postgres-mcp',
    envMap: [{ child: 'DATABASE_URI', from: '$SECRET' }],
    defaultArgs: ['--access-mode=restricted'],
    hostRemap: 'docker-desktop' as const,
    audit: {
      urlLeakInErrors: 'pending' as const,
      reviewedAt: null,
      version: null,
    },
  };

  test('runs the project-local kindgi via the package manager; launcher args protected by `--`', () => {
    const entry = buildMcpServerEntry(
      postgresPreset,
      'GRIEVANCE_DB_URL',
      'local',
      { kind: 'tenant', raw: 'tenant' },
      'pnpm',
    );
    expect(entry.command).toBe('pnpm');
    // Args: ["exec", "kindgi", "mcp-launch", "--", <launcher-flags>, "--", <defaultArgs>]
    expect(entry.args.slice(0, 4)).toEqual(['exec', 'kindgi', 'mcp-launch', '--']);
    expect(entry.args).toContain('--runtime=docker');
    expect(entry.args).toContain('--package=crystaldba/postgres-mcp');
    expect(entry.args).toContain('--env-map=DATABASE_URI=secret:GRIEVANCE_DB_URL@local:tenant');
    expect(entry.args).toContain('--host-remap=docker-desktop');
    expect(entry.args).toContain('--access-mode=restricted');
  });

  test('npm projects use `npx --no` — never a registry download of `kindgi`', () => {
    const entry = buildMcpServerEntry(
      postgresPreset,
      'X',
      'local',
      { kind: 'tenant', raw: 'tenant' },
      'npm',
    );
    expect(entry.command).toBe('npx');
    expect(entry.args.slice(0, 4)).toEqual(['--no', '--', 'kindgi', 'mcp-launch']);
  });

  test('a Python pack runs the published CLI through npx (no npm project to install it into)', () => {
    const entry = buildMcpServerEntry(
      postgresPreset,
      'X',
      'local',
      { kind: 'tenant', raw: 'tenant' },
      'path',
    );
    expect(entry.command).toBe('npx');
    expect(entry.args[0]).toBe('--yes');
    expect(entry.args[1]).toBe(publishedCliSpec(CLI_VERSION));
    expect(entry.args.slice(2, 4)).toEqual(['mcp-launch', '--']);
  });

  test('embeds project scope with id', () => {
    const entry = buildMcpServerEntry(
      postgresPreset,
      'X',
      'prod',
      { kind: 'project', id: 'pack-a', raw: 'project:pack-a' },
      'pnpm',
    );
    expect(entry.args).toContain('--env-map=DATABASE_URI=secret:X@prod:project:pack-a');
  });

  test('omits host-remap when preset does not carry one', () => {
    // Build without `hostRemap` at all — `exactOptionalPropertyTypes`
    // treats `{ hostRemap: undefined }` as different from an absent
    // key, and Preset's `hostRemap?` means "may be absent."
    const { hostRemap: _dropped, ...postgresWithoutHostRemap } = postgresPreset;
    const npxPreset = {
      ...postgresWithoutHostRemap,
      runtime: 'npx' as const,
      package: '@x/some-mcp',
      defaultArgs: [],
    };
    const entry = buildMcpServerEntry(
      npxPreset,
      'TOKEN',
      'local',
      { kind: 'tenant', raw: 'tenant' },
      'pnpm',
    );
    expect(entry.args.some((a) => a.startsWith('--host-remap='))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// `kindgi mcp add`
// ---------------------------------------------------------------------

describe('kindgi mcp add', () => {
  beforeEach(async () => {
    // Pre-populate .env.local so add's secret-existence check passes.
    await writeFile(
      join(packDir, '.env.local'),
      'GRIEVANCE_DB_URL=postgres://u:p@localhost:5432/bb\n',
      'utf8',
    );
  });

  test('writes an entry to .mcp.json using the postgres preset', async () => {
    // A pnpm project: the entry must run the project's own kindgi via pnpm.
    await writeFile(join(packDir, 'pnpm-lock.yaml'), '', 'utf8');
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    expect(out.exitCode).toBe(0);
    const raw = await readFile(join(packDir, '.mcp.json'), 'utf8');
    const mcpJson = JSON.parse(raw) as {
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };
    expect(mcpJson.mcpServers?.grievance_db).toBeDefined();
    const entry = mcpJson.mcpServers?.grievance_db;
    expect(entry?.command).toBe('pnpm');
    expect(entry?.args.slice(0, 3)).toEqual(['exec', 'kindgi', 'mcp-launch']);
    expect(entry?.args).toContain('--runtime=docker');
    expect(entry?.args).toContain('--env-map=DATABASE_URI=secret:GRIEVANCE_DB_URL@local:tenant');
  });

  test('a Python pack ([tool.kindgi] in pyproject.toml) gets the published CLI through npx', async () => {
    await rm(join(packDir, 'kindgi.config.ts'));
    await writeFile(
      join(packDir, 'pyproject.toml'),
      '[project]\nname = "ledger"\nversion = "0.1.0"\n\n[tool.kindgi.pack]\nid = "ledger"\nversion = "0.1.0"\n',
      'utf8',
    );
    // A lockfile above or beside the pack must not turn it into an npm project.
    await writeFile(join(packDir, 'package-lock.json'), '{}', 'utf8');
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    expect(out.exitCode).toBe(0);
    const mcpJson = JSON.parse(await readFile(join(packDir, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };
    const entry = mcpJson.mcpServers?.grievance_db;
    expect(entry?.command).toBe('npx');
    expect(entry?.args.slice(0, 1)).toEqual(['--yes']);
    expect(entry?.args[1]).toBe(publishedCliSpec(CLI_VERSION));
    expect(entry?.args.slice(2, 4)).toEqual(['mcp-launch', '--']);
  });

  test('prints restart hint to stderr on success', async () => {
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    expect(out.stderr).toContain('Restart your MCP client');
  });

  test('errors when --secret is missing', async () => {
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres']));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('--secret');
  });

  test('errors when secret not in .env.<envName>', async () => {
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=MISSING']));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('MISSING');
    expect(out.stderr).toContain('kindgi secrets set');
  });

  test('errors when kind is not a known preset', async () => {
    const out = await runCli(
      baseInputs(['mcp', 'add', 'nonexistent', '--secret=GRIEVANCE_DB_URL']),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('nonexistent');
    expect(out.stderr).toContain('Available:');
  });

  test('refuses to overwrite existing server without --force', async () => {
    await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('already');
    expect(out.stderr).toContain('--force');
  });

  test('overwrites when --force is set', async () => {
    await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    const out = await runCli(
      baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL', '--force']),
    );
    expect(out.exitCode).toBe(0);
  });

  test('honors --server-name to disambiguate two configs from the same preset', async () => {
    await writeFile(
      join(packDir, '.env.local'),
      'GRIEVANCE_DB_URL=x\nDECISIONS_DB_URL=y\n',
      'utf8',
    );
    await runCli(
      baseInputs([
        'mcp',
        'add',
        'postgres',
        '--secret=GRIEVANCE_DB_URL',
        '--server-name=grievance_db',
      ]),
    );
    const out = await runCli(
      baseInputs([
        'mcp',
        'add',
        'postgres',
        '--secret=DECISIONS_DB_URL',
        '--server-name=decisions_db',
      ]),
    );
    expect(out.exitCode).toBe(0);
    const raw = await readFile(join(packDir, '.mcp.json'), 'utf8');
    const mcpJson = JSON.parse(raw) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(mcpJson.mcpServers ?? {}).sort()).toEqual(['decisions_db', 'grievance_db']);
  });

  test('errors on malformed --scope', async () => {
    const out = await runCli(
      baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL', '--scope=cluster']),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('scope');
  });

  test('preserves unrelated keys in an existing .mcp.json', async () => {
    await writeFile(
      join(packDir, '.mcp.json'),
      JSON.stringify({
        someOtherKey: 'preserve-me',
        mcpServers: { other: { command: 'x', args: [] } },
      }),
      'utf8',
    );
    const out = await runCli(baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL']));
    expect(out.exitCode).toBe(0);
    const raw = await readFile(join(packDir, '.mcp.json'), 'utf8');
    const mcpJson = JSON.parse(raw) as {
      someOtherKey?: string;
      mcpServers?: Record<string, unknown>;
    };
    expect(mcpJson.someOtherKey).toBe('preserve-me');
    expect(Object.keys(mcpJson.mcpServers ?? {}).sort()).toEqual(['grievance_db', 'other']);
  });
});

// ---------------------------------------------------------------------
// `kindgi mcp list`
// ---------------------------------------------------------------------

describe('kindgi mcp list', () => {
  test('returns empty servers list when .mcp.json is absent', async () => {
    const out = await runCli(baseInputs(['mcp', 'list']));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { servers: unknown[] };
    expect(parsed.servers).toEqual([]);
  });

  test('lists servers from an existing .mcp.json sorted by name', async () => {
    await writeFile(
      join(packDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          zeta: { command: 'x', args: [] },
          alpha: { command: 'y', args: [] },
        },
      }),
      'utf8',
    );
    const out = await runCli(baseInputs(['mcp', 'list']));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { servers: Array<{ name: string }> };
    expect(parsed.servers.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});

// ---------------------------------------------------------------------
// `kindgi mcp remove`
// ---------------------------------------------------------------------

describe('kindgi mcp remove', () => {
  test('removes a named server and drops empty mcpServers key when last', async () => {
    await writeFile(
      join(packDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'x', args: [] } } }),
      'utf8',
    );
    const out = await runCli(baseInputs(['mcp', 'remove', 'alpha']));
    expect(out.exitCode).toBe(0);
    const raw = await readFile(join(packDir, '.mcp.json'), 'utf8');
    const mcpJson = JSON.parse(raw) as { mcpServers?: unknown };
    expect(mcpJson.mcpServers).toBeUndefined();
  });

  test('preserves other servers when removing one', async () => {
    await writeFile(
      join(packDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'x', args: [] },
          beta: { command: 'y', args: [] },
        },
      }),
      'utf8',
    );
    await runCli(baseInputs(['mcp', 'remove', 'alpha']));
    const raw = await readFile(join(packDir, '.mcp.json'), 'utf8');
    const mcpJson = JSON.parse(raw) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(mcpJson.mcpServers ?? {})).toEqual(['beta']);
  });

  test('idempotent when server is absent', async () => {
    await writeFile(join(packDir, '.mcp.json'), JSON.stringify({}), 'utf8');
    const out = await runCli(baseInputs(['mcp', 'remove', 'nothing']));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('nothing to remove');
  });
});

describe('kindgi mcp --quiet', () => {
  test('add, remove, and a remove with nothing to remove print nothing; the file changes as before', async () => {
    await writeFile(
      join(packDir, '.env.local'),
      'GRIEVANCE_DB_URL=postgres://u:p@localhost:5432/bb\n',
      'utf8',
    );
    const servers = async () =>
      Object.keys(
        (JSON.parse(await readFile(join(packDir, '.mcp.json'), 'utf8')) as { mcpServers?: object })
          .mcpServers ?? {},
      );
    const added = await runCli(
      baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL', '--quiet']),
    );
    expect(await servers()).toEqual(['grievance_db']);
    const removed = await runCli(baseInputs(['mcp', 'remove', 'grievance_db', '--quiet']));
    expect(await servers()).toEqual([]);
    const absent = await runCli(baseInputs(['mcp', 'remove', 'grievance_db', '--quiet']));
    for (const out of [added, removed, absent]) {
      expect([out.exitCode, out.stdout, out.stderr]).toEqual([0, '', '']);
    }
  });
});

// ---------------------------------------------------------------------
// `kindgi mcp add` with a connection preset
// ---------------------------------------------------------------------

const ANA_HUBSPOT = '3f1a9b77-3333-4c5d-8e6f-000000000003';
const COMPANY_ASANA = '3f1a9b77-3333-4c5d-8e6f-000000000005';

function connection(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    connectionId: ANA_HUBSPOT,
    envName: 'prod',
    appId: 'hubspot',
    app: 'hubspot',
    owner: { kind: 'member', userId: 'user-ana' },
    account: { id: 'user-ana', label: 'HubSpot' },
    permissions: ['mcp.tools'],
    state: 'working',
    connectedAt: '2026-11-15T01:00:00.000Z',
    createdAt: '2026-11-15T01:00:00.000Z',
    createdBy: 'user-ana',
    updatedAt: '2026-11-15T01:00:00.000Z',
    ...overrides,
  };
}

interface FakeRuntime {
  readonly client: Record<string, unknown>;
  readonly listed: unknown[];
  readonly registered: unknown[];
  readonly unregistered: string[];
}

function fakeRuntime(
  connections: readonly Record<string, unknown>[],
  register: (input: unknown) => Promise<unknown> = async () => ({}),
): FakeRuntime {
  const listed: unknown[] = [];
  const registered: unknown[] = [];
  const unregistered: string[] = [];
  const client = {
    connections: {
      list: async (query: unknown) => {
        listed.push(query);
        return { data: connections, hasMore: false };
      },
    },
    mcp: {
      endpoints: {
        register: async (input: unknown) => {
          registered.push(input);
          return register(input);
        },
        unregister: async (endpointId: string) => {
          unregistered.push(endpointId);
        },
      },
    },
  };
  return { client, listed, registered, unregistered };
}

function addWith(runtime: FakeRuntime, argv: readonly string[]) {
  return runCli(
    baseInputs(['mcp', 'add', ...argv, '--url=https://x', '--token=t'], {
      clientFactory: () => runtime.client as never,
    }),
  );
}

function alreadyRegistered(): KindgiApiError {
  return new KindgiApiError(
    fromWire(
      { code: 'mcp-endpoint-already-registered', message: 'Endpoint "hubspot" is registered' },
      409,
    ),
  );
}

describe('kindgi mcp add — connection presets', () => {
  test('hubspot registers at the runtime, signing in as each person, its tools listed with yours', async () => {
    const runtime = fakeRuntime([connection({})]);
    const out = await addWith(runtime, ['hubspot']);
    expect(out.exitCode).toBe(0);
    expect(runtime.listed).toEqual([
      { app: 'hubspot', owner: 'me', ownerKind: 'member', limit: 100 },
    ]);
    expect(runtime.registered).toEqual([
      {
        endpointId: 'hubspot',
        name: 'HubSpot',
        transport: 'streamable-http',
        config: { transport: 'streamable-http', url: 'https://mcp.hubspot.com' },
        auth: { scheme: 'connection', app: 'hubspot', as: 'person' },
        catalogConnectionId: ANA_HUBSPOT,
        scope: { kind: 'tenant' },
      },
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      endpointId: 'hubspot',
      preset: 'hubspot',
      app: 'hubspot',
      as: 'person',
      url: 'https://mcp.hubspot.com',
      scope: 'tenant',
      catalogConnectionId: ANA_HUBSPOT,
      replaced: false,
    });
    expect(out.stderr).toContain("it signs in as each person's own HubSpot connection");
    expect(out.stderr).toContain(`Its tools are listed with yours (${ANA_HUBSPOT})`);
    await expect(access(join(packDir, '.mcp.json'))).rejects.toThrow();
  });

  test('asana --as=company, in a project, under its own id', async () => {
    const runtime = fakeRuntime([
      connection({
        connectionId: COMPANY_ASANA,
        appId: 'asana',
        app: 'asana',
        owner: { kind: 'company' },
        account: { id: 'company', label: 'Asana' },
      }),
    ]);
    const out = await addWith(runtime, [
      'asana',
      '--as=company',
      '--scope=project:p1',
      '--server-name=asana-ops',
    ]);
    expect(out.exitCode).toBe(0);
    expect(runtime.listed).toEqual([{ app: 'asana', ownerKind: 'company', limit: 100 }]);
    expect(runtime.registered).toEqual([
      {
        endpointId: 'asana-ops',
        name: 'Asana',
        transport: 'streamable-http',
        config: { transport: 'streamable-http', url: 'https://mcp.asana.com/v2/mcp' },
        auth: { scheme: 'connection', app: 'asana', as: 'company' },
        catalogConnectionId: COMPANY_ASANA,
        scope: { kind: 'project', projectId: 'p1' },
      },
    ]);
    expect(out.stderr).toContain("it signs in as the company's Asana connection");
    expect(out.stderr).toContain(`listed with the company's (${COMPANY_ASANA})`);
  });

  test('a connection that needs reconnecting is used, with the hint to reconnect it', async () => {
    const runtime = fakeRuntime([connection({ state: 'needs-reconnecting' })]);
    const out = await addWith(runtime, ['hubspot']);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain(`kindgi connections connect hubspot --reconnect=${ANA_HUBSPOT}`);
  });

  test('with no connection of yours, it says how to connect, and registers nothing', async () => {
    const runtime = fakeRuntime([]);
    const out = await addWith(runtime, ['hubspot']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'No HubSpot connection of yours to list its tools with. Run `kindgi connections connect hubspot` first',
    );
    expect(runtime.registered).toEqual([]);
  });

  test("with no company connection, it says a tenant admin connects the company's", async () => {
    const runtime = fakeRuntime([]);
    const out = await addWith(runtime, ['asana', '--as=company', '--env=prod']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'No Asana connection of the company\'s in env "prod" to list its tools with. Run `kindgi connections connect asana --for-company` (a tenant admin) first',
    );
    expect(runtime.registered).toEqual([]);
  });

  test("removed and removing connections, another app's and another owner's are not used", async () => {
    const runtime = fakeRuntime([
      connection({ state: 'removed' }),
      connection({ state: 'removing' }),
      connection({ app: 'asana', appId: 'asana' }),
      connection({ owner: { kind: 'company' } }),
    ]);
    const out = await addWith(runtime, ['hubspot']);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No HubSpot connection of yours');
    expect(runtime.registered).toEqual([]);
  });

  test('connections in two envs need --env, which picks one', async () => {
    const staging = '3f1a9b77-3333-4c5d-8e6f-000000000006';
    const both = [connection({}), connection({ connectionId: staging, envName: 'staging' })];
    const refused = await addWith(fakeRuntime(both), ['hubspot']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "More than one HubSpot connection of yours, in envs prod, staging. Name the runtime's env with --env=<name>.",
    );
    const runtime = fakeRuntime(both);
    const out = await addWith(runtime, ['hubspot', '--env=staging']);
    expect(out.exitCode).toBe(0);
    expect(runtime.registered).toMatchObject([{ catalogConnectionId: staging }]);
  });

  test('an endpoint already registered is kept without --force, and replaced with it', async () => {
    const kept = fakeRuntime([connection({})], async () => {
      throw alreadyRegistered();
    });
    const refused = await addWith(kept, ['hubspot']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      'Endpoint "hubspot" is already registered. Re-run with --force to replace it, or pick a different --server-name.',
    );
    expect(kept.unregistered).toEqual([]);

    let calls = 0;
    const replaced = fakeRuntime([connection({})], async () => {
      calls += 1;
      if (calls === 1) throw alreadyRegistered();
      return {};
    });
    const out = await addWith(replaced, ['hubspot', '--force']);
    expect(out.exitCode).toBe(0);
    expect(replaced.unregistered).toEqual(['hubspot']);
    expect(replaced.registered).toHaveLength(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ replaced: true });
  });

  test("the runtime's refusal is passed on", async () => {
    const runtime = fakeRuntime([connection({})], async () => {
      throw new KindgiApiError(
        fromWire(
          {
            code: 'invalid-mcp-endpoint',
            message: "The server does not name the entry's issuer",
            details: { reason: 'issuer-mismatch' },
          },
          400,
        ),
      );
    });
    const out = await addWith(runtime, ['hubspot']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("The server does not name the entry's issuer");
  });

  test.each([
    [['--secret=HUBSPOT_TOKEN'], '--secret is for a preset the launcher runs'],
    [['--path=.'], '--path is for a preset the launcher runs'],
    [['--as=team'], 'Bad --as "team". Accepted: person | company.'],
    [['--scope=team:1'], 'Bad --scope "team:1"'],
  ])('refuses %j', async (flags, message) => {
    const runtime = fakeRuntime([connection({})]);
    const out = await addWith(runtime, ['hubspot', ...flags]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(message);
    expect(runtime.listed).toEqual([]);
  });

  test('--as on a preset the launcher runs is refused', async () => {
    const out = await runCli(
      baseInputs(['mcp', 'add', 'postgres', '--secret=GRIEVANCE_DB_URL', '--as=person']),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      '--as is only for a connection preset (asana, hubspot). "postgres" is run by the launcher',
    );
  });
});

// ---------------------------------------------------------------------
// `kindgi mcp presets`
// ---------------------------------------------------------------------

describe('kindgi mcp presets', () => {
  test('lists at least the postgres preset shipped in the repo', async () => {
    const out = await runCli(baseInputs(['mcp', 'presets']));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      presets: Array<{ kind: string; runtime: string; package: string }>;
    };
    const kinds = parsed.presets.map((p) => p.kind);
    expect(kinds).toContain('postgres');
    const postgres = parsed.presets.find((p) => p.kind === 'postgres');
    expect(postgres?.runtime).toBe('docker');
    expect(postgres?.package).toBe('crystaldba/postgres-mcp');
  });

  test('lists the hubspot and asana connection presets with their app and URL', async () => {
    const out = await runCli(baseInputs(['mcp', 'presets']));
    const parsed = JSON.parse(out.stdout) as { presets: Array<Record<string, unknown>> };
    expect(parsed.presets.find((p) => p.kind === 'hubspot')).toMatchObject({
      auth: 'connection',
      app: 'hubspot',
      url: 'https://mcp.hubspot.com',
    });
    expect(parsed.presets.find((p) => p.kind === 'asana')).toMatchObject({
      auth: 'connection',
      app: 'asana',
      url: 'https://mcp.asana.com/v2/mcp',
    });
  });
});
