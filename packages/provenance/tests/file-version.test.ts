// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { fileVersionOf } from '../src/index.js';
import type { ProvenanceNode } from '../src/index.js';

const node = (attributes: Record<string, unknown> | undefined, kind = 'artifact') =>
  ({
    id: 'art-1',
    kind,
    timestamp: '2026-11-05T10:00:00.000Z',
    contentHash: 'a'.repeat(64),
    ...(attributes !== undefined && { attributes }),
  }) as ProvenanceNode;

describe("a file version's node", () => {
  test('an update names its file, its version, its name and the version it replaced', () => {
    expect(
      fileVersionOf(
        node({ fileId: 'f_7', fileVersion: 3, fileName: 'plan.txt', filePreviousVersion: 2 }),
      ),
    ).toEqual({ fileId: 'f_7', fileVersion: 3, fileName: 'plan.txt', filePreviousVersion: 2 });
  });

  test('a version given to the run, with no name: its file and version only', () => {
    expect(fileVersionOf(node({ fileId: 'f_7', fileVersion: 1, other: true }))).toEqual({
      fileId: 'f_7',
      fileVersion: 1,
    });
  });

  test('another kind of node, or one from before file versions: none', () => {
    expect(fileVersionOf(node({ fileId: 'f_7', fileVersion: 1 }, 'tool-result'))).toBeUndefined();
    expect(fileVersionOf(node(undefined))).toBeUndefined();
    expect(fileVersionOf(node({ name: 'plan.txt' }))).toBeUndefined();
  });

  test('a fileId or fileVersion not of its shape: none', () => {
    for (const attributes of [
      { fileId: '', fileVersion: 1 },
      { fileId: 7, fileVersion: 1 },
      { fileId: 'f_7', fileVersion: 0 },
      { fileId: 'f_7', fileVersion: 1.5 },
      { fileId: 'f_7', fileVersion: '2' },
      { fileId: 'f_7' },
    ]) {
      expect(fileVersionOf(node(attributes))).toBeUndefined();
    }
  });

  test('a name or replaced version not of its shape is left out', () => {
    expect(
      fileVersionOf(node({ fileId: 'f_7', fileVersion: 2, fileName: 9, filePreviousVersion: 2 })),
    ).toEqual({ fileId: 'f_7', fileVersion: 2 });
    expect(fileVersionOf(node({ fileId: 'f_7', fileVersion: 2, filePreviousVersion: 0 }))).toEqual({
      fileId: 'f_7',
      fileVersion: 2,
    });
  });
});
