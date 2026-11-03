// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing app follows the output flags in every
 * language, as a new pack's init does: the summary as JSON on stdout
 * (`--raw` on one line, `--table` as `--json`), and under `--quiet`, with
 * `--json` or `--raw` too, no summary and only the warnings on stderr. Each
 * app sits in a repository rooted at the CLI's home folder, so init has a
 * warning to keep: the root's settings it leaves to you. Every run is in
 * the same folder, so the outputs compare byte for byte.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

const POM = `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>acme-ledger</artifactId>
  <version>2.4.0</version>
</project>
`;

const PYPROJECT = `[project]
name = "acme-widgets"
version = "2.3.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27"]
`;

const BUILD = `ThisBuild / scalaVersion := "3.3.8"
ThisBuild / version := "2.4.0"

lazy val root = (project in file("."))
  .settings(
    name := "acme-ledger"
  )
`;

const APPS = {
  typescript: ['package.json', JSON.stringify({ name: 'acme-app', version: '1.0.0' })],
  java: ['pom.xml', POM],
  python: ['pyproject.toml', PYPROJECT],
  scala: ['build.sbt', BUILD],
} as const;

let parent: string;
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'kindgi-augment-formats-'));
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

/** `kindgi init <argv>` in a new app of `language`, at the same path every time. */
async function init(language: keyof typeof APPS, argv: readonly string[]) {
  const home = join(parent, 'home');
  await rm(home, { recursive: true, force: true });
  const app = join(home, 'app');
  await mkdir(join(home, '.git'), { recursive: true });
  await mkdir(app);
  const [file, contents] = APPS[language];
  await writeFile(join(app, file), contents);
  return runCli({ argv: ['init', ...argv], env: {}, cwd: app, home });
}

const warningsOf = (stderr: string) =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('  ⚠ '))
    .map((line) => `${line}\n`)
    .join('');

describe.each(Object.keys(APPS) as (keyof typeof APPS)[])('kindgi init in a %s app', (language) => {
  test('--json and --table: as with no flag; --raw: the summary on one line', async () => {
    const plain = await init(language, []);
    expect(plain.exitCode, plain.stderr).toBe(0);
    const summary: unknown = JSON.parse(plain.stdout);
    expect(summary).toMatchObject({ kind: 'augment' });
    expect(plain.stdout).toBe(`${JSON.stringify(summary, null, 2)}\n`);
    expect(plain.stderr).toContain('  Kindgi added to ');
    expect(plain.stderr).toContain('  Next steps:');

    for (const flag of ['--json', '--table']) {
      expect(await init(language, [flag]), flag).toEqual(plain);
    }
    const raw = await init(language, ['--raw']);
    expect(raw).toEqual({ ...plain, stdout: `${JSON.stringify(summary)}\n` });
  });

  test('--quiet, alone or with --json or --raw: no summary, the warnings alone on stderr', async () => {
    const plain = await init(language, []);
    const warnings = warningsOf(plain.stderr);
    expect(warnings).toContain('not written: the repo root is your home folder');
    for (const flags of [['--quiet'], ['--quiet', '--json'], ['--quiet', '--raw']]) {
      const quiet = await init(language, flags);
      expect(quiet, flags.join(' ')).toEqual({ exitCode: 0, stdout: '', stderr: warnings });
    }
  });
});
