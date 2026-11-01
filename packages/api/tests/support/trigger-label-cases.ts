// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

/**
 * A trigger's label, as the four trigger kinds take it: on create and on
 * update, a string that isn't blank, of at most 100 code points; `null`
 * clears it on update. A stored label sent back unchanged passes, and the
 * update leaves it out. Each kind's route test runs these cases with its
 * own harness.
 */

/** What a route answered: its status, the trigger's id when made, the refusal's message. */
export type LabelAnswer = {
  readonly status: number;
  readonly id?: string;
  readonly message?: string;
};

export type LabelHarness = {
  /** Make one, with `label` in the body unless it's `undefined`. */
  readonly create: (label?: unknown) => Promise<LabelAnswer>;
  /** Send an update with only `label`. */
  readonly update: (id: string, label: unknown) => Promise<LabelAnswer>;
  /** The label as stored, `null` for none. */
  readonly labelOf: (id: string) => Promise<string | null>;
  /** Store a label past the route, as one stored before the rule. */
  readonly store: (id: string, label: string) => Promise<void>;
  /** The updates the route sent its binding, newest last. */
  readonly sent: () => readonly Record<string, unknown>[];
  /** What a successful update answers. */
  readonly updated: number;
};

const REFUSED = '`label` must be a non-empty string of at most 100 characters';

/** One code point outside the Basic Multilingual Plane: two UTF-16 units. */
const ASTRAL = String.fromCodePoint(0x1f600);

export function describeTriggerLabel(what: string, make: () => LabelHarness): void {
  describe(`${what}: its label`, () => {
    const made = async (h: LabelHarness, label?: unknown): Promise<string> => {
      const res = await h.create(label);
      expect(res.status, res.message).toBe(201);
      if (res.id === undefined) throw new Error('no id');
      return res.id;
    };

    test.each([
      ['not a string', 5],
      ['empty', ''],
      ['blank', '   '],
      ['101 code points', 'x'.repeat(101)],
    ])('create refuses one that is %s', async (_what, label) => {
      const h = make();
      expect(await h.create(label)).toMatchObject({ status: 400, message: REFUSED });
    });

    test('create takes 100 code points outside the BMP, which is 200 UTF-16 units', async () => {
      const h = make();
      const id = await made(h, ASTRAL.repeat(100));
      expect(await h.labelOf(id)).toBe(ASTRAL.repeat(100));
    });

    test('create without one, or with null, makes it with none', async () => {
      const h = make();
      expect(await h.labelOf(await made(h))).toBeNull();
      expect(await h.labelOf(await made(h, null))).toBeNull();
    });

    test.each([
      ['not a string', 5],
      ['an object', {}],
      ['empty', ''],
      ['blank', '  '],
      ['101 code points', 'x'.repeat(101)],
    ])('update refuses one that is %s, and keeps the label', async (_what, label) => {
      const h = make();
      const id = await made(h, 'nightly');
      expect(await h.update(id, label)).toMatchObject({ status: 400, message: REFUSED });
      expect(await h.labelOf(id)).toBe('nightly');
    });

    test('update with null clears it, and a new one sets it', async () => {
      const h = make();
      const id = await made(h, 'nightly');
      expect((await h.update(id, null)).status).toBe(h.updated);
      expect(await h.labelOf(id)).toBeNull();
      expect((await h.update(id, 'weekly')).status).toBe(h.updated);
      expect(await h.labelOf(id)).toBe('weekly');
    });

    test('a stored label over the limit, sent back unchanged, passes and is left out', async () => {
      const h = make();
      const id = await made(h, 'nightly');
      const long = 'x'.repeat(101);
      await h.store(id, long);
      expect((await h.update(id, long)).status).toBe(h.updated);
      expect(h.sent().at(-1)).not.toHaveProperty('label');
      expect(await h.labelOf(id)).toBe(long);
    });
  });
}

/** A route's answer as a {@link LabelAnswer}: the id is the body's `idField`. */
export async function labelAnswer(res: Response, idField: string): Promise<LabelAnswer> {
  const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  const id = body[idField];
  const message = body.error?.message;
  return {
    status: res.status,
    ...(typeof id === 'string' && { id }),
    ...(message !== undefined && { message }),
  };
}
