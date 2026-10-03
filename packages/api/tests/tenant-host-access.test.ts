// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  TENANT_HOST_ACCESS_LEVELS,
  deniesHostReach,
  parseTenantHostAccess,
  stdioRefusal,
} from '../src/index.js';

describe('tenant host access', () => {
  test("deployed denies running a command, the metadata network and the server's own host; local allows all", () => {
    for (const reach of ['exec', 'metadata-network', 'loopback'] as const) {
      expect(deniesHostReach('deployed', reach)).toBe(true);
      expect(deniesHostReach('local', reach)).toBe(false);
    }
  });

  test('only the levels parse', () => {
    expect(TENANT_HOST_ACCESS_LEVELS).toEqual(['local', 'deployed']);
    for (const level of TENANT_HOST_ACCESS_LEVELS) expect(parseTenantHostAccess(level)).toBe(level);
    for (const other of ['', 'Deployed', 'hosted', 'none']) {
      expect(parseTenantHostAccess(other)).toBeUndefined();
    }
  });

  test('the stdio refusal names the endpoint, the setting and the way out', () => {
    expect(stdioRefusal('acme.docs')).toMatch(
      /^MCP endpoint "acme\.docs" uses the stdio transport.*KINDGI_TENANT_HOST_ACCESS=deployed.*streamable-http/,
    );
  });
});
