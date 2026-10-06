// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

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

/** `kindgi conversations list` with `flags` against a client that records the call. */
async function list(flags: readonly string[]) {
  const calls: unknown[] = [];
  const out = await runCli({
    argv: ['conversations', 'list', ...flags, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        conversations: {
          list: async (filter: unknown) => {
            calls.push(filter);
            return { data: [], hasMore: false };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi conversations list', () => {
  test('lists with no filter: the API leaves replay conversations out', async () => {
    const { out, calls } = await list([]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{}]);
  });

  test('--status, --replays, --limit and --cursor map to one list call', async () => {
    const { out, calls } = await list([
      '--status=open',
      '--replays=only',
      '--limit=5',
      '--cursor=c-1',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ status: 'open', replays: 'only', limit: 5, cursor: 'c-1' }]);
  });

  test('errors: a status or replays it does not know', async () => {
    for (const [flag, message] of [
      ['--status=archived', '--status must be one of open, closed, got "archived"'],
      ['--replays=all', '--replays must be one of exclude, include, only, got "all"'],
    ] as const) {
      const { out, calls } = await list([flag]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain(message);
      expect(calls).toEqual([]);
    }
  });
});

const CONVERSATION = {
  id: 'c-1',
  tenantId: 't-1',
  agentId: 'acme.helper',
  agentVersion: '1.0.0',
  title: 'Untitled conversation',
  status: 'open',
  turnCount: 0,
};

/** `kindgi conversations <argv>` against a client whose conversation methods record their calls. */
async function conversations(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['conversations', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        conversations: {
          get: record('get', CONVERSATION),
          open: record('open', CONVERSATION),
          close: record('close', { ...CONVERSATION, status: 'closed' }),
          messages: record('messages', { data: [], hasMore: false }),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi conversations get / open / close / messages (T238)', () => {
  test('get <conversation-id>', async () => {
    const { out, calls } = await conversations(['get', 'c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['get', 'c-1']]);
    expect(out.stdout).toContain('"agentVersion": "1.0.0"');
  });

  test('open <agent-id> <version>, with --title, --project and --participant', async () => {
    const { out, calls } = await conversations([
      'open',
      'acme.helper',
      '1.0.0',
      '--title=Onboarding',
      '--project=p-1',
      '--participant=user-7',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'open',
        {
          agentId: 'acme.helper',
          agentVersion: '1.0.0',
          title: 'Onboarding',
          projectId: 'p-1',
          participantId: 'user-7',
        },
      ],
    ]);
  });

  test('open needs the version: the conversation pins it', async () => {
    const { out, calls } = await conversations(['open', 'acme.helper']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('version');
    expect(calls).toEqual([]);
  });

  test('close <conversation-id>', async () => {
    const { out, calls } = await conversations(['close', 'c-1']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['close', 'c-1']]);
    expect(out.stdout).toContain('"status": "closed"');
  });

  test('messages <conversation-id> [--limit] [--cursor]', async () => {
    const { out, calls } = await conversations(['messages', 'c-1', '--limit=10', '--cursor=m-9']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['messages', 'c-1', { limit: 10, cursor: 'm-9' }]]);
  });

  test('each command without its id: a usage error naming it, nothing called', async () => {
    for (const command of ['get', 'close', 'messages']) {
      const { out, calls } = await conversations([command]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain('conversation-id');
      expect(calls).toEqual([]);
    }
  });

  test('every conversations command is in --help now', async () => {
    const { out } = await conversations(['--help']);
    for (const command of ['list', 'get', 'open', 'close', 'messages']) {
      expect(out.stdout).toContain(command);
    }
  });
});
