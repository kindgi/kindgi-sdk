// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/lib/stamp-unreleased.mjs`: a changelog's
 * `## Unreleased` section stamped as a version. Run: `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { StampError, stampUnreleased, unreleasedProblems } from './stamp-unreleased.mjs';

const EMPTY = 'No changes.';

const CHANGELOG = `# Acme

Intro text.

## Unreleased

- a change
- another change

## 1.1.0

- an older change
`;

describe('stampUnreleased', () => {
  test('the entries move under the version, below a fresh, empty Unreleased', () => {
    assert.equal(
      stampUnreleased(CHANGELOG, '1.2.0-rc.0', EMPTY, 'CHANGELOG.md'),
      `# Acme

Intro text.

## Unreleased

## 1.2.0-rc.0

- a change
- another change

## 1.1.0

- an older change
`,
    );
  });

  test('a section with no entries says so, so every version keeps a heading', () => {
    const stamped = stampUnreleased(
      '# Acme\n\n## Unreleased\n\n## 1.1.0\n\n- old\n',
      '1.2.0',
      EMPTY,
      'C',
    );
    assert.equal(
      stamped,
      '# Acme\n\n## Unreleased\n\n## 1.2.0\n\nNo changes.\n\n## 1.1.0\n\n- old\n',
    );
  });

  test('the first release: Unreleased is the only section', () => {
    assert.equal(
      stampUnreleased('# Acme\n\n## Unreleased\n\n- first\n', '0.1.0', EMPTY, 'C'),
      '# Acme\n\n## Unreleased\n\n## 0.1.0\n\n- first\n',
    );
  });

  test('stamping a version that already has a heading changes nothing (a second run)', () => {
    const once = stampUnreleased(CHANGELOG, '1.2.0', EMPTY, 'C');
    assert.equal(stampUnreleased(once, '1.2.0', EMPTY, 'C'), once);
  });

  test('a "## " line inside a fenced block is not a heading', () => {
    const text = '# Acme\n\n## Unreleased\n\n- a change:\n\n```md\n## Unreleased\n```\n';
    assert.deepEqual(unreleasedProblems(text, 'C'), []);
    assert.equal(
      stampUnreleased(text, '1.0.0', EMPTY, 'C'),
      '# Acme\n\n## Unreleased\n\n## 1.0.0\n\n- a change:\n\n```md\n## Unreleased\n```\n',
    );
  });

  test('refuses a changelog without exactly one Unreleased, above every version', () => {
    assert.throws(
      () => stampUnreleased('# Acme\n\n## 1.0.0\n', '1.1.0', EMPTY, 'sdks/java/CHANGELOG.md'),
      (err) => {
        assert.ok(err instanceof StampError);
        assert.match(err.message, /CHANGELOG\.md needs one "## Unreleased" heading; it has 0/);
        return true;
      },
    );
    assert.deepEqual(
      unreleasedProblems('## Unreleased\n\n## Unreleased\n', 'sdks/java/CHANGELOG.md'),
      [
        'sdks/java/CHANGELOG.md needs one "## Unreleased" heading; it has 2',
        'sdks/java/CHANGELOG.md has "## Unreleased" twice',
      ],
    );
    assert.deepEqual(unreleasedProblems('## 1.0.0\n\n## Unreleased\n', 'sdks/java/CHANGELOG.md'), [
      'sdks/java/CHANGELOG.md: "## Unreleased" must be the first section, above every version',
    ]);
    assert.deepEqual(
      unreleasedProblems('## Unreleased\n\n## 1.0.0\n\n## 1.0.0\n', 'sdks/java/CHANGELOG.md'),
      ['sdks/java/CHANGELOG.md has "## 1.0.0" twice'],
    );
  });
});
