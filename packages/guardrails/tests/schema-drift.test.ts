// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

describe('bundled schema drift', () => {
  test('src/guardrail.schema.json matches the canonical @kindgi/specs/guardrail.schema.json', async () => {
    // The package bundles a copy of the canonical schema for offline
    // validation; the two must never diverge.
    const bundled = await readFile(
      new URL('../src/guardrail.schema.json', import.meta.url),
      'utf-8',
    );
    const canonical = await readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/guardrail.schema.json'),
      'utf-8',
    );
    expect(JSON.parse(bundled)).toEqual(JSON.parse(canonical));
  });
});
