// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The part of a writable stream `writeFully` uses. */
export interface WriteTarget {
  write(chunk: string, callback: (err?: Error | null) => void): boolean;
}

/**
 * Write `text` and resolve once the stream has handed it to the OS. Writes
 * to a pipe are asynchronous on macOS, so a `process.exit()` right after
 * `write` cuts piped output at the pipe's buffer (64 KiB). A write error
 * (the reader went away: `kindgi … | head`) resolves too — there is no one
 * left to write to.
 */
export function writeFully(stream: WriteTarget, text: string): Promise<void> {
  if (text.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}
