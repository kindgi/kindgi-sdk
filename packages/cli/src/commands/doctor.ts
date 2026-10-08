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
 * fails. `skip` is never a failure, and neither is `warn`: it works now,
 * but the person should know (a provider whose agents land on a model its
 * preset no longer lists, or not on the preset's default).
 *
 * Under `kindgi-cli` (the PyPI build, `KINDGI_CLI_INSTALL=pypi`), Node is
 * the one the wheel brings and npm isn't needed, so neither is a failure,
 * and the fixes say `uv run kindgi …` (or `uvx --from kindgi-cli kindgi …`
 * outside a project), not npx.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { findKindgiConfig } from '@kindgi/handler-runtime';
import { LOCAL_ENV_NAME, displayEnvPath, readPackEnv } from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { type DockerRunner, docker } from '../dev/runtime-container.js';
import { DEFAULT_RUNTIME_IMAGE, registryOf } from '../dev/runtime-image.js';
import { checkDocker, checkImageAccess, credentialHelperHint } from '../dev/runtime-registry.js';
import { renderJson } from '../output.js';
import {
  type PackageManager,
  binCommand,
  cliInstall,
  defaultDetectIo,
  publishedCliSpec,
  pythonBinRunner,
  usablePackageManager,
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
  | 'provider'
  | 'console-sign-in';

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  /** `warn` works now but needs the person's attention: never a failure (`ok` stays true). */
  readonly status: 'pass' | 'warn' | 'fail' | 'skip';
  /** What was found, in a sentence. */
  readonly message: string;
  /** The exact command or step that fixes it: on every failure and warning, and on some skips. */
  readonly fix?: string;
}

/** What `kindgi doctor --json` prints. */
export interface DoctorReport {
  /** No check failed (skips and warnings don't count). */
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
  'console-sign-in': 'Console sign-in',
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
  const pypi = cliInstall(ctx.env) === 'pypi';
  const kindgi = await kindgiCommand(dir, language, pypi, tool);

  checks.push(...(await nodeChecks(seam.nodeVersion ?? process.versions.node, tool, pypi)));
  checks.push(...(await pythonChecks(tool, language)));
  const dockerCheck = await checkDockerRunning(run);
  checks.push(dockerCheck);
  checks.push(
    dockerCheck.status === 'pass'
      ? await registryCheck(run, seam.image ?? DEFAULT_RUNTIME_IMAGE, kindgi)
      : skip('registry', 'Not checked: it needs Docker running.'),
  );
  checks.push(await consoleSignInCheck(ctx));

  if (config === undefined || language === undefined) {
    checks.push({
      id: 'project',
      status: 'skip',
      message: `No Kindgi project in ${dir}: no kindgi.config.ts, and no pyproject.toml with [tool.kindgi].`,
      fix: createProjectFix(kindgi, pypi),
    });
    for (const id of ['dependencies', 'model-key', 'runtime', 'provider'] as const) {
      checks.push(skip(id, 'Not checked: it needs a project.'));
    }
    return report(checks, null);
  }

  const rc = await readKindgirc(dir);
  checks.push(projectCheck(dir, language, rc));
  checks.push(await dependenciesCheck(dir, language, tool));
  checks.push(await modelKeyCheck(dir, seam, ctx.env, kindgi));
  const runtime = await runtimeCheck(ctx, rc, kindgi);
  checks.push(runtime.check);
  checks.push(
    runtime.check.status === 'pass' && runtime.url !== undefined && rc.token !== undefined
      ? await providerCheck(ctx, runtime.url, rc.token, kindgi, seam)
      : skip('provider', `Not checked: it needs the runtime running (${kindgi('dev')}).`),
  );
  return report(checks, { dir, language });
}

/** The report as ✓/✗ lines, each failure with its fix. */
export function doctorText(report: DoctorReport): string {
  const lines = [`kindgi doctor (CLI ${report.cliVersion})`];
  for (const check of report.checks) {
    const mark = MARKS[check.status];
    lines.push(`  ${mark} ${TITLES[check.id]}: ${check.message}`);
    if (check.fix !== undefined && check.status !== 'pass') lines.push(`      Fix: ${check.fix}`);
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const warned = report.checks.filter((c) => c.status === 'warn').length;
  const warnings = `${warned} ${warned === 1 ? 'warning' : 'warnings'}`;
  lines.push(
    failed > 0
      ? `${failed} ${failed === 1 ? 'problem' : 'problems'} to fix${warned > 0 ? `, and ${warnings}` : ''}.`
      : warned > 0
        ? `Everything checked is ready, with ${warnings}.`
        : 'Everything checked is ready.',
  );
  return `${lines.join('\n')}\n`;
}

const MARKS: Readonly<Record<DoctorCheck['status'], string>> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
  skip: '–',
};

function report(checks: readonly DoctorCheck[], project: DoctorReport['project']): DoctorReport {
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    cliVersion: CLI_VERSION,
    project,
    checks,
  };
}

const pass = (id: DoctorCheckId, message: string): DoctorCheck => ({ id, status: 'pass', message });
const warn = (id: DoctorCheckId, message: string, fix: string): DoctorCheck => ({
  id,
  status: 'warn',
  message,
  fix,
});
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

/** Node and npm. Under kindgi-cli, Node is the one the wheel brings and npm isn't needed. */
async function nodeChecks(
  version: string,
  tool: NonNullable<DoctorSeam['tool']>,
  pypi: boolean,
): Promise<DoctorCheck[]> {
  if (!pypi) return [nodeCheck(version, false), await npmCheck(tool)];
  return [
    nodeCheck(version, true),
    skip(
      'npm',
      'Not needed: this kindgi is kindgi-cli (from PyPI), for Python projects, and it brings its own Node.',
    ),
  ];
}

/** How to start a project here: kindgi-cli makes Python packs only. */
function createProjectFix(kindgi: Kindgi, pypi: boolean): string {
  return pypi
    ? `Create one: ${kindgi('init', '<name>', '--template=python')}, then run doctor in its folder.`
    : `Create one: ${kindgi('init', '<name>')} (TypeScript; add --template=python for Python), then run doctor in its folder.`;
}

function nodeCheck(version: string, pypi: boolean): DoctorCheck {
  return atLeast(version, MIN_NODE)
    ? pass('node', pypi ? `Node ${version}, bundled with kindgi-cli.` : `Node ${version}.`)
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
  const login = `${kindgi('auth', 'registry', '--username', '<robot name>', '--password-stdin')} (the robot name and token come from access.kindgi.com; pipe the token in, never paste it into a chat)`;
  switch (access.kind) {
    case 'ok':
      return pass('registry', `Docker can pull the runtime image (${image}).`);
    case 'no-access':
      return fail(
        'registry',
        `Docker can't pull the runtime image from ${host}: ${firstLine(access.detail)}`,
        `Log Docker in with your pull token: ${login}. Then run doctor again.`,
      );
    case 'not-found':
      return access.maybeNoAccess === true
        ? fail(
            'registry',
            `Docker has no access to the runtime image on ${host}, or it isn't there: docker manifest inspect can't tell them apart (${firstLine(access.detail)}).`,
            `If you haven't logged Docker in yet: ${login}. Otherwise check this machine can reach ${host}, then run doctor again.`,
          )
        : fail(
            'registry',
            `Couldn't find the runtime image on ${host}: ${firstLine(access.detail)}`,
            `Check this machine can reach ${host} (the network, a proxy or a firewall), then run doctor again.`,
          );
    case 'credential-helper':
      return fail(
        'registry',
        `Docker couldn't run its credential helper${access.helper !== undefined ? ` (docker-credential-${access.helper})` : ''}: ${firstLine(access.detail)}`,
        credentialHelperHint(access.helper),
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

async function dependenciesCheck(
  dir: string,
  language: 'node' | 'python',
  tool: NonNullable<DoctorSeam['tool']>,
): Promise<DoctorCheck> {
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
  const { pm, declared } = await installedPackageManager(dir, tool);
  return fail(
    'dependencies',
    "@kindgi/sdk isn't installed: the project's dependencies aren't.",
    `Install them: ${pm} install${declared !== undefined ? ` (the project names ${declared}, which isn't installed here)` : ''}`,
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

/** `a`, `a or b`, `a, b or c`. */
function orList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** The presets that take an LLM provider key, with the key's name, in preset order. */
async function keyedPresets(
  seam: DoctorSeam,
): Promise<readonly { readonly name: string; readonly secret: string }[]> {
  const presets = await (seam.presets ?? (() => loadProviderPresets()))();
  return Object.values(presets).flatMap((p) =>
    p.secret !== undefined ? [{ name: p.name, secret: p.secret }] : [],
  );
}

/** A model key the presets name, set in the project's env files. Its value is never read out. */
async function modelKeyCheck(
  dir: string,
  seam: DoctorSeam,
  hostEnv: Readonly<Record<string, string | undefined>>,
  kindgi: Kindgi,
): Promise<DoctorCheck> {
  const names = [...new Set((await keyedPresets(seam)).map((p) => p.secret))];
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
  const others = names.slice(1);
  return fail(
    'model-key',
    `No model key in ${files} (looked for ${names.join(', ')})${inShell !== undefined ? `; ${inShell} is set in your shell, but kindgi dev reads keys from the project's env files` : ''}.`,
    `With kindgi dev running, set one LLM provider's key: ${kindgi('secrets', 'set', want, '--env=local', '--scope=tenant')}${others.length > 0 ? `, or the same with ${orList(others)}` : ''} (it prompts without echoing; or pipe it in with --from-stdin). Never paste a key into a chat.`,
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

/**
 * Whether anyone can sign in to the console of the runtime the CLI points
 * at (`--url`, `KINDGI_API_URL`, `kindgi auth login`). Since 0.1.5,
 * signing in with an API token is off by default outside `kindgi dev`: a
 * deployment that relied on it, with no identity provider, has no way in.
 */
async function consoleSignInCheck(ctx: CommandContext): Promise<DoctorCheck> {
  const apiUrl = ctx.config.apiUrl?.replace(/\/+$/, '');
  if (apiUrl === undefined) {
    return skip(
      'console-sign-in',
      'Not checked: no runtime to ask (set KINDGI_API_URL, or run kindgi auth login).',
    );
  }
  const TOKEN_ON =
    'Set KINDGI_CONSOLE_TOKEN_SIGN_IN=on on the runtime and restart it, to keep signing in to the console with an API token';
  let methods: { identityProviders?: unknown; apiToken?: unknown } | undefined;
  try {
    const res = await ctx.fetch(`${apiUrl}/v1/auth/sign-in-options`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return skip(
        'console-sign-in',
        `Not checked: the runtime at ${apiUrl} doesn't say how people sign in (older than 0.1.5).`,
      );
    }
    methods = ((await res.json()) as { methods?: typeof methods }).methods;
  } catch {
    return skip('console-sign-in', `Not checked: nothing answers at ${apiUrl}.`);
  }
  if (methods === undefined) {
    return skip(
      'console-sign-in',
      `Not checked: the runtime at ${apiUrl} doesn't say how people sign in (older than 0.1.5).`,
    );
  }
  if (methods.apiToken === true) {
    return pass(
      'console-sign-in',
      methods.identityProviders === true
        ? 'People can sign in to the console with an API token or an identity provider.'
        : 'People can sign in to the console with an API token.',
    );
  }
  if (methods.identityProviders !== true) {
    return warn(
      'console-sign-in',
      `Nobody can sign in to the console at ${apiUrl}: signing in with an API token is off (the default outside kindgi dev since 0.1.5), and no identity provider is set up.`,
      `${TOKEN_ON}; or set up sign-in with your identity provider (KINDGI_AUTH_SECRET_PATH, then kindgi sso providers start).`,
    );
  }
  const token = ctx.config.token;
  if (token === undefined) {
    return pass('console-sign-in', 'People sign in to the console with an identity provider.');
  }
  try {
    const res = await ctx.fetch(`${apiUrl}/v1/auth/providers`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const providers = ((await res.json()) as { data?: unknown[] }).data ?? [];
      if (providers.length === 0) {
        return warn(
          'console-sign-in',
          `Sign-in with an identity provider is on at ${apiUrl}, but none is registered, and signing in with an API token is off: nobody can sign in to the console.`,
          `Register one (kindgi sso providers start <id> --idp=google|entra|okta|keycloak); or ${TOKEN_ON.charAt(0).toLowerCase()}${TOKEN_ON.slice(1)}.`,
        );
      }
    }
  } catch {
    // The providers couldn't be listed: the sign-in options already said it's on.
  }
  return pass('console-sign-in', 'People sign in to the console with an identity provider.');
}

async function providerCheck(
  ctx: CommandContext,
  apiUrl: string,
  token: string,
  kindgi: Kindgi,
  seam: DoctorSeam,
): Promise<DoctorCheck> {
  try {
    const page = await ctx.clientFor(apiUrl, token).providers.list();
    const listed = page.data as readonly ListedProvider[];
    const ids = listed.map((p) => p.id ?? '?');
    const models = ids.filter((id) => id !== DEV_ECHO_PROVIDER_ID);
    const presets = (await keyedPresets(seam)).map((p) => p.name);
    const register =
      presets.length > 1
        ? `Register the provider whose key you set: ${kindgi('providers', 'register', '--preset=<preset>')}, where <preset> is ${orList(presets)} (see Model key).`
        : `Register one: ${kindgi('providers', 'register', `--preset=${presets[0] ?? 'anthropic'}`)} (its key must be set first; see Model key).`;
    if (models.length > 0) {
      const registered = `${models.length === 1 ? 'A provider is' : `${models.length} providers are`} registered: ${models.join(', ')}.`;
      const stale = staleDefaults(
        listed,
        await (seam.presets ?? (() => loadProviderPresets()))(),
        kindgi,
      );
      return stale.length === 0
        ? pass('provider', registered)
        : warn(
            'provider',
            [registered, ...stale.map((s) => s.message)].join(' '),
            stale.map((s) => s.fix).join(' '),
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

/** A registered provider as `providers.list` answers it; a runtime before 0.1.4 sends no `defaultModel`. */
interface ListedProvider {
  readonly id?: string;
  readonly models?: readonly { readonly name: string }[];
  readonly defaultModel?: string;
}

/**
 * Registrations made from a preset (the preset's provider id) whose
 * agents that name no model land where the preset no longer would send
 * them: on a model the preset dropped, or, for a registration with no
 * default model, not on the preset's default.
 */
function staleDefaults(
  listed: readonly ListedProvider[],
  presets: Readonly<Record<string, ProviderPreset>>,
  kindgi: Kindgi,
): readonly { readonly message: string; readonly fix: string }[] {
  const byId = new Map(Object.values(presets).map((p) => [p.metadata.id, p]));
  return listed.flatMap((p) => {
    const preset = p.id === undefined ? undefined : byId.get(p.id);
    const names = (p.models ?? []).map((m) => m.name);
    if (preset === undefined || names.length === 0) return [];
    // As the router breaks a tie: the provider's default model, else the first by name.
    const lands =
      p.defaultModel !== undefined && names.includes(p.defaultModel)
        ? p.defaultModel
        : [...names].sort((a, b) => a.localeCompare(b))[0];
    const register = kindgi(
      'providers',
      'register',
      `--preset=${preset.name}`,
      ...(preset.adapterConfig ?? []).map((s) => `--${s.key}=<${s.key}>`),
    );
    if (!preset.metadata.models.some((m) => m.name === lands)) {
      return [
        {
          message: `On ${p.id}, an agent that names no model gets ${lands}, which the ${preset.name} preset no longer lists.`,
          fix: `Re-register ${p.id} for the preset's current models: ${register}. Or name a model on your agents (preferredModel).`,
        },
      ];
    }
    const wanted = preset.metadata.defaultModel;
    if (
      p.defaultModel === undefined &&
      wanted !== undefined &&
      wanted !== lands &&
      names.includes(wanted)
    ) {
      return [
        {
          message: `On ${p.id}, an agent that names no model gets ${lands}, the first by name: ${p.id} has no default model, and the ${preset.name} preset's is ${wanted}.`,
          fix: `Re-register ${p.id}: ${register}. A runtime older than 0.1.4 doesn't keep a default model: there, name a model on your agents (preferredModel).`,
        },
      ];
    }
    return [];
  });
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
  pypi: boolean,
  tool: NonNullable<DoctorSeam['tool']>,
): Promise<Kindgi> {
  if (pypi) {
    // The PyPI build runs from the project's own environment; outside one, uvx.
    if (language === undefined) {
      return (...args) => ['uvx', '--from', 'kindgi-cli', 'kindgi', ...args].join(' ');
    }
    const runner = await pythonBinRunner(dir, { KINDGI_CLI_INSTALL: 'pypi' });
    return (...args) => {
      const c = binCommand(runner, 'kindgi', args);
      return [c.command, ...c.args].join(' ');
    };
  }
  if (language === 'node') {
    const runner = (await installedPackageManager(dir, tool)).pm;
    return (...args) => {
      const c = binCommand(runner, 'kindgi', args);
      return [c.command, ...c.args].join(' ');
    };
  }
  const spec = publishedCliSpec(CLI_VERSION);
  return (...args) => ['npx', spec, ...args].join(' ');
}

/**
 * The package manager that runs here (`usablePackageManager`), asking
 * through doctor's tool seam whether a declared one is installed.
 */
function installedPackageManager(
  dir: string,
  tool: NonNullable<DoctorSeam['tool']>,
): Promise<{ readonly pm: PackageManager; readonly declared?: PackageManager }> {
  return usablePackageManager(dir, {
    ...defaultDetectIo,
    runs: async (pm) => (await tool(pm, ['--version'])).code === 0,
  });
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
