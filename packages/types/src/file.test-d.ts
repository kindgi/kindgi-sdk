// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, test } from 'vitest';
import { type FileNotShownReason, type FileValue, isFileValue } from './file.js';

describe('FileValue', () => {
  test('isFileValue narrows an unknown value', () => {
    function inspect(value: unknown): void {
      if (isFileValue(value)) {
        expectTypeOf(value).toEqualTypeOf<FileValue>();
        expectTypeOf(value.artifactId).toEqualTypeOf<string>();
        expectTypeOf(value.notShown).toEqualTypeOf<FileNotShownReason | undefined>();
      }
    }
    inspect({});
  });

  test("a file value needs its type mark and a file's required fields", () => {
    const fields = { artifactId: 'a', contentType: 'image/png', size: 1, sha256: 'x' };
    // @ts-expect-error — missing the 'kindgi.file' type mark.
    const _noType: FileValue = fields;
    // @ts-expect-error — 'type' must be 'kindgi.file'.
    const _otherType: FileValue = { ...fields, type: 'file' };
    // @ts-expect-error — missing sha256.
    const _noHash: FileValue = {
      type: 'kindgi.file',
      artifactId: 'a',
      contentType: 'image/png',
      size: 1,
    };
  });

  test('a reason not shown is one of the listed reasons', () => {
    expectTypeOf<'gone'>().toExtend<FileNotShownReason>();
    expectTypeOf<'refused'>().toExtend<FileNotShownReason>();
    // @ts-expect-error — not a listed reason.
    const _hidden: FileNotShownReason = 'hidden';
  });
});
