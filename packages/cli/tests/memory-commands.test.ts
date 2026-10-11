// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi memory facts list / get / revisions / write / supersede /
 * delete / verify` (T238, T273), through the client's `memory.facts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const FACT = {
  id: 'fact-1',
  type: 'acme.preference',
  scope: { tenantId: 't-1', userId: 'u-1' },
  version: 1,
  createdAt: '2026-10-06T12:00:00Z',
  content: { tone: 'brief' },
};

async function memory(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['memory', 'facts', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        identity: { whoami: record('whoami', { tenantId: 't-1', scopes: [] }) },
        memory: {
          search: record('search', [{ fact: FACT, score: 2 / 61 }]),
          facts: {
            list: record('list', { data: [FACT], hasMore: false, items: [FACT] }),
            read: record('read', FACT),
            write: record('write', FACT),
            supersede: record('supersede', { ...FACT, version: 2 }),
            delete: record('delete', {
              ...FACT,
              invalidatedAt: '2026-10-07T00:00:00Z',
              invalidatedBy: 'user:u-1',
              invalidationReason: 'deleted',
            }),
            verify: record('verify', { ...FACT, version: 2, trust: 'verified' }),
            revisions: record('revisions', [
              { ...FACT, version: 2, content: { tone: 'warm' } },
              {
                ...FACT,
                invalidatedAt: '2026-10-07T00:00:00Z',
                invalidatedBy: 'user:u-1',
                invalidationReason: 'superseded',
              },
            ]),
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi memory facts (T238)', () => {
  test('list, with every filter', async () => {
    const { out, calls } = await memory([
      'list',
      '--type=acme.preference',
      '--scope={"userId":"u-1"}',
      '--limit=5',
      '--cursor=c-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { type: 'acme.preference', scope: { userId: 'u-1' }, limit: 5, cursor: 'c-1' }],
    ]);
  });

  test('list --table; a --scope that is not an object is refused', async () => {
    const { out } = await memory(['list', '--table']);
    expect(out.stdout).toContain('fact-1');
    expect(out.stdout).toContain('{"tone":"brief"}');
    const bad = await memory(['list', '--scope=[1]']);
    expect(bad.out.exitCode).not.toBe(0);
    expect(bad.out.stderr).toContain('--scope must be a JSON object');
    expect(bad.calls).toEqual([]);
  });

  test('get <fact-id>', async () => {
    const { out, calls } = await memory(['get', 'fact-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['read', 'fact-1']]);
    expect(JSON.parse(out.stdout)).toEqual(FACT);
  });

  test("write: the scope's tenant is yours when the input leaves it out", async () => {
    const { out, calls } = await memory([
      'write',
      '--input={"type":"acme.preference","scope":{"userId":"u-1"},"content":{"tone":"brief"}}',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['whoami'],
      [
        'write',
        {
          type: 'acme.preference',
          scope: { userId: 'u-1', tenantId: 't-1' },
          content: { tone: 'brief' },
        },
      ],
    ]);
  });

  test('write: no scope is the whole tenant; a given tenant is passed on as is', async () => {
    const none = await memory(['write', '--input={"type":"acme.note","content":"hi"}']);
    expect(none.calls).toEqual([
      ['whoami'],
      ['write', { type: 'acme.note', content: 'hi', scope: { tenantId: 't-1' } }],
    ]);
    const file = join(cwd, 'fact.json');
    await writeFile(
      file,
      JSON.stringify({ type: 'acme.note', scope: { tenantId: 't-2' }, content: 'hi' }),
    );
    const given = await memory(['write', `--input=@${file}`]);
    expect(given.calls).toEqual([
      ['write', { type: 'acme.note', scope: { tenantId: 't-2' }, content: 'hi' }],
    ]);
  });

  test('write needs --input, an object, with an object scope', async () => {
    const missing = await memory(['write']);
    expect(missing.out.stderr).toContain('--input=<json-or-@file> is required');
    const notObject = await memory(['write', '--input="hi"']);
    expect(notObject.out.stderr).toContain('--input must be a JSON object');
    const badScope = await memory(['write', '--input={"type":"t","content":1,"scope":"x"}']);
    expect(badScope.out.stderr).toContain('--input `scope` must be a JSON object');
    expect([...missing.calls, ...notObject.calls, ...badScope.calls]).toEqual([]);
  });

  test('get one revision, or as it stood then; list as it stood then', async () => {
    const { calls } = await memory([
      'get',
      'fact-1',
      '--revision=2',
      '--as-of=2026-10-06T02:00:00+02:00',
    ]);
    expect(calls).toEqual([['read', 'fact-1', { version: 2, asOf: '2026-10-06T00:00:00.000Z' }]]);
    const listed = await memory(['list', '--as-of=2026-10-06']);
    expect(listed.calls).toEqual([['list', { asOf: '2026-10-06T00:00:00.000Z' }]]);
  });

  test('supersede <fact-id> --input, with --expect-version', async () => {
    const { out, calls } = await memory([
      'supersede',
      'fact-1',
      '--input={"content":{"tone":"warm"},"subjects":[{"kind":"user","id":"u-1"}]}',
      '--expect-version=1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'supersede',
        'fact-1',
        { content: { tone: 'warm' }, subjects: [{ kind: 'user', id: 'u-1' }], expectVersion: 1 },
      ],
    ]);
    expect(JSON.parse(out.stdout).version).toBe(2);
  });

  test('supersede needs --input with content', async () => {
    const missing = await memory(['supersede', 'fact-1']);
    expect(missing.out.stderr).toContain('--input=<json-or-@file> is required');
    const noContent = await memory(['supersede', 'fact-1', '--input={"subjects":[]}']);
    expect(noContent.out.stderr).toContain('--input needs `content`');
    // Usage errors.
    expect([missing.out.exitCode, noContent.out.exitCode]).toEqual([2, 2]);
    expect([...missing.calls, ...noContent.calls]).toEqual([]);
  });

  test('delete and verify, with and without --expect-version', async () => {
    const deleted = await memory(['delete', 'fact-1']);
    expect(deleted.out.exitCode, deleted.out.stderr).toBe(0);
    expect(deleted.calls).toEqual([['delete', 'fact-1']]);
    expect(JSON.parse(deleted.out.stdout).invalidationReason).toBe('deleted');
    const verified = await memory(['verify', 'fact-1', '--expect-version=1']);
    expect(verified.calls).toEqual([['verify', 'fact-1', { expectVersion: 1 }]]);
    expect(JSON.parse(verified.out.stdout).trust).toBe('verified');
    const bad = await memory(['delete', 'fact-1', '--expect-version=one']);
    expect(bad.out.stderr).toContain('--expect-version must be an integer');
    expect(bad.calls).toEqual([]);
  });

  test('revisions --table: newest first, why each one ended', async () => {
    const { out, calls } = await memory(['revisions', 'fact-1', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['revisions', 'fact-1']]);
    const rows = out.stdout.trim().split('\n').slice(2);
    expect(rows[0]).toMatch(/^2 .*current/);
    expect(rows[1]).toContain('superseded 2026-10-07T00:00:00Z by user:u-1');
  });

  test('help names the whole path and every command', async () => {
    const { out } = await memory(['--help']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('Usage: kindgi memory facts <subcommand>');
    for (const name of ['write', 'supersede', 'delete', 'verify', 'revisions', 'retrieve']) {
      expect(out.stdout).toMatch(new RegExp(`^ {2}${name} `, 'm'));
    }
  });

  test('retrieve --query searches, and --table shows the hits best first', async () => {
    const { out, calls } = await memory([
      'retrieve',
      '--query={"mode":"both","query":"refund","limit":5}',
      '--table',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['search', { mode: 'both', query: 'refund', limit: 5 }]]);
    expect(out.stdout).toContain('fact-1');
    expect(out.stdout).toContain('0.0328');
  });

  test('retrieve needs --query, an object', async () => {
    const missing = await memory(['retrieve']);
    expect(missing.out.stderr).toContain('--query=<json-or-@file> is required');
    const bad = await memory(['retrieve', '--query=[1]']);
    expect(bad.out.stderr).toContain('--query must be a JSON object');
    // Usage errors.
    expect([missing.out.exitCode, bad.out.exitCode]).toEqual([2, 2]);
    expect([...missing.calls, ...bad.calls]).toEqual([]);
  });
});
