// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deploy` names every agent and flow the runtime registered under
 * another version than its definition's: which version runs, why, and the
 * version to set in the code so the two don't drift apart.
 */

import { describe, expect, test } from 'vitest';

import { versionLines } from '../src/deploy/response.js';

describe('versionLines', () => {
  test('one line per agent registered under another version; none for the rest', () => {
    expect(
      versionLines('agent', [
        { id: 'acme.intake', version: '2.0.0' },
        {
          id: 'acme.matcher',
          version: '1.4.1',
          authoredVersion: '1.4.0',
          reason: 'pins-changed',
          newVersion: true,
          pinChanges: [
            { kind: 'tool', id: 'acme.score', from: '1.0.0', to: '1.1.0' },
            { kind: 'tool', id: 'acme.rank', to: '0.2.0' },
          ],
        },
        {
          id: 'acme.router',
          version: '0.3.1',
          authoredVersion: '0.3.0',
          reason: 'unpinned',
          newVersion: true,
        },
        {
          id: 'acme.drafter',
          version: '1.4.2',
          authoredVersion: '1.4.1',
          reason: 'version-taken',
          newVersion: true,
        },
        {
          id: 'acme.summary',
          version: '3.0.1',
          authoredVersion: '3.0.0',
          reason: 'pins-changed',
          newVersion: false,
        },
      ]),
    ).toEqual([
      "agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0, tool acme.rank none → 0.2.0); set version: '1.4.1' in acme.matcher to match",
      "agent acme.router: registered new version 0.3.1 (0.3.0 was published before pins; 0.3.1 pins its tools); set version: '0.3.1' in acme.router to match",
      "agent acme.drafter: registered new version 1.4.2 (1.4.1 is taken by a different definition); set version: '1.4.2' in acme.drafter to match",
      "agent acme.summary: 3.0.0 runs as 3.0.1, registered by an earlier deploy (3.0.0's pins changed); set version: '3.0.1' in acme.summary to match",
    ]);
  });

  test("a flow's line names the agent pin that changed", () => {
    expect(
      versionLines('flow', [
        {
          id: 'acme.review',
          version: '2.0.1',
          authoredVersion: '2.0.0',
          reason: 'pins-changed',
          newVersion: true,
          pinChanges: [{ kind: 'agent', id: 'acme.matcher', from: '1.4.0', to: '1.4.1' }],
        },
      ]),
    ).toEqual([
      "flow acme.review: registered new version 2.0.1 (2.0.0's pins changed: agent acme.matcher 1.4.0 → 1.4.1); set version: '2.0.1' in acme.review to match",
    ]);
  });
});
