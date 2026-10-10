// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi guardrails list`, through the client's `guardrails`: JSON by default, a table with `--table`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const GUARDRAILS = [
  {
    id: 'acme-shop.no-card-numbers',
    kind: 'zero-llm',
    check: 'forbidden-substring',
    config: { substrings: ['4242'] },
    action: { 'on-violation': 'halt' },
    severity: 'critical',
  },
  {
    id: 'acme-shop.cite-order',
    kind: 'zero-llm',
    check: 'must-cite',
    action: { 'on-violation': 'log-only' },
  },
];

const list = (argv: readonly string[]) =>
  runCli({
    argv: ['guardrails', 'list', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({ guardrails: { list: async () => ({ data: GUARDRAILS, hasMore: false }) } }) as never,
  });

describe('kindgi guardrails list', () => {
  test('--table: a row per guardrail with its kind, check, action and severity', async () => {
    const out = await list(['--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/ID\s+KIND\s+CHECK\s+ACTION\s+SEVERITY/);
    expect(out.stdout).toMatch(
      /acme-shop\.no-card-numbers\s+zero-llm\s+forbidden-substring\s+halt\s+critical/,
    );
    // No severity: the cell is empty, not "undefined".
    expect(out.stdout).toMatch(/acme-shop\.cite-order\s+zero-llm\s+must-cite\s+log-only\s*$/m);
    expect(out.stdout).not.toContain('undefined');
    expect(out.stdout).not.toContain('"data"');
  });

  test('without --table: the page as JSON, as before', async () => {
    const out = await list([]);
    expect(out.exitCode, out.stderr).toBe(0);
    const page = JSON.parse(out.stdout) as { data: { id: string }[]; hasMore: boolean };
    expect(page.data.map((g) => g.id)).toEqual([
      'acme-shop.no-card-numbers',
      'acme-shop.cite-order',
    ]);
  });
});
