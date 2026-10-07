// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import addFormats from 'ajv-formats';
import Ajv from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';

import { SPECS_SCHEMAS_DIR } from '../src/index.js';

/** The agent spec's retrieval intents: facts need types; conversations have none and their own scopes. */
describe('agent.schema.json RetrievalIntent', () => {
  const schema = JSON.parse(readFileSync(join(SPECS_SCHEMAS_DIR, 'agent.schema.json'), 'utf8'));
  const AjvCtor = Ajv as unknown as typeof Ajv.default;
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  ajv.addSchema(schema);
  const valid = ajv.compile({ $ref: `${schema.$id}#/$defs/RetrievalIntent` });

  test.each([
    { types: ['acme.note'], scope: 'tenant' },
    { source: 'facts', types: ['acme.note'], scope: 'same-user', mode: 'both' },
    { source: 'conversations', scope: 'same-user' },
    { source: 'conversations', scope: 'same-segment', mode: 'keyword', limit: 5 },
  ])('valid: %j', (intent) => {
    expect(valid(intent)).toBe(true);
  });

  test.each([
    { scope: 'tenant' },
    { types: ['acme.note'], scope: 'same-segment' },
    { source: 'conversations', types: ['acme.note'], scope: 'same-user' },
    { source: 'conversations', scope: 'tenant' },
    { source: 'files', scope: 'same-user' },
  ])('invalid: %j', (intent) => {
    expect(valid(intent)).toBe(false);
  });
});
