// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docsSource, headers, lockfileImporters, menu, plan, redirects } from './versions-plan.mjs';

const tag = (v) => `@kindgi/sdk@${v}`;
const tags = (...versions) => versions.map(tag);
const summary = (p) => ({
  lines: p.lines.map((l) => l.tag),
  next: p.next?.tag,
});

test('releases only: each line from its newest release, newest line first', () => {
  assert.deepEqual(summary(plan(tags('0.1.0', '0.1.2', '0.1.1', '0.2.0'))), {
    lines: [tag('0.2.0'), tag('0.1.2')],
    next: undefined,
  });
});

test('a release candidate never builds a line, and is next while newer than every release', () => {
  assert.deepEqual(summary(plan(tags('0.1.2', '0.1.3', '0.1.4-rc.0'))), {
    lines: [tag('0.1.3')],
    next: tag('0.1.4-rc.0'),
  });
});

test('next is the newest pre-release, numerically (rc.10 after rc.9)', () => {
  assert.deepEqual(summary(plan(tags('0.1.3', '0.1.4-rc.9', '0.1.4-rc.10', '0.1.4-rc.2'))), {
    lines: [tag('0.1.3')],
    next: tag('0.1.4-rc.10'),
  });
});

test('once the release ships, its release candidates are older: no next', () => {
  assert.deepEqual(summary(plan(tags('0.1.3', '0.1.4-rc.0', '0.1.4-rc.1', '0.1.4'))), {
    lines: [tag('0.1.4')],
    next: undefined,
  });
});

test('the next release cycle gets its own next', () => {
  assert.deepEqual(summary(plan(tags('0.1.4-rc.1', '0.1.4', '0.1.5-rc.0'))), {
    lines: [tag('0.1.4')],
    next: tag('0.1.5-rc.0'),
  });
});

test('a new minor line in release candidates is next, not a line', () => {
  assert.deepEqual(summary(plan(tags('0.1.4', '0.2.0-rc.0'))), {
    lines: [tag('0.1.4')],
    next: tag('0.2.0-rc.0'),
  });
});

test('tags that are not versions are ignored', () => {
  assert.deepEqual(summary(plan([...tags('0.1.3'), '@kindgi/sdk@latest', '@kindgi/sdk@0.1'])), {
    lines: [tag('0.1.3')],
    next: undefined,
  });
});

test('every release is listed, newest first; lines keep their newest release', () => {
  const p = plan(tags('0.1.0', '0.1.2', '0.1.1', '0.2.0', '0.2.1-rc.0'));
  assert.deepEqual(
    p.releases.map((r) => r.tag),
    tags('0.2.0', '0.1.2', '0.1.1', '0.1.0'),
  );
  assert.deepEqual(
    p.lines.map((l) => l.tag),
    tags('0.2.0', '0.1.2'),
  );
});

test('versions.json: the root, each release under its own path, and next', () => {
  assert.deepEqual(menu(plan(tags('0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4-rc.3'))), {
    latest: '0.1.3',
    versions: [
      { version: '0.1.3', line: '0.1', path: '/' },
      { version: '0.1.3', line: '0.1', path: '/v0.1.3/' },
      { version: '0.1.2', line: '0.1', path: '/v0.1.2/' },
      { version: '0.1.1', line: '0.1', path: '/v0.1.1/' },
      { version: '0.1.0', line: '0.1', path: '/v0.1.0/' },
      { version: '0.1.4-rc.3', line: '0.1', path: '/next/', next: true },
    ],
  });
});

test('versions.json: no next once its release ships', () => {
  const { latest, versions } = menu(plan(tags('0.1.3', '0.1.4-rc.3', '0.1.4')));
  assert.equal(latest, '0.1.4');
  assert.deepEqual(
    versions.map((v) => v.path),
    ['/', '/v0.1.4/', '/v0.1.3/'],
  );
});

test('_redirects: each line path goes to its newest release, page for page', () => {
  assert.equal(
    redirects(plan(tags('0.1.2', '0.1.3', '0.2.0'))),
    '/v0.2 /v0.2.0/ 301\n/v0.2/* /v0.2.0/:splat 301\n/v0.1 /v0.1.3/ 301\n/v0.1/* /v0.1.3/:splat 301\n',
  );
});

test('_headers: every Markdown page, at the root and under every version, is noindex', () => {
  assert.equal(headers(), '/*.md\n  X-Robots-Tag: noindex\n');
  // Matched as Cloudflare documents a splat: greedily, any characters, slashes too.
  const [pattern] = headers().split('\n');
  const literal = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${pattern.split('*').map(literal).join('.*')}$`);
  for (const path of [
    '/index.md',
    '/start/install.md',
    '/v0.1.7/start/install.md',
    '/next/guides/tools/write-a-tool.md',
  ]) {
    assert.ok(rule.test(path), path);
  }
  for (const path of ['/start/install/', '/v0.1.7/', '/llms.txt', '/versions.json']) {
    assert.ok(!rule.test(path), path);
  }
});

test("a release's docs: its tag, or its docs branch when that changes only site/", () => {
  assert.deepEqual(docsSource({ tag: tag('0.1.4') }), { ref: tag('0.1.4') });
  assert.deepEqual(
    docsSource({
      tag: tag('0.1.4'),
      branch: 'origin/release-docs/0.1.4',
      startsAtTag: true,
      changed: ['site/src/content/docs/start/quickstart-typescript.md'],
    }),
    { ref: 'origin/release-docs/0.1.4' },
  );
});

test("a release's docs branch that changes code, or doesn't start at the tag, fails", () => {
  const outside = docsSource({
    tag: tag('0.1.4'),
    branch: 'origin/release-docs/0.1.4',
    startsAtTag: true,
    changed: ['site/src/content/docs/start/agent.md', 'packages/cli/src/commands/dev.ts'],
  });
  assert.match(
    outside.error,
    /outside site\/ since @kindgi\/sdk@0\.1\.4 \(packages\/cli\/src\/commands\/dev\.ts\)/,
  );
  const elsewhere = docsSource({
    tag: tag('0.1.4'),
    branch: 'origin/release-docs/0.1.4',
    startsAtTag: false,
  });
  assert.match(elsewhere.error, /doesn't start at @kindgi\/sdk@0\.1\.4/);
});

/**
 * A lockfile as pnpm writes one: a first document with pnpm's own version,
 * then the workspace's importers and their packages.
 */
function lockfile({
  pnpm = '12.4.2',
  typescript = '5.9.3',
  hono = '4.6.0',
  site = ['      astro:', '        specifier: ^7.2.10', '        version: 7.2.10'],
  packages = ['  astro@7.2.10:', '    resolution: {integrity: sha512-a}'],
} = {}) {
  return [
    '---',
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    packageManagerDependencies:',
    '      pnpm:',
    `        specifier: ${pnpm}`,
    `        version: ${pnpm}`,
    '',
    '---',
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      typescript:',
    '        specifier: ^5.7.3',
    `        version: ${typescript}`,
    '',
    '  packages/api:',
    '    dependencies:',
    '      hono:',
    '        specifier: ^4.6.0',
    `        version: ${hono}`,
    '',
    '  site:',
    '    dependencies:',
    ...site,
    '',
    'packages:',
    '',
    ...packages,
    '',
  ].join('\n');
}

const docsBranch = {
  tag: tag('0.1.4'),
  branch: 'origin/release-docs/0.1.4',
  startsAtTag: true,
};

test("lockfileImporters: each importer's block, from every document, and nothing after", () => {
  const importers = lockfileImporters(lockfile());
  assert.deepEqual([...importers.keys()], ['.', 'packages/api', 'site']);
  assert.equal(
    importers.get('.'),
    [
      '  .:',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.4.2',
      '        version: 12.4.2',
      '---',
      '  .:',
      '    devDependencies:',
      '      typescript:',
      '        specifier: ^5.7.3',
      '        version: 5.9.3',
    ].join('\n'),
  );
  assert.equal(
    importers.get('site'),
    '  site:\n    dependencies:\n      astro:\n        specifier: ^7.2.10\n        version: 7.2.10',
  );
  assert.deepEqual(lockfileImporters("lockfileVersion: '9.0'\n"), new Map());
});

test("a release's docs branch may change the lockfile's site importer, and the packages it adds", () => {
  const branchLockfile = lockfile({
    site: [
      '      astro:',
      '        specifier: ^7.2.10',
      '        version: 7.2.10',
      '      remark-gfm:',
      '        specifier: ^4.0.1',
      '        version: 4.0.1',
    ],
    packages: [
      '  astro@7.2.10:',
      '    resolution: {integrity: sha512-a}',
      '',
      '  remark-gfm@4.0.1:',
      '    resolution: {integrity: sha512-b}',
    ],
  });
  assert.deepEqual(
    docsSource({
      ...docsBranch,
      changed: ['pnpm-lock.yaml', 'site/package.json', 'site/scripts/agent-markdown.mjs'],
      lockfiles: { tag: lockfile(), branch: branchLockfile },
    }),
    { ref: 'origin/release-docs/0.1.4' },
  );
});

test("a release's docs branch whose lockfile changes another importer fails, naming it", () => {
  const api = docsSource({
    ...docsBranch,
    changed: ['pnpm-lock.yaml', 'site/package.json'],
    lockfiles: { tag: lockfile(), branch: lockfile({ hono: '4.7.0' }) },
  });
  assert.match(
    api.error,
    /changes pnpm-lock\.yaml outside the site importer since @kindgi\/sdk@0\.1\.4 \(packages\/api\): the site-only lockfile guard/,
  );
  // pnpm's own version sits in the first document's root importer.
  const root = docsSource({
    ...docsBranch,
    changed: ['pnpm-lock.yaml'],
    lockfiles: { tag: lockfile(), branch: lockfile({ pnpm: '12.5.0', typescript: '5.9.4' }) },
  });
  assert.match(root.error, /\(\. \(the workspace root\)\): the site-only lockfile guard/);
  const added = docsSource({
    ...docsBranch,
    changed: ['pnpm-lock.yaml'],
    lockfiles: {
      tag: lockfile(),
      branch: lockfile().replace(
        '\n  site:\n',
        '\n  packages/new:\n    dependencies: {}\n\n  site:\n',
      ),
    },
  });
  assert.match(added.error, /\(packages\/new\): the site-only lockfile guard/);
});

test('the lockfile guard needs both lockfiles, with importers in each', () => {
  const missing = docsSource({ ...docsBranch, changed: ['pnpm-lock.yaml'] });
  assert.match(missing.error, /the site-only lockfile guard needs the lockfile at both/);
  const unreadable = docsSource({
    ...docsBranch,
    changed: ['pnpm-lock.yaml'],
    lockfiles: { tag: lockfile(), branch: "lockfileVersion: '9.0'\n" },
  });
  assert.match(
    unreadable.error,
    /the site-only lockfile guard finds no importers in pnpm-lock\.yaml at origin\/release-docs\/0\.1\.4/,
  );
});

test("a lockfile change doesn't let a release's docs branch change other files outside site/", () => {
  const source = docsSource({
    ...docsBranch,
    changed: ['package.json', 'pnpm-lock.yaml', 'site/package.json'],
    lockfiles: { tag: lockfile(), branch: lockfile() },
  });
  assert.match(source.error, /outside site\/ since @kindgi\/sdk@0\.1\.4 \(package\.json\)/);
});

test("without a lockfile change, the lockfiles aren't read", () => {
  assert.deepEqual(
    docsSource({
      ...docsBranch,
      changed: ['site/src/content/docs/start/install.mdx'],
      lockfiles: { tag: lockfile(), branch: lockfile({ hono: '4.7.0' }) },
    }),
    { ref: 'origin/release-docs/0.1.4' },
  );
});
