// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { SLUG, SLUG_RULE } from '@kindgi/types';

/**
 * Names, labels, titles and slugs, as the routes take them. Create and update
 * check a field with the same call. An update has one exception, for a value
 * stored before its rule applied: see {@link patchedField}.
 */

/** The longest name a project, an org, a team or a workspace takes. */
export const NAME_MAX = 100;

/** The longest label an API key, a system key or a trigger takes. */
export const LABEL_MAX = 100;

/** The longest title a conversation takes. */
export const TITLE_MAX = 200;

/** A field as checked: its value, or why it's refused. */
export type Checked<T> =
  | { readonly value: T; readonly problem?: undefined }
  | { readonly problem: string };

/**
 * Whether `text` holds at most `max` code points, as JSON Schema's `maxLength`
 * counts them: a character outside the Basic Multilingual Plane is one, not two.
 */
export function atMostCodePoints(text: string, max: number): boolean {
  // A code point is one or two UTF-16 units, so `max` units or fewer always fit.
  if (text.length <= max) return true;
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
    if (count > max) return false;
  }
  return true;
}

/**
 * A name, a label or a title: a string that isn't blank once trimmed, of at
 * most `max` code points. It's kept as sent, untrimmed.
 */
export function boundedText(raw: unknown, field: string, max: number): Checked<string> {
  if (typeof raw !== 'string' || raw.trim() === '' || !atMostCodePoints(raw, max)) {
    return { problem: `\`${field}\` must be a non-empty string of at most ${max} characters` };
  }
  return { value: raw };
}

/**
 * A trigger's label: `null` is no label (an update's way to clear one), and
 * anything else is checked as {@link boundedText}, at most {@link LABEL_MAX}.
 */
export function labelOrNull(raw: unknown, field = 'label'): Checked<string | null> {
  if (raw === null) return { value: null };
  return boundedText(raw, field, LABEL_MAX);
}

/** An org's, a project's or a team's slug, by `@kindgi/types`' {@link SLUG}. */
export function slugText(raw: unknown, field = 'slug'): Checked<string> {
  if (typeof raw !== 'string' || !SLUG.test(raw)) {
    return { problem: `\`${field}\` must be ${SLUG_RULE}` };
  }
  return { value: raw };
}

/** What an update does with one field it was sent. */
export type PatchedField<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'write'; readonly value: T }
  | { readonly kind: 'refused'; readonly problem: string };

/**
 * A field an update was sent, checked as create checks it, with one exception.
 * A value that fails but equals the stored one exactly is `kept`: it passes,
 * and the update leaves it out. So a value stored before its rule applied can
 * be sent back unchanged, and isn't written again, which could undo a change
 * that landed in between. `stored` is called only for a value that fails.
 */
export async function patchedField<T>(
  raw: unknown,
  check: (raw: unknown) => Checked<T>,
  stored: () => Promise<unknown>,
): Promise<PatchedField<T>> {
  if (raw === undefined) return { kind: 'absent' };
  const checked = check(raw);
  if (checked.problem === undefined) return { kind: 'write', value: checked.value };
  return (await stored()) === raw
    ? { kind: 'kept' }
    : { kind: 'refused', problem: checked.problem };
}

/** `read`, made at most once, on first use. */
export function once<T>(read: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => {
    made ??= read();
    return made;
  };
}
