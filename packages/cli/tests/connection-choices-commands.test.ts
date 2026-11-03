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

/** The caller's own connections a choice may name, with `--mine`. */
const WORK_ID = '4a5b6c7d-aaaa-4b8c-9d0e-00000000000b';
const SCHOOL_ID = '5b6c7d8e-bbbb-4c9d-8e1f-00000000000c';
const OWN = [
  {
    connectionId: WORK_ID,
    name: 'work',
    app: 'google',
    accountLabel: 'ana@acme.example',
    state: 'working',
    main: true,
  },
  {
    connectionId: SCHOOL_ID,
    name: 'school',
    app: 'google',
    accountLabel: 'ana@school.acme.example',
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
/** A tool's set of the company's connections, sales its default. */
const SET_ID = '7a8b9cad-cccc-4dae-8f20-00000000000d';
const TOOL_SET = {
  ...CHOICE,
  choiceId: SET_ID,
  toolId: 'acme.mail',
  need: 'inbox',
  connectionId: SALES_ID,
  connectionIds: [SUPPORT_ID, SALES_ID],
  version: 1,
};
/** The caller's own choice, of their work connection. */
const OWN_CHOICE_ID = '8b9cadbe-dddd-4ebf-9031-00000000000e';
const OWN_CHOICE = {
  ...CHOICE,
  choiceId: OWN_CHOICE_ID,
  connectionId: WORK_ID,
  person: { userId: 'user-ana' },
  version: 1,
};

/** `whoami` as the server answers it for a person's token. */
const ANA = { tenantId: 't-1', scopes: [], userId: 'user-ana' };

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

/**
 * `candidates` as the server answers it: only what its `app` filter keeps; with
 * `owner=me`, your own.
 */
function candidates(rec: ReturnType<typeof recorder>['rec']) {
  return async (input: { readonly app?: string; readonly owner?: string }) => {
    const all: readonly { readonly app: string }[] = input.owner === 'me' ? OWN : CANDIDATES;
    const kept = all.filter((c) => input.app === undefined || c.app === input.app);
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

  test("several connections make a tool's set, --default its default; the agent's choice stays", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-choices',
        'set',
        'support',
        'sales',
        '--agent=acme.support',
        '--tool=acme.mail',
        '--need=inbox',
        '--default=sales',
        '--app=google',
        `--project=${PROJECT}`,
      ],
      {
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', { data: [CHOICE], hasMore: false }),
          set: rec('set', TOOL_SET),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['candidates', { projectId: PROJECT, app: 'google' }],
      ['list', { projectId: PROJECT, agentId: 'acme.support', toolId: 'acme.mail' }],
      [
        'set',
        {
          projectId: PROJECT,
          agentId: 'acme.support',
          toolId: 'acme.mail',
          need: 'inbox',
          connectionId: SALES_ID,
          connectionIds: [SUPPORT_ID, SALES_ID],
        },
      ],
    ]);
    expect(out.stderr).toBe(
      `Chose support and sales at google for tool acme.mail (inbox) of agent acme.support, sales by default (choice ${SET_ID}).\n`,
    );

    const again = await run(
      [
        'connection-choices',
        'set',
        SUPPORT_ID,
        SALES_ID,
        '--agent=acme.support',
        '--tool=acme.mail',
        `--default=${SALES_ID}`,
        `--project=${PROJECT}`,
      ],
      {
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', { data: [CHOICE, TOOL_SET], hasMore: false }),
          set: rec('set', TOOL_SET),
        },
      },
    );
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stderr).toBe(
      `tool acme.mail (inbox) of agent acme.support already uses support and sales at google, sales by default (choice ${SET_ID}): nothing changed.\n`,
    );
  });

  test('--mine: a choice of your own connections, for your own runs, in place of your own only', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-choices',
        'set',
        'work',
        '--agent=acme.support',
        '--mine',
        `--project=${PROJECT}`,
      ],
      {
        identity: { whoami: rec('whoami', ANA) },
        connectionChoices: {
          candidates: candidates(rec),
          list: rec('list', {
            data: [CHOICE, { ...OWN_CHOICE, choiceId: EARLIER_ID, connectionId: SCHOOL_ID }],
            hasMore: false,
          }),
          set: rec('set', OWN_CHOICE),
        },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['whoami'],
      ['candidates', { projectId: PROJECT, owner: 'me' }],
      ['list', { projectId: PROJECT, agentId: 'acme.support', owner: 'me' }],
      [
        'set',
        {
          projectId: PROJECT,
          agentId: 'acme.support',
          connectionId: WORK_ID,
          person: { userId: 'user-ana' },
        },
      ],
    ]);
    expect(out.stderr).toBe(
      `Chose your work at google for agent acme.support (choice ${OWN_CHOICE_ID}), in place of school (choice ${EARLIER_ID}).\n`,
    );
  });

  test("--mine: a name that isn't one of your own is refused, naming yours", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      ['connection-choices', 'set', 'support', '--agent=acme.support', '--mine'],
      {
        projects: { getDefault: rec('getDefault', { id: PROJECT }) },
        identity: { whoami: rec('whoami', ANA) },
        connectionChoices: { candidates: candidates(rec), set: rec('set', OWN_CHOICE) },
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      'No connection is named "support". Your own connections: work, school.',
    );
    expect(calls.map(([name]) => name)).toEqual(['getDefault', 'whoami', 'candidates']);
  });

  test('--mine with a token that acts as no person is refused before the candidates', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-choices',
        'set',
        'work',
        '--agent=acme.support',
        '--mine',
        `--project=${PROJECT}`,
      ],
      {
        identity: { whoami: rec('whoami', { tenantId: 't-1', scopes: [] }) },
        connectionChoices: { candidates: candidates(rec), set: rec('set', OWN_CHOICE) },
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(
      '--mine is a choice of your own, and this token acts as no person',
    );
    expect(calls).toEqual([['whoami']]);
  });

  test.each([
    [
      ['support', 'sales', '--agent=acme.support', '--default=sales'],
      'A set of connections is for one tool: give --tool=<tool-id>',
    ],
    [
      ['support', 'sales', '--agent=acme.support', '--tool=acme.mail'],
      'A set takes --default=<connection>, one of the set, which a call that names none uses',
    ],
    [
      ['support', '--agent=acme.support', '--default=support'],
      "--default is a set's: name two or more connections",
    ],
    [
      ['support', '--agent=acme.support', '--need=inbox'],
      "--need is a tool's: give --tool=<tool-id>",
    ],
  ] as const)('%j is refused before any call', async (argv, said) => {
    const { calls, rec } = recorder();
    const out = await run(['connection-choices', 'set', ...argv, `--project=${PROJECT}`], {
      connectionChoices: { candidates: candidates(rec), set: rec('set', TOOL_SET) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });

  test("a --default that isn't one of the set is refused before the set", async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'connection-choices',
        'set',
        SUPPORT_ID,
        SALES_ID,
        '--agent=acme.support',
        '--tool=acme.mail',
        `--default=${OPS_ID}`,
        `--project=${PROJECT}`,
      ],
      { connectionChoices: { candidates: candidates(rec), set: rec('set', TOOL_SET) } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--default must be one of the set's connections");
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

  test('--table: AGENT/FLOW, TOOL, NEED, APP, CONNECTIONS by name, CHOICE ID; REMOVED with --include-removed', async () => {
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
    expect(header).toMatch(/^AGENT\/FLOW\s+TOOL\s+NEED\s+APP\s+CONNECTIONS\s+CHOICE ID\s*$/);
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

  test("--tool and --mine ask for one tool's choices and your own only", async () => {
    const { calls, rec } = recorder();
    const page = { data: [OWN_CHOICE], hasMore: false };
    const out = await run(
      ['connection-choices', 'list', `--project=${PROJECT}`, '--tool=acme.mail', '--mine'],
      { connectionChoices: { list: rec('list', page), candidates: candidates(rec) } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['list', { projectId: PROJECT, toolId: 'acme.mail', owner: 'me' }]]);
    expect(JSON.parse(out.stdout)).toEqual(page);
  });

  test("--table: a set's default is marked, your own named, another person's only counted", async () => {
    const { calls, rec } = recorder();
    const THEIRS_ID = '9cadbecf-eeee-4fc0-8142-00000000000f';
    const theirs = {
      ...TOOL_SET,
      choiceId: THEIRS_ID,
      connectionId: '00000000-0000-4000-8000-000000000011',
      connectionIds: [
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000012',
        '00000000-0000-4000-8000-000000000013',
      ],
      person: { userId: 'user-bo' },
    };
    const out = await run(['connection-choices', 'list', `--project=${PROJECT}`, '--table'], {
      identity: { whoami: rec('whoami', ANA) },
      connectionChoices: {
        list: rec('list', { data: [CHOICE, TOOL_SET, OWN_CHOICE, theirs], hasMore: false }),
        candidates: candidates(rec),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['list', { projectId: PROJECT }],
      ['whoami'],
      ['candidates', { projectId: PROJECT }],
      ['candidates', { projectId: PROJECT, owner: 'me' }],
    ]);
    const [, , ...rows] = out.stdout.split('\n');
    expect(rows[0]).toMatch(
      new RegExp(`^agent acme\\.support\\s+google\\s+support\\s+${CHOICE_ID}`),
    );
    expect(rows[1]).toMatch(
      new RegExp(
        `^agent acme\\.support\\s+acme\\.mail\\s+inbox\\s+google\\s+support, sales \\(default\\)\\s+${SET_ID}`,
      ),
    );
    expect(rows[2]).toMatch(
      new RegExp(`^agent acme\\.support\\s+google\\s+work\\s+${OWN_CHOICE_ID}`),
    );
    expect(rows[3]).toMatch(
      new RegExp(
        `^agent acme\\.support\\s+acme\\.mail\\s+inbox\\s+google\\s+3 connections\\s+${THEIRS_ID}`,
      ),
    );
    expect(out.stdout).not.toContain('00000000-0000-4000-8000-00000000001');
  });

  test("--table: a person's choice is counted when who you are can't be read; --mine names yours", async () => {
    const { calls, rec } = recorder();
    const unread = await run(['connection-choices', 'list', `--project=${PROJECT}`, '--table'], {
      identity: {
        whoami: async () => {
          throw new Error('not allowed');
        },
      },
      connectionChoices: {
        list: rec('list', { data: [OWN_CHOICE], hasMore: false }),
        candidates: candidates(rec),
      },
    });
    expect(unread.exitCode, unread.stderr).toBe(0);
    expect(unread.stdout).toMatch(/\s1 connection\s/);
    expect(unread.stdout).not.toContain(WORK_ID);
    expect(calls.map(([name]) => name)).toEqual(['list']);

    const mine = recorder();
    const listed = await run(
      ['connection-choices', 'list', `--project=${PROJECT}`, '--mine', '--table'],
      {
        connectionChoices: {
          list: mine.rec('list', { data: [OWN_CHOICE], hasMore: false }),
          candidates: candidates(mine.rec),
        },
      },
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(mine.calls).toEqual([
      ['list', { projectId: PROJECT, owner: 'me' }],
      ['candidates', { projectId: PROJECT, owner: 'me' }],
    ]);
    expect(listed.stdout).toMatch(/\swork\s/);
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
        `Remove connection choice ${CHOICE_ID}? A tool's choice gives way to its agent's or flow's. An agent's or flow's gives way to the project's only company connection at the app, or stops when there are several; your own gives way to your main connection, else your only one. [y/N] `,
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

  test("a tool's choice and your own are removed by their id, as any other", async () => {
    for (const choiceId of [SET_ID, OWN_CHOICE_ID]) {
      const { calls, rec } = recorder();
      const out = await run(['connection-choices', 'unset', choiceId, '--yes'], {
        connectionChoices: { remove: rec('remove', { deleted: true }) },
      });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(calls).toEqual([['remove', choiceId]]);
      expect(out.stdout).toBe(`Removed connection choice ${choiceId}.\n`);
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
