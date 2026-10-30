// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { CorrectionMadeBy, CorrectionStatus } from '../src/correction-binding.js';
import { parseCorrectionLink, planChange, sortAtSave } from '../src/correction-sorting.js';

const ana: CorrectionMadeBy = { kind: 'user', id: 'u-ana' };
const at = '2026-10-30T10:00:00.000Z';

describe('sortAtSave', () => {
  test('wrong decisions go to the owner, whatever the answer', () => {
    expect(sortAtSave({ decisions: 'wrong', answer: 'wrong', expert: false }, ana, at)).toEqual({
      status: 'with-owner',
      sortedTo: 'owner',
      sorted: { by: { kind: 'rule' }, at },
    });
  });

  test('a wrong answer, or a wrong item of it, goes to Improve, open', () => {
    const toImprove = { status: 'open', sortedTo: 'improve', sorted: { by: { kind: 'rule' }, at } };
    expect(sortAtSave({ decisions: 'right', answer: 'wrong', expert: false }, ana, at)).toEqual(
      toImprove,
    );
    expect(
      sortAtSave(
        {
          answer: 'right',
          items: [
            { key: 'm1', verdict: 'right' },
            { key: 'm2', verdict: 'wrong' },
          ],
          expert: false,
        },
        ana,
        at,
      ),
    ).toEqual(toImprove);
  });

  test('nothing wrong is fixed, as recorded right, by its author', () => {
    expect(sortAtSave({ decisions: 'right', answer: 'right', expert: false }, ana, at)).toEqual({
      status: 'fixed',
      fixedIn: { how: 'recorded-right', by: ana, at },
    });
  });

  test("an end user's correction stays open and unsorted; an expert's on their behalf is sorted", () => {
    expect(
      sortAtSave({ decisions: 'wrong', participantId: 'cust-1', expert: false }, ana, at),
    ).toEqual({ status: 'open' });
    expect(
      sortAtSave({ answer: 'right', participantId: 'cust-1', expert: false }, ana, at),
    ).toEqual({ status: 'open' });
    expect(
      sortAtSave({ decisions: 'wrong', participantId: 'cust-1', expert: true }, ana, at).status,
    ).toBe('with-owner');
  });
});

describe('planChange (the change table)', () => {
  const from = (status: CorrectionStatus, sortedTo?: 'improve' | 'developer' | 'owner') => ({
    status,
    ...(sortedTo !== undefined && { sortedTo }),
  });
  const byAna = { by: { kind: 'user', id: 'u-ana' }, at };

  test('re-sorting to the owner sets with-owner; away from the owner sets open', () => {
    expect(planChange(from('open', 'improve'), { sortedTo: 'owner' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'owner', sorted: byAna, status: 'with-owner' },
    });
    expect(
      planChange(
        from('with-owner', 'owner'),
        { sortedTo: 'developer', reason: 'a code bug' },
        ana,
        at,
      ),
    ).toEqual({
      kind: 'ok',
      change: { sortedTo: 'developer', sorted: { ...byAna, reason: 'a code bug' }, status: 'open' },
    });
  });

  test('re-sorting keeps the status otherwise, and a correction being fixed elsewhere loses its link', () => {
    expect(planChange(from('open'), { sortedTo: 'improve' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'improve', sorted: byAna },
    });
    expect(planChange(from('being-fixed', 'improve'), { sortedTo: 'owner' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'owner', sorted: byAna, status: 'with-owner', link: null },
    });
    expect(planChange(from('being-fixed', 'improve'), { sortedTo: 'developer' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'developer', sorted: byAna },
    });
  });

  test("away from the owner is open, even while the owner's fix was under way", () => {
    expect(planChange(from('being-fixed', 'owner'), { sortedTo: 'developer' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'developer', sorted: byAna, status: 'open', link: null },
    });
  });

  test("a fixed, wont-fix or removed correction can't be re-sorted", () => {
    for (const status of ['fixed', 'wont-fix', 'removed'] as const) {
      expect(planChange(from(status, 'improve'), { sortedTo: 'developer' }, ana, at)).toEqual({
        kind: 'not-allowed',
        from: status,
        to: status,
      });
    }
  });

  test('being-fixed from open or with-owner, with a link', () => {
    const link = { kind: 'pull-request' as const, url: 'https://github.com/acme/app/pull/1' };
    for (const status of ['open', 'with-owner'] as const) {
      expect(planChange(from(status), { status: 'being-fixed', link }, ana, at)).toEqual({
        kind: 'ok',
        change: { status: 'being-fixed', link },
      });
    }
    expect(planChange(from('open'), { status: 'being-fixed' }, ana, at).kind).toBe('bad-input');
    expect(planChange(from('fixed'), { status: 'being-fixed', link }, ana, at)).toEqual({
      kind: 'not-allowed',
      from: 'fixed',
      to: 'being-fixed',
    });
  });

  test('a link goes only with being-fixed', () => {
    const link = { kind: 'improve-run' as const, id: 'ir-1' };
    expect(planChange(from('open'), { status: 'wont-fix', reason: 'x', link }, ana, at).kind).toBe(
      'bad-input',
    );
    expect(planChange(from('open'), { sortedTo: 'improve', link }, ana, at).kind).toBe('bad-input');
  });

  test('wont-fix from anything but removed, with a reason kept as the status note; a fixed one drops fixedIn', () => {
    for (const status of ['open', 'being-fixed', 'with-owner', 'fixed', 'wont-fix'] as const) {
      expect(
        planChange(from(status), { status: 'wont-fix', reason: 'by design' }, ana, at),
      ).toEqual({
        kind: 'ok',
        change: {
          status: 'wont-fix',
          link: null,
          statusNote: { text: 'by design', by: ana, at },
          ...(status === 'fixed' && { fixedIn: null }),
        },
      });
    }
    expect(planChange(from('open'), { status: 'wont-fix' }, ana, at).kind).toBe('bad-input');
    expect(planChange(from('removed'), { status: 'wont-fix', reason: 'x' }, ana, at)).toEqual({
      kind: 'not-allowed',
      from: 'removed',
      to: 'wont-fix',
    });
  });

  test('open again from being-fixed or wont-fix; the note says why, or is cleared', () => {
    expect(
      planChange(from('wont-fix'), { status: 'open', reason: 'it matters now' }, ana, at),
    ).toEqual({
      kind: 'ok',
      change: {
        status: 'open',
        link: null,
        statusNote: { text: 'it matters now', by: ana, at },
      },
    });
    expect(planChange(from('being-fixed'), { status: 'open' }, ana, at)).toEqual({
      kind: 'ok',
      change: { status: 'open', link: null, statusNote: null },
    });
    expect(planChange(from('fixed'), { status: 'open' }, ana, at).kind).toBe('not-allowed');
  });

  test('open again on one sorted to the owner is with-owner, as re-sorting to the owner is', () => {
    for (const status of ['being-fixed', 'wont-fix'] as const) {
      expect(planChange(from(status, 'owner'), { status: 'open' }, ana, at)).toEqual({
        kind: 'ok',
        change: { status: 'with-owner', link: null, statusNote: null },
      });
    }
  });

  test('fixed and removed are never set by hand, and an empty change is bad input', () => {
    expect(planChange(from('open'), { status: 'fixed' }, ana, at)).toEqual({
      kind: 'not-allowed',
      from: 'open',
      to: 'fixed',
    });
    expect(planChange(from('open'), { status: 'removed' }, ana, at).kind).toBe('not-allowed');
    expect(planChange(from('open'), {}, ana, at).kind).toBe('bad-input');
  });

  test("a status set by hand ends a test run's reopening; a re-sort alone keeps it", () => {
    const reopened = {
      ...from('open', 'improve'),
      reopenedIn: { version: '13', how: 'went-back' as const, by: ana, at },
    };
    const link = { kind: 'improve-run' as const, id: 'ir-2' };
    expect(planChange(reopened, { status: 'being-fixed', link }, ana, at)).toEqual({
      kind: 'ok',
      change: { status: 'being-fixed', link, reopenedIn: null },
    });
    expect(planChange(reopened, { status: 'wont-fix', reason: 'by design' }, ana, at)).toEqual({
      kind: 'ok',
      change: {
        status: 'wont-fix',
        link: null,
        statusNote: { text: 'by design', by: ana, at },
        reopenedIn: null,
      },
    });
    expect(planChange(reopened, { sortedTo: 'developer' }, ana, at)).toEqual({
      kind: 'ok',
      change: { sortedTo: 'developer', sorted: byAna },
    });
  });

  test('a re-sort and a status at once: the re-sort first, then the status from where it put it', () => {
    const link = { kind: 'suggested-change' as const, id: 'sc-9' };
    // with-owner -> (re-sort to improve) open -> being-fixed.
    expect(
      planChange(
        from('with-owner', 'owner'),
        { sortedTo: 'improve', status: 'being-fixed', link, reason: 'Improve can fix it' },
        ana,
        at,
      ),
    ).toEqual({
      kind: 'ok',
      change: { sortedTo: 'improve', sorted: byAna, status: 'being-fixed', link },
    });
  });
});

describe('parseCorrectionLink', () => {
  test('an Improve run, a suggested change, or a pull request URL; nothing else', () => {
    expect(parseCorrectionLink('ir-12')).toEqual({ kind: 'improve-run', id: 'ir-12' });
    expect(parseCorrectionLink('sc-3')).toEqual({ kind: 'suggested-change', id: 'sc-3' });
    expect(parseCorrectionLink('https://github.com/acme/app/pull/7')).toEqual({
      kind: 'pull-request',
      url: 'https://github.com/acme/app/pull/7',
    });
    expect(parseCorrectionLink('ftp://example.com/x')).toBeUndefined();
    expect(parseCorrectionLink('PR 7')).toBeUndefined();
  });
});
