// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/agents/{agentId}/release-gate` answers `400` without a
 * `scopeKind` (agent-pin-gate-routes.test.ts), so its spec says the
 * parameter is required, and a client generated from it asks for one. The
 * lists that take the same parameter as a filter keep it optional.
 */

import { describe, expect, test } from 'vitest';

import { generateOpenApiDocument } from '../src/index.js';

type Parameter = { readonly name: string; readonly in: string; readonly required?: boolean };
type Operation = { readonly parameters?: readonly Parameter[] };

const paths = generateOpenApiDocument().paths as Record<string, Record<string, Operation>>;

function scopeKindOn(path: string): Parameter | undefined {
  return paths[path]?.get?.parameters?.find((p) => p.in === 'query' && p.name === 'scopeKind');
}

describe('scopeKind', () => {
  test('is required to resolve the release gate for a scope', () => {
    expect(scopeKindOn('/v1/agents/{agentId}/release-gate')?.required).toBe(true);
  });

  test.each(['/v1/release-gates', '/v1/agents/{agentId}/pin-history'])(
    'stays an optional filter on %s',
    (path) => {
      expect(scopeKindOn(path)?.required).toBe(false);
    },
  );
});
