// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ScopeSegment } from '@kindgi/types';

/** A segment key: lowercase, like an identifier (`company`, `contact-role`). */
const SEGMENT_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_SEGMENTS = 8;
const MAX_VALUE_LENGTH = 256;

type Parsed =
  | { readonly kind: 'ok'; readonly segments?: readonly ScopeSegment[] }
  | { readonly kind: 'err'; readonly message: string };

function checked(segments: readonly ScopeSegment[], field: string): Parsed {
  if (segments.length === 0) return { kind: 'ok' };
  if (segments.length > MAX_SEGMENTS) {
    return { kind: 'err', message: `\`${field}\` takes at most ${MAX_SEGMENTS} segments` };
  }
  const seen = new Set<string>();
  for (const { key, value } of segments) {
    if (!SEGMENT_KEY_RE.test(key)) {
      return {
        kind: 'err',
        message: `\`${field}\`: a segment key is lowercase letters, digits, - and _ (starting with a letter); got "${key}"`,
      };
    }
    if (seen.has(key))
      return { kind: 'err', message: `\`${field}\`: the key "${key}" appears twice` };
    seen.add(key);
    if (value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      return {
        kind: 'err',
        message: `\`${field}\`: a segment value is 1–${MAX_VALUE_LENGTH} characters (key "${key}")`,
      };
    }
  }
  return { kind: 'ok', segments };
}

/**
 * A run's or a pin's segment path from a JSON body: an ordered list of
 * `{key, value}`, coarse to fine (e.g. `company` then `role`).
 */
export function parseSegmentsBody(raw: unknown, field = 'segments'): Parsed {
  if (raw === undefined) return { kind: 'ok' };
  if (!Array.isArray(raw)) {
    return {
      kind: 'err',
      message: `\`${field}\` must be an array of {key, value}, coarse to fine`,
    };
  }
  const segments: ScopeSegment[] = [];
  for (const item of raw) {
    const { key, value } = (item ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { kind: 'err', message: `\`${field}\`: each segment is {key: string, value: string}` };
    }
    segments.push({ key, value });
  }
  return checked(segments, field);
}

/** The same from a query: repeated `segment=key:value`, in order. */
export function parseSegmentsQuery(values: readonly string[]): Parsed {
  const segments: ScopeSegment[] = [];
  for (const raw of values) {
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      return { kind: 'err', message: `\`segment\` is key:value; got "${raw}"` };
    }
    segments.push({ key: raw.slice(0, colon), value: raw.slice(colon + 1) });
  }
  return checked(segments, 'segment');
}
