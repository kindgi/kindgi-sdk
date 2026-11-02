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
import type { AgentVersionRecord } from '../src/index.js';

interface Def extends PinnedDefinition {
  readonly id: string;
  readonly name: string;
}

/** A version as a registry reads it back: with what it was made for, who made it Latest, and the agent's owner. */
type Read = Def & Pick<AgentVersionRecord, 'madeFor' | 'latestAt' | 'latestBy' | 'owner'>;

/** What the runtime's registry adds to a version it reads. */
const asRead = {
  projectId: '6f1c2d4e-0000-4000-8000-000000000001',
  madeInProjectId: '6f1c2d4e-0000-4000-8000-000000000001',
  madeFor: 'latest',
  latestAt: '2026-10-30T09:00:00.000Z',
  latestBy: { kind: 'user', id: 'usr-ana' },
  owner: { userId: 'usr-ana', setAt: '2026-10-30T09:00:00.000Z' },
} as unknown as Omit<Read, keyof Def>;

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

  test('a version read back with what it was made for, who made it Latest and its owner is unchanged', async () => {
    const published: Read[] = [];
    const outcome = await deployVersion<Read>({
      label: 'agent "acme.intake"',
      definition,
      pins: before,
      pinsDigest: pinsDigest(before),
      existing: [{ ...definition, pins: before, pinsDigest: pinsDigest(before), ...asRead }],
      publish: async (version) => {
        published.push(version);
        return 'ok';
      },
    });
    expect(outcome).toEqual({ kind: 'unchanged', version: '1.0.0' });
    expect(published).toEqual([]);
  });

  test('an earlier version read back the same way is reused', async () => {
    const published: Read[] = [];
    const outcome = await deployVersion<Read>({
      label: 'agent "acme.intake"',
      definition,
      pins: after,
      pinsDigest: pinsDigest(after),
      existing: [
        { ...definition, pins: before, pinsDigest: pinsDigest(before), ...asRead },
        {
          ...definition,
          version: '1.0.1',
          pins: after,
          pinsDigest: pinsDigest(after),
          derivedFrom: { version: '1.0.0', reason: 'pins-changed' },
          ...asRead,
          madeFor: 'project',
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
