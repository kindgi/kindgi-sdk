// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `deploy/runs-check.ts`: what a deploy asks about its blocks against
 * what runs (`POST /v1/deployments/check`), over the real client, and the
 * lines it prints from the answer.
 */

import { type DeployCheckStop, createClient } from '@kindgi/client';
import { describe, expect, test } from 'vitest';

import {
  checkRuns,
  passedLines,
  replaceFlagsProblem,
  replaceOf,
  runsCheckInputOf,
  stoppedText,
} from '../src/deploy/runs-check.js';

const API = 'https://api.example.com';
const SUPPORT = '0b3f6a9e-7c1d-4e2a-9b8f-1a2b3c4d5e6f';
const SANDBOX = '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const INPUT = {
  packId: 'returns-helper',
  agents: ['returns-helper.agent'],
  blocks: [{ id: 'returns-helper.tone', version: '3.0.0' }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wireError(status: number, code: string, details?: unknown): Response {
  return json(status, {
    error: {
      code,
      message: `${code} said`,
      ...(details !== undefined && { details }),
      requestId: 'req-1',
    },
  });
}

/** A client whose runtime answers `check` (and each project's name); the bodies sent are kept. */
function runtime(check: () => Response, names: Record<string, string> = {}) {
  const sent: unknown[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u === `${API}/v1/deployments/check`) {
      sent.push(JSON.parse(String(init?.body)));
      return check();
    }
    const id = /\/v1\/projects\/([^/?]+)$/.exec(u)?.[1];
    const name = id !== undefined ? names[id] : undefined;
    if (name !== undefined) return json(200, { id, name, slug: name.toLowerCase() });
    return wireError(404, 'not-found');
  }) as typeof fetch;
  const client = createClient({
    apiUrl: API,
    auth: { kind: 'apiToken', token: 'kgi-test' },
    fetch: fetchImpl,
  });
  return { client, sent };
}

const LATEST_STOP: DeployCheckStop = {
  blockId: 'returns-helper.tone',
  inFiles: '3.0.0',
  runs: {
    version: '4.0.0',
    projectId: SANDBOX,
    follows: 'latest',
    by: { kind: 'user', id: 'usr-ana', name: 'Ana' },
    at: '2026-11-05T09:12:00.000Z',
  },
  pr: { url: 'https://github.com/acme/returns/pull/214' },
};

describe('the check against what runs, asked', () => {
  test("sends the pack's agents and blocks, the project, and each --replace with the reason", async () => {
    const { client, sent } = runtime(() =>
      json(200, {
        replaced: [{ blockId: 'returns-helper.tone', from: '4.0.0', to: '3.0.0' }],
        notNeeded: ['returns-helper.rules'],
      }),
    );
    const check = await checkRuns(client, INPUT, {
      projectId: SUPPORT,
      replace: { blocks: ['returns-helper.tone', 'returns-helper.rules'], reason: 'v4 was a try' },
    });
    expect(sent).toEqual([
      {
        projectId: SUPPORT,
        agents: ['returns-helper.agent'],
        blocks: [{ id: 'returns-helper.tone', version: '3.0.0' }],
        replace: [
          { blockId: 'returns-helper.tone', reason: 'v4 was a try' },
          { blockId: 'returns-helper.rules', reason: 'v4 was a try' },
        ],
      },
    ]);
    expect(check).toEqual({
      kind: 'passed',
      replaced: [{ blockId: 'returns-helper.tone', from: '4.0.0', to: '3.0.0' }],
      notNeeded: ['returns-helper.rules'],
    });
  });

  test('a 409 deploy-would-put-back-older-blocks is a stop, each block from details.blocks', async () => {
    const { client } = runtime(() =>
      wireError(409, 'deploy-would-put-back-older-blocks', { blocks: [LATEST_STOP] }),
    );
    expect(await checkRuns(client, INPUT, {})).toEqual({ kind: 'stopped', stops: [LATEST_STOP] });
  });

  test("a runtime before the check (404) or one that doesn't read pins and Latest (501) leaves it unchecked", async () => {
    for (const answer of [
      () => wireError(404, 'not-found'),
      () => wireError(501, 'runs-in-unsupported'),
    ]) {
      const { client } = runtime(answer);
      expect(await checkRuns(client, INPUT, {})).toEqual({ kind: 'unchecked', why: 'unsupported' });
    }
  });

  test('a key the check refuses (403) leaves it unchecked, on a runtime before the check or with it', async () => {
    // Before the check, the deployments router asks admin on the tenant for the path.
    for (const code of ['permission-denied', 'forbidden-by-a-newer-server']) {
      const { client } = runtime(() => wireError(403, code));
      expect(await checkRuns(client, INPUT, {})).toEqual({ kind: 'unchecked', why: 'forbidden' });
    }
  });

  test('any other answer, or no answer, fails the check, saying why', async () => {
    const { client } = runtime(() => wireError(400, 'bad-input'));
    expect(await checkRuns(client, INPUT, {})).toEqual({
      kind: 'failed',
      message: 'bad-input: bad-input said',
    });
    const down = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 'kgi-test' },
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const failed = await checkRuns(down, INPUT, {});
    expect(failed.kind).toBe('failed');
  });
});

describe('the lines the check prints', () => {
  test('a stop: each block, what runs, where, by whom and when; what keeps it; the command that drops it', async () => {
    const { client } = runtime(() => json(200, {}), {
      [SANDBOX]: 'Support sandbox',
      [SUPPORT]: 'Support',
    });
    const stops: DeployCheckStop[] = [
      LATEST_STOP,
      {
        blockId: 'returns-helper.refund-rules',
        inFiles: '1.0.0',
        runs: {
          version: '2.0.0',
          projectId: SUPPORT,
          follows: 'pin',
          segment: [{ key: 'region', value: 'eu' }],
          by: { kind: 'service', id: 'svc-ci' },
          at: '2026-11-03T16:40:00.000Z',
        },
        pr: { url: 'https://github.com/acme/returns/pull/214' },
      },
      { blockId: 'returns-helper.faq', inFiles: '1.0.0', runs: { version: '1.1.0' } },
    ];
    const text = await stoppedText(client, stops, {
      what: 'deploy',
      ours: 'your files',
      nothingDone: 'Nothing was deployed.',
      keep: 'run `kindgi blocks pull`, then deploy again',
      command: 'kindgi deploy --env=prod',
    });
    expect(text).toBe(
      [
        '✗ Stopped: this deploy would put back older blocks than run now.',
        '',
        '  Block                         In your files   Runs now',
        '  returns-helper.tone           3.0.0           4.0.0  latest in Support sandbox (Ana, 11-05)',
        '  returns-helper.refund-rules   1.0.0           2.0.0  pinned for region=eu in Support by svc-ci, 11-03',
        "  returns-helper.faq            1.0.0           1.1.0  in a project you can't read",
        '',
        '  Nothing was deployed.',
        '  To keep the newer versions:  merge https://github.com/acme/returns/pull/214, or run `kindgi blocks pull`, then deploy again.',
        '  To drop them on purpose:  kindgi deploy --env=prod --replace=returns-helper.tone --replace=returns-helper.refund-rules --replace=returns-helper.faq --reason=<why>',
        '',
      ].join('\n'),
    );
  });

  test("a project whose name can't be read is named by its id; a Latest without who or when names neither", async () => {
    const { client } = runtime(() => json(200, {}));
    const text = await stoppedText(
      client,
      [
        {
          blockId: 'returns-helper.tone',
          inFiles: '3.0.0',
          runs: { version: '4.0.0', projectId: SANDBOX, follows: 'latest' },
        },
      ],
      {
        what: 'deploy',
        ours: 'your files',
        nothingDone: 'Nothing was deployed.',
        keep: 'run `kindgi blocks pull`, then deploy again',
        command: 'kindgi deploy --env=staging',
      },
    );
    expect(text).toContain(`4.0.0  latest in ${SANDBOX}\n`);
    expect(text).toContain(
      '  To keep the newer versions:  run `kindgi blocks pull`, then deploy again.\n',
    );
  });

  test('a pass: each block put back on purpose, each --replace not needed; else that nothing is older', () => {
    expect(
      passedLines({
        kind: 'passed',
        replaced: [{ blockId: 'returns-helper.tone', from: '4.0.0', to: '3.0.0' }],
        notNeeded: ['returns-helper.rules'],
      }),
    ).toEqual([
      '  returns-helper.tone: 4.0.0 runs now, 3.0.0 in your files; put back on purpose (--replace)',
      '  returns-helper.rules: nothing newer runs; --replace not needed',
    ]);
    expect(passedLines({ kind: 'passed', replaced: [], notNeeded: [] })).toEqual([
      '  ✓ No block in your files is older than what runs.',
    ]);
  });
});

describe('what the check is asked from', () => {
  test("an index's agents and blocks, at their versions; anything else in it is left out", () => {
    expect(
      runsCheckInputOf({
        packId: 'returns-helper',
        agents: [{ id: 'returns-helper.agent', model: {} }, { name: 'no id' }],
        blocks: [
          {
            id: 'returns-helper.tone',
            version: '3.0.0',
            kind: 'prompt',
            content: { template: 'Hi.' },
            modulePath: 'blocks/tone.json',
          },
        ],
        tools: [{ id: 'returns-helper.echo' }],
      }),
    ).toEqual(INPUT);
    expect(runsCheckInputOf({})).toEqual({ packId: undefined, agents: [], blocks: [] });
  });

  test('--replace needs --reason, and --reason goes with --replace', () => {
    expect(replaceFlagsProblem({ blocks: ['tone'], reason: undefined })).toBe(
      '--replace puts back an older version on purpose: say why with --reason=<text>',
    );
    expect(replaceFlagsProblem({ blocks: [], reason: 'why' })).toBe(
      '--reason says why --replace puts a block back: it goes with --replace=<block>',
    );
    expect(replaceFlagsProblem({ blocks: ['tone'], reason: 'why' })).toBeUndefined();
    expect(replaceFlagsProblem({ blocks: [], reason: undefined })).toBeUndefined();
    expect(replaceOf({ blocks: [], reason: undefined })).toBeUndefined();
  });
});
