// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { type WriteTarget, writeFully } from '../src/write-fully.js';

/** A stream that takes its chunks later, as a pipe does on macOS. */
function slowStream(error?: Error) {
  const taken: string[] = [];
  const stream: WriteTarget = {
    write(chunk, callback) {
      setTimeout(() => {
        taken.push(chunk);
        callback(error ?? null);
      }, 20);
      return false;
    },
  };
  return { stream, taken };
}

describe('writeFully', () => {
  test('resolves only once the stream has taken the text', async () => {
    const { stream, taken } = slowStream();
    const pending = writeFully(stream, 'x'.repeat(200_000));
    expect(taken).toEqual([]);
    await pending;
    expect(taken.join('').length).toBe(200_000);
  });

  test('resolves on a write error — the reader went away', async () => {
    const { stream } = slowStream(new Error('EPIPE'));
    await expect(writeFully(stream, 'text')).resolves.toBeUndefined();
  });

  test('writes nothing for empty text', async () => {
    const { stream, taken } = slowStream();
    await writeFully(stream, '');
    expect(taken).toEqual([]);
  });
});
