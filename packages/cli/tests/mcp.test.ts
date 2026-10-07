// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `kindgi mcp` subcommands + helpers. Drives the real CLI
 * entry (`runCli`) against a tmp pack dir so `.mcp.json` reads/writes
 * hit real filesystem.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(entry.args.slice(0, 3)).toEqual(['--no', 'kindgi', 'mcp-launch']);
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
});
