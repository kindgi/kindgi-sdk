// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The deploy rule meets an expert's edit: when a deploy's definition and
 * pins match a version derived by an edit (`reason: 'edited'`), the
 * deploy reuses it and reports its own reason for not registering the
 * definition's version, not the edit's.
 */

import { describe, expect, test } from 'vitest';

import { type AgentPins, pinsDigest } from '@kindgi/agents';

import { type PinnedDefinition, deployVersion } from '../src/deploy-versions.js';

interface Def extends PinnedDefinition {
  readonly id: string;
  readonly name: string;
}

const before: AgentPins = { tools: {}, prompts: { 'acme.p': '1.0.0' }, settings: {} };
const after: AgentPins = { tools: {}, prompts: { 'acme.p': '1.1.0' }, settings: {} };
const definition: Def = { id: 'acme.intake', version: '1.0.0', name: 'Intake' };

describe('deployVersion reuses a version an edit derived', () => {
  test("reports the deploy's own reason (pins-changed), not 'edited'", async () => {
    const published: Def[] = [];
    const outcome = await deployVersion<Def>({
      label: 'agent "acme.intake"',
      definition,
      pins: after,
      pinsDigest: pinsDigest(after),
      existing: [
        { ...definition, pins: before, pinsDigest: pinsDigest(before) },
        {
          ...definition,
          version: '1.0.1',
          pins: after,
          pinsDigest: pinsDigest(after),
          derivedFrom: { version: '1.0.0', reason: 'edited', label: 'Tighter tone' },
        },
      ],
      publish: async (version) => {
        published.push(version);
        return 'ok';
      },
    });
    expect(outcome).toMatchObject({ kind: 'reused', version: '1.0.1', reason: 'pins-changed' });
    expect(published).toEqual([]);
  });
});

describe('deployVersion reads what the registry sets as no part of the definition', () => {
  test('a version read back with its project is unchanged', async () => {
    const published: Def[] = [];
    const outcome = await deployVersion<Def>({
      label: 'agent "acme.intake"',
      definition,
      pins: before,
      pinsDigest: pinsDigest(before),
      existing: [
        {
          ...definition,
          pins: before,
          pinsDigest: pinsDigest(before),
          projectId: '6f1c2d4e-0000-4000-8000-000000000001',
        },
      ],
      publish: async (version) => {
        published.push(version);
        return 'ok';
      },
    });
    expect(outcome).toEqual({ kind: 'unchanged', version: '1.0.0' });
    expect(published).toEqual([]);
  });
});
