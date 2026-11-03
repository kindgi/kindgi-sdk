// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';
import type { ProjectId, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { type CorrectionOutcomeChange, planRunOutcome } from '../src/index.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const ana = { kind: 'user', id: 'u-ana' } as const;
/** After every write in these tests: the store's clock starts 2026-10-01 and counts seconds. */
const endedAt = '2026-10-02T00:00:00.000Z';

function harness() {
  const store = inMemoryCorrections();
  const corrected = () =>
    store.record({
      tenantId,
      projectId,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: 'acme.desk', version: '1.2.0' },
        input: { ask: 'refund order 41?' },
        output: { text: 'Refunded.' },
      },
      madeBy: ana,
      status: 'open',
      answer: 'wrong',
      shouldSay: 'Final sale: no refund.',
    });
  const get = async (correctionId: string) => {
    const got = await store.get({ tenantId, correctionId });
    if (got === null) return null;
    const { run: _run, ...correction } = got;
    return correction;
  };
  /** What a run of `version` that passed (or failed) the correction's case does to it now. */
  const outcome = async (
    correctionId: string,
    version: string,
    passed: boolean,
  ): Promise<readonly CorrectionOutcomeChange[]> => {
    const now = await get(correctionId);
    return planRunOutcome({
      version,
      how: 'pin',
      follows: 'pin',
      by: ana,
      at: '2026-11-06T09:00:00.000Z',
      corrections: now === null ? [] : [now],
      passed: new Map([[correctionId, passed]]),
    }).changes;
  };
  return { store, corrected, get, outcome };
}

describe("the in-memory store's applyRunOutcome", () => {
  test('a reopen keeps fixedIn beside reopenedIn; passing again takes the new fixedIn and ends the reopening', async () => {
    const h = harness();
    const { id } = await h.corrected();
    const v13 = { version: '13', how: 'pin', by: ana, at: '2026-11-06T09:00:00.000Z' } as const;
    await h.store.applyRunOutcome({ tenantId, endedAt, changes: await h.outcome(id, '13', true) });
    expect(await h.get(id)).toMatchObject({ status: 'fixed', fixedIn: v13 });

    const later = '2026-10-03T00:00:00.000Z';
    await h.store.applyRunOutcome({
      tenantId,
      endedAt: later,
      changes: await h.outcome(id, '14', false),
    });
    expect(await h.get(id)).toMatchObject({
      status: 'open',
      fixedIn: v13,
      reopenedIn: { version: '14', how: 'pin', by: ana },
    });

    await h.store.applyRunOutcome({
      tenantId,
      endedAt: '2026-10-04T00:00:00.000Z',
      changes: await h.outcome(id, '15', true),
    });
    const again = await h.get(id);
    expect(again).toMatchObject({ status: 'fixed', fixedIn: { version: '15', how: 'pin' } });
    expect(again).not.toHaveProperty('reopenedIn');
  });

  test('a correction changed after the run ended keeps what it is', async () => {
    const h = harness();
    const { id } = await h.corrected();
    const changes = await h.outcome(id, '13', true);
    // A person starts fixing it after the run ended.
    await h.store.update({
      tenantId,
      correctionId: id,
      expected: { status: 'open', sortedTo: null },
      status: 'being-fixed',
      link: { kind: 'improve-run', id: 'ir-1' },
    });
    const before = await h.get(id);
    // After it was made (00:00:01), before the person's change (00:00:02).
    const ranEarlier = '2026-10-01T00:00:01.500Z';
    expect(await h.store.applyRunOutcome({ tenantId, endedAt: ranEarlier, changes })).toEqual([]);
    expect(await h.get(id)).toEqual(before);
  });

  test('the same outcome applied twice changes it once', async () => {
    const h = harness();
    const { id } = await h.corrected();
    const changes = await h.outcome(id, '13', true);
    // After it was made (00:00:01), before the first apply's own write (00:00:02).
    const ranAt = '2026-10-01T00:00:01.500Z';
    expect(await h.store.applyRunOutcome({ tenantId, endedAt: ranAt, changes })).toEqual([id]);
    const once = await h.get(id);
    expect(await h.store.applyRunOutcome({ tenantId, endedAt: ranAt, changes })).toEqual([]);
    expect(await h.get(id)).toEqual(once);
  });

  test('a removed correction, or one of another tenant, is left', async () => {
    const h = harness();
    const { id } = await h.corrected();
    const changes = await h.outcome(id, '13', true);
    expect(
      await h.store.applyRunOutcome({ tenantId: randomUUID() as TenantId, endedAt, changes }),
    ).toEqual([]);
    await h.store.unregister({ tenantId, correctionId: id });
    expect(await h.store.applyRunOutcome({ tenantId, endedAt, changes })).toEqual([]);
    expect(await h.get(id)).toMatchObject({ status: 'removed' });
  });
});
