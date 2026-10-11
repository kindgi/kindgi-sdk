// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Java pack's CLI pin: `kindgiw` (its three ways to run the pinned CLI),
 * the warning when another CLI runs in the pack, and `kindgi upgrade`.
 */

import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { cliPinWarning, readCliPin, writeCliPin } from '../src/cli-pin.js';
import { runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';

const TEMPLATE = fileURLToPath(new URL('../src/templates/java/', import.meta.url));

let pack: string;
let bin: string;
beforeEach(async () => {
  pack = await mkdtemp(join(tmpdir(), 'kindgi-pin-'));
  bin = join(pack, '.fake-bin');
  await mkdir(bin);
});
afterEach(async () => {
  await rm(pack, { recursive: true, force: true });
});

async function config(cli?: string): Promise<void> {
  await writeFile(
    join(pack, 'kindgi.config.json'),
    `${JSON.stringify({ language: 'java', ...(cli !== undefined && { cli }), pack: { id: 'acme', version: '1.0.0' } }, null, 2)}\n`,
  );
}

/** A fake program on the wrapper's PATH that prints its name and arguments. */
async function fake(name: string): Promise<void> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\necho "${name} $*"\n`);
  await chmod(file, 0o755);
}

function kindgiw(...args: string[]) {
  return spawnSync('sh', [join(pack, 'kindgiw'), ...args], {
    // Only the fakes, and what sh, sed and dirname need.
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

describe.skipIf(process.platform === 'win32')('kindgiw', () => {
  beforeEach(async () => {
    await copyFile(join(TEMPLATE, 'kindgiw'), join(pack, 'kindgiw'));
  });

  test('with Node: npx runs the pinned CLI, arguments passed through', async () => {
    await config('0.1.6');
    await fake('node');
    await fake('npx');
    await fake('uvx');
    const run = kindgiw('runs', 'start', '--input={"a": 1}');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('npx --yes @kindgi/cli@0.1.6 runs start --input={"a": 1}');
  });

  test('without Node: uvx runs kindgi-cli from PyPI, the version spelled as PEP 440', async () => {
    await config('0.1.6-rc.2');
    await fake('uvx');
    const run = kindgiw('dev');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('uvx --from kindgi-cli==0.1.6rc2 kindgi dev');
  });

  test('neither: one message naming both installs, exit 1', async () => {
    await config('0.1.6');
    const run = kindgiw('dev');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('the Kindgi CLI 0.1.6 runs with Node 22.12 or later');
    expect(run.stderr).toContain('or with uv');
  });

  test('without a pin: says where it belongs', async () => {
    await config();
    await fake('node');
    await fake('npx');
    const run = kindgiw('dev');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no "cli" version in');
  });

  test('the template ships it executable, with its Windows twin', async () => {
    expect((await stat(join(TEMPLATE, 'kindgiw'))).mode & 0o111).not.toBe(0);
    const cmd = await readFile(join(TEMPLATE, 'kindgiw.cmd'), 'utf8');
    expect(cmd).toContain('npx --yes "@kindgi/cli@%KINDGIW_VERSION%" %*');
    expect(cmd).toContain('uvx --from "kindgi-cli==%KINDGIW_PEP440%" kindgi %*');
  });
});

describe('the pin', () => {
  test('read, written after language, and moved, keeping the other keys', async () => {
    await config();
    expect(await readCliPin(pack)).toBeUndefined();
    expect(await writeCliPin(join(pack, 'kindgi.config.json'), '0.1.6')).toEqual({});
    expect(
      Object.keys(JSON.parse(await readFile(join(pack, 'kindgi.config.json'), 'utf8'))),
    ).toEqual(['language', 'cli', 'pack']);
    expect(await writeCliPin(join(pack, 'kindgi.config.json'), '0.1.7')).toEqual({
      previous: '0.1.6',
    });
    expect(await readCliPin(pack)).toBe('0.1.7');
  });

  test('the warning: only when another CLI runs', () => {
    expect(cliPinWarning('0.1.6', '0.1.6')).toBeUndefined();
    expect(cliPinWarning('0.1.6', '0.1.7')).toContain('pins the Kindgi CLI 0.1.6');
  });

  test('a command in a pack pinned to another CLI warns first; one pinned to this CLI, not', async () => {
    await config('0.0.1');
    const other = await runCli({ argv: ['doctor', '--help'], env: {}, cwd: pack, home: pack });
    expect(other.stderr).toBe('');
    const warned = await runCli({
      argv: ['skills', 'sync', '--dry-run'],
      env: {},
      cwd: pack,
      home: pack,
    });
    expect(warned.stderr).toContain(
      `pins the Kindgi CLI 0.0.1 ("cli" in kindgi.config.json), and this is ${CLI_VERSION}`,
    );
    await config(CLI_VERSION);
    const same = await runCli({
      argv: ['skills', 'sync', '--dry-run'],
      env: {},
      cwd: pack,
      home: pack,
    });
    expect(same.stderr).not.toContain('pins the Kindgi CLI');
  });
});

describe('kindgi upgrade', () => {
  test("moves the pin and the pom's kindgi.version, and writes the wrappers", async () => {
    await config('0.1.6');
    await writeFile(
      join(pack, 'pom.xml'),
      '<project><properties>\n    <kindgi.version>0.1.6</kindgi.version>\n  </properties></project>\n',
    );
    const out = await runCli({ argv: ['upgrade', '--to=0.1.7'], env: {}, cwd: pack, home: pack });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await readCliPin(pack)).toBe('0.1.7');
    expect(await readFile(join(pack, 'pom.xml'), 'utf8')).toContain(
      '<kindgi.version>0.1.7</kindgi.version>',
    );
    expect((await stat(join(pack, 'kindgiw'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(pack, 'kindgiw.cmd'))).isFile()).toBe(true);
    expect(out.stderr).toContain('"cli": 0.1.6 → 0.1.7');
  });

  test("defaults to this CLI's version; a pom without the property is told what to set", async () => {
    await config();
    await writeFile(join(pack, 'pom.xml'), '<project/>\n');
    const out = await runCli({ argv: ['upgrade'], env: {}, cwd: pack, home: pack });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await readCliPin(pack)).toBe(CLI_VERSION);
    expect(out.stderr).toContain(
      `Set the com.kindgi:kindgi-pack version in pom.xml to ${CLI_VERSION}`,
    );
  });

  test("a Scala pack: moves the pin and build.sbt's kindgi-pack-scala version", async () => {
    await writeFile(
      join(pack, 'kindgi.config.json'),
      JSON.stringify({ language: 'scala', cli: '0.1.6', pack: { id: 'acme', version: '1.0.0' } }),
    );
    await writeFile(
      join(pack, 'build.sbt'),
      'libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "0.1.6"\n',
    );
    const out = await runCli({ argv: ['upgrade', '--to=0.1.7'], env: {}, cwd: pack, home: pack });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await readCliPin(pack)).toBe('0.1.7');
    expect(await readFile(join(pack, 'build.sbt'), 'utf8')).toBe(
      'libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "0.1.7"\n',
    );
    expect(out.stderr).toContain('build.sbt kindgi-pack-scala: 0.1.6 → 0.1.7');
    // A build that declares it elsewhere (project/*.scala) is told what to set.
    await writeFile(join(pack, 'build.sbt'), 'libraryDependencies ++= Dependencies.all\n');
    const elsewhere = await runCli({
      argv: ['upgrade', '--to=0.1.8'],
      env: {},
      cwd: pack,
      home: pack,
    });
    expect(elsewhere.stderr).toContain(
      'Set the "com.kindgi" %% "kindgi-pack-scala" version where your build declares it (build.sbt, project/*.scala) to 0.1.8.',
    );
  });

  test('a TypeScript pack is told to use its package manager; a bad version is refused', async () => {
    await writeFile(
      join(pack, 'kindgi.config.mjs'),
      "export default { pack: { id: 'a', version: '1' } };\n",
    );
    const ts = await runCli({ argv: ['upgrade'], env: {}, cwd: pack, home: pack });
    expect(ts.exitCode).toBe(1);
    expect(ts.stderr).toContain('pnpm add -D @kindgi/cli@');
    const bad = await runCli({ argv: ['upgrade', '--to=latest'], env: {}, cwd: pack, home: pack });
    expect(bad.exitCode).toBe(2);
  });
});
