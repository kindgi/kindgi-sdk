// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { planRefusedError, planRefusedMessage, planWarningField } from '../src/plan-limits.js';

/** What a `plan-limit-reached` says, and when an answer carries `planWarning`. */

const TAIL =
  'What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or renew the key on a larger plan.';

describe('planRefusedMessage', () => {
  test('one count over, with its numbers', () => {
    expect(
      planRefusedMessage(
        [{ limit: 'agents', adding: 2, numbers: { plan: 10, most: 12, inUse: 11 } }],
        {},
      ),
    ).toBe(
      `This adds 2 agents to production, and this runtime's license key runs at most 12: its plan's 10, and a margin. 11 run in production now. ${TAIL}`,
    );
  });

  test('one of each, said in the singular', () => {
    expect(
      planRefusedMessage(
        [{ limit: 'flows', adding: 1, numbers: { plan: 1, most: 2, inUse: 1 } }],
        {},
      ),
    ).toBe(
      `This adds 1 flow to production, and this runtime's license key runs at most 2: its plan's 1, and a margin. 1 runs in production now. ${TAIL}`,
    );
  });

  test('both counts over: both, flows first', () => {
    expect(
      planRefusedMessage(
        [
          { limit: 'flows', adding: 2, numbers: { plan: 3, most: 4, inUse: 4 } },
          { limit: 'agents', adding: 3, numbers: { plan: 10, most: 12, inUse: 11 } },
        ],
        {},
      ),
    ).toBe(
      `This adds 2 flows and 3 agents to production, and this runtime's license key runs at most 4 flows and 12 agents: its plan's 3 and 10, and a margin. 4 flows and 11 agents run in production now. ${TAIL}`,
    );
  });

  test('without the numbers: who to ask', () => {
    expect(
      planRefusedMessage(
        [
          { limit: 'flows', adding: 2 },
          { limit: 'agents', adding: 3 },
        ],
        {},
      ),
    ).toBe(
      "This adds 2 flows and 3 agents to production, past what this runtime's license key allows. Ask whoever runs this Kindgi for a larger plan. What runs keeps running.",
    );
  });

  test('with where a larger plan is', () => {
    expect(
      planRefusedMessage(
        [{ limit: 'agents', adding: 1, numbers: { plan: 3, most: 4, inUse: 4 } }],
        { next: 'https://example.com/plans' },
      ),
    ).toBe(
      "This adds 1 agent to production, and this runtime's license key runs at most 4: its plan's 3, and a margin. 4 run in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or get a larger plan: https://example.com/plans.",
    );
    expect(
      planRefusedMessage([{ limit: 'agents', adding: 1 }], { next: 'https://example.com/plans' }),
    ).toBe(
      "This adds 1 agent to production, past what this runtime's license key allows. For a larger plan: https://example.com/plans. What runs keeps running.",
    );
  });

  test('putting a project in production', () => {
    expect(
      planRefusedMessage(
        [{ limit: 'agents', adding: 2, numbers: { plan: 10, most: 12, inUse: 11 } }],
        { goingLive: true },
      ),
    ).toBe(
      `Putting this project in production adds 2 agents, and this runtime's license key runs at most 12: its plan's 10, and a margin. 11 run in production now. ${TAIL}`,
    );
  });

  test('never says to retire a deployment', () => {
    const words = [
      planRefusedMessage(
        [{ limit: 'agents', adding: 1, numbers: { plan: 1, most: 2, inUse: 2 } }],
        {},
      ),
      planRefusedMessage([{ limit: 'agents', adding: 1 }], {}),
    ];
    for (const said of words) expect(said).not.toMatch(/retire/i);
  });
});

describe("planRefusedMessage, on a workspace's own limits", () => {
  const TENANT_TAIL =
    'What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or ask whoever runs this Kindgi for a larger limit.';

  test('one count over: the workspace, its limit and a margin, never a key or a plan name', () => {
    const said = planRefusedMessage(
      [{ limit: 'agents', adding: 2, scope: 'tenant', numbers: { plan: 10, most: 12, inUse: 11 } }],
      {},
    );
    expect(said).toBe(
      `This adds 2 agents to production, and this workspace runs at most 12: its limit of 10, and a margin. 11 run in production now. ${TENANT_TAIL}`,
    );
    expect(said).not.toMatch(/license key|renew|Free|Starter|Business/);
  });

  test('both counts over: its limits, flows first', () => {
    expect(
      planRefusedMessage(
        [
          { limit: 'flows', adding: 1, scope: 'tenant', numbers: { plan: 3, most: 4, inUse: 4 } },
          {
            limit: 'agents',
            adding: 3,
            scope: 'tenant',
            numbers: { plan: 10, most: 12, inUse: 11 },
          },
        ],
        {},
      ),
    ).toBe(
      `This adds 1 flow and 3 agents to production, and this workspace runs at most 4 flows and 12 agents: its limits of 3 and 10, and a margin. 4 flows and 11 agents run in production now. ${TENANT_TAIL}`,
    );
  });

  test('with where a larger plan is', () => {
    expect(
      planRefusedMessage(
        [{ limit: 'flows', adding: 2, scope: 'tenant', numbers: { plan: 1, most: 2, inUse: 1 } }],
        { next: 'https://example.com/plans', goingLive: true },
      ),
    ).toBe(
      'Putting this project in production adds 2 flows, and this workspace runs at most 2: its limit of 1, and a margin. 1 runs in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or move to a larger plan: https://example.com/plans.',
    );
  });

  test("one count over the workspace's limit and the other over the key's: a sentence each", () => {
    const tenantFlows = {
      limit: 'flows',
      adding: 1,
      scope: 'tenant',
      numbers: { plan: 3, most: 4, inUse: 4 },
    } as const;
    expect(
      planRefusedMessage(
        [tenantFlows, { limit: 'agents', adding: 1, numbers: { plan: 10, most: 12, inUse: 12 } }],
        {},
      ),
    ).toBe(
      "This adds 1 flow and 1 agent to production. This workspace runs at most 4 flows: its limit of 3, and a margin. 4 flows run in production now. This runtime's license key runs at most 12 agents: its plan's 10, and a margin. 12 agents run in production now. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or renew the key on a larger plan, and ask whoever runs this Kindgi for a larger limit.",
    );
    // The key's numbers count other tenants too: the workspace's are still given.
    expect(
      planRefusedMessage([tenantFlows, { limit: 'agents', adding: 2, scope: 'installation' }], {}),
    ).toBe(
      "This adds 1 flow and 2 agents to production. This workspace runs at most 4 flows: its limit of 3, and a margin. 4 flows run in production now. For agents, that's past what this runtime's license key allows. What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or ask whoever runs this Kindgi for a larger limit and plan.",
    );
  });
});

describe('planRefusedError', () => {
  test("names whose numbers each count passed, when the binding says; the first is the top level's", () => {
    const error = planRefusedError(
      undefined,
      {
        kind: 'refused',
        over: [
          { limit: 'flows', adding: 1, scope: 'tenant', numbers: { plan: 3, most: 4, inUse: 4 } },
          { limit: 'agents', adding: 2, scope: 'installation' },
        ],
        newIds: { flows: ['f-new'], agents: ['a-1', 'a-2'] },
      },
      {},
    );
    expect(error).toMatchObject({
      limit: 'flows',
      scope: 'tenant',
      plan: 3,
      over: [
        { limit: 'flows', adding: 1, scope: 'tenant', plan: 3, most: 4, inUse: 4 },
        { limit: 'agents', adding: 2, scope: 'installation' },
      ],
    });
    const unsaid = planRefusedError(
      undefined,
      {
        kind: 'refused',
        over: [{ limit: 'agents', adding: 1 }],
        newIds: { flows: [], agents: ['a'] },
      },
      {},
    );
    expect(unsaid).not.toHaveProperty('scope');
    expect(unsaid.over).toEqual([{ limit: 'agents', adding: 1 }]);
  });
});

describe('planWarningField', () => {
  test('a count at its plan is carried', () => {
    expect(planWarningField({ agents: { plan: 10, most: 12, inUse: 10 } })).toEqual({
      planWarning: { agents: { plan: 10, most: 12, inUse: 10 } },
    });
  });

  test('no warning, or an empty one, carries nothing: never {}', () => {
    expect(planWarningField(undefined)).toEqual({});
    expect(planWarningField({})).toEqual({});
  });
});
