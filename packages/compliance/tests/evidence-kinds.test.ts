// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';

import { EVIDENCE_KINDS } from '../src/index.js';

describe('EVIDENCE_KINDS drift', () => {
  test('matches the built-in kinds listed in @kindgi/specs/compliance-evidence.schema.json', async () => {
    const schema = JSON.parse(
      await readFile(
        createRequire(import.meta.url).resolve('@kindgi/specs/compliance-evidence.schema.json'),
        'utf-8',
      ),
    ) as { properties: { kind: { examples: string[] } } };
    expect([...EVIDENCE_KINDS]).toEqual(schema.properties.kind.examples);
  });
});
