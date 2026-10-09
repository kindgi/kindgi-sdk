// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi doctor` (T130): each check, from fakes of the tools, Docker, the runtime and the client. */

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type DoctorReport, type DoctorSeam, MIN_NODE, atLeast } from '../src/commands/doctor.js';
import type { DockerRunner } from '../src/dev/runtime-container.js';
import { runCli } from '../src/main.js';
import { loadProviderPresets } from '../src/providers/preset-loader.js';

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-doctor-'));
  home = await mkdtemp(join(tmpdir(), 'kindgi-doctor-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const IMAGE = 'quay.io/kindgi/runtime:1.0.0@sha256:abc';

/** Docker that is running and can pull the image, unless told otherwise. */
const dockerThat =
  (state: 'ok' | 'missing' | 'stopped' | 'no-access' | 'helper'): DockerRunner =>
  async (args) => {
    if (state === 'missing') return { code: null, stdout: '', stderr: 'spawn docker ENOENT' };
    if (args[0] === 'version') {
      return state === 'stopped'
        ? {
            code: 1,
            stdout: '',
            stderr: 'Cannot connect to the Docker daemon. Is the docker daemon running?',
          }
        : { code: 0, stdout: '27.3.1\n', stderr: '' };
    }
    if (state === 'helper') {
      return {
        code: 1,
        stdout: '',
        stderr:
          'error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH, out: ``',
      };
    }
    if (state === 'no-access') {
      return {
        code: 1,
        stdout: '',
        stderr: 'unauthorized: access to the requested resource is not authorized',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

const TOOLS: Readonly<Record<string, string | null>> = {
  npm: '10.9.2',
  python3: 'Python 3.12.4',
  uv: 'uv 0.5.11 (Homebrew 2024-12-19)',
};

function seam(
  over: Partial<DoctorSeam> & { tools?: Record<string, string | null> } = {},
): DoctorSeam {
  const tools = { ...TOOLS, ...over.tools };
  return {
    nodeVersion: over.nodeVersion ?? '22.12.0',
    image: IMAGE,
    docker: over.docker ?? dockerThat('ok'),
    presets: async () => ({
      anthropic: {
        name: 'anthropic',
        description: '',
        adapterId: 'x',
        secret: 'ANTHROPIC_API_KEY',
        pricesCheckedAt: '',
        metadata: {} as never,
      },
      gemini: {
        name: 'gemini',
        description: '',
        adapterId: 'y',
        pricesCheckedAt: '',
        metadata: {} as never,
      },
    }),
    tool: async (command) => {
      const out = tools[command];
      return out === undefined || out === null
        ? { code: null, stdout: '', stderr: `spawn ${command} ENOENT` }
        : { code: 0, stdout: `${out}\n`, stderr: '' };
    },
  };
}

async function doctor(
  options: {
    seam?: DoctorSeam;
    env?: Record<string, string>;
    fetchImpl?: typeof fetch;
    providers?: unknown[] | Error;
    /** `providers.check` per provider id: its issues (default none), or an error it throws. */
    checks?: Record<string, { path: string; message: string }[]> | Error;
    json?: boolean;
  } = {},
) {
  const out = await runCli({
    argv: ['doctor', ...(options.json === false ? [] : ['--json'])],
    env: options.env ?? {},
    cwd: dir,
    home,
    doctorSeam: options.seam ?? seam(),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    clientFactory: () =>
      ({
        providers: {
          list: async () => {
            if (options.providers instanceof Error) throw options.providers;
            return { data: options.providers ?? [], hasMore: false };
          },
          check: async (providerId: string) => {
            if (options.checks instanceof Error) throw options.checks;
            const issues = options.checks?.[providerId] ?? [];
            return { providerId, adapterId: '@acme/adapter', checked: true, issues };
          },
        },
      }) as never,
  });
  const report = options.json === false ? undefined : (JSON.parse(out.stdout) as DoctorReport);
  const check = (id: string) => report?.checks.find((c) => c.id === id);
  return { out, report, check };
}

async function tsProject(options: { installed?: boolean; rc?: object; envLocal?: string } = {}) {
  await writeFile(join(dir, 'kindgi.config.ts'), 'export default {};\n');
  await writeFile(join(dir, 'package.json'), '{"name":"acme-pack"}\n');
  if (options.installed === true)
    await mkdir(join(dir, 'node_modules', '@kindgi', 'sdk'), { recursive: true });
  if (options.rc !== undefined)
    await writeFile(join(dir, '.kindgirc.json'), JSON.stringify(options.rc));
  if (options.envLocal !== undefined) await writeFile(join(dir, '.env.local'), options.envLocal);
}

const SECRET = 'sk-ant-do-not-print-me';
const RC = { apiUrl: 'http://127.0.0.1:4999', token: 'kgi_bt_test', tenantId: 't-1' };
const healthy: typeof fetch = async () => new Response('{"status":"ok"}', { status: 200 });

describe('outside a project', () => {
  test('the machine checks run; the project checks skip, saying why; exit 0', async () => {
    const { out, report, check } = await doctor();
    expect(out.exitCode).toBe(0);
    expect(report?.ok).toBe(true);
    expect(report?.project).toBeNull();
    expect(report?.checks.map((c) => c.id)).toEqual([
      'node',
      'npm',
      'python',
      'uv',
      'docker',
      'registry',
      'console-sign-in',
      'license',
      'project',
      'dependencies',
      'model-key',
      'runtime',
      'provider',
    ]);
    expect(check('console-sign-in')).toMatchObject({ status: 'skip' });
    expect(check('console-sign-in')?.message).toContain('no runtime to ask');
    expect(check('node')).toMatchObject({ status: 'pass', message: 'Node 22.12.0.' });
    expect(check('python')).toMatchObject({ status: 'skip' });
    expect(check('python')?.message).toContain('Python 3.12.4 is installed');
    expect(check('uv')?.message).toContain('uv 0.5.11 is installed');
    expect(check('registry')).toMatchObject({ status: 'pass' });
    expect(check('project')).toMatchObject({ status: 'skip' });
    expect(check('project')?.fix).toMatch(/^Create one: npx @kindgi\/cli@\S+ init <name> /);
    for (const id of ['dependencies', 'model-key', 'runtime', 'provider']) {
      expect(check(id)).toMatchObject({
        status: 'skip',
        message: 'Not checked: it needs a project.',
      });
    }
  });

  test('the human report: ✓, – and the closing line', async () => {
    const { out } = await doctor({ json: false });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('  ✓ Node.js: Node 22.12.0.');
    expect(out.stdout).toContain('  – Project: No Kindgi project in');
    expect(out.stdout).toContain('Everything checked is ready.');
  });
});

describe('the machine', () => {
  test('Docker not installed: ✗ with the fix, the image check skipped, exit 1', async () => {
    const { out, report, check } = await doctor({ seam: seam({ docker: dockerThat('missing') }) });
    expect(out.exitCode).toBe(1);
    expect(report?.ok).toBe(false);
    expect(check('docker')).toMatchObject({ status: 'fail' });
    expect(check('docker')?.message).toContain("Docker isn't installed");
    expect(check('docker')?.fix).toContain('install Docker Desktop');
    expect(check('registry')).toMatchObject({
      status: 'skip',
      message: 'Not checked: it needs Docker running.',
    });
  });

  test('Docker not running: the fix says to start it; the human report shows ✗ and Fix', async () => {
    const json = await doctor({ seam: seam({ docker: dockerThat('stopped') }) });
    expect(json.check('docker')?.message).toContain("Docker isn't running");
    expect(json.check('docker')?.fix).toBe(
      'Start Docker Desktop (or the Docker engine), then run this again.',
    );
    const text = await doctor({ seam: seam({ docker: dockerThat('stopped') }), json: false });
    expect(text.out.exitCode).toBe(1);
    expect(text.out.stdout).toContain("  ✗ Docker: Docker isn't running");
    expect(text.out.stdout).toContain('      Fix: Start Docker Desktop');
    expect(text.out.stdout).toContain('1 problem to fix.');
  });

  test('no pull access: the fix is the registry login, the token piped in', async () => {
    const { check } = await doctor({ seam: seam({ docker: dockerThat('no-access') }) });
    expect(check('registry')).toMatchObject({ status: 'fail' });
    expect(check('registry')?.fix).toMatch(
      /npx @kindgi\/cli@\S+ auth registry --username <robot name> --password-stdin/,
    );
  });

  test("a credential helper Docker can't run: named, with the fix, not a network problem", async () => {
    const { check } = await doctor({ seam: seam({ docker: dockerThat('helper') }) });
    expect(check('registry')).toMatchObject({ status: 'fail' });
    expect(check('registry')?.message).toContain(
      "Docker couldn't run its credential helper (docker-credential-desktop)",
    );
    expect(check('registry')?.fix).toContain('/Applications/Docker.app/Contents/Resources/bin');
  });

  test('an old Node, and no npm', async () => {
    const { check } = await doctor({
      seam: seam({ nodeVersion: '20.11.1', tools: { npm: null } }),
    });
    expect(check('node')).toMatchObject({
      status: 'fail',
      message: `Node 20.11.1; Kindgi needs ${MIN_NODE} or later.`,
    });
    expect(check('npm')).toMatchObject({ status: 'fail' });
  });
});

describe('a TypeScript project', () => {
  test('without its dependencies, a key or a runtime: what to do, in order', async () => {
    await tsProject();
    const { out, report, check } = await doctor();
    expect(out.exitCode).toBe(1);
    expect(report?.project).toEqual({ dir, language: 'node' });
    expect(check('project')).toMatchObject({ status: 'pass' });
    expect(check('project')?.message).toContain("kindgi dev hasn't run here yet");
    expect(check('dependencies')).toMatchObject({
      status: 'fail',
      fix: 'Install them: npm install',
    });
    expect(check('model-key')).toMatchObject({ status: 'fail' });
    expect(check('model-key')?.message).toContain('looked for ANTHROPIC_API_KEY');
    expect(check('model-key')?.fix).toContain(
      'kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant',
    );
    expect(check('runtime')).toMatchObject({ status: 'skip' });
    expect(check('provider')).toMatchObject({ status: 'skip' });
    expect(check('python')?.message).toContain('Not needed (a TypeScript project)');
  });

  test('the key is named with its file, never its value', async () => {
    await tsProject({ installed: true, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const { out, check } = await doctor();
    expect(check('dependencies')).toMatchObject({ status: 'pass' });
    expect(check('model-key')).toMatchObject({
      status: 'pass',
      message: 'ANTHROPIC_API_KEY is set in .env.local.',
    });
    expect(out.stdout).not.toContain(SECRET);
    const text = await doctor({ json: false });
    expect(text.out.stdout).not.toContain(SECRET);
  });

  test('a key only in the shell: said so, since kindgi dev reads the env files', async () => {
    await tsProject({ installed: true });
    const { out, check } = await doctor({ env: { ANTHROPIC_API_KEY: SECRET } });
    expect(check('model-key')?.message).toContain('ANTHROPIC_API_KEY is set in your shell');
    expect(out.stdout).not.toContain(SECRET);
  });

  test('a running runtime with a provider: everything passes, exit 0', async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const { out, report, check } = await doctor({
      fetchImpl: healthy,
      providers: [{ id: 'anthropic' }],
    });
    expect(out.exitCode).toBe(0);
    expect(report?.ok).toBe(true);
    expect(check('project')?.message).toContain('kindgi dev has run here (.kindgirc.json)');
    expect(check('runtime')).toMatchObject({
      status: 'pass',
      message:
        'The runtime answers at http://127.0.0.1:4999; its console is at http://127.0.0.1:4999/console/.',
    });
    expect(report?.consoleUrl).toBe('http://127.0.0.1:4999/console/');
    expect(check('provider')).toMatchObject({
      status: 'pass',
      message: 'A provider is registered: anthropic.',
    });
  });

  test('a runtime that serves no console: said so, and no console URL', async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const headless: typeof fetch = async (input) =>
      String(input).endsWith('/console/')
        ? new Response('{"error":{"code":"route-not-found"}}', { status: 404 })
        : new Response('{"status":"ok"}', { status: 200 });
    const { report, check } = await doctor({
      fetchImpl: headless,
      providers: [{ id: 'anthropic' }],
    });
    expect(check('runtime')).toMatchObject({
      status: 'pass',
      message: 'The runtime answers at http://127.0.0.1:4999 (it serves no console).',
    });
    expect(report?.consoleUrl).toBeUndefined();
  });

  test("only kindgi dev's dev-echo: a failure, since it isn't a model", async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const only = await doctor({ fetchImpl: healthy, providers: [{ id: 'dev-echo' }] });
    expect(only.check('provider')).toMatchObject({
      status: 'fail',
      message: "Only dev-echo is registered: agents get its canned replies, not a model's.",
    });
    const both = await doctor({
      fetchImpl: healthy,
      providers: [{ id: 'dev-echo' }, { id: 'anthropic' }],
    });
    expect(both.check('provider')).toMatchObject({
      status: 'pass',
      message: 'A provider is registered: anthropic.',
    });
  });

  test('no provider registered: the register command', async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const { out, check } = await doctor({ fetchImpl: healthy, providers: [] });
    expect(out.exitCode).toBe(1);
    expect(check('provider')).toMatchObject({ status: 'fail' });
    expect(check('provider')?.fix).toContain('kindgi providers register --preset=anthropic');
  });
});

describe("a registration the runtime can't build: its problems, from GET /v1/providers/{id}/check", () => {
  const withPresets = (): DoctorSeam => ({ ...seam(), presets: () => loadProviderPresets() });
  const run = async (
    providers: unknown[],
    checks: Record<string, { path: string; message: string }[]> | Error,
    json = true,
  ) => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    return doctor({ fetchImpl: healthy, providers, checks, seam: withPresets(), json });
  };
  const API = {
    path: '/adapter_config/api',
    message: 'api must be one of responses, chat-completions.',
  };

  test('one of two: a warning naming it, each problem, and how to register it again; exit 0', async () => {
    const { out, report, check } = await run([{ id: 'openai' }, { id: 'anthropic' }], {
      openai: [API],
    });
    expect(out.exitCode).toBe(0);
    expect(report?.ok).toBe(true);
    expect(check('provider')).toMatchObject({
      status: 'warn',
      message:
        "2 providers are registered: openai, anthropic. The runtime can't build openai from its registration, so agents only get the others.",
      details: ['openai: /adapter_config/api: api must be one of responses, chat-completions.'],
    });
    expect(check('provider')?.fix).toMatch(
      /^Unregister openai \(.*providers unregister openai\), then register it again: .*providers register --preset=openai/,
    );
  });

  test('every model provider: a failure, exit 1, each problem listed', async () => {
    const { out, report, check } = await run(
      [{ id: 'openai' }, { id: 'acme-llm' }, { id: 'dev-echo' }],
      {
        openai: [API],
        'acme-llm': [
          {
            path: '/adapter_id',
            message:
              'This runtime has no adapter "@acme/llm", so it can\'t build provider "acme-llm".',
          },
          { path: '/secret_ref', message: 'secret_ref is required.' },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    expect(report?.ok).toBe(false);
    expect(check('provider')).toMatchObject({
      status: 'fail',
      message:
        "No usable provider: the runtime can't build any of openai, acme-llm from their registration, so an agent has no model to call.",
      details: [
        'openai: /adapter_config/api: api must be one of responses, chat-completions.',
        'acme-llm: /adapter_id: This runtime has no adapter "@acme/llm", so it can\'t build provider "acme-llm".',
        'acme-llm: /secret_ref: secret_ref is required.',
      ],
    });
    // Not from a preset: its own spec, with the setting fixed.
    expect(check('provider')?.fix).toContain(
      'providers register --spec=@<file>. (its spec with the setting fixed)',
    );
  });

  test('the human report: each problem under the check, marked ✗', async () => {
    const { out } = await run([{ id: 'openai' }, { id: 'anthropic' }], { openai: [API] }, false);
    expect(out.stdout).toContain(
      "  ! Provider: 2 providers are registered: openai, anthropic. The runtime can't build openai",
    );
    expect(out.stdout).toContain(
      '\n      ✗ openai: /adapter_config/api: api must be one of responses, chat-completions.\n',
    );
    expect(out.stdout).toMatch(/\n {6}Fix: Unregister openai /);
  });

  test('a runtime without the route (before 0.1.5): the check is skipped, the rest as before', async () => {
    const missing = Object.assign(
      new Error('No route registered for GET /v1/providers/openai/check.'),
      {
        code: 'not-found',
        serverCode: 'route-not-found',
      },
    );
    const { check } = await run([{ id: 'openai' }], missing);
    expect(check('provider')).toMatchObject({
      status: 'pass',
      message: 'A provider is registered: openai.',
    });
    expect(check('provider')?.details).toBeUndefined();
  });

  test('a provider gone between the list and its check is left out, not reported', async () => {
    const gone = Object.assign(new Error('Provider "openai" not found'), {
      code: 'not-found',
      serverCode: 'provider-not-found',
    });
    const { check } = await run([{ id: 'openai' }], gone);
    expect(check('provider')).toMatchObject({ status: 'pass' });
  });
});

describe('a Vertex provider and the Google credentials kindgi dev gives the runtime', () => {
  const vertex = [
    { id: 'gemini', models: [{ name: 'gemini-3.8-flash' }], defaultModel: 'gemini-3.8-flash' },
  ];

  test('none (KINDGI_DEV_GOOGLE_CREDENTIALS unset): a warning that says how to give them', async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const { out, check } = await doctor({ fetchImpl: healthy, providers: vertex });
    expect(out.exitCode).toBe(0);
    expect(check('provider')).toMatchObject({
      status: 'warn',
      message:
        'A provider is registered: gemini. gemini is Vertex AI, and kindgi dev gives the runtime no Google credentials (KINDGI_DEV_GOOGLE_CREDENTIALS is unset).',
      fix: "Provider gemini (Vertex AI) has no Google credentials: set KINDGI_DEV_GOOGLE_CREDENTIALS=adc (or a credentials file), in the pack's .env or the shell, and restart kindgi dev.",
    });
  });

  test('named in the shell or the env files: a pass', async () => {
    const creds = join(dir, 'vertex-sa.json');
    await writeFile(
      creds,
      JSON.stringify({ type: 'service_account', client_email: 'v@acme.iam.gserviceaccount.com' }),
    );
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const shell = await doctor({
      fetchImpl: healthy,
      providers: vertex,
      env: { KINDGI_DEV_GOOGLE_CREDENTIALS: creds },
    });
    expect(shell.check('provider')).toMatchObject({
      status: 'pass',
      message: 'A provider is registered: gemini.',
    });
    await tsProject({
      installed: true,
      rc: RC,
      envLocal: `ANTHROPIC_API_KEY=${SECRET}\nKINDGI_DEV_GOOGLE_CREDENTIALS=${creds}\n`,
    });
    const files = await doctor({ fetchImpl: healthy, providers: vertex });
    expect(files.check('provider')).toMatchObject({ status: 'pass' });
  });

  test('a value kindgi dev would refuse: the warning says why', async () => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    const { check } = await doctor({
      fetchImpl: healthy,
      providers: vertex,
      env: { KINDGI_DEV_GOOGLE_CREDENTIALS: 'relative.json' },
    });
    expect(check('provider')).toMatchObject({ status: 'warn' });
    expect(check('provider')?.message).toContain('KINDGI_DEV_GOOGLE_CREDENTIALS must be `adc`');
  });
});

describe('a registration whose default model the preset no longer gives: a warning', () => {
  const models = (...names: string[]) => names.map((name) => ({ name }));
  /** The bundled presets, as `kindgi providers register --preset` reads them. */
  const withPresets = (): DoctorSeam => ({ ...seam(), presets: () => loadProviderPresets() });
  const run = async (providers: unknown[], json = true) => {
    await tsProject({ installed: true, rc: RC, envLocal: `ANTHROPIC_API_KEY=${SECRET}\n` });
    return doctor({ fetchImpl: healthy, providers, seam: withPresets(), json });
  };

  test('on a model the preset dropped: says which, and how to re-register; exit 0', async () => {
    const { out, report, check } = await run([
      { id: 'gemini', models: models('gemini-2.5-pro', 'gemini-2.5-flash') },
    ]);
    expect(out.exitCode).toBe(0);
    expect(report?.ok).toBe(true);
    expect(check('provider')).toMatchObject({
      status: 'warn',
      message:
        'A provider is registered: gemini. On gemini, an agent that names no model gets gemini-2.5-flash, which the gemini preset no longer lists. gemini is Vertex AI, and kindgi dev gives the runtime no Google credentials (KINDGI_DEV_GOOGLE_CREDENTIALS is unset).',
    });
    expect(check('provider')?.fix).toContain(
      'kindgi providers register --preset=gemini --project=<project>',
    );
  });

  test('registered before presets named a default: says where agents land, and the preset’s default', async () => {
    const { check } = await run([
      {
        id: 'anthropic',
        models: models('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'),
      },
    ]);
    expect(check('provider')).toMatchObject({ status: 'warn' });
    expect(check('provider')?.message).toContain(
      "On anthropic, an agent that names no model gets claude-haiku-4-5, the first by name: anthropic has no default model, and the anthropic preset's is claude-sonnet-5-5.",
    );
    expect(check('provider')?.fix).toContain('kindgi providers register --preset=anthropic.');
    expect(check('provider')?.fix).toContain('older than 0.1.4');
  });

  test("a registration on the preset's default, one without it, or not from a preset: no warning", async () => {
    for (const provider of [
      {
        id: 'anthropic',
        models: models('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'),
        defaultModel: 'claude-sonnet-5-5',
      },
      // --models=claude-haiku-4-5: a subset without the default is the person's choice.
      { id: 'anthropic', models: models('claude-haiku-4-5') },
      { id: 'acme-llm', models: models('acme-small', 'acme-large') },
    ]) {
      const { check } = await run([provider]);
      expect(check('provider'), JSON.stringify(provider)).toMatchObject({ status: 'pass' });
    }
  });

  test('several providers: one check, each warning with its fix', async () => {
    const { check } = await run([
      { id: 'anthropic', models: models('claude-sonnet-5-5', 'claude-haiku-4-5') },
      { id: 'gemini', models: models('gemini-2.5-flash') },
    ]);
    expect(check('provider')?.message).toMatch(
      /^2 providers are registered: anthropic, gemini\. On anthropic, .* On gemini, /,
    );
    expect(check('provider')?.fix).toMatch(
      /Unregister anthropic \(.*providers unregister anthropic\), then register it again: .* Unregister gemini \(/,
    );
  });

  test('a --json reader that knows only pass, fail and skip still reads it as ready', async () => {
    const { out, report } = await run([{ id: 'gemini', models: models('gemini-2.5-flash') }]);
    const known = new Set(['pass', 'fail', 'skip']);
    expect(report?.checks.some((c) => !known.has(c.status))).toBe(true);
    // Such a reader goes by `ok` and the failures, and a warning is neither.
    expect(report?.ok).toBe(true);
    expect(report?.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(out.exitCode).toBe(0);
    for (const c of report?.checks ?? []) {
      expect(Object.keys(c).every((k) => ['id', 'status', 'message', 'fix'].includes(k))).toBe(
        true,
      );
    }
  });

  test('the human report: ! with its fix, and the closing line counts it', async () => {
    const { out } = await run([{ id: 'gemini', models: models('gemini-2.5-flash') }], false);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      '  ! Provider: A provider is registered: gemini. On gemini, an agent that names no model gets gemini-2.5-flash',
    );
    // A registered id is taken: the fix unregisters it first (registering it again is a 409).
    expect(out.stdout).toMatch(
      /\n {6}Fix: Unregister gemini \(.*providers unregister gemini\), then register it again: .*--preset=gemini/,
    );
    expect(out.stdout).toContain('Everything checked is ready, with 1 warning.\n');
  });

  test('the runtime: nothing answering is a skip; a wrong answer or a hang is a failure', async () => {
    await tsProject({ installed: true, rc: RC });
    const refused: typeof fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    expect((await doctor({ fetchImpl: refused })).check('runtime')).toMatchObject({
      status: 'skip',
      message: 'Not running: nothing answers at http://127.0.0.1:4999.',
    });
    const wrong: typeof fetch = async () => new Response('nope', { status: 502 });
    expect((await doctor({ fetchImpl: wrong })).check('runtime')).toMatchObject({ status: 'fail' });
    const hang: typeof fetch = async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    expect((await doctor({ fetchImpl: hang })).check('runtime')?.message).toContain(
      "didn't answer within 5 s",
    );
  });

  test('a malformed .kindgirc.json: the project check says to delete it', async () => {
    await tsProject({ installed: true });
    await writeFile(join(dir, '.kindgirc.json'), '{not json');
    const { check } = await doctor();
    expect(check('project')).toMatchObject({
      status: 'fail',
      fix: 'Delete .kindgirc.json: kindgi dev writes a new one on its next start.',
    });
  });

  test('a pnpm project on a machine without pnpm: the fixes fall back to npm', async () => {
    await tsProject();
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const { check } = await doctor({ seam: seam({ tools: { pnpm: null } }) });
    expect(check('dependencies')?.fix).toBe(
      "Install them: npm install (the project names pnpm, which isn't installed here)",
    );
    expect(check('model-key')?.fix).toMatch(
      /^With kindgi dev running, set one LLM provider's key: npx --no kindgi secrets set ANTHROPIC_API_KEY /,
    );
  });

  test('several key presets: the model-key fix offers any one of their keys', async () => {
    await tsProject();
    const keyed = (name: string, secret: string) => ({
      name,
      description: '',
      adapterId: 'x',
      secret,
      pricesCheckedAt: '',
      metadata: {} as never,
    });
    const { check } = await doctor({
      seam: {
        ...seam(),
        presets: async () => ({
          anthropic: keyed('anthropic', 'ANTHROPIC_API_KEY'),
          openai: keyed('openai', 'OPENAI_API_KEY'),
          openrouter: keyed('openrouter', 'OPENROUTER_API_KEY'),
        }),
      },
    });
    expect(check('model-key')?.message).toContain(
      'looked for ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY',
    );
    expect(check('model-key')?.fix).toContain(
      'secrets set ANTHROPIC_API_KEY --env=local --scope=tenant, or the same with OPENAI_API_KEY or OPENROUTER_API_KEY',
    );
  });

  test('a pnpm project: the fixes are its own commands (pnpm install, pnpm exec kindgi …)', async () => {
    await tsProject();
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const { check } = await doctor({ seam: seam({ tools: { pnpm: '10.28.0' } }) });
    expect(check('dependencies')?.fix).toBe('Install them: pnpm install');
    expect(check('model-key')?.fix).toMatch(
      /^With kindgi dev running, set one LLM provider's key: pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant /,
    );
    expect(check('runtime')?.fix).toBe(
      'Start it: pnpm exec kindgi dev (it keeps running; stop it with Ctrl+C).',
    );
  });
});

describe('a Python project', () => {
  async function pyProject() {
    await writeFile(
      join(dir, 'pyproject.toml'),
      '[project]\nname = "acme"\n\n[tool.kindgi.pack]\nid = "acme"\n',
    );
  }

  test('Python and uv are required; without .venv, uv sync', async () => {
    await pyProject();
    const { report, check } = await doctor({ seam: seam({ tools: { python3: null, uv: null } }) });
    expect(report?.project).toEqual({ dir, language: 'python' });
    expect(check('python')).toMatchObject({ status: 'fail' });
    expect(check('uv')).toMatchObject({ status: 'fail' });
    expect(check('uv')?.fix).toContain('astral.sh/uv/install.sh');
    expect(check('dependencies')).toMatchObject({
      status: 'fail',
      fix: 'Install the dependencies: uv sync',
    });
  });

  test('installed: Python, uv and the kindgi package in .venv pass', async () => {
    await pyProject();
    await mkdir(join(dir, '.venv', 'lib', 'python3.12', 'site-packages', 'kindgi'), {
      recursive: true,
    });
    const { check } = await doctor();
    expect(check('python')).toMatchObject({ status: 'pass', message: 'Python 3.12.4.' });
    expect(check('uv')).toMatchObject({ status: 'pass', message: 'uv 0.5.11.' });
    expect(check('dependencies')).toMatchObject({ status: 'pass' });
  });

  test('a Python older than 3.11 fails', async () => {
    await pyProject();
    const { check } = await doctor({ seam: seam({ tools: { python3: 'Python 3.10.12' } }) });
    expect(check('python')).toMatchObject({ status: 'fail' });
  });
});

describe('under kindgi-cli, the PyPI build (T127)', () => {
  const PYPI = { KINDGI_CLI_INSTALL: 'pypi' };

  test("Node is the wheel's and npm isn't needed: neither fails, with no node or npm on PATH", async () => {
    const { report, check } = await doctor({
      env: PYPI,
      seam: seam({ nodeVersion: '24.19.0', tools: { npm: null } }),
    });
    expect(check('node')).toMatchObject({
      status: 'pass',
      message: 'Node 24.19.0, bundled with kindgi-cli.',
    });
    expect(check('npm')).toMatchObject({ status: 'skip' });
    expect(check('npm')?.message).toContain('kindgi-cli (from PyPI)');
    expect(report?.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  test('outside a project, the fixes run kindgi-cli through uvx, and start a Python pack', async () => {
    const { check } = await doctor({
      env: PYPI,
      seam: seam({ docker: dockerThat('no-access'), tools: { npm: null } }),
    });
    expect(check('project')?.fix).toBe(
      'Create one: uvx --from kindgi-cli kindgi init <name> --template=python, then run doctor in its folder.',
    );
    expect(check('registry')?.fix).toContain('uvx --from kindgi-cli kindgi auth registry');
    expect(check('registry')?.fix).not.toContain('npx');
  });

  test("in a Python project, the fixes run the project's own kindgi (uv run kindgi …)", async () => {
    await writeFile(
      join(dir, 'pyproject.toml'),
      '[project]\nname = "acme"\n\n[tool.kindgi.pack]\nid = "acme"\n',
    );
    const { check } = await doctor({
      env: PYPI,
      seam: seam({ docker: dockerThat('no-access'), tools: { npm: null } }),
    });
    expect(check('registry')?.fix).toContain('uv run kindgi auth registry');
  });
});

test('MIN_NODE is the CLI package’s engines.node', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  };
  expect(pkg.engines.node).toBe(`>=${MIN_NODE}`);
  expect(atLeast('22.12.0', MIN_NODE)).toBe(true);
  expect(atLeast('22.11.9', MIN_NODE)).toBe(false);
  expect(atLeast('v23.0.0', MIN_NODE)).toBe(true);
});

describe('console sign-in: can anyone sign in to the console of the runtime the CLI points at', () => {
  const RUNTIME = 'https://kindgi.acme.example';
  const env = { KINDGI_API_URL: RUNTIME, KINDGI_API_TOKEN: 'kgi_admin' };
  const answering =
    (signInOptions: unknown, providers: unknown[] = [], status = 200): typeof fetch =>
    async (input) => {
      const url = String(input);
      if (url === `${RUNTIME}/v1/auth/sign-in-options`) {
        return new Response(JSON.stringify(signInOptions), { status });
      }
      if (url === `${RUNTIME}/v1/auth/providers`) {
        return new Response(JSON.stringify({ data: providers }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

  test('token sign-in on: pass', async () => {
    const { check } = await doctor({
      env,
      fetchImpl: answering({ data: [], methods: { identityProviders: false, apiToken: true } }),
    });
    expect(check('console-sign-in')).toMatchObject({ status: 'pass' });
  });

  test('token sign-in off and no identity provider: a warning naming the setting, exit 0', async () => {
    const { out, check } = await doctor({
      env,
      fetchImpl: answering({ data: [], methods: { identityProviders: false, apiToken: false } }),
    });
    expect(out.exitCode).toBe(0);
    const found = check('console-sign-in');
    expect(found?.status).toBe('warn');
    expect(found?.message).toContain(`Nobody can sign in to the console at ${RUNTIME}`);
    expect(found?.fix).toContain('KINDGI_CONSOLE_TOKEN_SIGN_IN=on');
  });

  test('identity providers on but none registered, token sign-in off: a warning', async () => {
    const { check } = await doctor({
      env,
      fetchImpl: answering({ data: [], methods: { identityProviders: true, apiToken: false } }, []),
    });
    const found = check('console-sign-in');
    expect(found?.status).toBe('warn');
    expect(found?.message).toContain('none is registered');
    expect(found?.fix).toContain('kindgi sso providers start');
    expect(found?.fix).toContain('KINDGI_CONSOLE_TOKEN_SIGN_IN=on');
  });

  test('identity providers on and one registered: pass', async () => {
    const { check } = await doctor({
      env,
      fetchImpl: answering({ data: [], methods: { identityProviders: true, apiToken: false } }, [
        { providerId: 'acme-okta' },
      ]),
    });
    expect(check('console-sign-in')).toMatchObject({ status: 'pass' });
  });

  test('a runtime older than 0.1.5: not checked', async () => {
    const { check } = await doctor({ env, fetchImpl: answering({}, [], 404) });
    expect(check('console-sign-in')).toMatchObject({ status: 'skip' });
    expect(check('console-sign-in')?.message).toContain('older than 0.1.5');
  });

  test('the text output: the warning and its fix', async () => {
    const { out } = await doctor({
      env,
      json: false,
      fetchImpl: answering({ data: [], methods: { identityProviders: false, apiToken: false } }),
    });
    expect(out.stdout).toContain('! Console sign-in: Nobody can sign in to the console');
    expect(out.stdout).toContain('Fix: Set KINDGI_CONSOLE_TOKEN_SIGN_IN=on on the runtime');
  });
});

describe('the license key', () => {
  const NOW = 1_791_500_000_000;
  const DAY = 86_400;
  const signer = generateKeyPairSync('ed25519');
  const licensePublicKeys = {
    'test-lk': Buffer.from(
      signer.publicKey.export({ format: 'jwk' }).x as string,
      'base64url',
    ).toString('base64'),
  };
  const key = (over: Record<string, unknown> = {}) => {
    const payload = {
      v: 1,
      kid: 'test-lk',
      sub: 'gh-42',
      name: 'octo',
      use: 'non-production',
      iat: NOW / 1000 - 30 * DAY,
      exp: NOW / 1000 + 57 * DAY,
      ...over,
    };
    const signed = `kgi_lk_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), signer.privateKey).toString('base64url')}`;
  };
  const licenseOf = async (env: Record<string, string> = {}) => {
    const { report } = await doctor({
      env,
      seam: { ...seam(), now: () => NOW, licensePublicKeys },
    });
    return report?.checks.find((c) => c.id === 'license');
  };

  test('none here: skipped (kindgi dev needs none)', async () => {
    expect(await licenseOf()).toMatchObject({
      status: 'skip',
      message: expect.stringContaining('kindgi dev needs none'),
    });
  });

  test('KINDGI_LICENSE_KEY with time left: whose, which use, until when', async () => {
    expect(await licenseOf({ KINDGI_LICENSE_KEY: key() })).toEqual({
      id: 'license',
      status: 'pass',
      message: `octo's non-production key, until ${new Date((NOW / 1000 + 57 * DAY) * 1000).toISOString().slice(0, 10)} (57 days).`,
    });
  });

  test('kindgi.env, in its last 30 days: a warning with the exact renew command, or access.kindgi.com', async () => {
    await writeFile(
      join(dir, 'kindgi.env'),
      `KINDGI_LICENSE_KEY=${key({ exp: NOW / 1000 + 12 * DAY })}\n`,
    );
    const check = await licenseOf();
    expect(check?.status).toBe('warn');
    expect(check?.message).toMatch(
      /^octo's non-production key expires in 12 days \(\d{4}-\d{2}-\d{2}\)\.$/,
    );
    expect(check?.fix).toBe(
      'kindgi license renew --env-file kindgi.env --renewer <its renewer key>, or sign in at https://access.kindgi.com for a new key',
    );
  });

  test('a key Kindgi issued by hand: write to contact; in the grace: still starts; past it: fails', async () => {
    const issued = { sub: 'acme-prod', name: 'Acme', use: 'production' };
    const expiring = await licenseOf({
      KINDGI_LICENSE_KEY: key({ ...issued, exp: NOW / 1000 + 3 * DAY }),
    });
    expect(expiring?.fix).toBe('Write to contact@kindgi.com for the next key');
    const grace = await licenseOf({
      KINDGI_LICENSE_KEY: key({ ...issued, exp: NOW / 1000 - 2 * DAY }),
    });
    expect([grace?.status, grace?.message.includes('the runtime starts with it until')]).toEqual([
      'warn',
      true,
    ]);
    const { out, report } = await doctor({
      env: { KINDGI_LICENSE_KEY: key({ ...issued, exp: NOW / 1000 - 20 * DAY }) },
      seam: { ...seam(), now: () => NOW, licensePublicKeys },
    });
    const expired = report?.checks.find((c) => c.id === 'license');
    expect([
      expired?.status,
      expired?.message.includes("more than 14 days ago: the runtime won't start with it"),
    ]).toEqual(['fail', true]);
    expect(out.exitCode).toBe(1);
  });

  test('signed with a key this CLI doesn’t know: update the CLI; not a key at all: fails', async () => {
    expect(await licenseOf({ KINDGI_LICENSE_KEY: key({ kid: 'lk-2099-1' }) })).toMatchObject({
      status: 'warn',
      fix: 'Update the Kindgi CLI, then run kindgi doctor again.',
    });
    expect(await licenseOf({ KINDGI_LICENSE_KEY: 'not-a-key' })).toMatchObject({ status: 'fail' });
  });
});
