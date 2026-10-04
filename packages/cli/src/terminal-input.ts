// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Reading a secret from the person at the terminal (a hidden prompt) or
 * from stdin: the value of `kindgi secrets set`, the registry token of
 * `kindgi auth registry`. Nothing here echoes or logs what it reads.
 */

import { EOL } from 'node:os';
import * as readline from 'node:readline';
import type { ReadStream } from 'node:tty';

/** A prompt whose answer isn't echoed. Tests hand in a fake. */
export interface TtySeam {
  /** Rejects with `PromptCancelled` when the person presses Ctrl+C (or Ctrl+D) instead. */
  promptHidden(prompt: string): Promise<string>;
  close(): void;
}

/** The person cancelled a prompt (Ctrl+C, or Ctrl+D): no answer, not an empty one. */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptCancelled';
  }
}

/** Whether stdin is a terminal, so a hidden prompt can read from it. */
export function stdinIsTty(): boolean {
  return Boolean((process.stdin as ReadStream).isTTY);
}

export function stripTrailingNewline(s: string): string {
  if (s.endsWith(EOL)) return s.slice(0, -EOL.length);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

export async function readStdinToEnd(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The hidden prompt on the real terminal: the prompt on stderr, keystrokes from stdin. */
export function realTtySeam(): TtySeam {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Silence output while user types. `readline` doesn't expose a
  // built-in "no-echo" mode; the standard trick is to override the
  // internal `_writeToOutput` on the interface. This is portable
  // enough across Node 22.x + prints only the prompt itself.
  const rlAny = rl as unknown as {
    _writeToOutput?: (s: string) => void;
    output?: NodeJS.WritableStream;
  };
  return {
    promptHidden: (prompt) =>
      new Promise<string>((resolve, reject) => {
        const originalWrite = rlAny._writeToOutput;
        const done = (): void => {
          rl.off('SIGINT', cancel);
          rl.off('close', cancel);
          if (originalWrite !== undefined) {
            rlAny._writeToOutput = originalWrite;
          } else {
            // biome-ignore lint/performance/noDelete: readline distinguishes missing property from undefined
            delete rlAny._writeToOutput;
          }
          (rlAny.output ?? process.stderr).write('\n');
        };
        // Ctrl+C in a raw-mode prompt reaches readline, not the process:
        // without these, readline closes, the answer never comes, and the
        // process exits 0 as if nothing went wrong.
        const cancel = (): void => {
          done();
          reject(new PromptCancelled());
        };
        rl.once('SIGINT', cancel);
        rl.once('close', cancel);
        rlAny._writeToOutput = function overrideWrite(str: string): void {
          // Write only the prompt itself (rl.question emits the
          // prompt via the same channel); swallow keystrokes.
          if (str === prompt) {
            (rlAny.output ?? process.stderr).write(str);
          }
        };
        rl.question(prompt, (answer) => {
          done();
          resolve(answer);
        });
      }),
    close: () => {
      rl.close();
    },
  };
}
