// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi console`: open the console of the runtime the CLI points at
 * (`.kindgirc.json`, which `kindgi dev` writes; `--url`; `KINDGI_API_URL`;
 * `kindgi auth login`) in the browser, after checking that the runtime
 * serves one (T374). `--no-open` only prints its URL.
 */

import { openUrlInBrowser } from '../open-url.js';
import { renderJson } from '../output.js';
import type { CommandResult, LeafCommand } from './types.js';

/** Where a runtime serves its console. */
export function consoleUrlOf(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/console/`;
}

export type ConsoleProbe =
  | { readonly kind: 'served'; readonly url: string }
  /** The runtime answers, without a console (started without `--console-static-dir`). */
  | { readonly kind: 'not-served'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly reason: string };

/** Whether the runtime at `apiUrl` serves its console. */
export async function probeConsole(fetchImpl: typeof fetch, apiUrl: string): Promise<ConsoleProbe> {
  const url = consoleUrlOf(apiUrl);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return res.ok ? { kind: 'served', url } : { kind: 'not-served', status: res.status };
  } catch (err) {
    return { kind: 'unreachable', reason: (err as Error).message };
  }
}

/** What `kindgi dev --open` and `kindgi console` say when no browser could be started. */
export function couldNotOpen(reason: string): string {
  return `Couldn't open a browser (${reason}): open the URL yourself.`;
}

export const consoleCommand: LeafCommand = {
  kind: 'leaf',
  name: 'console',
  description: "Open the runtime's console in your browser.",
  usage: 'kindgi console [--no-open]',
  optionSpec: {
    'no-open': {
      type: 'boolean',
      description: "Print the console's URL without opening a browser.",
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const apiUrl = ctx.config.apiUrl;
    if (apiUrl === undefined) {
      return {
        kind: 'error',
        stderr:
          'No runtime to open: run `kindgi dev` in your project (it writes .kindgirc.json), or pass --url=<the runtime URL>.\n',
        exitCode: 1,
      };
    }
    const probe = await probeConsole(ctx.fetch, apiUrl);
    if (probe.kind === 'unreachable') {
      return {
        kind: 'error',
        stderr: `Nothing answers at ${apiUrl} (${probe.reason}). Start it with \`kindgi dev\` in your project, or pass --url=<the runtime URL>.\n`,
        exitCode: 1,
      };
    }
    if (probe.kind === 'not-served') {
      return {
        kind: 'error',
        stderr: `The runtime at ${apiUrl} serves no console (GET /console/: HTTP ${probe.status}). It serves one when started with --console-static-dir, as the published image is by default.\n`,
        exitCode: 1,
      };
    }
    const open = ctx.options['no-open'] !== true;
    const opened = open ? await (ctx.openUrl ?? openUrlInBrowser)(probe.url) : undefined;
    if (ctx.globals.formatRequested) {
      return {
        kind: 'ok',
        rendered: renderJson(
          {
            url: probe.url,
            opened: opened?.ok === true,
            ...(opened !== undefined && !opened.ok && { openError: opened.reason }),
          },
          ctx.globals.format,
        ),
      };
    }
    return {
      kind: 'ok',
      rendered: {
        stdout: `Console: ${probe.url}${opened?.ok === true ? ' (opened in your browser)' : ''}\n`,
        stderr: opened !== undefined && !opened.ok ? `${couldNotOpen(opened.reason)}\n` : '',
      },
    };
  },
};
