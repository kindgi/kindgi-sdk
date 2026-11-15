// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The agents' text scans give their patterns' own answers, in time in step
 * with the text's length: a link in a remembered fact, and the dotted ids a
 * drafted template names. Each pattern tries a start at every word in a long
 * run of its characters, and each start walks to the run's end before it
 * fails, so its time grows with the square of the run.
 */

import { describe, expect, test } from 'vitest';

import { dottedIds } from '../src/drafted-template.js';
import {
  type BlockIssue,
  type DraftedTemplateContext,
  checkDraftedTemplate,
  looksLikeInstruction,
} from '../src/index.js';

/** How long `run` takes, in ms. */
function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe('a link in a remembered fact', () => {
  // The link pattern `looksLikeInstruction` had: the reference.
  const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S/i;

  test('is found where the pattern finds one, in time in step with the text', () => {
    const nbsp = `a://${String.fromCharCode(0xa0)}`;
    for (const text of [
      'See https://example.com/x',
      '1.a://x',
      '_a://x',
      'a:// x',
      'a://',
      '1.2://x',
      'HTTPS://X',
      nbsp,
      `x${'1'.repeat(100)}://y`,
      'a:://x',
      'a://b://c',
      '+a://x',
      `${String.fromCharCode(0xe9)}a://x`,
    ]) {
      expect(looksLikeInstruction(text, []), text).toBe(LINK.test(text));
    }
    expect(looksLikeInstruction('See https://example.com/x', [])).toBe(true);
    expect(looksLikeInstruction('1.a://x', [])).toBe(true);
    expect(looksLikeInstruction('_a://x', [])).toBe(false);
    expect(looksLikeInstruction('a:// x', [])).toBe(false);
    expect(looksLikeInstruction('a://', [])).toBe(false);
    expect(looksLikeInstruction('1.2://x', [])).toBe(false);
    expect(looksLikeInstruction('HTTPS://X', [])).toBe(true);
    expect(looksLikeInstruction(nbsp, [])).toBe(false);
    expect(looksLikeInstruction(`x${'1'.repeat(100)}://y`, [])).toBe(true);

    // 64 KiB each. The pattern takes seconds on these.
    const run = 'a.'.repeat(32 * 1024);
    for (const text of [run, `${run}:// `]) {
      let found: boolean | undefined;
      expect(
        timed(() => {
          found = looksLikeInstruction(text, []);
        }),
        text.slice(-8),
      ).toBeLessThan(500);
      expect(found).toBe(false);
    }
  });
});

describe('the dotted ids a drafted template names', () => {
  // The pattern `checkDraftedTemplate` matched: the reference.
  const DOTTED_ID = /\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi;

  test('are the ones the pattern finds', () => {
    const accented = `${String.fromCharCode(0xe9)}ab.c`;
    for (const text of [
      'acme.export',
      'ACME.Export',
      'x-acme.export',
      '1-ab.c',
      '_ab.c',
      'a.b',
      'ab.c',
      'ab.c-',
      'ab.--',
      'ab.cd.--',
      'ab..c',
      'see ab.c and de.f.',
      accented,
      'x.ab.c',
      '-ab.c',
      'ab.c-d',
      'ab.c-.d',
      'ab.c--x.yz',
      'ab.--.cd',
      'ab.--.--',
      'a-b.c-d.e',
      'Use acme.rank.score; weight {{ settings["acme.weights"].recency }}.',
    ]) {
      expect(dottedIds(text), text).toEqual(text.match(DOTTED_ID) ?? []);
    }
    expect(dottedIds('acme.export')).toEqual(['acme.export']);
    expect(dottedIds('ACME.Export')).toEqual(['ACME.Export']);
    expect(dottedIds('x-acme.export')).toEqual(['x-acme.export']);
    expect(dottedIds('1-ab.c')).toEqual(['ab.c']);
    expect(dottedIds('_ab.c')).toEqual([]);
    expect(dottedIds('a.b')).toEqual([]);
    expect(dottedIds('ab.c')).toEqual(['ab.c']);
    expect(dottedIds('ab.c-')).toEqual(['ab.c']);
    expect(dottedIds('ab.--')).toEqual([]);
    expect(dottedIds('ab.cd.--')).toEqual(['ab.cd']);
    expect(dottedIds('ab..c')).toEqual([]);
    expect(dottedIds('see ab.c and de.f.')).toEqual(['ab.c', 'de.f']);
    expect(dottedIds(accented)).toEqual(['ab.c']);
  });

  test('are found in time in step with the templates', () => {
    const context = (template: string): DraftedTemplateContext => ({
      current: { template },
      settingsBlocks: [],
      knownIds: [],
    });
    let issues: BlockIssue[] | undefined;

    // A 64 KiB current template. The pattern takes seconds on it.
    const current = 'a-'.repeat(32 * 1024);
    expect(
      timed(() => {
        issues = checkDraftedTemplate('Be brief.', context(current));
      }),
    ).toBeLessThan(500);
    expect(issues).toEqual([]);

    // The longest candidate there is: 20,000 characters (`DRAFTED_TEMPLATE_MAX`),
    // against a current template half as long. The cap keeps the pattern itself
    // to about a third of a second here, under the bar above, so this case's bar
    // is lower.
    const candidate = `${'a-'.repeat(9_999)}.-`;
    const longest = 'Answer briefly. '.repeat(625);
    expect(
      timed(() => {
        issues = checkDraftedTemplate(candidate, context(longest));
      }),
    ).toBeLessThan(100);
    expect(issues).toEqual([]);
  });
});
