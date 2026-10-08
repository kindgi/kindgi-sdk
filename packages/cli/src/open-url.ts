// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Open a URL in the person's browser: `kindgi console` and
 * `kindgi dev --open` (T374). The system's own opener does it (`open` on
 * macOS, `xdg-open` on Linux, the URL handler on Windows), started
 * detached so the CLI never waits on the browser. Whether a browser
 * really showed the page can't be known; a missing opener is, and the
 * caller then prints the URL to open by hand.
 */

import { spawn } from 'node:child_process';

/** Tests inject one; production uses {@link openUrlInBrowser}. */
export type OpenUrl = (url: string) => Promise<OpenUrlOutcome>;

export type OpenUrlOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** The command that opens `url` on `platform`. */
export function browserOpener(
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: readonly string[] } {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // Not `cmd /c start`: cmd would read `&` in a URL as its own.
      return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

export const openUrlInBrowser: OpenUrl = (url) =>
  new Promise((resolve) => {
    const { command, args } = browserOpener(process.platform, url);
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
      child.once('error', (err) =>
        resolve({
          ok: false,
          reason: `${command}: ${(err as NodeJS.ErrnoException).code ?? err.message}`,
        }),
      );
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ ok: false, reason: (err as Error).message });
    }
  });
