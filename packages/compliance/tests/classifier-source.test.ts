// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A classifier file's retention, as written: `days` (with `onDenyDays`), or
// `kept: true` and no days. The `@ts-expect-error` lines are checked by the
// package's typecheck (`tsc --noEmit` covers tests/), not by vitest: if the
// type ever takes one of them, the typecheck fails on the unused directive.

import { describe, expect, test } from 'vitest';

import type {
  Classification,
  ClassificationSource,
  ComplianceClassifierSource,
} from '../src/index.js';

describe('ClassificationSource', () => {
  test('a kind gives days or kept, never both or neither', () => {
    const kept = { retention: { kept: true }, signed: true, exportable: true } as const;
    const held = {
      retention: { kept: true, legalHold: true },
      signed: true,
      exportable: true,
    } as const;
    const days = {
      retention: { days: 90, onDenyDays: 365 },
      signed: false,
      exportable: true,
    } as const;
    const file: ComplianceClassifierSource = {
      version: 1,
      default: days,
      byKind: { 'hitl-decision': kept, 'secret-set': held, 'secret-rotated': 'secret-set' },
    };
    expect(file.byKind['hitl-decision']).toEqual({
      retention: { kept: true },
      signed: true,
      exportable: true,
    });

    const refused: ClassificationSource[] = [
      // @ts-expect-error kept and days: a file gives one or the other
      { retention: { kept: true, days: 90 }, signed: true, exportable: true },
      // @ts-expect-error a kept kind has no denials kept apart
      { retention: { kept: true, onDenyDays: 365 }, signed: true, exportable: true },
      // @ts-expect-error neither days nor kept
      { retention: {}, signed: true, exportable: true },
      // @ts-expect-error kept is true or absent
      { retention: { kept: false }, signed: true, exportable: true },
    ];
    expect(refused).toHaveLength(4);
  });

  test('a Classification without kept is already a ClassificationSource', () => {
    const resolved: Classification = {
      retention: { days: 730, legalHold: true },
      signed: true,
      exportable: false,
    };
    const entry: ClassificationSource = resolved;
    expect(entry).toBe(resolved);
  });
});
