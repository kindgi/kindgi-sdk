#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Build the `kindgi-cli` wheel (sdks/python-cli): the CLI for Python
 * developers, with no Node install. The wheel carries `@kindgi/cli` as npm
 * installs it (`node_modules/@kindgi/cli`, so the CLI knows it's a published
 * one) and depends on `nodejs-wheel-binaries` for Node.
 *
 *   --from-npm <version>   the published @kindgi/cli@<version> (the release;
 *                          npm's metadata can lag a publish, so it retries)
 *   --from-workspace       this checkout's @kindgi/cli and the @kindgi/*
 *                          packages it depends on, packed (CI, dry runs)
 *   --out <dir>            where the wheel goes (default sdks/python-cli/dist)
 *   --smoke                install the wheel in a fresh venv and run
 *                          `kindgi --version` with no Node on PATH
 *
 * Universal (`py3-none-any`): esbuild's native binary is per platform, and a
 * Python pack never loads it (a TypeScript pack's bundles only; the CLI says
 * so: `src/esbuild-loader.ts`). The version must be the npm packages'
 * (`scripts/sync-python-version.mjs` keeps sdks/python-cli in lockstep).
 * The npm packages it carries are listed, with their licenses, in
 * `THIRD-PARTY-NOTICES.txt`. Needs Node, npm, pnpm (workspace) and uv.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toPep440 } from './sync-python-version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'sdks', 'python-cli');
const CLI_DIR = join(PROJECT, 'src', 'kindgi_cli', '_cli');

/**
 * The licenses the wheel may carry (permissive). Anything else stops the
 * build: a copyleft package needs a decision before it ships.
 */
export const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'MIT OR CC0-1.0',
  '(MIT OR CC0-1.0)',
]);

/** Packages the universal wheel leaves out (native, per platform; a Python pack never loads them). */
const LEFT_OUT = ['esbuild', '@esbuild'];

// ---- what goes in --------------------------------------------------------

/**
 * The workspace packages `name` depends on (its `dependencies`, transitively),
 * itself included: what `--from-workspace` packs.
 *
 * @param {string} name
 * @param {ReadonlyMap<string, { readonly dependencies?: Record<string, string> }>} manifests by package name
 */
export function workspaceClosure(name, manifests) {
  const seen = new Set();
  const visit = (pkg) => {
    if (seen.has(pkg) || !manifests.has(pkg)) return;
    seen.add(pkg);
    for (const dep of Object.keys(manifests.get(pkg)?.dependencies ?? {})) visit(dep);
  };
  visit(name);
  return [...seen].sort();
}

/**
 * Every package under `nodeModules` (scoped and nested ones too), with its
 * license and license files' text, as one notices file.
 *
 * @param {string} nodeModules
 */
export function thirdPartyNotices(nodeModules) {
  return renderNotices(collectPackages(nodeModules));
}

/** The packages a notices file covers whose license isn't in `ALLOWED_LICENSES`. */
export function disallowedLicenses(nodeModules) {
  return [...collectPackages(nodeModules).entries()]
    .filter(([, { manifest }]) => !ALLOWED_LICENSES.has(licenseOf(manifest)))
    .map(([key, { manifest }]) => `${key} (${licenseOf(manifest)})`);
}

function licenseOf(manifest) {
  return typeof manifest.license === 'string'
    ? manifest.license
    : (manifest.license?.type ?? 'UNKNOWN');
}

function authorOf(manifest) {
  const a = manifest.author;
  return typeof a === 'string' ? a : (a?.name ?? 'its authors');
}

function collectPackages(nodeModules) {
  const packages = new Map();
  walkPackages(nodeModules, packages);
  return packages;
}

/** Every package directory under `dir` (scoped and nested ones too), by `name@version`. */
function walkPackages(dir, packages) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (entry.startsWith('@')) walkPackages(path, packages);
    else addPackage(path, packages);
  }
}

function addPackage(path, packages) {
  const manifestPath = join(path, 'package.json');
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const key = `${manifest.name}@${manifest.version}`;
  if (!packages.has(key)) packages.set(key, { manifest, path });
  walkPackages(join(path, 'node_modules'), packages);
}

function renderNotices(packages) {
  const sections = [...packages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { manifest, path }]) => {
      const license = licenseOf(manifest);
      const files = readdirSync(path)
        .filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
        .sort();
      const texts = files.map((f) => readFileSync(join(path, f), 'utf8').trim());
      return [
        '='.repeat(78),
        `${key}  (${license})`,
        '='.repeat(78),
        texts.length > 0
          ? texts.join('\n\n')
          : `The package ships no license file. It is licensed ${license} by ${authorOf(manifest)}; the license's terms: https://spdx.org/licenses/${license.replace(/[()]/g, '').split(' ')[0]}.html`,
      ].join('\n');
    });
  return [
    'Third-party notices for kindgi-cli',
    '',
    'kindgi-cli carries the npm package @kindgi/cli and the packages it depends on, listed here with their licenses.',
    'Node itself comes from the nodejs-wheel-binaries package, under its own license.',
    '',
    ...sections,
    '',
  ].join('\n');
}

// ---- the build -------------------------------------------------------------

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...options,
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function installFromNpm(version) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      run(
        'npm',
        [
          'install',
          '--omit=dev',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          `@kindgi/cli@${version}`,
        ],
        {
          cwd: CLI_DIR,
        },
      );
      return;
    } catch (err) {
      if (attempt >= 10) throw err;
      console.error(
        `npm doesn't have @kindgi/cli@${version} yet (attempt ${attempt}); retrying in 30 s`,
      );
      sleep(30_000);
    }
  }
}

function workspaceManifests() {
  const listed = JSON.parse(run('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: ROOT }));
  const manifests = new Map();
  for (const pkg of listed) {
    if (pkg.name === undefined || pkg.path === undefined) continue;
    manifests.set(pkg.name, {
      ...JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')),
      dir: pkg.path,
    });
  }
  return manifests;
}

function installFromWorkspace() {
  const manifests = workspaceManifests();
  const packs = mkdtempSync(join(tmpdir(), 'kindgi-cli-packs-'));
  try {
    const tarballs = workspaceClosure('@kindgi/cli', manifests).map((name) => {
      const out = run('pnpm', ['pack', '--pack-destination', packs, '--json'], {
        cwd: manifests.get(name).dir,
      });
      // A package's prepack script may print first; the JSON is the last block.
      const start = out.lastIndexOf('\n{\n');
      return JSON.parse(start === -1 ? out : out.slice(start + 1)).filename;
    });
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        ...tarballs,
      ],
      {
        cwd: CLI_DIR,
      },
    );
  } finally {
    rmSync(packs, { recursive: true, force: true });
  }
}

function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (lstatSync(join(dir, entry)).isSymbolicLink()) {
      throw new Error(`${join(dir, entry)} is a symlink: a wheel can't carry it`);
    }
  }
}

function smoke(wheel, version) {
  const venv = mkdtempSync(join(tmpdir(), 'kindgi-cli-smoke-'));
  try {
    run('uv', ['venv', '--quiet', venv]);
    run('uv', ['pip', 'install', '--quiet', '--python', join(venv, 'bin', 'python'), wheel]);
    // No Node on PATH: the wheel's own Node runs the CLI.
    const out = run(join(venv, 'bin', 'kindgi'), ['--version'], {
      env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' },
    });
    if (!out.includes(version))
      throw new Error(`kindgi --version printed "${out.trim()}", not ${version}`);
    console.log(`smoke: kindgi --version → ${out.trim()} (no Node on PATH)`);
  } finally {
    rmSync(venv, { recursive: true, force: true });
  }
}

function main(argv) {
  const fromNpm = argv.indexOf('--from-npm');
  const fromWorkspace = argv.includes('--from-workspace');
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? join(PROJECT, 'dist') : argv[outIndex + 1];
  if ((fromNpm === -1) === !fromWorkspace) {
    throw new Error(
      'usage: node scripts/build-cli-wheel.mjs (--from-npm <version> | --from-workspace) [--out <dir>] [--smoke]',
    );
  }
  const cliManifest = JSON.parse(
    readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'),
  );
  const version = fromNpm === -1 ? cliManifest.version : argv[fromNpm + 1];
  const pyproject = readFileSync(join(PROJECT, 'pyproject.toml'), 'utf8');
  const pyVersion = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  if (pyVersion !== toPep440(version)) {
    throw new Error(
      `sdks/python-cli is at ${pyVersion}, the CLI at ${version}: run node scripts/sync-python-version.mjs`,
    );
  }

  rmSync(CLI_DIR, { recursive: true, force: true });
  mkdirSync(CLI_DIR, { recursive: true });
  writeFileSync(join(CLI_DIR, 'package.json'), '{ "private": true }\n');
  if (fromWorkspace) installFromWorkspace();
  else installFromNpm(version);

  const nodeModules = join(CLI_DIR, 'node_modules');
  for (const name of [...LEFT_OUT, '.bin'])
    rmSync(join(nodeModules, name), { recursive: true, force: true });
  const installed = JSON.parse(
    readFileSync(join(nodeModules, '@kindgi', 'cli', 'package.json'), 'utf8'),
  );
  if (installed.version !== version)
    throw new Error(`installed @kindgi/cli ${installed.version}, not ${version}`);
  assertNoSymlinks(CLI_DIR);
  const refused = disallowedLicenses(nodeModules);
  if (refused.length > 0) {
    throw new Error(
      `the wheel would carry packages under licenses not on the allow-list: ${refused.join(', ')}`,
    );
  }
  writeFileSync(join(CLI_DIR, 'THIRD-PARTY-NOTICES.txt'), thirdPartyNotices(nodeModules));

  run('uv', ['build', '--wheel', '--out-dir', out], { cwd: PROJECT, stdio: 'inherit' });
  const wheel = join(out, `kindgi_cli-${toPep440(version)}-py3-none-any.whl`);
  if (!existsSync(wheel)) throw new Error(`no wheel at ${wheel}`);
  console.log(`built ${wheel}`);
  if (argv.includes('--smoke')) smoke(wheel, version);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`build-cli-wheel: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
