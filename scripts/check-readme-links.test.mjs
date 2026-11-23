// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `scripts/check-readme-links.mjs`: the READMEs npm and PyPI show have whole
 * links only.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { linksToFix, publishedReadmes } from './check-readme-links.mjs';

/** A file's name, built so check-refs doesn't read it as a document reference. */
const README = `README${'.md'}`;
const DOCS = `DOCS${'.md'}`;

describe('linksToFix', () => {
  test('finds inline links, images, definitions and HTML links that go to a file', () => {
    const markdown = [
      '# x',
      'See [the spec](../specs/) and [License](./LICENSE).',
      '![diagram](docs/flow.png)',
      '[ref]: ../types/',
      '<a href="examples/">examples</a> <img src="logo.svg">',
    ].join('\n');
    assert.deepEqual(linksToFix(markdown), [
      { line: 2, target: '../specs/' },
      { line: 2, target: './LICENSE' },
      { line: 3, target: 'docs/flow.png' },
      { line: 4, target: '../types/' },
      { line: 5, target: 'examples/' },
      { line: 5, target: 'logo.svg' },
    ]);
  });

  test('whole URLs, mail and anchors in the README are fine', () => {
    const markdown = [
      '[docs](https://docs.kindgi.com/reference/packages/specs/#schemas)',
      '[license](https://www.apache.org/licenses/LICENSE-2.0) [mail](mailto:contact@kindgi.com)',
      'Jump to [usage](#usage).',
      '[ref]: https://docs.kindgi.com/',
    ].join('\n');
    assert.deepEqual(linksToFix(markdown), []);
  });

  test("links into this repository on GitHub, whole or not; other repositories' are fine", () => {
    const markdown = [
      '[source](https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java) [repo](https://github.com/kindgi/kindgi-sdk)',
      '<a href="https://www.github.com/Kindgi/kindgi-sdk#readme">x</a>',
      '[ref]: https://github.com/kindgi/kindgi-sdk/blob/main/LICENSE',
      '[other](https://github.com/kindgi/kindgi-sdk-extras) [elsewhere](https://github.com/acme/kindgi-sdk/)',
    ].join('\n');
    assert.deepEqual(linksToFix(markdown), [
      { line: 1, target: 'https://github.com/kindgi/kindgi-sdk/tree/main/sdks/java' },
      { line: 1, target: 'https://github.com/kindgi/kindgi-sdk' },
      { line: 2, target: 'https://www.github.com/Kindgi/kindgi-sdk#readme' },
      { line: 3, target: 'https://github.com/kindgi/kindgi-sdk/blob/main/LICENSE' },
    ]);
  });

  test('code is not read: fenced blocks and inline spans', () => {
    const markdown = [
      'Write `[x](./a/)` for a link.',
      '```md',
      '[inside](../b/)',
      '```',
      '~~~',
      '[also inside](../c/)',
      '~~~',
      'After [the fence](../d/).',
    ].join('\n');
    assert.deepEqual(linksToFix(markdown), [{ line: 8, target: '../d/' }]);
  });
});

describe('publishedReadmes', () => {
  test("every public package's README and each pyproject's readme; private packages left out", () => {
    const root = mkdtempSync(join(tmpdir(), 'check-readme-links-'));
    try {
      const write = (path, text) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('packages/a/package.json', '{"name":"@kindgi/a"}');
      write(`packages/a/${README}`, '# a\n');
      write('packages/b/package.json', '{"name":"@kindgi/b","private":true}');
      write(`packages/b/${README}`, '# b\n');
      write('packages/adapters/c/package.json', '{"name":"@kindgi/c"}');
      write(`packages/adapters/c/${README}`, '# c\n');
      write('packages/d/package.json', '{"name":"@kindgi/d"}');
      write('sdks/py/pyproject.toml', '[project]\nname = "x"\nreadme = "README.rst"\n');
      write('sdks/py/README.rst', 'x\n');
      write(
        'sdks/py-cli/pyproject.toml',
        `[project]\nreadme = { file = "${DOCS}", content-type = "text/markdown" }\n`,
      );
      write(`sdks/py-cli/${DOCS}`, '# x\n');
      write('sdks/none/pyproject.toml', '[project]\nname = "y"\n');
      write(`sdks/none/${README}`, '# y\n');
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      assert.deepEqual(publishedReadmes(root), [
        `packages/a/${README}`,
        `packages/adapters/c/${README}`,
        `sdks/py-cli/${DOCS}`,
        'sdks/py/README.rst',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
