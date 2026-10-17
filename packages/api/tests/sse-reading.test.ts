// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `readingOf`: an event stream's reading signal also ends when the
 * request aborts, whether that comes later or came before.
 */

import { describe, expect, test } from 'vitest';

import { readingOf } from '../src/routes/sse.js';

describe('readingOf', () => {
  test('aborts when the request aborts', () => {
    const client = new AbortController();
    const reading = readingOf(new Request('http://acme.test/', { signal: client.signal }));
    expect(reading.signal.aborted).toBe(false);
    client.abort();
    expect(reading.signal.aborted).toBe(true);
  });

  test('a request already aborted: aborted at once', () => {
    const client = new AbortController();
    client.abort();
    const reading = readingOf(new Request('http://acme.test/', { signal: client.signal }));
    expect(reading.signal.aborted).toBe(true);
  });
});
