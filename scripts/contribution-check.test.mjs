// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `scripts/contribution-check.mjs`: what an outside contributor's
 * pull request must carry, and the comment the check writes. Run:
 * `pnpm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMENT_MARKER, evaluateContribution, renderComment } from './contribution-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const AGENT_COMMIT =
  'docs: fix the start-a-run example\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';

const COMPLETE = `## What and why

The start-a-run page's Python example passed the wrong field. https://docs.kindgi.com/v0.1/guides/runs/start-a-run/

## Checks

- [x] \`pnpm run docs:build\`: 723 pages, no broken links
- [x] \`pnpm run docs:samples\`: 113 file samples check

Supervised-by: Ada Lovelace <ada@acme.dev>
`;

const outside = (body, commitMessages = [AGENT_COMMIT]) =>
  evaluateContribution({ association: 'CONTRIBUTOR', body, commitMessages });

describe('evaluateContribution', () => {
  test("a maintainer's pull request isn't checked", () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      assert.deepEqual(evaluateContribution({ association, body: '', commitMessages: [] }), {
        applies: false,
        missing: [],
        notes: [],
        failed: false,
      });
    }
  });

  test('a complete pull request passes, with nothing to say', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
      const result = evaluateContribution({
        association,
        body: COMPLETE,
        commitMessages: [AGENT_COMMIT],
      });
      assert.deepEqual(result, { applies: true, missing: [], notes: [], failed: false });
    }
  });

  test('the person: missing, a placeholder, twice, or without an email, fails', () => {
    const without = COMPLETE.replace(/Supervised-by:.*\n/, '');
    assert.match(outside(without).missing[0], /The person who supervised it/);
    assert.equal(outside(without).failed, true);
    for (const line of [
      'Supervised-by: Your Name <you@example.com>',
      'Supervised-by: Ada Lovelace <ada@example.org>',
    ]) {
      const result = outside(COMPLETE.replace(/Supervised-by:.*/, line));
      assert.match(result.missing[0], /template's placeholder/);
    }
    assert.match(
      outside(`${COMPLETE}Supervised-by: Grace Hopper <grace@acme.dev>\n`).missing[0],
      /There are 2; keep one/,
    );
    assert.match(
      outside(COMPLETE.replace(/Supervised-by:.*/, 'Supervised-by: Ada Lovelace')).missing[0],
      /needs both/,
    );
  });

  test('the checks: missing, an unticked one, or none in the form, fails', () => {
    const noSection = COMPLETE.replace(/## Checks[\s\S]*?(?=Supervised-by)/, '');
    assert.match(outside(noSection).missing[0], /The checks you ran/);
    const unticked = COMPLETE.replace(
      '- [x] `pnpm run docs:samples`',
      '- [ ] `pnpm run docs:samples`',
    );
    assert.match(outside(unticked).missing[0], /still unticked/);
    const noResult = COMPLETE.replace(/- \[x\].*\n- \[x\].*\n/, '- [x] ran the docs build\n');
    assert.match(outside(noResult).missing[0], /none in that form/);
    // The template's own placeholder line is unticked.
    const template = readFileSync(join(ROOT, '.github', 'pull_request_template.md'), 'utf8');
    const fromTemplate = outside(template);
    assert.equal(fromTemplate.failed, true);
    assert.equal(fromTemplate.missing.length, 2);
  });

  test('no agent trailer: a note, not a failure', () => {
    const result = outside(COMPLETE, ['docs: fix the example\n']);
    assert.equal(result.failed, false);
    assert.equal(result.missing.length, 0);
    assert.match(result.notes[0], /Co-Authored-By/);
    // A trailer on any one commit is enough, in any case.
    assert.equal(
      outside(COMPLETE, ['wip\n', 'fix\n\nco-authored-by: Agent <a@acme.dev>']).notes.length,
      0,
    );
  });

  test('CRLF bodies (the web editor) read the same', () => {
    assert.equal(outside(COMPLETE.replace(/\n/g, '\r\n')).failed, false);
  });
});

describe('renderComment', () => {
  test('starts with the marker; says what is missing and links the skill', () => {
    const text = renderComment(outside('', ['wip\n']));
    assert.ok(text.startsWith(COMMENT_MARKER));
    assert.match(text, /The person who supervised it/);
    assert.match(text, /The checks you ran/);
    assert.match(text, /The agent's trailer/);
    assert.match(text, /kindgi-contributing/);
  });

  test('a complete pull request gets a thank-you', () => {
    assert.match(
      renderComment(outside(COMPLETE)),
      /^<!-- kindgi-contribution-check -->\n✓ Thanks!/,
    );
  });
});
