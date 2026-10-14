// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { hostNamesPackService, packServiceName } from '../src/index.js';

describe('packServiceName', () => {
  // Computed independently: Python's base64.b32encode(sha256(f"{t}:{d}")), lowercased, unpadded, first 20.
  test.each([
    ['4fc847d5-95b4-4c68-bf9d-618a241c9771', 'dep-0001', 'kp-56x5ifwtzcwtqeieiokt'],
    [
      '00000000-0000-0000-0000-000000000001',
      'd1b8a6c0-2f3e-4f6b-9a1e-1c2d3e4f5a6b',
      'kp-3obuglpcxrixloovhbyi',
    ],
    ['a', 'b', 'kp-m6b2ghvl62gmybta7e24'],
    ['t-1', 'dep-1', 'kp-eslgokebn7iqldfhboiy'],
    ['t-1', 'dep-2', 'kp-6hqwa6lxclph5vfx2ls3'],
  ])('%s + %s → %s', (tenantId, deploymentId, expected) => {
    expect(packServiceName(tenantId, deploymentId)).toBe(expected);
  });

  test('a Cloud Run service name: 23 characters, lowercase letters, digits and hyphens, a letter first', () => {
    const name = packServiceName('t-1', 'dep-1');
    expect(name).toHaveLength(23);
    expect(name).toMatch(/^kp-[a-z2-7]{20}$/);
  });

  test('the tenant is part of it: the same deployment id in two tenants names two services', () => {
    expect(packServiceName('t-1', 'dep-1')).not.toBe(packServiceName('t-2', 'dep-1'));
    expect(packServiceName('t-1', 'dep-1')).not.toBe(packServiceName('dep-1', 't-1'));
  });
});

describe('hostNamesPackService', () => {
  const name = packServiceName('t-1', 'dep-1');

  test('the name, then `-` or `.`', () => {
    expect(hostNamesPackService(`${name}-123456789012.us-central1.run.app`, name)).toBe(true);
    expect(hostNamesPackService(`${name}.pack.internal`, name)).toBe(true);
    expect(hostNamesPackService(`${name.toUpperCase()}-1.us-central1.run.app`, name)).toBe(true);
  });

  test('a longer name, another name, or the name alone is refused', () => {
    expect(hostNamesPackService(`${name}x-123456789012.us-central1.run.app`, name)).toBe(false);
    expect(hostNamesPackService(`${packServiceName('t-2', 'dep-1')}-1.run.app`, name)).toBe(false);
    expect(hostNamesPackService(name, name)).toBe(false);
  });
});
