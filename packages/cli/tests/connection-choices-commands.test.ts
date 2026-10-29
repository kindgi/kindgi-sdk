// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi connection-choices …`: set, list, unset (and its question). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ConnectionsSeam } from '../src/commands/connections.js';
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

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const SUPPORT_ID = '5e6f7a88-5555-4e7f-8a81-000000000005';
const SALES_ID = '3f1a9b77-3333-4c5d-8e6f-000000000003';
const OPS_ID = '6f7a8b99-6666-4f80-9b92-000000000006';
const CHOICE_ID = '1c2d3e4f-7777-4a8b-9c0d-000000000007';
const EARLIER_ID = '2d3e4f50-8888-4b9c-8d1e-000000000008';

/** The project's company connections a choice may name. */
const CANDIDATES = [
  {
    connectionId: SUPPORT_ID,
    name: 'support',
    app: 'google',
    accountLabel: 'help@acme.example',
    state: 'working',
  },
  {
    connectionId: SALES_ID,
    name: 'sales',
    app: 'google',
    accountLabel: 'sales@acme.example',
    state: 'working',
  },
  {
    connectionId: OPS_ID,
    name: 'support',
    app: 'microsoft',
    accountLabel: 'ops@acme.example',
    state: 'working',
  },
];

const CHOICE = {
  choiceId: CHOICE_ID,
  projectId: PROJECT,
  envName: 'prod',
  agentId: 'acme.support',
  app: 'google',
  connectionId: SUPPORT_ID,
  version: 2,
  createdAt: '2026-10-28T02:00:00.000Z',
  createdBy: 'user-ana',
};
const EARLIER = {
  ...CHOICE,
  choiceId: EARLIER_ID,
  connectionId: SALES_ID,
  version: 1,
  createdAt: '2026-10-27T02:00:00.000Z',
};

async function run(
  argv: readonly string[],
  client: Record<string, unknown>,
  connectionsSeam: ConnectionsSeam = { interactive: () => false },
) {
  return runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
    connectionsSeam,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

/** `candidates` as the server answers it: only what its `app` filter keeps. */
function candidates(rec: ReturnType<typeof recorder>['rec']) {
  return async (input: { readonly app?: string }) => {
    const kept = CANDIDATES.filter((c) => input.app === undefined || c.app === input.app);
    return rec('candidates', { data: kept, hasMore: false })(input);
  };
}

describe('kindgi connection-choices set', () => {
  test('by name, for an agent: says what it chose and what it replaced', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connection-choices', 'set', 'sales', '--agent=acme.support', `--project=${PROJECT}`],
      {
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', { data: [CHOICE], hasMore: false }),
          set: rec('set', { ...EARLIER, choiceId: '3e4f5061-9999-4cad-8e2f-000000000009' }),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['candidates', { projectId: PROJECT }],
      ['list', { projectId: PROJECT, agentId: 'acme.support' }],
      ['set', { projectId: PROJECT, agentId: 'acme.support', connectionId: SALES_ID }],
    ]);
    expect(JSON.parse(out.stdout)).toMatchObject({ connectionId: SALES_ID, app: 'google' });
    expect(out.stderr).toBe(
      `Chose sales at google for agent acme.support (choice 3e4f5061-9999-4cad-8e2f-000000000009), in place of support (choice ${CHOICE_ID}).\n`,
    );
  });

  test("for a flow, in the tenant's Default project, with nothing chosen before", async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-choices', 'set', SUPPORT_ID, '--flow=acme.triage'], {
      projects: { getDefault: rec('getDefault', { id: PROJECT }) },
      connectionChoices: {
        candidates: candidates(rec),
        list: rec('list', { data: [], hasMore: false }),
        set: rec('set', { ...CHOICE, agentId: undefined, flowId: 'acme.triage' }),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['getDefault'],
      ['candidates', { projectId: PROJECT }],
      ['list', { projectId: PROJECT, flowId: 'acme.triage' }],
      ['set', { projectId: PROJECT, flowId: 'acme.triage', connectionId: SUPPORT_ID }],
    ]);
    expect(out.stderr).toBe(
      `Chose support at google for flow acme.triage (choice ${CHOICE_ID}).\n`,
    );
  });

  test('the one already chosen changes nothing, and says so', async () => {
    const { rec } = recorder();
    const out = await run(
      ['connection-choices', 'set', SUPPORT_ID, '--agent=acme.support', `--project=${PROJECT}`],
      {
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', { data: [CHOICE], hasMore: false }),
          set: rec('set', CHOICE),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe(
      `agent acme.support already uses support at google (choice ${CHOICE_ID}): nothing changed.\n`,
    );
  });

  test('a choice at another app replaces nothing there', async () => {
    const { rec } = recorder();
    const out = await run(
      ['connection-choices', 'set', OPS_ID, '--agent=acme.support', `--project=${PROJECT}`],
      {
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', { data: [CHOICE], hasMore: false }),
          set: rec('set', {
            ...CHOICE,
            choiceId: EARLIER_ID,
            app: 'microsoft',
            connectionId: OPS_ID,
          }),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe(
      `Chose support at microsoft for agent acme.support (choice ${EARLIER_ID}).\n`,
    );
  });

  test.each([
    [['sales']],
    [['sales', '--agent=acme.support', '--flow=acme.triage']],
    [['sales', '--agent=']],
  ] as const)('%j: one agent or one flow, refused before any call', async (argv) => {
    const { calls, rec } = recorder();
    const out = await run(['connection-choices', 'set', ...argv, `--project=${PROJECT}`], {
      projects: { getDefault: rec('getDefault', { id: PROJECT }) },
      connectionChoices: { candidates: candidates(rec), set: rec('set', CHOICE) },
    });
    expect(out.exitCode).toBe(2);
    expect(calls).toEqual([]);
    if (argv.length !== 2 || argv[1] !== '--agent=') {
      expect(out.stderr).toContain(
        'A choice is for one agent or one flow: give --agent=<id> or --flow=<id>',
      );
    }
  });

  test('a name two apps have is refused, listing both; --app narrows it', async () => {
    const both = recorder();
    const out = await run(
      ['connection-choices', 'set', 'support', '--agent=acme.support', `--project=${PROJECT}`],
      { connectionChoices: { candidates: candidates(both.rec), set: both.rec('set', CHOICE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('"support" names 2 connections:');
    expect(out.stderr).toContain(
      `  support  help@acme.example at google, company  ${SUPPORT_ID}\n`,
    );
    expect(out.stderr).toContain(`  support  ops@acme.example at microsoft, company  ${OPS_ID}\n`);
    expect(out.stderr).toContain('--app=<app> narrows it; or pass the connection id.');
    expect(both.calls).toEqual([['candidates', { projectId: PROJECT }]]);

    const one = recorder();
    const narrowed = await run(
      [
        'connection-choices',
        'set',
        'support',
        '--agent=acme.support',
        '--app=microsoft',
        `--project=${PROJECT}`,
      ],
      {
        connectionChoices: {
          candidates: candidates(one.rec),
          list: one.rec('list', { data: [], hasMore: false }),
          set: one.rec('set', { ...CHOICE, app: 'microsoft', connectionId: OPS_ID }),
        },
      },
    );
    expect(narrowed.exitCode, narrowed.stderr).toBe(0);
    expect(one.calls[0]).toEqual(['candidates', { projectId: PROJECT, app: 'microsoft' }]);
    expect(one.calls.at(-1)).toEqual([
      'set',
      { projectId: PROJECT, agentId: 'acme.support', connectionId: OPS_ID },
    ]);
  });

  test("a name none has is refused, naming the project's company connections", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connection-choices', 'set', 'billing', '--agent=acme.support', `--project=${PROJECT}`],
      { connectionChoices: { candidates: candidates(rec), set: rec('set', CHOICE) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      `No connection is named "billing". This project's company connections: support, sales, support.`,
    );
    expect(calls.map(([name]) => name)).toEqual(['candidates']);
  });
});

describe('kindgi connection-choices list', () => {
  test('passes its filters; JSON is the wire page, without a candidates lookup', async () => {
    const { calls, rec } = recorder();
    const page = { data: [CHOICE], hasMore: false };
    const out = await run(
      [
        'connection-choices',
        'list',
        `--project=${PROJECT}`,
        '--agent=acme.support',
        '--app=google',
        '--include-removed',
        '--limit=5',
        '--cursor=c2',
      ],
      { connectionChoices: { list: rec('list', page), candidates: candidates(rec) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'list',
        {
          projectId: PROJECT,
          agentId: 'acme.support',
          app: 'google',
          includeRemoved: true,
          limit: 5,
          cursor: 'c2',
        },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual(page);
  });

  test('--table: AGENT/FLOW, APP, CONNECTION by name, CHOICE ID; REMOVED with --include-removed', async () => {
    const { calls, rec } = recorder();
    const gone = '3e4f5061-9999-4cad-8e2f-000000000009';
    const page = {
      data: [
        CHOICE,
        { ...EARLIER, agentId: undefined, flowId: 'acme.triage' },
        { ...CHOICE, choiceId: gone, connectionId: '00000000-0000-4000-8000-00000000000a' },
      ],
      hasMore: false,
    };
    const out = await run(['connection-choices', 'list', `--project=${PROJECT}`, '--table'], {
      connectionChoices: { list: rec('list', page), candidates: candidates(rec) },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { projectId: PROJECT }],
      ['candidates', { projectId: PROJECT }],
    ]);
    const [header, , ...rows] = out.stdout.split('\n');
    expect(header).toMatch(/^AGENT\/FLOW\s+APP\s+CONNECTION\s+CHOICE ID\s*$/);
    expect(rows[0]).toMatch(
      new RegExp(`^agent acme\\.support\\s+google\\s+support\\s+${CHOICE_ID}`),
    );
    expect(rows[1]).toMatch(new RegExp(`^flow acme\\.triage\\s+google\\s+sales\\s+${EARLIER_ID}`));
    // A connection that's no longer a candidate shows its id.
    expect(rows[2]).toContain('00000000-0000-4000-8000-00000000000a');

    const removedAt = '2026-10-28T03:00:00.000Z';
    const withRemoved = await run(
      ['connection-choices', 'list', `--project=${PROJECT}`, '--include-removed', '--table'],
      {
        connectionChoices: {
          list: async () => ({ data: [{ ...EARLIER, removedAt }], hasMore: false }),
          candidates: candidates(rec),
        },
      },
    );
    expect(withRemoved.stdout.split('\n')[0]).toMatch(/CHOICE ID\s+REMOVED\s*$/);
    expect(withRemoved.stdout).toContain(removedAt);
  });

  test('--table with no choices reads no candidates; a failed lookup shows ids', async () => {
    const { calls, rec } = recorder();
    const empty = await run(['connection-choices', 'list', `--project=${PROJECT}`, '--table'], {
      connectionChoices: {
        list: rec('list', { data: [], hasMore: false }),
        candidates: candidates(rec),
      },
    });
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(calls.map(([name]) => name)).toEqual(['list']);

    const refused = await run(['connection-choices', 'list', `--project=${PROJECT}`, '--table'], {
      connectionChoices: {
        list: async () => ({ data: [CHOICE], hasMore: false }),
        candidates: async () => {
          throw new Error('not allowed');
        },
      },
    });
    expect(refused.exitCode, refused.stderr).toBe(0);
    expect(refused.stdout).toContain(SUPPORT_ID);
  });
});

describe('kindgi connection-choices unset', () => {
  test('--yes removes it and says so; --json prints what the server answered', async () => {
    const { calls, rec } = recorder();
    const client = { connectionChoices: { remove: rec('remove', { deleted: true }) } };
    const out = await run(['connection-choices', 'unset', CHOICE_ID, '--yes'], client);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['remove', CHOICE_ID]]);
    expect(out.stdout).toBe(`Removed connection choice ${CHOICE_ID}.\n`);

    const json = await run(['connection-choices', 'unset', CHOICE_ID, '--yes', '--json'], client);
    expect(JSON.parse(json.stdout)).toEqual({ deleted: true });
  });

  test('without --yes and no terminal to ask on, nothing is removed', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-choices', 'unset', CHOICE_ID], {
      connectionChoices: { remove: rec('remove', { deleted: true }) },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      "kindgi connection-choices unset asks first, and there's no terminal to ask on. Run it with --yes.\n",
    );
    expect(calls).toEqual([]);
  });

  test('at a terminal it asks; a yes removes it, a no changes nothing', async () => {
    for (const answer of [true, false]) {
      const { calls, rec } = recorder();
      const asked: string[] = [];
      const out = await run(
        ['connection-choices', 'unset', CHOICE_ID],
        { connectionChoices: { remove: rec('remove', { deleted: true }) } },
        {
          interactive: () => true,
          confirm: async (question) => {
            asked.push(question);
            return answer;
          },
        },
      );
      expect(asked).toEqual([
        `Remove connection choice ${CHOICE_ID}? Its agent or flow then uses the project's only company connection at the app, or stops when there are several. [y/N] `,
      ]);
      if (answer) {
        expect(out.exitCode, out.stderr).toBe(0);
        expect(calls).toEqual([['remove', CHOICE_ID]]);
      } else {
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toBe('kindgi connection-choices unset: nothing changed.\n');
        expect(calls).toEqual([]);
      }
    }
  });

  test('a choice id is required', async () => {
    const { calls, rec } = recorder();
    const out = await run(['connection-choices', 'unset', '--yes'], {
      connectionChoices: { remove: rec('remove', { deleted: true }) },
    });
    expect(out.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });
});

test('help lists the group and its commands', async () => {
  const top = await run(['--help'], {});
  expect(top.stdout).toContain('connection-choices');
  const group = await run(['connection-choices', '--help'], {});
  expect(group.exitCode, group.stderr).toBe(0);
  for (const verb of ['set', 'list', 'unset']) expect(group.stdout).toContain(verb);
});
