// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi doctor` (T130): each check, from fakes of the tools, Docker, the runtime and the client. */

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
  java: 'openjdk version "21.0.6" 2025-01-21 LTS',
  mvn: 'Apache Maven 3.9.16 (abc)',
  sbt: '1.12.15',
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
      'java',
      'maven',
      'sbt',
      'docker',
      'registry',
      'project',
      'dependencies',
      'model-key',
      'runtime',
      'provider',
    ]);
    expect(check('node')).toMatchObject({ status: 'pass', message: 'Node 22.12.0.' });
    expect(check('python')).toMatchObject({ status: 'skip' });
    expect(check('python')?.message).toContain('Python 3.12.4 is installed');
    expect(check('uv')?.message).toContain('uv 0.5.11 is installed');
    expect(check('java')).toMatchObject({ status: 'skip' });
    expect(check('java')?.message).toContain('Java 21.0.6 is installed');
    expect(check('maven')?.message).toContain('Maven 3.9.16 is installed');
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
      message: 'The runtime answers at http://127.0.0.1:4999.',
    });
    expect(check('provider')).toMatchObject({
      status: 'pass',
      message: 'A provider is registered: anthropic.',
    });
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
        'A provider is registered: gemini. On gemini, an agent that names no model gets gemini-2.5-flash, which the gemini preset no longer lists.',
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
    expect(check('provider')?.fix).toMatch(/Re-register anthropic: .* Re-register gemini /);
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
    expect(out.stdout).toMatch(/\n {6}Fix: Re-register gemini for the preset's current models: /);
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

describe('a Java project (kindgi.config.json)', () => {
  const POM_WITH_KINDGI = `<project><dependencies><dependency>
      <groupId>com.kindgi</groupId>
      <artifactId>kindgi-pack</artifactId>
      <version>0.1.6</version>
    </dependency></dependencies></project>`;

  async function javaProject(options: { pom?: string; wrapper?: boolean } = {}): Promise<void> {
    await writeFile(
      join(dir, 'kindgi.config.json'),
      JSON.stringify({ language: 'java', pack: { id: 'acme', version: '1.0.0' } }),
    );
    if (options.pom !== undefined) await writeFile(join(dir, 'pom.xml'), options.pom);
    if (options.wrapper === true) await writeFile(join(dir, 'mvnw'), '#!/bin/sh\n');
  }

  test('a JDK 17+, the Maven wrapper and kindgi-pack in pom.xml pass', async () => {
    await javaProject({ pom: POM_WITH_KINDGI, wrapper: true });
    const { report, check } = await doctor();
    expect(report?.project).toEqual({ dir, language: 'java' });
    expect(check('project')?.message).toContain('A Java project (kindgi.config.json)');
    expect(check('java')).toMatchObject({
      status: 'pass',
      message: 'Java 21.0.6 (the java on your PATH).',
    });
    expect(check('maven')).toMatchObject({
      status: 'pass',
      message: 'The project has the Maven wrapper (mvnw).',
    });
    expect(check('dependencies')).toMatchObject({ status: 'pass' });
    expect(check('python')?.message).toContain('Not needed (a Java project)');
  });

  test("JAVA_HOME's JDK is the one checked; older than 17 fails, with the fix", async () => {
    await javaProject({ pom: POM_WITH_KINDGI });
    const { check } = await doctor({
      env: { JAVA_HOME: '/opt/jdk-11' },
      seam: seam({ tools: { '/opt/jdk-11/bin/java': 'openjdk version "11.0.22" 2024-01-16' } }),
    });
    expect(check('java')).toMatchObject({ status: 'fail' });
    expect(check('java')?.message).toBe(
      'Java 11.0.22 (JAVA_HOME, /opt/jdk-11); a Kindgi Java project needs 17 or later.',
    );
    expect(check('java')?.fix).toContain('adoptium.net');
    expect(check('maven')).toMatchObject({ status: 'pass', message: 'Maven 3.9.16.' });
  });

  test('no JDK, no Maven, no kindgi-pack: each fails with its fix', async () => {
    await javaProject({ pom: '<project></project>' });
    const { check } = await doctor({ seam: seam({ tools: { java: null, mvn: null } }) });
    expect(check('java')).toMatchObject({ status: 'fail' });
    expect(check('maven')).toMatchObject({ status: 'fail' });
    expect(check('maven')?.fix).toContain('mvn wrapper:wrapper');
    expect(check('dependencies')).toMatchObject({
      status: 'fail',
      fix: 'Add the com.kindgi:kindgi-pack dependency to pom.xml.',
    });
  });
});

describe('a Scala project (kindgi.config.json, "language": "scala")', () => {
  async function scalaProject(build?: string): Promise<void> {
    await writeFile(
      join(dir, 'kindgi.config.json'),
      JSON.stringify({ language: 'scala', pack: { id: 'acme', version: '1.0.0' } }),
    );
    if (build !== undefined) await writeFile(join(dir, 'build.sbt'), build);
  }

  test('a JDK 17+, sbt and kindgi-pack-scala in the build pass; Maven is not needed', async () => {
    await scalaProject('libraryDependencies ++= Dependencies.all\n');
    // The dependency may live in project/*.scala.
    await mkdir(join(dir, 'project'), { recursive: true });
    await writeFile(
      join(dir, 'project', 'Dependencies.scala'),
      'object Dependencies { val all = Seq("com.kindgi" %% "kindgi-pack-scala" % "0.1.6") }\n',
    );
    const { report, check } = await doctor();
    expect(report?.project).toEqual({ dir, language: 'scala' });
    expect(check('project')?.message).toContain('A Scala project (kindgi.config.json)');
    expect(check('java')).toMatchObject({ status: 'pass' });
    expect(check('sbt')).toMatchObject({ status: 'pass' });
    expect(check('sbt')?.message).toContain('sbt 1.12.15');
    expect(check('maven')?.message).toContain('Not needed (a Scala project)');
    expect(check('dependencies')).toMatchObject({ status: 'pass' });
  });

  test('no sbt and no kindgi-pack-scala: each fails with its fix', async () => {
    await scalaProject('scalaVersion := "3.3.8"\n');
    const { check } = await doctor({ seam: seam({ tools: { sbt: null } }) });
    expect(check('sbt')).toMatchObject({ status: 'fail' });
    expect(check('sbt')?.fix).toContain('scala-sbt.org');
    expect(check('dependencies')).toMatchObject({
      status: 'fail',
      fix: 'Add "com.kindgi" %% "kindgi-pack-scala" % "<version>" to libraryDependencies in build.sbt.',
    });
  });

  test('outside a Scala project, sbt is a skip that says whether it is installed', async () => {
    const { check } = await doctor();
    expect(check('sbt')).toMatchObject({ status: 'skip' });
    expect(check('sbt')?.message).toContain('sbt 1.12.15 is installed, for a Scala project');
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
