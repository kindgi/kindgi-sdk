// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi provenance list / get / export` (T238), through the client's `provenance`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

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

const RECORD = {
  id: 'prov-1',
  runId: 'run-1',
  tenantId: 't-1',
  version: '1.0.0',
  createdAt: '2026-10-06T12:00:00Z',
  signed: false,
};

async function provenance(
  argv: readonly string[],
  answers: { readonly query?: unknown; readonly get?: unknown } = {},
) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      if (result instanceof Error) throw result;
      return result;
    };
  const out = await runCli({
    argv: ['provenance', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        provenance: {
          query: record('query', answers.query ?? { data: [RECORD], hasMore: false }),
          get: record('get', answers.get ?? { ...RECORD, nodes: [] }),
          export: record('export', { bundle: {}, signature: 'sig' }),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi provenance (T238)', () => {
  test('list, with every filter', async () => {
    const { out, calls } = await provenance([
      'list',
      '--run=run-1',
      '--agent=acme.helper',
      '--created-after=2026-10-01',
      '--project=p-1',
      '--limit=5',
      '--cursor=c-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'query',
        {
          scope: { kind: 'project', projectId: 'p-1' },
          runId: 'run-1',
          agentId: 'acme.helper',
          createdAfter: '2026-10-01T00:00:00.000Z',
          limit: 5,
          cursor: 'c-1',
        },
      ],
    ]);
  });

  test('list --org scopes to an org; --project and --org together are refused', async () => {
    const org = await provenance(['list', '--org=o-1']);
    expect(org.calls).toEqual([['query', { scope: { kind: 'org', orgId: 'o-1' } }]]);
    const both = await provenance(['list', '--org=o-1', '--project=p-1']);
    expect(both.out.exitCode).not.toBe(0);
    expect(both.out.stderr).toContain('--project and --org are mutually exclusive');
    expect(both.calls).toEqual([]);
  });

  test("list --flow: that flow's runs' records; a runtime that ignores the filter is refused", async () => {
    const flowRecord = { ...RECORD, flowRef: { id: 'acme.report', version: '1.0.0' } };
    const filtered = { data: [flowRecord], hasMore: false };
    const ok = await provenance(['list', '--flow=acme.report', '--table'], {
      query: { ...filtered, flowId: 'acme.report' },
    });
    expect(ok.out.exitCode, ok.out.stderr).toBe(0);
    expect(ok.calls).toEqual([['query', { flowId: 'acme.report' }]]);
    expect(ok.out.stdout).toContain('acme.report@1.0.0');

    const ignored = await provenance(['list', '--flow=acme.report'], { query: filtered });
    expect(ignored.out.exitCode).not.toBe(0);
    expect(ignored.out.stderr).toContain('--flow needs a runtime that lists records by flow');
    expect(ignored.out.stdout).toBe('');
  });

  test('list --table', async () => {
    const { out } = await provenance(['list', '--table']);
    expect(out.stdout).toContain('run-1');
    expect(out.stdout).toContain('no');
  });

  test('get <run-id>', async () => {
    const { out, calls } = await provenance(['get', 'run-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['get', 'run-1']]);
  });

  test("get on a flow run whose record isn't written yet prints the record's state", async () => {
    const notYet = (fields: Record<string, unknown>, message: string) =>
      new KindgiApiError({
        code: 'not-found',
        serverCode: 'provenance-not-found',
        message,
        resource: { kind: 'provenance', id: 'run-1' },
        fields: { runId: 'run-1', ...fields },
      });
    const writing = await provenance(['get', 'run-1'], {
      get: notYet({ recordState: 'being-written' }, "The run's record is being written."),
    });
    expect(writing.out.exitCode).toBe(1);
    expect(writing.out.stderr).toContain("The run's record is being written.");
    expect(writing.out.stderr).toContain('Record state: being-written');

    const failed = await provenance(['get', 'run-1'], {
      get: notYet({ recordState: 'failed', reason: 'build-failed' }, "The run's record failed."),
    });
    expect(failed.out.stderr).toContain('Record state: failed (build-failed)');

    const none = await provenance(['get', 'run-1'], { get: notYet({}, 'No record for run-1.') });
    expect(none.out.stderr).not.toContain('Record state');
  });

  test('export <run-id> --signing-key [--include-messages]', async () => {
    const { out, calls } = await provenance([
      'export',
      'run-1',
      '--signing-key=k-1',
      '--include-messages',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['export', { runId: 'run-1', signingKeyId: 'k-1', includeMessages: true }],
    ]);
    const plain = await provenance(['export', 'run-1', '--signing-key=k-1']);
    expect(plain.calls).toEqual([['export', { runId: 'run-1', signingKeyId: 'k-1' }]]);
  });

  test('export without --signing-key signs with the active key: the call names none', async () => {
    const { calls } = await provenance(['export', 'run-1']);
    expect(calls).toEqual([['export', { runId: 'run-1' }]]);
  });

  test('get/export without the run: usage errors', async () => {
    for (const command of ['get', 'export']) {
      const { out, calls } = await provenance([command]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain('run-id');
      expect(calls).toEqual([]);
    }
  });
});
