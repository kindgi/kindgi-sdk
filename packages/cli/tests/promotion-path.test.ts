// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { promotionHint, promotionPath } from '../src/deploy/promotion-path.js';

const STAGING = '11111111-1111-4111-8111-111111111111';
const QA = '22222222-2222-4222-8222-222222222222';
const PROD = '33333333-3333-4333-8333-333333333333';
const projects = [
  { id: STAGING, name: 'Staging', slug: 'acme-staging' },
  { id: QA, name: 'QA', slug: 'acme-qa' },
  { id: PROD, name: 'Prod', slug: 'acme-prod' },
];
const order = {
  entries: [
    { position: 0, projectId: STAGING },
    { position: 1, projectId: QA },
    { position: 2, projectId: PROD },
  ],
};
const environments = [
  { name: 'staging', ref: 'acme-staging' },
  { name: 'qa', ref: 'acme-qa' },
  { name: 'prod', ref: PROD },
];

describe('promotionPath', () => {
  test("each environment from the order's first to the refused one, by its pack-config name", () => {
    expect(
      promotionPath({
        firstProjectId: STAGING,
        position: 1,
        orders: [{ entries: [{ position: 0, projectId: 'other' }] }, order],
        projects,
        environments,
      }),
    ).toEqual([
      { kind: 'env', name: 'staging' },
      { kind: 'env', name: 'qa' },
    ]);
  });

  test("a project the config doesn't name goes by its name; one the caller can't read is hidden", () => {
    expect(
      promotionPath({
        firstProjectId: STAGING,
        position: 2,
        orders: [
          {
            entries: [
              { position: 2, projectId: PROD },
              { position: 0, projectId: STAGING },
              { position: 1 },
            ],
          },
        ],
        projects,
        environments: [
          { name: 'staging', ref: 'acme-staging' },
          // Two environments naming one project: the first names it.
          { name: 'staging-copy', ref: STAGING },
        ],
      }),
    ).toEqual([
      { kind: 'env', name: 'staging' },
      { kind: 'hidden' },
      { kind: 'project', name: 'Prod' },
    ]);
  });

  test('a slug two projects share names neither', () => {
    const shared = [
      { id: STAGING, name: 'Staging', slug: 'shop', orgId: 'org-a' },
      { id: QA, name: 'QA', slug: 'shop', orgId: 'org-b' },
    ];
    expect(
      promotionPath({
        firstProjectId: STAGING,
        position: 1,
        orders: [order],
        projects: shared,
        environments: [{ name: 'staging', ref: 'shop' }],
      }),
    ).toEqual([
      { kind: 'project', name: 'Staging' },
      { kind: 'project', name: 'QA' },
    ]);
  });

  test('none when no listed order starts at the first environment, or it has nothing at the position', () => {
    const input = { firstProjectId: STAGING, projects, environments };
    expect(promotionPath({ ...input, position: 1, orders: [] })).toBeUndefined();
    expect(
      promotionPath({
        ...input,
        position: 1,
        orders: [
          {
            entries: [
              { position: 0, projectId: QA },
              { position: 1, projectId: STAGING },
            ],
          },
        ],
      }),
    ).toBeUndefined();
    expect(promotionPath({ ...input, position: 3, orders: [order] })).toBeUndefined();
    expect(promotionPath({ ...input, position: 2, orders: [order] })).toHaveLength(3);
  });
});

describe('promotionHint', () => {
  test('names the first environment and the refused one, and a promote per step', () => {
    expect(
      promotionHint([
        { kind: 'env', name: 'staging' },
        { kind: 'env', name: 'qa' },
        { kind: 'env', name: 'prod' },
      ]),
    ).toEqual({
      text: 'Builds reach prod only by promotion from the environment before it. A build enters its environment order at staging, the first environment: deploy there, then promote the build one environment at a time.',
      commands: ['kindgi promote --from=staging --to=qa', 'kindgi promote --from=qa --to=prod'],
    });
  });

  test('a project the config names no environment for: a placeholder, and how to add one', () => {
    expect(
      promotionHint([
        { kind: 'env', name: 'staging' },
        { kind: 'project', name: 'QA' },
        { kind: 'hidden' },
      ]),
    ).toEqual({
      text: "Builds reach a project you can't read only by promotion from the environment before it. A build enters its environment order at staging, the first environment: deploy there, then promote the build one environment at a time. Your pack config names no environment for project QA: add one, with its `project`, to promote through it. `kindgi environments list` shows the order, as far as you can read it.",
      commands: [
        'kindgi promote --from=staging --to=<the environment for project QA>',
        'kindgi promote --from=<the environment for project QA> --to=<the next environment>',
      ],
    });
    expect(
      promotionHint([
        { kind: 'project', name: 'Staging' },
        { kind: 'project', name: 'Prod' },
      ]).text,
    ).toContain(
      'at project Staging, the first environment: deploy there, then promote the build one environment at a time. Your pack config names no environment for projects Staging, Prod:',
    );
  });

  test('without a path, or with only one environment on it: the rule, and where the order is', () => {
    const rule = promotionHint(undefined);
    expect(rule.commands).toEqual([]);
    expect(rule.text).toContain('`kindgi environments list` shows the order.');
    expect(promotionHint([{ kind: 'env', name: 'staging' }])).toEqual(rule);
    expect(promotionHint([])).toEqual(rule);
  });
});
