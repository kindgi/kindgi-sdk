// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi doctor`: whether this machine and this folder are ready to run
 * Kindgi, each check with what it found and, when it fails, the exact fix
 * (T130). A coding agent reads `--json` and fixes what fails; a person
 * reads the ✓/✗ lines. Any failed check exits 1.
 *
 * The checks, in order: Node, npm, Python and uv (a Python project's),
 * Docker, pull access to the pinned runtime image, the project, its
 * dependencies, a model key in its env files (never its value), the
 * runtime `kindgi dev` runs, and a provider registered there. Outside a
 * project the project's checks are skipped, saying why; a check that
 * needs another (the registry needs Docker) is skipped when that one
 * fails. `skip` is never a failure.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { findKindgiConfig } from '@kindgi/handler-runtime';
import { LOCAL_ENV_NAME, displayEnvPath, readPackEnv } from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { type DockerRunner, docker } from '../dev/runtime-container.js';
import { DEFAULT_RUNTIME_IMAGE, registryOf } from '../dev/runtime-image.js';
import { checkDocker, checkImageAccess } from '../dev/runtime-registry.js';
import { renderJson } from '../output.js';
import {
  binCommand,
  detectBinRunner,
  detectPackageManager,
  publishedCliSpec,
} from '../package-manager.js';
import { type ProviderPreset, loadProviderPresets } from '../providers/preset-loader.js';
import { CLI_VERSION } from '../version-info.js';
import type { CommandResult, LeafCommand } from './types.js';

/**
 * The provider `kindgi dev` falls back to, with canned replies
 * (`DEV_ECHO_PROVIDER_ID` in `@kindgi/dev-echo-provider`): not a model.
 */
const DEV_ECHO_PROVIDER_ID = 'dev-echo';

/** The Node the CLI needs (`engines.node` in its package.json). */
export const MIN_NODE = '22.12.0';
/** The Python a Python project needs (`requires-python` in its pyproject.toml). */
export const MIN_PYTHON = '3.11.0';

export type DoctorCheckId =
  | 'node'
  | 'npm'
  | 'python'
  | 'uv'
  | 'docker'
  | 'registry'
  | 'project'
  | 'dependencies'
  | 'model-key'
  | 'runtime'
  | 'provider';

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly status: 'pass' | 'fail' | 'skip';
  /** What was found, in a sentence. */
  readonly message: string;
  /** The exact command or step that fixes it: on every failure, and on some skips. */
  readonly fix?: string;
}

/** What `kindgi doctor --json` prints. */
export interface DoctorReport {
  /** No check failed (skips don't count). */
  readonly ok: boolean;
  readonly cliVersion: string;
  /** The Kindgi project in the folder checked, or `null` outside one. */
  readonly project: { readonly dir: string; readonly language: 'node' | 'python' } | null;
  readonly checks: readonly DoctorCheck[];
}

export interface ToolOutcome {
  /** `null` when the tool isn't installed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable seams, so tests run the checks without the tools, Docker or a runtime. */
export interface DoctorSeam {
  /** Runs a tool to completion (`npm --version`, …). */
  readonly tool?: (command: string, args: readonly string[]) => Promise<ToolOutcome>;
  readonly docker?: DockerRunner;
  /** Default: the Node running the CLI. */
  readonly nodeVersion?: string;
  /** The image the registry check pulls. Default: the one `kindgi dev` runs. */
  readonly image?: string;
  readonly presets?: () => Promise<Readonly<Record<string, ProviderPreset>>>;
}

const TITLES: Readonly<Record<DoctorCheckId, string>> = {
  node: 'Node.js',
  npm: 'npm',
  python: 'Python',
  uv: 'uv',
  docker: 'Docker',
  registry: 'Runtime image',
  project: 'Project',
  dependencies: 'Dependencies',
  'model-key': 'Model key',
  runtime: 'Runtime',
  provider: 'Provider',
};

export const doctorCommand: LeafCommand = {
  kind: 'leaf',
  name: 'doctor',
  description:
    'Check this machine and folder are ready to run Kindgi: Node, Docker, access to the runtime image, the project, its model key, the runtime and a provider. Each check says what it found and, when it fails, the exact fix. Exits 1 when any check fails; --json for a coding agent.',
  usage: 'kindgi doctor [--path=<dir>] [--json]',
  optionSpec: {
    path: {
      type: 'string',
      description: 'The folder to check. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const dir = resolve(ctx.cwd, typeof ctx.options.path === 'string' ? ctx.options.path : '.');
    const report = await runDoctor(ctx, dir);
    const exitCode = report.ok ? 0 : 1;
    if (ctx.globals.formatRequested) {
      return { kind: 'ok', rendered: renderJson(report, ctx.globals.format), exitCode };
    }
    return { kind: 'ok', rendered: { stdout: doctorText(report), stderr: '' }, exitCode };
  },
};

/** Every check, in order. */
export async function runDoctor(ctx: CommandContext, dir: string): Promise<DoctorReport> {
  const seam = ctx.doctorSeam ?? {};
  const tool = seam.tool ?? runTool;
  const run = seam.docker ?? docker;
  const checks: DoctorCheck[] = [];

  const config = await findKindgiConfig(dir);
  const language =
    config === undefined ? undefined : config.format === 'pyproject' ? 'python' : 'node';
  const kindgi = await kindgiCommand(dir, language);

  checks.push(nodeCheck(seam.nodeVersion ?? process.versions.node));
  checks.push(await npmCheck(tool));
  checks.push(...(await pythonChecks(tool, language)));
  const dockerCheck = await checkDockerRunning(run);
  checks.push(dockerCheck);
  checks.push(
    dockerCheck.status === 'pass'
      ? await registryCheck(run, seam.image ?? DEFAULT_RUNTIME_IMAGE, kindgi)
      : skip('registry', 'Not checked: it needs Docker running.'),
  );

  if (config === undefined || language === undefined) {
    checks.push({
      id: 'project',
      status: 'skip',
      message: `No Kindgi project in ${dir}: no kindgi.config.ts, and no pyproject.toml with [tool.kindgi].`,
      fix: `Create one: ${kindgi('init', '<name>')} (TypeScript; add --template=python for Python), then run doctor in its folder.`,
    });
    for (const id of ['dependencies', 'model-key', 'runtime', 'provider'] as const) {
      checks.push(skip(id, 'Not checked: it needs a project.'));
    }
    return report(checks, null);
  }

  const rc = await readKindgirc(dir);
  checks.push(projectCheck(dir, language, rc));
  checks.push(await dependenciesCheck(dir, language));
  checks.push(await modelKeyCheck(dir, seam, ctx.env, kindgi));
  const runtime = await runtimeCheck(ctx, rc, kindgi);
  checks.push(runtime.check);
  checks.push(
    runtime.check.status === 'pass' && runtime.url !== undefined && rc.token !== undefined
      ? await providerCheck(ctx, runtime.url, rc.token, kindgi)
      : skip('provider', `Not checked: it needs the runtime running (${kindgi('dev')}).`),
  );
  return report(checks, { dir, language });
}

/** The report as ✓/✗ lines, each failure with its fix. */
export function doctorText(report: DoctorReport): string {
  const lines = [`kindgi doctor (CLI ${report.cliVersion})`];
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–';
    lines.push(`  ${mark} ${TITLES[check.id]}: ${check.message}`);
    if (check.fix !== undefined && check.status !== 'pass') lines.push(`      Fix: ${check.fix}`);
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  lines.push(
    failed === 0
      ? 'Everything checked is ready.'
      : `${failed} ${failed === 1 ? 'problem' : 'problems'} to fix.`,
  );
  return `${lines.join('\n')}\n`;
}

function report(checks: readonly DoctorCheck[], project: DoctorReport['project']): DoctorReport {
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    cliVersion: CLI_VERSION,
    project,
    checks,
  };
}

const pass = (id: DoctorCheckId, message: string): DoctorCheck => ({ id, status: 'pass', message });
const fail = (id: DoctorCheckId, message: string, fix: string): DoctorCheck => ({
  id,
  status: 'fail',
  message,
  fix,
});
const skip = (id: DoctorCheckId, message: string, fix?: string): DoctorCheck => ({
  id,
  status: 'skip',
  message,
  ...(fix !== undefined && { fix }),
});

// ---------- tools ----------

function nodeCheck(version: string): DoctorCheck {
  return atLeast(version, MIN_NODE)
    ? pass('node', `Node ${version}.`)
    : fail(
        'node',
        `Node ${version}; Kindgi needs ${MIN_NODE} or later.`,
        `Install Node ${MIN_NODE} or later from https://nodejs.org (or: nvm install 22).`,
      );
}

async function npmCheck(tool: NonNullable<DoctorSeam['tool']>): Promise<DoctorCheck> {
  const npm = await tool('npm', ['--version']);
  return npm.code === 0
    ? pass('npm', `npm ${npm.stdout.trim()}.`)
    : fail(
        'npm',
        "npm isn't on your PATH.",
        `npm comes with Node: reinstall Node ${MIN_NODE} or later from https://nodejs.org.`,
      );
}

/** Python and uv: needed by a Python project; elsewhere, what's installed (for choosing a template). */
async function pythonChecks(
  tool: NonNullable<DoctorSeam['tool']>,
  language: 'node' | 'python' | undefined,
): Promise<DoctorCheck[]> {
  const python = await pythonVersion(tool);
  const uv = await tool('uv', ['--version']);
  const uvVersion =
    uv.code === 0
      ? uv.stdout
          .trim()
          .replace(/^uv\s+/, '')
          .split(/\s/)[0]
      : undefined;
  const pythonFix = `Install Python ${MIN_PYTHON.replace(/\.0$/, '')} or later (https://www.python.org/downloads, or: uv python install 3.12).`;
  const uvFix =
    'Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh (or: brew install uv).';
  if (language !== 'python') {
    const why = language === 'node' ? 'a TypeScript project' : 'no project yet';
    return [
      skip(
        'python',
        `Not needed (${why}); ${python !== undefined ? `Python ${python} is installed` : "Python isn't installed"}, for a Python project (kindgi init --template=python).`,
      ),
      skip(
        'uv',
        `Not needed (${why}); ${uvVersion !== undefined ? `uv ${uvVersion} is installed` : "uv isn't installed"}, for a Python project.`,
      ),
    ];
  }
  return [
    python === undefined
      ? fail('python', "Python isn't installed (python3 isn't on your PATH).", pythonFix)
      : atLeast(python, MIN_PYTHON)
        ? pass('python', `Python ${python}.`)
        : fail(
            'python',
            `Python ${python}; a Kindgi Python project needs 3.11 or later.`,
            pythonFix,
          ),
    uvVersion !== undefined
      ? pass('uv', `uv ${uvVersion}.`)
      : fail('uv', "uv isn't installed: a Kindgi Python project installs and runs with it.", uvFix),
  ];
}

async function pythonVersion(tool: NonNullable<DoctorSeam['tool']>): Promise<string | undefined> {
  for (const command of ['python3', 'python']) {
    const got = await tool(command, ['--version']);
    const version = /Python\s+(\d+\.\d+\.\d+)/.exec(`${got.stdout} ${got.stderr}`)?.[1];
    if (got.code === 0 && version !== undefined) return version;
  }
  return undefined;
}

// ---------- Docker and the runtime image ----------

async function checkDockerRunning(run: DockerRunner): Promise<DoctorCheck> {
  const ready = await checkDocker(run);
  if (ready.kind === 'ok') return pass('docker', 'Docker is running.');
  const [message = ready.message, ...rest] = ready.message.split('\n');
  return fail('docker', message, rest.map((l) => l.trim()).join(' '));
}

async function registryCheck(
  run: DockerRunner,
  image: string,
  kindgi: Kindgi,
): Promise<DoctorCheck> {
  const access = await checkImageAccess(run, image);
  const host = registryOf(image);
  switch (access.kind) {
    case 'ok':
      return pass('registry', `Docker can pull the runtime image (${image}).`);
    case 'no-access':
      return fail(
        'registry',
        `Docker can't pull the runtime image from ${host}: ${firstLine(access.detail)}`,
        `Log Docker in with your pull token: ${kindgi('auth', 'registry', '--username', '<robot name>', '--password-stdin')} (the robot name and token come from access.kindgi.com; pipe the token in, never paste it into a chat). Then run doctor again.`,
      );
    case 'not-found':
      return fail(
        'registry',
        `Couldn't find the runtime image on ${host}: ${firstLine(access.detail)}`,
        `Check this machine can reach ${host} (the network, a proxy or a firewall), then run doctor again.`,
      );
    case 'no-tool':
      return fail(
        'registry',
        "Couldn't check the runtime image: neither docker buildx nor docker manifest is available.",
        'Docker Desktop includes buildx; on Linux, install the docker-buildx-plugin package.',
      );
  }
}

// ---------- the project ----------

interface Kindgirc {
  readonly exists: boolean;
  readonly apiUrl?: string;
  readonly token?: string;
  /** Set when the file is there but isn't valid JSON. */
  readonly malformed?: string;
}

/** `.kindgirc.json`, which `kindgi dev` writes: the runtime's URL and token. */
async function readKindgirc(dir: string): Promise<Kindgirc> {
  let raw: string;
  try {
    raw = await readFile(join(dir, '.kindgirc.json'), 'utf8');
  } catch {
    return { exists: false };
  }
  try {
    const parsed = JSON.parse(raw) as { apiUrl?: unknown; token?: unknown };
    return {
      exists: true,
      ...(typeof parsed.apiUrl === 'string' && parsed.apiUrl !== '' && { apiUrl: parsed.apiUrl }),
      ...(typeof parsed.token === 'string' && parsed.token !== '' && { token: parsed.token }),
    };
  } catch (err) {
    return { exists: true, malformed: (err as Error).message };
  }
}

function projectCheck(dir: string, language: 'node' | 'python', rc: Kindgirc): DoctorCheck {
  const kind =
    language === 'python'
      ? 'A Python project (pyproject.toml)'
      : 'A TypeScript project (kindgi.config.ts)';
  if (rc.malformed !== undefined) {
    return fail(
      'project',
      `${kind} in ${dir}, but its .kindgirc.json isn't valid JSON (${rc.malformed}).`,
      'Delete .kindgirc.json: kindgi dev writes a new one on its next start.',
    );
  }
  return pass(
    'project',
    `${kind} in ${dir}; ${rc.exists ? 'kindgi dev has run here (.kindgirc.json)' : "kindgi dev hasn't run here yet"}.`,
  );
}

async function dependenciesCheck(dir: string, language: 'node' | 'python'): Promise<DoctorCheck> {
  if (language === 'python') {
    return (await pythonPackageInstalled(dir))
      ? pass('dependencies', 'The kindgi package is installed in .venv.')
      : fail(
          'dependencies',
          "The kindgi package isn't installed in this project's .venv.",
          'Install the dependencies: uv sync',
        );
  }
  if (await nodePackageInstalled(dir, '@kindgi/sdk')) {
    return pass('dependencies', '@kindgi/sdk is installed.');
  }
  const pm = await detectPackageManager(dir);
  return fail(
    'dependencies',
    "@kindgi/sdk isn't installed: the project's dependencies aren't.",
    `Install them: ${pm} install`,
  );
}

/** `node_modules/<name>` here or in a folder above (a workspace hoists it). */
async function nodePackageInstalled(dir: string, name: string): Promise<boolean> {
  let current = dir;
  for (;;) {
    if (await isDirectory(join(current, 'node_modules', name))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** `kindgi` in `.venv`'s site-packages (`lib/python3.x/` on macOS and Linux, `Lib/` on Windows). */
async function pythonPackageInstalled(dir: string): Promise<boolean> {
  const venv = join(dir, '.venv');
  if (await isDirectory(join(venv, 'Lib', 'site-packages', 'kindgi'))) return true;
  let versions: string[];
  try {
    versions = (await readdir(join(venv, 'lib'))).filter((n) => n.startsWith('python'));
  } catch {
    return false;
  }
  for (const version of versions) {
    if (await isDirectory(join(venv, 'lib', version, 'site-packages', 'kindgi'))) return true;
  }
  return false;
}

/** A model key the presets name, set in the project's env files. Its value is never read out. */
async function modelKeyCheck(
  dir: string,
  seam: DoctorSeam,
  hostEnv: Readonly<Record<string, string | undefined>>,
  kindgi: Kindgi,
): Promise<DoctorCheck> {
  const presets = await (seam.presets ?? (() => loadProviderPresets()))();
  const names = [
    ...new Set(Object.values(presets).flatMap((p) => (p.secret !== undefined ? [p.secret] : []))),
  ];
  const env = await readPackEnv({ packDir: dir, envName: LOCAL_ENV_NAME });
  const files = env.files.read.map((f) => displayEnvPath(dir, f)).join(' or ');
  const found = names.find((name) => (env.values[name] ?? '').trim() !== '');
  if (found !== undefined) {
    const origin = env.origin[found];
    return pass(
      'model-key',
      `${found} is set${origin !== undefined ? ` in ${displayEnvPath(dir, origin)}` : ''}.`,
    );
  }
  const inShell = names.find((name) => (hostEnv[name] ?? '').trim() !== '');
  const want = names[0] ?? 'ANTHROPIC_API_KEY';
  return fail(
    'model-key',
    `No model key in ${files} (looked for ${names.join(', ')})${inShell !== undefined ? `; ${inShell} is set in your shell, but kindgi dev reads keys from the project's env files` : ''}.`,
    `With kindgi dev running: ${kindgi('secrets', 'set', want, '--env=local', '--scope=tenant')} (it prompts without echoing; or pipe it in with --from-stdin). Never paste a key into a chat.`,
  );
}

// ---------- the runtime ----------

async function runtimeCheck(
  ctx: CommandContext,
  rc: Kindgirc,
  kindgi: Kindgi,
): Promise<{ readonly check: DoctorCheck; readonly url?: string }> {
  const start = `Start it: ${kindgi('dev')} (it keeps running; stop it with Ctrl+C).`;
  const restart = `Restart kindgi dev (Ctrl+C, then ${kindgi('dev')})`;
  if (rc.apiUrl === undefined) {
    return {
      check: skip('runtime', "Not running: kindgi dev hasn't run here yet.", start),
    };
  }
  const url = `${rc.apiUrl.replace(/\/+$/, '')}/health`;
  try {
    const res = await ctx.fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (res.ok)
      return { check: pass('runtime', `The runtime answers at ${rc.apiUrl}.`), url: rc.apiUrl };
    return {
      check: fail(
        'runtime',
        `Something answers at ${rc.apiUrl}, but not as a healthy Kindgi runtime (HTTP ${res.status}).`,
        `${restart}; if another program holds that port, kindgi dev picks a free one.`,
      ),
    };
  } catch (err) {
    if (isTimeout(err)) {
      return {
        check: fail(
          'runtime',
          `Something holds ${rc.apiUrl} but didn't answer within 5 s.`,
          `${restart}.`,
        ),
      };
    }
    return {
      check: skip('runtime', `Not running: nothing answers at ${rc.apiUrl}.`, start),
    };
  }
}

async function providerCheck(
  ctx: CommandContext,
  apiUrl: string,
  token: string,
  kindgi: Kindgi,
): Promise<DoctorCheck> {
  try {
    const page = await ctx.clientFor(apiUrl, token).providers.list();
    const ids = page.data.map((p) => (p as { id?: string }).id ?? '?');
    const models = ids.filter((id) => id !== DEV_ECHO_PROVIDER_ID);
    const register = `Register one: ${kindgi('providers', 'register', '--preset=anthropic')} (its key must be set first; see Model key).`;
    if (models.length > 0) {
      return pass(
        'provider',
        `${models.length === 1 ? 'A provider is' : `${models.length} providers are`} registered: ${models.join(', ')}.`,
      );
    }
    return ids.length > 0
      ? fail(
          'provider',
          `Only ${DEV_ECHO_PROVIDER_ID} is registered: agents get its canned replies, not a model's.`,
          register,
        )
      : fail('provider', 'No provider is registered, so an agent has no model to call.', register);
  } catch (err) {
    return fail(
      'provider',
      `Couldn't list the providers: ${(err as Error).message}`,
      'Run doctor again once kindgi dev has finished starting; if it persists, restart kindgi dev.',
    );
  }
}

// ---------- helpers ----------

/** A `kindgi` command as this folder runs it, for a fix to copy. */
type Kindgi = (...args: string[]) => string;

/**
 * In a TypeScript project, its own CLI (`pnpm exec kindgi …`,
 * `npx --no kindgi …`); in a Python project or outside one, the
 * published CLI of this version through npx.
 */
async function kindgiCommand(
  dir: string,
  language: 'node' | 'python' | undefined,
): Promise<Kindgi> {
  if (language === 'node') {
    const runner = await detectBinRunner(dir, 'node');
    return (...args) => {
      const c = binCommand(runner, 'kindgi', args);
      return [c.command, ...c.args].join(' ');
    };
  }
  const spec = publishedCliSpec(CLI_VERSION);
  return (...args) => ['npx', spec, ...args].join(' ');
}

/** Run a tool to completion; `code: null` when it isn't installed. Gives up after 15 s. */
function runTool(command: string, args: readonly string[]): Promise<ToolOutcome> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** `a` ≥ `b`, comparing `major.minor.patch`. */
export function atLeast(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
