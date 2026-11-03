// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  addSubmissions,
  markFixed,
  markWithdrawn,
  parseFeedback,
} from '../src/feedback/entries.js';

const HEADER =
  '# Kindgi framework feedback\n\nRunning list of bugs, friction, questions, and design observations.\n\n---\n\n';

const entry = (id: string, title: string, body: string, extra = '') =>
  `## ${title}\n\n- **id:** ${id}\n- **hash:** feedback-0a1b2c3d\n- **kind:** bug\n- **severity:** high\n- **date:** 2026-10-15T07:00:00.000Z\n- **sdk:** 0.1.8 · **cli:** 0.1.8 · **by:** claude-code\n${extra}\n${body}\n\n---\n`;

const FILE = `${HEADER}${entry('2026-10-15.1', 'kindgi dev fails on a path with a space', '### Summary\nIt fails.')}\n${entry('2026-10-15.2', 'Second', '### Observed\nAlso fails.')}`;

describe('parseFeedback', () => {
  test('reads each entry that feedback write appends: title, metadata and body', () => {
    const [first, second] = parseFeedback(FILE);
    expect(first).toEqual({
      title: 'kindgi dev fails on a path with a space',
      fields: {
        id: '2026-10-15.1',
        hash: 'feedback-0a1b2c3d',
        kind: 'bug',
        severity: 'high',
        date: '2026-10-15T07:00:00.000Z',
        sdk: '0.1.8',
        cli: '0.1.8',
        by: 'claude-code',
      },
      body: '### Summary\nIt fails.',
      fixed: false,
      submissions: [],
    });
    expect(second?.fields.id).toBe('2026-10-15.2');
    expect(second?.body).toBe('### Observed\nAlso fails.');
  });

  test("a body's own headings, rules and fenced blocks stay in its entry", () => {
    const body =
      '## Notes\n\nnot an entry\n\n---\n\n```md\n## Inside a fence\n\n- **id:** 2026-01-01.1\n```';
    const entries = parseFeedback(`${HEADER}${entry('2026-10-15.1', 'One', body)}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe(body);
  });

  test('reads the submitted lines, a withdrawn one, and a Fixed line under the heading', () => {
    const text = `${HEADER}## One\n\n> **Fixed:** in 0.1.9\n\n- **id:** 2026-10-15.1\n- **hash:** feedback-0a1b2c3d\n- **sdk:** 0.1.8 · **cli:** 0.1.8 · **by:** human\n- **submitted:** 2026-10-15T08:00:00.000Z · **report:** fbr_AAAAAAAAAAAAAAAA\n- **submitted:** 2026-10-16T08:00:00.000Z · **report:** fbr_BBBBBBBBBBBBBBBB · **withdrawn:** 2026-10-17T08:00:00.000Z\n\nBody.\n\n---\n`;
    const [one] = parseFeedback(text);
    expect(one?.fixed).toBe(true);
    expect(one?.submissions).toEqual([
      { reportId: 'fbr_AAAAAAAAAAAAAAAA', submittedAt: '2026-10-15T08:00:00.000Z' },
      {
        reportId: 'fbr_BBBBBBBBBBBBBBBB',
        submittedAt: '2026-10-16T08:00:00.000Z',
        withdrawnAt: '2026-10-17T08:00:00.000Z',
      },
    ]);
    expect(one?.fields.submitted).toBeUndefined();
    expect(one?.body).toBe('Body.');
  });

  test('a file with no entries has none', () => {
    expect(parseFeedback(HEADER)).toEqual([]);
    expect(parseFeedback('')).toEqual([]);
  });
});

describe('the edits', () => {
  test('a submitted line goes after the metadata, one per report, in order, and nothing else moves', () => {
    const { text, missing } = addSubmissions(
      FILE,
      [
        { entry: '2026-10-15.2', reportId: 'fbr_AAAAAAAAAAAAAAAA' },
        { entry: '2026-10-15.2', reportId: 'fbr_BBBBBBBBBBBBBBBB' },
        { entry: '2026-10-15.9', reportId: 'fbr_CCCCCCCCCCCCCCCC' },
      ],
      '2026-10-15T08:00:00.000Z',
    );
    expect(missing).toEqual(['2026-10-15.9']);
    const added =
      '- **submitted:** 2026-10-15T08:00:00.000Z · **report:** fbr_AAAAAAAAAAAAAAAA\n- **submitted:** 2026-10-15T08:00:00.000Z · **report:** fbr_BBBBBBBBBBBBBBBB\n';
    const [before, after] = FILE.split(
      '- **sdk:** 0.1.8 · **cli:** 0.1.8 · **by:** claude-code\n\n### Observed',
    );
    expect(text).toBe(
      `${before}- **sdk:** 0.1.8 · **cli:** 0.1.8 · **by:** claude-code\n${added}\n### Observed${after}`,
    );
    expect(parseFeedback(text)[1]?.submissions.map((s) => s.reportId)).toEqual([
      'fbr_AAAAAAAAAAAAAAAA',
      'fbr_BBBBBBBBBBBBBBBB',
    ]);
  });

  test('withdrawn is added to its line once', () => {
    const sent = addSubmissions(
      FILE,
      [{ entry: '2026-10-15.1', reportId: 'fbr_AAAAAAAAAAAAAAAA' }],
      '2026-10-15T08:00:00.000Z',
    ).text;
    const once = markWithdrawn(sent, ['fbr_AAAAAAAAAAAAAAAA'], '2026-10-16T08:00:00.000Z');
    expect(once).toContain(
      '- **submitted:** 2026-10-15T08:00:00.000Z · **report:** fbr_AAAAAAAAAAAAAAAA · **withdrawn:** 2026-10-16T08:00:00.000Z\n',
    );
    expect(markWithdrawn(once, ['fbr_AAAAAAAAAAAAAAAA'], '2026-10-17T08:00:00.000Z')).toBe(once);
  });

  test('Fixed goes under the heading, with a blank line either side, and only once', () => {
    const fixed = markFixed(FILE, [
      { entry: '2026-10-15.2', note: 'in 0.1.9 (report fbr_AAAAAAAAAAAAAAAA)' },
      { entry: '2026-10-15.2', note: 'a second note' },
    ]);
    expect(fixed).toContain(
      '## Second\n\n> **Fixed:** in 0.1.9 (report fbr_AAAAAAAAAAAAAAAA)\n\n- **id:** 2026-10-15.2\n',
    );
    expect(fixed).not.toContain('a second note');
    expect(parseFeedback(fixed).map((e) => e.fixed)).toEqual([false, true]);
    expect(markFixed(fixed, [{ entry: '2026-10-15.2', note: 'again' }])).toBe(fixed);

    const tight = '## One\n- **id:** 2026-10-15.1\n\nBody.\n';
    expect(markFixed(tight, [{ entry: '2026-10-15.1', note: 'in 0.1.9' }])).toBe(
      '## One\n\n> **Fixed:** in 0.1.9\n\n- **id:** 2026-10-15.1\n\nBody.\n',
    );
  });

  test('a CRLF file stays CRLF', () => {
    const crlf = FILE.replaceAll('\n', '\r\n');
    const sent = addSubmissions(
      crlf,
      [{ entry: '2026-10-15.1', reportId: 'fbr_AAAAAAAAAAAAAAAA' }],
      '2026-10-15T08:00:00.000Z',
    ).text;
    expect(sent.replaceAll('\r\n', '')).not.toContain('\n');
    expect(sent.endsWith('\r\n')).toBe(true);
    expect(parseFeedback(sent)[0]?.submissions).toHaveLength(1);
    expect(parseFeedback(sent)[0]?.body).toBe('### Summary\nIt fails.');
  });
});
