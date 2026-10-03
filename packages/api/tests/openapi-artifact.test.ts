// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Freshness gate for the committed OpenAPI artifact. `openapi.json` ships
// with this package (`@kindgi/api/openapi.json`) and is the input to SDK
// codegen, so a stale file silently ships stale client types. Regenerate
// with `pnpm --filter @kindgi/api gen:openapi` and commit the result.

import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { generateOpenApiDocument } from '../src/index.js';

const STALE =
  'packages/api/openapi.json is stale — run `pnpm --filter @kindgi/api gen:openapi` and commit it';

describe('openapi.json artifact', () => {
  test('matches the generator output (content)', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
    );
    expect(committed, STALE).toEqual(generateOpenApiDocument());
  });

  test('matches the generator output (bytes — emitter formatting)', async () => {
    const committed = await readFile(new URL('../openapi.json', import.meta.url), 'utf8');
    const generated = `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
    expect(committed === generated, STALE).toBe(true);
  });
});
