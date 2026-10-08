// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  fillVersion,
  linksToMain,
  pinRepoLinks,
  versionInCode,
  versionedPages,
} from './versioned-pages.mjs';

const tag = '@kindgi/sdk@0.1.5';
const repo = 'https://github.com/kindgi/kindgi-sdk';

test('a release build points tree/main and blob/main links at its tag', () => {
  const html = `<a href="${repo}/tree/main/sdks/java/kindgi-pack">README</a> <a href="${repo}/blob/main/CONTRIBUTING.md#maven-central">x</a> [y](${repo}/tree/main)`;
  assert.equal(
    pinRepoLinks(html, tag),
    `<a href="${repo}/tree/${tag}/sdks/java/kindgi-pack">README</a> <a href="${repo}/blob/${tag}/CONTRIBUTING.md#maven-central">x</a> [y](${repo}/tree/${tag})`,
  );
});

test('the preview (main) keeps its links, and other links are left alone', () => {
  const html = `<a href="${repo}/tree/main/sdks">a</a>`;
  assert.equal(pinRepoLinks(html, 'main'), html);
  const others = `<a href="${repo}/edit/main/site/src/content/docs/x.md">edit</a> <a href="${repo}/tree/maintenance/x">b</a> <a href="https://github.com/other/repo/tree/main/x">c</a>`;
  assert.equal(pinRepoLinks(others, tag), others);
});

test('linksToMain finds what still reads main, not the edit link', () => {
  const html = `${repo}/raw/main/a.txt https://raw.githubusercontent.com/kindgi/kindgi-sdk/main/b.json ${repo}/edit/main/site/x.md ${repo}/tree/${tag}/c`;
  assert.deepEqual(linksToMain(html), [
    'github.com/kindgi/kindgi-sdk/raw/main',
    'raw.githubusercontent.com/kindgi/kindgi-sdk/main/',
  ]);
});

test('fillVersion fills every token', () => {
  assert.equal(
    fillVersion('<version>{{kindgi.version}}</version> and {{kindgi.version}}', '0.1.5'),
    '<version>0.1.5</version> and 0.1.5',
  );
});

test('the code plugin fills a code block before highlighting', () => {
  const lines = [
    '<version>{{kindgi.version}}</version>',
    'x {{kindgi.version}} {{kindgi.version}}',
    'none',
  ].map((text) => ({
    text,
    editText(start, end, replacement) {
      this.text = this.text.slice(0, start) + replacement + this.text.slice(end);
      return this.text;
    },
  }));
  versionInCode('0.1.5-rc.2').hooks.preprocessCode({ codeBlock: { getLines: () => lines } });
  assert.deepEqual(
    lines.map((line) => line.text),
    ['<version>0.1.5-rc.2</version>', 'x 0.1.5-rc.2 0.1.5-rc.2', 'none'],
  );
});

function build(files) {
  const dir = mkdtempSync(join(tmpdir(), 'kindgi-versioned-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const done = (integration, dir) =>
  integration.hooks['astro:build:done']({
    dir: pathToFileURL(`${dir}/`),
    logger: { info: () => undefined },
  });

test('a release build fixes its pages and llms.txt', () => {
  const dir = build({
    'start/java-app/index.html': `<a href="${repo}/tree/main/sdks/java">x</a> <code>{{kindgi.version}}</code>`,
    'llms-full.txt': `[x](${repo}/blob/main/README.md) {{kindgi.version}}`,
  });
  try {
    done(versionedPages({ ref: tag, version: '0.1.5' }), dir);
    assert.equal(
      readFileSync(join(dir, 'start/java-app/index.html'), 'utf8'),
      `<a href="${repo}/tree/${tag}/sdks/java">x</a> <code>0.1.5</code>`,
    );
    assert.equal(
      readFileSync(join(dir, 'llms-full.txt'), 'utf8'),
      `[x](${repo}/blob/${tag}/README.md) 0.1.5`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a release build fails on a page that still reads main', () => {
  const dir = build({
    'a/index.html': `<a href="https://raw.githubusercontent.com/kindgi/kindgi-sdk/main/x.json">x</a>`,
  });
  try {
    assert.throws(
      () => done(versionedPages({ ref: tag, version: '0.1.5' }), dir),
      /a\/index\.html: raw\.githubusercontent\.com\/kindgi\/kindgi-sdk\/main\//,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preview keeps its main links, and still gets the version', () => {
  const dir = build({
    'a/index.html': `<a href="${repo}/tree/main/x">x</a> <code>{{kindgi.version}}</code>`,
  });
  try {
    done(versionedPages({ ref: 'main', version: '0.1.4' }), dir);
    assert.equal(
      readFileSync(join(dir, 'a/index.html'), 'utf8'),
      `<a href="${repo}/tree/main/x">x</a> <code>0.1.4</code>`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
