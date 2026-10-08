// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi console` (T374): checks that the runtime the CLI points at
 * serves a console, then opens it, or with `--no-open` prints its URL.
 * The browser is a seam; nothing is opened for real.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { type RunCliInputs, runCli } from '../src/main.js';
import { type OpenUrlOutcome, browserOpener } from '../src/open-url.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-console-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-console-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const RUNTIME = 'http://127.0.0.1:4999';

/** A runtime that answers `/console/` with `status`, or doesn't answer at all. */
function runtime(status: number | 'down'): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    if (status === 'down') throw new TypeError('fetch failed');
    return new Response(status === 200 ? '<!doctype html>' : '{}', { status });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

function browser(outcome: OpenUrlOutcome = { ok: true }) {
  const opened: string[] = [];
  return {
    opened,
    openUrl: async (url: string) => {
      opened.push(url);
      return outcome;
    },
  };
}

function inputs(extra: Partial<RunCliInputs>): RunCliInputs {
  return { argv: ['console'], env: {}, cwd, home, ...extra };
}

describe('kindgi console', () => {
  test('opens the console of the runtime kindgi dev wrote to .kindgirc.json', async () => {
    await writeFile(join(cwd, '.kindgirc.json'), JSON.stringify({ apiUrl: RUNTIME, token: 't' }));
    const { fetchImpl, asked } = runtime(200);
    const b = browser();
    const out = await runCli(inputs({ fetchImpl, openUrl: b.openUrl }));
    expect(out.exitCode).toBe(0);
    expect(asked).toEqual([`${RUNTIME}/console/`]);
    expect(b.opened).toEqual([`${RUNTIME}/console/`]);
    expect(out.stdout).toBe(`Console: ${RUNTIME}/console/ (opened in your browser)\n`);
  });

  test('--no-open prints the URL and opens nothing', async () => {
    const { fetchImpl } = runtime(200);
    const b = browser();
    const out = await runCli(
      inputs({
        argv: ['console', '--no-open', `--url=${RUNTIME}/`],
        fetchImpl,
        openUrl: b.openUrl,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(b.opened).toEqual([]);
    expect(out.stdout).toBe(`Console: ${RUNTIME}/console/\n`);
  });

  test('no browser to start: the URL is printed, with how to go on; still exit 0', async () => {
    const { fetchImpl } = runtime(200);
    const b = browser({ ok: false, reason: 'xdg-open: ENOENT' });
    const out = await runCli(
      inputs({ argv: ['console', `--url=${RUNTIME}`], fetchImpl, openUrl: b.openUrl }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(`Console: ${RUNTIME}/console/\n`);
    expect(out.stderr).toBe("Couldn't open a browser (xdg-open: ENOENT): open the URL yourself.\n");
  });

  test('--json: the URL and whether it opened', async () => {
    const { fetchImpl } = runtime(200);
    const b = browser({ ok: false, reason: 'open: ENOENT' });
    const out = await runCli(
      inputs({ argv: ['console', '--json', `--url=${RUNTIME}`], fetchImpl, openUrl: b.openUrl }),
    );
    expect(JSON.parse(out.stdout)).toEqual({
      url: `${RUNTIME}/console/`,
      opened: false,
      openError: 'open: ENOENT',
    });
  });

  test('no runtime configured: says to run kindgi dev; nothing fetched or opened', async () => {
    const { fetchImpl, asked } = runtime(200);
    const b = browser();
    const out = await runCli(inputs({ fetchImpl, openUrl: b.openUrl }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No runtime to open: run `kindgi dev` in your project');
    expect(asked).toEqual([]);
    expect(b.opened).toEqual([]);
  });

  test('nothing answers: says so, and how to start it', async () => {
    const { fetchImpl } = runtime('down');
    const b = browser();
    const out = await runCli(
      inputs({ argv: ['console', `--url=${RUNTIME}`], fetchImpl, openUrl: b.openUrl }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(`Nothing answers at ${RUNTIME} (fetch failed)`);
    expect(b.opened).toEqual([]);
  });

  test('a runtime without a console: says so, and how one is served', async () => {
    const { fetchImpl } = runtime(404);
    const b = browser();
    const out = await runCli(
      inputs({ argv: ['console', `--url=${RUNTIME}`], fetchImpl, openUrl: b.openUrl }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('serves no console (GET /console/: HTTP 404)');
    expect(out.stderr).toContain('--console-static-dir');
    expect(b.opened).toEqual([]);
  });
});

describe('browserOpener', () => {
  const url = 'http://127.0.0.1:4000/console/?a=1&b=2';

  test.each([
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
    ['freebsd', 'xdg-open', [url]],
    // Not through cmd, which would split the URL at `&`.
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
  ] as const)('%s: %s', (platform, command, args) => {
    expect(browserOpener(platform, url)).toEqual({ command, args });
  });
});
