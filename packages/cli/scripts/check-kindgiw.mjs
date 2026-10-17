#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Java template's CLI wrapper, run as a person runs it: `kindgiw.cmd`
 * on Windows (the `kindgiw.yml` workflow, on windows-latest), `kindgiw`
 * (sh) elsewhere. Its three ways, with fake programs on a bare PATH:
 *
 *   - Node present: `npx --yes @kindgi/cli@<pin> …`;
 *   - no Node, uv present: `uvx --from kindgi-cli==<PEP 440 pin> kindgi …`;
 *   - neither: one message naming both installs, exit 1.
 *
 * Then one real run: `kindgiw --version` through the real npx, pinned to
 * the published @kindgi/cli (its `latest`), prints that version.
 *
 * Usage: node packages/cli/scripts/check-kindgiw.mjs [--no-real]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const template = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates', 'java');
const wrapper = windows ? 'kindgiw.cmd' : 'kindgiw';
const failures = [];

function pack(pin) {
  const dir = mkdtempSync(join(tmpdir(), 'kindgiw-'));
  writeFileSync(
    join(dir, 'kindgi.config.json'),
    `${JSON.stringify({ language: 'java', cli: pin, pack: { id: 'acme', version: '1.0.0' } }, null, 2)}\n`,
  );
  copyFileSync(join(template, wrapper), join(dir, wrapper));
  if (!windows) chmodSync(join(dir, wrapper), 0o755);
  mkdirSync(join(dir, 'fakes'));
  return dir;
}

/** A fake program that prints its name and its arguments. */
function fake(dir, name) {
  if (windows) {
    writeFileSync(join(dir, 'fakes', `${name}.cmd`), `@echo ${name} %*\r\n`);
  } else {
    writeFileSync(join(dir, 'fakes', name), `#!/bin/sh\necho "${name} $*"\n`);
    chmodSync(join(dir, 'fakes', name), 0o755);
  }
}

/** The system directories the wrapper itself needs (cmd's where and PowerShell; sh's sed). */
function systemPath() {
  if (!windows) return ['/usr/bin', '/bin'];
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return [join(root, 'System32'), join(root, 'System32', 'WindowsPowerShell', 'v1.0')];
}

function run(dir, args, path) {
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'sh';
  const argv = windows ? ['/d', '/c', join(dir, wrapper), ...args] : [join(dir, wrapper), ...args];
  const env = windows
    ? { ...process.env, PATH: path, Path: path }
    : { PATH: path, HOME: process.env.HOME ?? '' };
  return spawnSync(command, argv, { env, encoding: 'utf8', cwd: dir });
}

/** What a fake printed, as one line: cmd's echo keeps the arguments' quotes, sh's doesn't. */
function printed(out) {
  return out.stdout.replace(/"/g, '').trim();
}

function check(name, ok, detail) {
  if (ok) {
    console.log(`check-kindgiw: ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`check-kindgiw: ✗ ${name}\n${detail}`);
  }
}

// 1. Node present: npx, the exact pin, the arguments passed through.
{
  const dir = pack('0.1.6');
  fake(dir, 'node');
  fake(dir, 'npx');
  fake(dir, 'uvx');
  const out = run(
    dir,
    ['runs', 'start', '--agent=acme.echo'],
    [join(dir, 'fakes'), ...systemPath()].join(delimiter),
  );
  check(
    'with Node: npx runs the pinned CLI',
    out.status === 0 && printed(out) === 'npx --yes @kindgi/cli@0.1.6 runs start --agent=acme.echo',
    `${out.status}\n${out.stdout}${out.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// 2. No Node, uv present: uvx, the pin as PEP 440.
{
  const dir = pack('0.1.6-rc.2');
  fake(dir, 'uvx');
  const out = run(dir, ['dev'], [join(dir, 'fakes'), ...systemPath()].join(delimiter));
  check(
    'without Node: uvx runs kindgi-cli from PyPI',
    out.status === 0 && printed(out) === 'uvx --from kindgi-cli==0.1.6rc2 kindgi dev',
    `${out.status}\n${out.stdout}${out.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// 3. Neither: one message naming both installs.
{
  const dir = pack('0.1.6');
  const out = run(dir, ['dev'], [join(dir, 'fakes'), ...systemPath()].join(delimiter));
  check(
    'neither: a message naming both installs, exit 1',
    out.status === 1 && /Node 22\.12 or later/.test(out.stderr) && /with uv/.test(out.stderr),
    `${out.status}\n${out.stdout}${out.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// 4. One real run, through the real npx, of the published CLI.
if (!process.argv.includes('--no-real')) {
  const npm = windows ? 'npm.cmd' : 'npm';
  const published = execFileSync(npm, ['view', '@kindgi/cli', 'version'], {
    encoding: 'utf8',
    shell: windows,
  }).trim();
  const dir = pack(published);
  const out = run(dir, ['--version'], process.env.PATH ?? '');
  check(
    `a real npx run prints the pinned ${published}`,
    out.status === 0 && out.stdout.trim().split(/\r?\n/).pop() === published,
    `${out.status}\n${out.stdout}${out.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures.length > 0 ? 1 : 0);
