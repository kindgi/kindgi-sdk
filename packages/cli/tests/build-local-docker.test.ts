// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi build --local` for real, with Docker: the image builds from
 * the pack's own lockfile, its indexer stage writes the same index as
 * the local one, and the image serves the pack's tool — a TypeScript
 * tool that imports a module of the app, bundled. Once with npm, once
 * with a pnpm workspace whose pack sits in a member folder.
 *
 * Gated: `KINDGI_DOCKER_TESTS=1` (needs Docker, and the network for the
 * base image and corepack's pnpm).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { REAL_BUILD_RUNNERS } from '../src/build/defaults.js';
import { runCli } from '../src/main.js';

const gated = process.env.KINDGI_DOCKER_TESTS !== '1';
const TOKEN = 'docker-test-token';
const containers: string[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * The app's own install scripts, which never run in the image (a
 * `postinstall: prisma generate` would fail there): if one ran, the
 * build would fail.
 */
const APP_INSTALL_SCRIPTS = {
  postinstall: 'echo "the app\'s own postinstall ran in the image" >&2; exit 1',
  prepare: 'echo "the app\'s own prepare ran in the image" >&2; exit 1',
};

const ECHO_TOOL = `import { greet } from '../../lib/greet';

export default {
  id: 'smoke.echo',
  version: '0.1.0',
  description: 'Greets by name.',
  input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  output: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'], additionalProperties: false },
  effects: [],
  mutating: false,
  handler: async (input: { name: string }) => ({ greeting: greet(input.name) }),
};
`;

async function put(root: string, rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), body, 'utf8');
}

/** The pack: a config, a tool, and the app module it imports. */
async function writePack(packDir: string, packageJson: Record<string, unknown>): Promise<void> {
  await put(packDir, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await put(
    packDir,
    'kindgi.config.mjs',
    "export default { pack: { id: 'smoke', version: '0.1.0' } };\n",
  );
  await put(
    packDir,
    'lib/greet.ts',
    'export const greet = (name: string): string => `Hello, ${name}!`;\n',
  );
  await put(packDir, 'tools/echo/index.ts', ECHO_TOOL);
}

async function buildLocal(
  packDir: string,
  artifactVersion: string,
  extraArgs: readonly string[] = [],
): Promise<{ readonly imageRef: string; readonly log: string }> {
  const out = await runCli({
    argv: [
      'build',
      '--local',
      `--artifact-version=${artifactVersion}`,
      `--path=${packDir}`,
      ...extraArgs,
    ],
    env: {},
    cwd: packDir,
    home: await mkdtemp(join(tmpdir(), 'kindgi-docker-home-')),
    buildRunners: REAL_BUILD_RUNNERS,
  });
  expect(out.exitCode, out.stderr).toBe(0);
  expect(out.stderr).toContain('matches the local index byte for byte');
  return { imageRef: (JSON.parse(out.stdout) as { imageRef: string }).imageRef, log: out.stderr };
}

/** Run the image, then call its tool the way the server does. */
async function serveAndInvoke(imageRef: string, name: string): Promise<unknown> {
  const container = `kindgi-build-test-${name}-${process.pid}`;
  containers.push(container);
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-p',
    '127.0.0.1::8080',
    '-e',
    `KINDGI_PACK_SERVICE_TOKEN=${TOKEN}`,
    imageRef,
  ]);
  const port = execFileSync('docker', ['port', container, '8080/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .pop();
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = await fetch(`${base}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error(execFileSync('docker', ['logs', container], { encoding: 'utf8' }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const reply = await fetch(`${base}/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'kindgi-pack-token': TOKEN },
    body: JSON.stringify({
      v: 2,
      kind: 'invoke',
      tool: { id: 'smoke.echo' },
      input: { name: 'Ada' },
      ctx: { tenantId: 't-1', runId: 'run-1', requestId: 'call-1' },
    }),
  });
  return reply.json();
}

describe.skipIf(gated)('kindgi build --local with Docker', () => {
  test("npm: builds from package-lock.json and serves the tool; the app's own install scripts don't run", async () => {
    const packDir = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-docker-npm-')));
    dirs.push(packDir);
    await writePack(packDir, {
      name: 'smoke-npm',
      version: '0.1.0',
      private: true,
      engines: { node: '>=22' },
      scripts: APP_INSTALL_SCRIPTS,
    });
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--silent'], {
      cwd: packDir,
    });

    const { imageRef } = await buildLocal(packDir, '20261002.1');
    expect(await serveAndInvoke(imageRef, 'npm')).toEqual({
      v: 2,
      kind: 'result',
      output: { greeting: 'Hello, Ada!' },
    });
  }, 600_000);

  test('pnpm workspace: the pack in a member folder installs from the root lockfile; a rebuild reuses the store', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-docker-pnpm-')));
    dirs.push(root);
    const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
    await put(
      root,
      'package.json',
      `${JSON.stringify({ name: 'mono', private: true, packageManager: `pnpm@${pnpm}`, scripts: APP_INSTALL_SCRIPTS }, null, 2)}\n`,
    );
    await put(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'services/*'\n");
    // Another member: the image installs only the pack's project, so not this.
    await put(
      root,
      'services/api/package.json',
      `${JSON.stringify({ name: 'api', version: '0.1.0', private: true, dependencies: { 'is-number': '7.0.0' } }, null, 2)}\n`,
    );
    const packDir = join(root, 'apps', 'support');
    const manifest = {
      name: 'support',
      version: '0.1.0',
      private: true,
      engines: { node: '24.x' },
      scripts: APP_INSTALL_SCRIPTS,
      dependencies: { 'kind-of': '6.0.3' } as Record<string, string>,
    };
    await writePack(packDir, manifest);
    execFileSync('pnpm', ['install', '--lockfile-only', '--silent'], { cwd: root });

    const { imageRef } = await buildLocal(packDir, '20261002.2');
    const other = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        imageRef,
        '-c',
        'ls /app/services/api/node_modules 2>&1 || true',
      ],
      { encoding: 'utf8' },
    );
    expect(other).not.toContain('is-number');
    expect(await serveAndInvoke(imageRef, 'pnpm')).toEqual({
      v: 2,
      kind: 'result',
      output: { greeting: 'Hello, Ada!' },
    });

    // Another dependency: a new lockfile, so the install runs again, and
    // takes what it already has from the store (the cache mount).
    manifest.dependencies.ms = '2.1.3';
    await put(packDir, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('pnpm', ['install', '--lockfile-only', '--silent'], { cwd: root });
    const rebuilt = await buildLocal(packDir, '20261002.3');
    expect(rebuilt.log).toMatch(/reused [1-9]\d*, downloaded/);
  }, 900_000);

  test("image: system packages, an extension's step with its file and build env, never in the final image", async () => {
    const packDir = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-docker-image-')));
    dirs.push(packDir);
    await writePack(packDir, {
      name: 'smoke-image',
      version: '0.1.0',
      private: true,
      engines: { node: '>=22' },
      dependencies: { 'marker-pkg': 'file:vendor/marker-pkg' },
    });
    // A package with a bin, vendored in the project: the extension's step runs it.
    await put(
      packDir,
      'vendor/marker-pkg/package.json',
      `${JSON.stringify({ name: 'marker-pkg', version: '1.0.0', bin: { 'write-marker': 'bin.js' } })}\n`,
    );
    await put(
      packDir,
      'vendor/marker-pkg/bin.js',
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('generated', { recursive: true });
fs.writeFileSync('generated/marker.json', JSON.stringify({ input: fs.readFileSync(process.argv[2], 'utf8').trim(), env: process.env.BUILD_MARK }));
`,
    );
    await put(packDir, 'marker/input.txt', 'from the context\n');
    await put(
      packDir,
      'kindgi.config.mjs',
      `export default {
  pack: { id: 'smoke', version: '0.1.0' },
  image: {
    systemPackages: ['jq'],
    extensions: [
      { name: 'marker', contextFiles: ['marker/input.txt'], postInstall: [{ bin: 'write-marker', args: ['marker/input.txt'] }] },
    ],
    buildEnv: { BUILD_MARK: 'from-build-env' },
  },
};
`,
    );
    execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: packDir });

    const { imageRef } = await buildLocal(packDir, '20261003.1');
    const inImage = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        imageRef,
        '-c',
        'cat /app/generated/marker.json; echo; jq --version; echo "BUILD_MARK=${BUILD_MARK:-unset}"',
      ],
      { encoding: 'utf8' },
    ).split('\n');
    expect(JSON.parse(inImage[0] ?? '')).toEqual({
      input: 'from the context',
      env: 'from-build-env',
    });
    expect(inImage[1]).toMatch(/^jq-/);
    expect(inImage[2]).toBe('BUILD_MARK=unset');
    // The tool still answers.
    expect(await serveAndInvoke(imageRef, 'image')).toMatchObject({ kind: 'result' });
  }, 600_000);

  test('--push: builds for linux/amd64, pushes to the registry, and writes a signed envelope', async () => {
    const packDir = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-docker-push-')));
    dirs.push(packDir);
    await writePack(packDir, {
      name: 'smoke-push',
      version: '0.1.0',
      private: true,
      engines: { node: '>=22' },
    });
    execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: packDir });
    // A registry of the test's own, on the Docker host's loopback: the
    // daemon pushes there (on Docker Desktop that's the VM's, which a port
    // published on the Mac's loopback isn't), and nothing else can reach it.
    const registry = `kindgi-build-test-registry-${process.pid}`;
    containers.push(registry);
    const port = 52_000 + (process.pid % 5_000);
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      registry,
      '--network',
      'host',
      '-e',
      `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
      'registry:2',
    ]);
    const key = join(packDir, 'signing-key.pem');
    await writeFile(
      key,
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      'utf8',
    );

    const repository = `localhost:${port}/smoke`;
    const { imageRef } = await buildLocal(packDir, '20261003.2', [
      `--push=${repository}`,
      '--tenant=t-test',
      `--signing-key=${key}`,
    ]);
    expect(imageRef).toMatch(new RegExp(`^${repository}@sha256:[0-9a-f]{64}$`));
    const envelope = JSON.parse(
      execFileSync('cat', [join(packDir, '.kindgi/build/deploy-envelope.json')], {
        encoding: 'utf8',
      }),
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({ imageRef, tenantId: 't-test', artifactVersion: '20261003.2' });
    expect(envelope.signature).toBeTruthy();
    // The integrity gate pulled it back from the registry by digest: it's
    // there, for linux/amd64.
    const platform = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', imageRef],
      { encoding: 'utf8' },
    ).trim();
    expect(platform).toBe('linux/amd64');
  }, 900_000);
});
