// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  docsSource,
  headers,
  lockfileDocuments,
  menu,
  plan,
  redirects,
  robots,
  snapshotKey,
} from './versions-plan.mjs';

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

test('_redirects: a line with only pre-releases goes to /next/, page for page, with a 302', () => {
  assert.equal(
    redirects(plan(tags('0.1.9', '0.1.10', '0.1.11-rc.0', '0.2.0-rc.0'))),
    '/v0.2 /next/ 302\n/v0.2/* /next/:splat 302\n/v0.1 /v0.1.10/ 301\n/v0.1/* /v0.1.10/:splat 301\n',
  );
});

test("_redirects: once the line's release ships, its 301 takes the path, and no 302 is left", () => {
  assert.equal(
    redirects(plan(tags('0.1.10', '0.2.0-rc.0', '0.2.0-rc.1', '0.2.0'))),
    '/v0.2 /v0.2.0/ 301\n/v0.2/* /v0.2.0/:splat 301\n/v0.1 /v0.1.10/ 301\n/v0.1/* /v0.1.10/:splat 301\n',
  );
});

test('_redirects: a pre-release of a line that has a release leaves its line on the release', () => {
  for (const versions of [
    ['0.1.10', '0.1.11-rc.0'],
    ['0.1.10', '0.2.0', '0.2.1-rc.0'],
  ]) {
    const p = plan(tags(...versions));
    assert.notEqual(p.next, undefined);
    assert.doesNotMatch(redirects(p), / 302\n/);
  }
});

test("_redirects: the next line's pre-release gets its own 302", () => {
  assert.equal(
    redirects(plan(tags('0.1.10', '0.2.0-rc.1', '0.2.0', '0.3.0-rc.0'))),
    '/v0.3 /next/ 302\n/v0.3/* /next/:splat 302\n/v0.2 /v0.2.0/ 301\n/v0.2/* /v0.2.0/:splat 301\n/v0.1 /v0.1.10/ 301\n/v0.1/* /v0.1.10/:splat 301\n',
  );
});

test('_headers: every Markdown page is noindex, and the Markdown and text files say UTF-8', () => {
  assert.equal(
    headers(),
    '/*.md\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex\n/*.txt\n  Content-Type: text/plain; charset=utf-8\n',
  );
  // Matched as Cloudflare documents a splat: greedily, any characters, slashes too.
  const literal = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = headers()
    .split('\n')
    .filter((line) => line.startsWith('/'))
    .map((pattern) => new RegExp(`^${pattern.split('*').map(literal).join('.*')}$`));
  const [markdown, text] = rules;
  for (const path of [
    '/index.md',
    '/start/install.md',
    '/v0.1.7/start/install.md',
    '/next/guides/tools/write-a-tool.md',
  ]) {
    assert.ok(markdown.test(path), path);
    assert.ok(!text.test(path), path);
  }
  for (const path of [
    '/llms.txt',
    '/llms-full.txt',
    '/llms-small.txt',
    '/_llms-txt/start.txt',
    '/v0.1.7/llms.txt',
    '/next/_llms-txt/guides.txt',
  ]) {
    assert.ok(text.test(path), path);
    assert.ok(!markdown.test(path), path);
  }
  for (const path of ['/start/install/', '/v0.1.7/', '/versions.json']) {
    assert.ok(!rules.some((rule) => rule.test(path)), path);
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
 * then the workspace's. `packages/api` reaches `foo` through `commander`,
 * `zod` through `zod-openapi`'s peer, and `dotenv-expand` by an alias; only
 * `site` reaches `astro` and `kleur`.
 */
const LOCKFILE_TEXT = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.4.2
        version: 12.4.2

packages:

  '@pnpm/exe.darwin-arm64@12.4.2':
    resolution: {integrity: sha512-p1}

  pnpm@12.4.2:
    resolution: {integrity: sha512-p2}

snapshots:

  '@pnpm/exe.darwin-arm64@12.4.2':
    optional: true

  pnpm@12.4.2:
    optionalDependencies:
      '@pnpm/exe.darwin-arm64': 12.4.2

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.7.3
        version: 5.9.3

  packages/api:
    dependencies:
      '@kindgi/types':
        specifier: workspace:*
        version: link:../types
      commander:
        specifier: ^12.1.0
        version: 12.1.0
      dotenv-expand-10:
        specifier: npm:dotenv-expand@10.0.0
        version: dotenv-expand@10.0.0
      zod-openapi:
        specifier: ^1.0.0
        version: 1.0.0(zod@4.0.0)

  site:
    dependencies:
      astro:
        specifier: ^7.2.10
        version: 7.2.10
      zod:
        specifier: ^4.0.0
        version: 4.0.0

packages:

  astro@7.2.10:
    resolution: {integrity: sha512-a1}

  commander@12.1.0:
    resolution: {integrity: sha512-c1}

  dotenv-expand@10.0.0:
    resolution: {integrity: sha512-d1}

  foo@1.2.0:
    resolution: {integrity: sha512-f1}

  kleur@4.1.5:
    resolution: {integrity: sha512-k1}

  typescript@5.9.3:
    resolution: {integrity: sha512-t1}
    hasBin: true

  zod-openapi@1.0.0:
    resolution: {integrity: sha512-o1}
    peerDependencies:
      zod: ^4.0.0

  zod@4.0.0:
    resolution: {integrity: sha512-z1}

snapshots:

  astro@7.2.10:
    dependencies:
      kleur: 4.1.5

  commander@12.1.0:
    dependencies:
      foo: 1.2.0

  dotenv-expand@10.0.0: {}

  foo@1.2.0: {}

  kleur@4.1.5: {}

  typescript@5.9.3: {}

  zod-openapi@1.0.0(zod@4.0.0):
    dependencies:
      zod: 4.0.0

  zod@4.0.0: {}
`;

/** The lockfile with each `[from, to]` made, each `from` there exactly once. */
function lockfileWith(...edits) {
  let text = LOCKFILE_TEXT;
  for (const [from, to] of edits) {
    assert.equal(text.split(from).length, 2, `once in the lockfile: ${from}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const docsBranch = {
  tag: tag('0.1.4'),
  branch: 'origin/release-docs/0.1.4',
  startsAtTag: true,
  changed: ['pnpm-lock.yaml', 'site/package.json'],
};

/** What the guard says of a branch whose lockfile is `branch`. */
const guarded = (branch) =>
  docsSource({ ...docsBranch, lockfiles: { tag: LOCKFILE_TEXT, branch } });

test('lockfileDocuments: each document, its keyed blocks as written, and the rest', () => {
  const [env, workspace, ...more] = lockfileDocuments(LOCKFILE_TEXT);
  assert.deepEqual(more, []);
  assert.deepEqual([...env.importers.keys()], ['.']);
  assert.deepEqual([...env.snapshots.keys()], ['@pnpm/exe.darwin-arm64@12.4.2', 'pnpm@12.4.2']);
  assert.equal(env.rest, "lockfileVersion: '9.0'");
  assert.deepEqual([...workspace.importers.keys()], ['.', 'packages/api', 'site']);
  assert.equal(
    workspace.importers.get('site'),
    '  site:\n    dependencies:\n      astro:\n        specifier: ^7.2.10\n        version: 7.2.10\n      zod:\n        specifier: ^4.0.0\n        version: 4.0.0',
  );
  assert.equal(
    workspace.snapshots.get('zod-openapi@1.0.0(zod@4.0.0)'),
    '  zod-openapi@1.0.0(zod@4.0.0):\n    dependencies:\n      zod: 4.0.0',
  );
  assert.equal(workspace.snapshots.get('foo@1.2.0'), '  foo@1.2.0: {}');
  assert.equal(
    workspace.packages.get('typescript@5.9.3'),
    '  typescript@5.9.3:\n    resolution: {integrity: sha512-t1}\n    hasBin: true',
  );
  assert.equal(workspace.rest, "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true");
});

test('snapshotKey: name@version with its peers, an alias by its own name, no workspace link', () => {
  assert.equal(snapshotKey('foo', '1.2.0'), 'foo@1.2.0');
  assert.equal(snapshotKey('zod-openapi', '1.0.0(zod@4.0.0)'), 'zod-openapi@1.0.0(zod@4.0.0)');
  assert.equal(snapshotKey('dotenv-expand-10', 'dotenv-expand@10.0.0'), 'dotenv-expand@10.0.0');
  assert.equal(snapshotKey('@kindgi/types', 'link:../types'), undefined);
});

test("a release's docs branch may change the site importer, and what only it installs", () => {
  const branch = lockfileWith(
    [
      '        specifier: ^7.2.10\n        version: 7.2.10',
      '        specifier: ^7.3.0\n        version: 7.3.0\n      remark-gfm:\n        specifier: ^4.0.1\n        version: 4.0.1',
    ],
    [
      '  astro@7.2.10:\n    resolution: {integrity: sha512-a1}\n',
      '  astro@7.3.0:\n    resolution: {integrity: sha512-a2}\n',
    ],
    [
      '  kleur@4.1.5:\n    resolution: {integrity: sha512-k1}\n',
      '  kleur@4.2.0:\n    resolution: {integrity: sha512-k2}\n\n  remark-gfm@4.0.1:\n    resolution: {integrity: sha512-r1}\n',
    ],
    [
      '  astro@7.2.10:\n    dependencies:\n      kleur: 4.1.5',
      '  astro@7.3.0:\n    dependencies:\n      kleur: 4.2.0',
    ],
    ['  kleur@4.1.5: {}', '  kleur@4.2.0: {}\n\n  remark-gfm@4.0.1: {}'],
  );
  assert.deepEqual(guarded(branch), { ref: 'origin/release-docs/0.1.4' });
});

test('a transitive change under another importer fails, though every importer is the same', () => {
  // `pnpm dedupe` moved commander's foo: no importer's block changes.
  const branch = lockfileWith(
    ['      foo: 1.2.0', '      foo: 1.3.0'],
    [
      '  foo@1.2.0:\n    resolution: {integrity: sha512-f1}',
      '  foo@1.3.0:\n    resolution: {integrity: sha512-f3}',
    ],
    ['  foo@1.2.0: {}', '  foo@1.3.0: {}'],
  );
  assert.match(
    guarded(branch).error,
    /^origin\/release-docs\/0\.1\.4 changes 5 entries of pnpm-lock\.yaml that importers other than site install \(commander@12\.1\.0 \(snapshot\), foo@1\.2\.0 \(snapshot\), foo@1\.2\.0 \(package\), foo@1\.3\.0 \(snapshot\), foo@1\.3\.0 \(package\)\) since @kindgi\/sdk@0\.1\.4: the site-only lockfile guard/,
  );
});

test("a package another importer reaches changes: fails, through peers' suffixes and aliases too", () => {
  const foo = guarded(lockfileWith(['sha512-f1', 'sha512-f2']));
  assert.match(foo.error, /changes 1 entry of pnpm-lock\.yaml .* \(foo@1\.2\.0 \(package\)\)/);
  // zod: site's own dependency, but packages/api reaches it through zod-openapi's peer.
  const zod = guarded(lockfileWith(['sha512-z1', 'sha512-z2']));
  assert.match(zod.error, /\(zod@4\.0\.0 \(package\)\)/);
  const alias = guarded(lockfileWith(['sha512-d1', 'sha512-d2']));
  assert.match(alias.error, /\(dotenv-expand@10\.0\.0 \(package\)\)/);
  // pnpm's own packages, in the first document.
  const pnpm = guarded(
    lockfileWith([
      "      '@pnpm/exe.darwin-arm64': 12.4.2",
      "      '@pnpm/exe.darwin-arm64': 12.4.3",
    ]),
  );
  assert.match(pnpm.error, /\(pnpm@12\.4\.2 \(snapshot\)\)/);
});

test('the guard names five differences, and counts them all', () => {
  const branch = lockfileWith(
    ...['t1', 'c1', 'd1', 'f1', 'o1', 'z1'].map((hash) => [`sha512-${hash}`, `sha512-${hash}x`]),
  );
  assert.match(
    guarded(branch).error,
    /changes 6 entries of pnpm-lock\.yaml that importers other than site install \(typescript@5\.9\.3 \(package\), commander@12\.1\.0 \(package\), dotenv-expand@10\.0\.0 \(package\), zod-openapi@1\.0\.0 \(package\), foo@1\.2\.0 \(package\), and 1 more\)/,
  );
});

test("a release's docs branch whose lockfile changes another importer fails, naming it", () => {
  const api = guarded(
    lockfileWith([
      '        specifier: ^12.1.0\n        version: 12.1.0',
      '        specifier: ^12.1.0\n        version: 12.2.0',
    ]),
  );
  assert.match(
    api.error,
    /changes pnpm-lock\.yaml outside the site importer \(packages\/api\) since @kindgi\/sdk@0\.1\.4: the site-only lockfile guard/,
  );
  // pnpm's own version sits in the first document's root importer.
  const root = guarded(
    lockfileWith([
      '        specifier: 12.4.2\n        version: 12.4.2',
      '        specifier: 12.5.0\n        version: 12.5.0',
    ]),
  );
  assert.match(root.error, /outside the site importer \(\. \(the workspace root\)\)/);
  const added = guarded(
    lockfileWith(['\n  site:\n', '\n  packages/new:\n    dependencies: {}\n\n  site:\n']),
  );
  assert.match(added.error, /outside the site importer \(packages\/new\)/);
});

test("the lockfile's settings and documents stay the tag's", () => {
  const settings = guarded(lockfileWith(['autoInstallPeers: true', 'autoInstallPeers: false']));
  assert.match(settings.error, /\(its top-level settings \(document 2\)\)/);
  const one = guarded(LOCKFILE_TEXT.slice(LOCKFILE_TEXT.indexOf('---', 3)));
  assert.match(one.error, /changes the number of documents in pnpm-lock\.yaml \(2 to 1\)/);
});

test('the lockfile guard needs both lockfiles, with importers in each', () => {
  const missing = docsSource({ ...docsBranch, changed: ['pnpm-lock.yaml'] });
  assert.match(missing.error, /the site-only lockfile guard needs the lockfile at both/);
  const unreadable = guarded("lockfileVersion: '9.0'\n");
  assert.match(
    unreadable.error,
    /the site-only lockfile guard finds no importers in pnpm-lock\.yaml at origin\/release-docs\/0\.1\.4/,
  );
});

test("a lockfile change doesn't let a release's docs branch change other files outside site/", () => {
  const source = docsSource({
    ...docsBranch,
    changed: ['package.json', 'pnpm-lock.yaml', 'site/package.json'],
    lockfiles: { tag: LOCKFILE_TEXT, branch: LOCKFILE_TEXT },
  });
  assert.match(source.error, /outside site\/ since @kindgi\/sdk@0\.1\.4 \(package\.json\)/);
});

test("without a lockfile change, the lockfiles aren't read", () => {
  assert.deepEqual(
    docsSource({
      ...docsBranch,
      changed: ['site/src/content/docs/start/install.mdx'],
      lockfiles: { tag: LOCKFILE_TEXT, branch: lockfileWith(['sha512-f1', 'sha512-f2']) },
    }),
    { ref: 'origin/release-docs/0.1.4' },
  );
});

test('robots.txt: nothing disallowed, and the sitemap that / was built with', () => {
  const index =
    '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://docs.kindgi.com/sitemap-0.xml</loc></sitemap></sitemapindex>';
  assert.equal(
    robots(index),
    'User-agent: *\nAllow: /\n\nSitemap: https://docs.kindgi.com/sitemap-index.xml\n',
  );
  assert.doesNotMatch(robots(index), /Disallow/);
  // No sitemap built for /: robots.txt would name a missing one, so the build stops.
  assert.throws(() => robots(undefined), /no sitemap-index\.xml naming a sitemap/);
  assert.throws(
    () => robots('<sitemapindex></sitemapindex>'),
    /no sitemap-index\.xml naming a sitemap/,
  );
});
