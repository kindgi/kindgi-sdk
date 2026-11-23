// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LATEST_PLUGIN,
  checksumLine,
  moduleZipName,
  writeDownloads,
  writeModuleZip,
} from './downloads.mjs';

/** A file's name, built so check-refs doesn't read it as a document reference. */
const README = `README${'.md'}`;
const pluginScript = fileURLToPath(
  new URL('../../scripts/wordpress-plugin-zip.mjs', import.meta.url),
);
const dirs = [];
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A repository with two releases: 0.1.0 has the Cloud Run module only, 0.2.0
// both modules and a newer plugin. Each commit at a fixed time.
const tag = (version) => `@kindgi/sdk@${version}`;
const COMMITTED = { '0.1.0': 1767225600, '0.2.0': 1767312001 };
let repo;

function write(path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
function git(args, env = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...env,
    },
  });
}
function plugin(version) {
  write(
    'integrations/wordpress/kindgi/kindgi.php',
    `<?php\n/**\n * Plugin Name: Kindgi\n * Version: ${version}\n */\ndefine( 'KINDGI_PLUGIN_VERSION', '${version}' );\n`,
  );
  write('integrations/wordpress/kindgi/readme.txt', `=== Kindgi ===\nStable tag: ${version}\n`);
}
function release(version) {
  const date = `@${COMMITTED[version]} +0000`;
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', version], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  git(['tag', '-a', '-m', version, tag(version)], { GIT_COMMITTER_DATE: date });
}

before(() => {
  repo = temp('kindgi-downloads-repo-');
  git(['init', '--quiet', '-b', 'main']);
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(pluginScript, join(repo, 'scripts', 'wordpress-plugin-zip.mjs'));
  write('LICENSE', 'Apache License\n');
  write('NOTICE', 'Kindgi\n');
  plugin('0.1.0');
  write('deploy/gcp-cloud-run/main.tf', 'terraform {}\n');
  write(`deploy/gcp-cloud-run/${README}`, '# Cloud Run\n');
  release('0.1.0');
  plugin('0.1.1');
  write('deploy/gcp-cloud-run/main.tf', 'terraform { required_version = ">= 1.6" }\n');
  write('deploy/azure-container-apps/main.tf', 'terraform {}\n');
  release('0.2.0');
  // After the newest release: not in any download.
  write('deploy/gcp-cloud-run/unreleased.tf', '\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'later']);
});

const listing = (zip) =>
  execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
const builds = [
  { tag: tag('0.2.0'), version: '0.2.0' },
  { tag: tag('0.1.0'), version: '0.1.0' },
];

describe('writeDownloads', () => {
  let dir;
  let names;
  before(() => {
    dir = join(temp('kindgi-downloads-out-'), 'downloads');
    names = writeDownloads(repo, builds, dir);
  });

  test("the newest release's plugin, under its version and as kindgi-latest.zip, and every release's modules", () => {
    assert.deepEqual(names, [
      'kindgi-0.1.1.zip',
      'kindgi-0.1.1.zip.sha256',
      'kindgi-azure-container-apps-0.2.0.zip',
      'kindgi-azure-container-apps-0.2.0.zip.sha256',
      'kindgi-gcp-cloud-run-0.1.0.zip',
      'kindgi-gcp-cloud-run-0.1.0.zip.sha256',
      'kindgi-gcp-cloud-run-0.2.0.zip',
      'kindgi-gcp-cloud-run-0.2.0.zip.sha256',
      'kindgi-latest.zip',
      'kindgi-latest.zip.sha256',
    ]);
  });

  test('kindgi-latest.zip is the same bytes as the versioned plugin zip, its checksum naming it', () => {
    const latest = readFileSync(join(dir, LATEST_PLUGIN));
    assert.deepEqual(latest, readFileSync(join(dir, 'kindgi-0.1.1.zip')));
    assert.equal(
      readFileSync(join(dir, `${LATEST_PLUGIN}.sha256`), 'utf8'),
      checksumLine(LATEST_PLUGIN, latest),
    );
    assert.ok(listing(join(dir, LATEST_PLUGIN)).includes('kindgi/kindgi.php'));
  });

  test("a module's zip holds its tag's module, under one directory named for it", () => {
    const zip = join(dir, moduleZipName('gcp-cloud-run', '0.2.0'));
    assert.deepEqual(listing(zip), [
      'kindgi-gcp-cloud-run-0.2.0/',
      `kindgi-gcp-cloud-run-0.2.0/${README}`,
      'kindgi-gcp-cloud-run-0.2.0/main.tf',
    ]);
    const main = execFileSync('unzip', ['-p', zip, 'kindgi-gcp-cloud-run-0.2.0/main.tf'], {
      encoding: 'utf8',
    });
    assert.equal(main, 'terraform { required_version = ">= 1.6" }\n');
    const older = join(dir, moduleZipName('gcp-cloud-run', '0.1.0'));
    assert.equal(
      execFileSync('unzip', ['-p', older, 'kindgi-gcp-cloud-run-0.1.0/main.tf'], {
        encoding: 'utf8',
      }),
      'terraform {}\n',
    );
  });

  test('every module checksum checks its zip, as sha256sum -c would', () => {
    for (const name of names.filter((n) => n.endsWith('.zip'))) {
      assert.equal(
        readFileSync(join(dir, `${name}.sha256`), 'utf8'),
        checksumLine(name, readFileSync(join(dir, name))),
        name,
      );
    }
  });
});

describe('writeModuleZip', () => {
  test("every entry is dated the tag's commit, in UTC, whatever the machine's zone", () => {
    const dir = temp('kindgi-downloads-module-');
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      writeModuleZip(repo, builds[0], 'gcp-cloud-run', dir);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'TZ');
      else process.env.TZ = saved;
    }
    // git also writes the exact second (an extended timestamp), which unzip
    // shows; a reader of the DOS time alone sees an even second either side.
    const committed = COMMITTED['0.2.0'];
    const want = [committed, committed - 1, committed + 1].map((seconds) => {
      const at = new Date(seconds * 1000);
      const two = (n) => String(n).padStart(2, '0');
      return `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}.${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`;
    });
    const dates = execFileSync('unzip', ['-Z', '-T', join(dir, 'kindgi-gcp-cloud-run-0.2.0.zip')], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    })
      .split('\n')
      .map((line) => /\s(\d{8}\.\d{6})\s/.exec(line)?.[1])
      .filter((date) => date !== undefined);
    assert.equal(dates.length, 3);
    assert.equal(new Set(dates).size, 1);
    assert.ok(want.includes(dates[0]), `${dates[0]} is not one of ${want.join(', ')}`);
  });

  test('a second build of a release writes the same bytes', () => {
    const first = temp('kindgi-downloads-module-');
    const second = temp('kindgi-downloads-module-');
    const name = writeModuleZip(repo, builds[0], 'azure-container-apps', first);
    writeModuleZip(repo, builds[0], 'azure-container-apps', second);
    assert.deepEqual(readFileSync(join(first, name)), readFileSync(join(second, name)));
  });

  test('a tag without the module has no zip for it', () => {
    const dir = temp('kindgi-downloads-module-');
    assert.equal(writeModuleZip(repo, builds[1], 'azure-container-apps', dir), undefined);
  });
});

test('writeDownloads needs a release with the plugin script', () => {
  const dir = temp('kindgi-downloads-none-');
  assert.throws(() => writeDownloads(repo, [], dir), /no release/);
  git(['rm', '--quiet', '-r', 'scripts']);
  git(['commit', '--quiet', '-m', 'no script']);
  git(['tag', 'bare']);
  assert.throws(
    () => writeDownloads(repo, [{ tag: 'bare', version: '0.3.0' }], dir),
    /has no scripts\/wordpress-plugin-zip\.mjs/,
  );
});
