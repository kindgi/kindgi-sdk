// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

describe('bundled schema drift', () => {
  test('src/provenance.schema.json matches the canonical @kindgi/specs/provenance.schema.json', async () => {
    // The package bundles a copy of the canonical schema for offline
    // validation; the two must never diverge.
    const bundled = await readFile(
      new URL('../src/provenance.schema.json', import.meta.url),
      'utf-8',
    );
    const canonical = await readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/provenance.schema.json'),
      'utf-8',
    );
    expect(JSON.parse(bundled)).toEqual(JSON.parse(canonical));
  });
});
