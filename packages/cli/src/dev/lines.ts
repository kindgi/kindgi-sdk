// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A process's output as lines. A chunk can end mid-line (a long JSON
 * record often does), so each line goes to `onLine` once it's complete;
 * `end()` passes on what's left. Empty lines are skipped, and a `\r`
 * before the line break is dropped. Give it text: a stream with
 * `setEncoding('utf8')` never splits a character between chunks.
 */
export interface LineReader {
  push(chunk: string): void;
  end(): void;
}

export function lineReader(onLine: (line: string) => void): LineReader {
  let rest = '';
  const emit = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text !== '') onLine(text);
  };
  return {
    push(chunk) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) emit(part);
    },
    end() {
      const last = rest;
      rest = '';
      emit(last);
    },
  };
}
