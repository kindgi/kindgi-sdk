// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A command's streamed lines and what `runCli` says first: the dev
 * runtime's line (said once a command reads its key) and the pin's. Each
 * is said once, the first line after them, whichever comes first.
 */

import { describe, expect, test } from 'vitest';

import { progressAfterHead } from '../src/progress-head.js';

const HINT =
  'kindgi build goes to the kindgi dev runtime at http://127.0.0.1:4000 (.env says so). For https://api.acme.example, pass --hosted.\n';
const PIN =
  '⚠ This pack pins the Kindgi CLI 0.0.1 ("cli" in kindgi.config.json), and this is 0.2.0.\n';

function streamed(): { readonly written: string[]; readonly write: (text: string) => void } {
  const written: string[] = [];
  return { written, write: (text) => written.push(text) };
}

describe('progressAfterHead', () => {
  test('not streamed: the outcome says the hint, then the pin', () => {
    const head = progressAfterHead(
      undefined,
      () => HINT,
      () => PIN,
    );
    expect(head.progress).toBeUndefined();
    expect(head.unsaid(PIN)).toBe(`${HINT}${PIN}`);
  });

  test('streamed but nothing written: the outcome says both', () => {
    const out = streamed();
    const head = progressAfterHead(
      out.write,
      () => HINT,
      () => PIN,
    );
    expect(head.unsaid(PIN)).toBe(`${HINT}${PIN}`);
    expect(out.written).toEqual([]);
  });

  test('a hint said before the first line goes out with it, then the pin, and not again', () => {
    const out = streamed();
    const head = progressAfterHead(
      out.write,
      () => HINT,
      () => PIN,
    );
    head.progress?.('  Environment: staging\n');
    head.progress?.('  Bundling\n');
    expect(out.written).toEqual([`${HINT}${PIN}  Environment: staging\n`, '  Bundling\n']);
    expect(head.unsaid(PIN)).toBe('');
  });

  test('a hint said after the first line is left for the outcome, without the pin', () => {
    let hint = '';
    const out = streamed();
    const head = progressAfterHead(
      out.write,
      () => hint,
      () => PIN,
    );
    head.progress?.('  Environment: staging\n');
    hint = HINT;
    head.progress?.('  Bundling\n');
    expect(out.written).toEqual([`${PIN}  Environment: staging\n`, '  Bundling\n']);
    expect(head.unsaid(PIN)).toBe(HINT);
  });

  test('no hint at all: the outcome says nothing more once a line went out', () => {
    const out = streamed();
    const head = progressAfterHead(
      out.write,
      () => '',
      () => '',
    );
    head.progress?.('  Environment: staging\n');
    expect(out.written).toEqual(['  Environment: staging\n']);
    expect(head.unsaid('')).toBe('');
  });
});
