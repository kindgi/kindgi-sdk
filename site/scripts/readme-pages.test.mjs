// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reference pages made from READMEs (`reference/readme-links.mjs`,
 * `reference/readmes.mjs`): their links stay on the site, within its
 * version, and never point into the repository.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hrefFrom, pagePath, rewriteLinks } from './reference/readme-links.mjs';
import {
  READMES,
  anchor,
  dropSections,
  markExcerpts,
  readmeLinks,
  readmePages,
} from './reference/readmes.mjs';

const README = `README${'.md'}`;

describe('hrefFrom', () => {
  test('a relative link from one page to another, its anchor kept', () => {
    assert.equal(pagePath('reference/java/index'), 'reference/java/');
    assert.equal(pagePath('reference/java/kindgi-pack'), 'reference/java/kindgi-pack/');
    assert.equal(hrefFrom('reference/java/index', 'reference/java/kindgi-pack/'), 'kindgi-pack/');
    assert.equal(hrefFrom('reference/java/kindgi-pack', 'reference/scala/'), '../../scala/');
    assert.equal(
      hrefFrom('reference/terraform/gcp-cloud-run', 'concepts/security/#your-tools-code'),
      '../../../concepts/security/#your-tools-code',
    );
  });

  test('a link to the page itself is its anchor, or ./', () => {
    assert.equal(hrefFrom('reference/scala/index', 'reference/scala/#checks'), '#checks');
    assert.equal(hrefFrom('reference/scala/index', 'reference/scala/'), './');
  });
});

describe('rewriteLinks', () => {
  const pages = new Map([
    ['/repo/sdks/java', 'reference/java/index'],
    ['/repo/packages/specs', 'reference/packages/specs'],
  ]);
  const page = { slug: 'reference/java/kindgi-pack', dir: '/repo/sdks/java/kindgi-pack', pages };

  test("a docs URL becomes a link within the site's version; a download stays whole", () => {
    const markdown = [
      '[Guide](https://docs.kindgi.com/v0.8/start/java-app/#streams)',
      '[Next](https://docs.kindgi.com/next/concepts/runs/)',
      '[Root](https://docs.kindgi.com/reference/packages/specs/)',
      '[Zip](https://docs.kindgi.com/downloads/kindgi-latest.zip)',
    ].join('\n');
    assert.equal(
      rewriteLinks(markdown, page),
      [
        '[Guide](../../../start/java-app/#streams)',
        '[Next](../../../concepts/runs/)',
        '[Root](../../packages/specs/)',
        '[Zip](https://docs.kindgi.com/downloads/kindgi-latest.zip)',
      ].join('\n'),
    );
  });

  test('a link to a rendered README goes to its page; any other file, an image too, is its text', () => {
    const markdown = [
      `See [the client](../${README}#install) and [specs](../../../packages/specs/).`,
      '[the source](src/main/java/) and [License](../../../LICENSE), ![logo](logo.png).',
    ].join('\n');
    assert.equal(
      rewriteLinks(markdown, page),
      [
        'See [the client](../#install) and [specs](../../packages/specs/).',
        'the source and License, logo.',
      ].join('\n'),
    );
  });

  test('code is left as it is', () => {
    const markdown = ['`[x](../)`', '```md', '[y](../)', '```', '[z](https://example.com/)'].join(
      '\n',
    );
    assert.equal(rewriteLinks(markdown, page), markdown);
  });
});

describe('dropSections', () => {
  test('drops the section to the next heading at its level, and the links to it', () => {
    const markdown = [
      '## Install',
      'Use Maven (see [Build from source](#build-from-source)).',
      '## Build from source',
      'Clone it.',
      '### Details',
      '```sh',
      '## not a heading',
      '```',
      '## Use',
      'As [built](#build-from-source).',
    ].join('\n');
    assert.equal(anchor('Build from source'), 'build-from-source');
    assert.equal(
      dropSections(markdown, ['Build from source']),
      ['## Install', 'Use Maven.', '## Use', 'As built.'].join('\n'),
    );
  });
});

describe('markExcerpts', () => {
  test("a Java or Scala block that isn't a whole file, and a block nothing checks, are excerpts", () => {
    const markdown = [
      '```java',
      '// src/main/java/my/Tool.java',
      'class Tool {}',
      '```',
      '```java',
      'var client = Kindgi.client();',
      '```',
      '```scala',
      'val x = 1',
      '```',
      '```hcl',
      'module "kindgi" {}',
      '```',
      '```sh',
      'echo ok',
      '```',
      '```java excerpt',
      'call();',
      '```',
    ].join('\n');
    const fences = markExcerpts(markdown)
      .split('\n')
      .filter((line) => line.startsWith('```') && line !== '```');
    assert.deepEqual(fences, [
      '```java',
      '```java excerpt',
      '```scala excerpt',
      '```hcl excerpt',
      '```sh',
      '```java excerpt',
    ]);
  });
});

describe('readmePages', () => {
  const pages = readmePages(readmeLinks());

  test('one page per README, under reference/java, reference/scala and reference/terraform', () => {
    assert.deepEqual(
      pages.map((page) => page.slug),
      READMES.map((readme) => readme.slug),
    );
    for (const page of pages) {
      assert.match(page.slug, /^reference\/(?:java|scala|terraform)\//);
      assert.match(
        page.content,
        /^---\ntitle: "[^"]+"\ndescription: "[^"]+"\nsidebar:\n {2}label: /,
      );
    }
  });

  test('no link into the repository, nor to GitHub, and no build from source', () => {
    for (const { slug, content } of pages) {
      const prose = content.replace(/^```[\s\S]*?^```/gm, '');
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)/g)) {
        assert.ok(
          /^(?:https?:|mailto:|#|\.\.?\/|[a-z0-9-]+\/)/.test(target) &&
            !/\.(?:md|tf|java|scala)(?:#|$)/.test(target) &&
            !target.includes('github.com'),
          `${slug}: ${target}`,
        );
      }
      assert.doesNotMatch(content, /^#+ Build from source$/m, slug);
    }
  });

  test("a module's page starts with its download", () => {
    const page = pages.find((p) => p.slug === 'reference/terraform/gcp-cloud-run');
    assert.match(
      page.content,
      /---\n\nEach release's module is a download, `kindgi-gcp-cloud-run-\{\{kindgi\.version\}\}\.zip`/,
    );
  });
});
