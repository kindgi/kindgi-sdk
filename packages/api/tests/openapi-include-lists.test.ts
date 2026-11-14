// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A list of extras is `include`: an array, sent as one comma-separated key
 * (`style: form`, `explode: false`), the form every server reads. A client
 * generated from the spec sends `include=output,waitingFor`, which an older
 * runtime reads too; repeated keys would lose all but the first there.
 */

import { describe, expect, test } from 'vitest';

import { generateOpenApiDocument } from '../src/index.js';

interface ParameterDoc {
  readonly name: string;
  readonly in: string;
  readonly schema: { readonly type?: string; readonly items?: { readonly enum?: unknown } };
  readonly style?: string;
  readonly explode?: boolean;
}

function queryParams(): { readonly where: string; readonly param: ParameterDoc }[] {
  const doc = generateOpenApiDocument() as {
    paths: Record<string, Record<string, { operationId: string; parameters?: ParameterDoc[] }>>;
  };
  const found: { where: string; param: ParameterDoc }[] = [];
  for (const methods of Object.values(doc.paths)) {
    for (const op of Object.values(methods)) {
      for (const param of op.parameters ?? []) {
        if (param.in === 'query') found.push({ where: `${op.operationId} ${param.name}`, param });
      }
    }
  }
  return found;
}

describe('OpenAPI include lists', () => {
  test('every `include` is an array of known values, one comma-separated key', () => {
    const includes = queryParams().filter(({ param }) => param.name === 'include');
    expect(includes.map(({ where }) => where).sort()).toEqual([
      'agents.testSet.listCases include',
      'cost.records.get include',
      'cost.records.list include',
      'identity.users.list include',
      'runs.list include',
    ]);
    for (const { where, param } of includes) {
      expect(param.schema.type, where).toBe('array');
      expect(Array.isArray(param.schema.items?.enum), `${where}: items without an enum`).toBe(true);
      expect(param.style, where).toBe('form');
      expect(param.explode, where).toBe(false);
    }
  });

  test('style and explode are set only on arrays, and explode false only with form', () => {
    for (const { where, param } of queryParams()) {
      if (param.style !== undefined || param.explode !== undefined) {
        expect(param.schema.type, `${where}: style or explode on a non-array`).toBe('array');
      }
      if (param.explode === false) expect(param.style, where).toBe('form');
    }
  });
});
