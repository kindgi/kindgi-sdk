// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `KINDGI_ATTACH_ROUTE_HOSTS`: the hosts a project's attach route may be
 * on. Parsed by the pack endpoint hosts' rules, through the same parser,
 * with every error naming this variable, never the other.
 */

import { describe, expect, test } from 'vitest';

import {
  ATTACH_ROUTE_HOSTS_VAR,
  KINDGI_ENV_SCHEMA,
  packEndpointHostAllowed,
  parseAttachRouteHosts,
  parsePackEndpointHosts,
} from '../src/index.js';

describe('KINDGI_ATTACH_ROUTE_HOSTS', () => {
  test('unset or blank: none, so every attach is refused', () => {
    expect(parseAttachRouteHosts(undefined)).toEqual([]);
    expect(parseAttachRouteHosts('  ')).toEqual([]);
    expect(packEndpointHostAllowed('attach.example.com', parseAttachRouteHosts(''))).toBe(false);
  });

  test("takes each of the pack endpoint hosts' forms, as that list parses them", () => {
    const raw = 'attach.example.com, *.attach.internal, *-123456789012.us-central1.run.app';
    const hosts = parseAttachRouteHosts(raw);
    expect(hosts).toEqual([
      { kind: 'exact', host: 'attach.example.com' },
      { kind: 'suffix', suffix: 'attach.internal' },
      { kind: 'tail', tail: '123456789012', domain: 'us-central1.run.app' },
    ]);
    expect(hosts).toEqual(parsePackEndpointHosts(raw));
    expect(packEndpointHostAllowed('attach.example.com', hosts)).toBe(true);
    expect(packEndpointHostAllowed('a.attach.internal', hosts)).toBe(true);
    expect(packEndpointHostAllowed('gw-123456789012.us-central1.run.app', hosts)).toBe(true);
    expect(packEndpointHostAllowed('gw-999999999999.us-central1.run.app', hosts)).toBe(false);
    expect(packEndpointHostAllowed('x.attach.example.com', hosts)).toBe(false);
  });

  test.each([
    ['*.run.app', 'refuses "*.run.app": run.app is Cloud Run\'s shared domain'],
    ['*-uc.a.run.app', 'refuses "*-uc.a.run.app": run.app is Cloud Run\'s shared domain'],
    ['https://attach.example.com', 'takes host names'],
    ['*-.attach.internal', 'takes host names'],
  ])('refuses %j at startup, naming this variable', (raw, words) => {
    expect(() => parseAttachRouteHosts(raw)).toThrow(`KINDGI_ATTACH_ROUTE_HOSTS ${words}`);
    let message = '';
    try {
      parseAttachRouteHosts(raw);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('KINDGI_PACK_ENDPOINT_HOSTS');
  });

  test("the pack endpoint hosts' errors still name their own variable", () => {
    expect(() => parsePackEndpointHosts('*.run.app')).toThrow(
      'KINDGI_PACK_ENDPOINT_HOSTS refuses "*.run.app"',
    );
    expect(() => parsePackEndpointHosts('*-.attach.internal')).toThrow(
      'KINDGI_PACK_ENDPOINT_HOSTS takes host names',
    );
  });

  test("is a server's optional variable in the schema, under the pack service's group", () => {
    expect(ATTACH_ROUTE_HOSTS_VAR).toBe('KINDGI_ATTACH_ROUTE_HOSTS');
    const spec = KINDGI_ENV_SCHEMA.find((v) => v.name === ATTACH_ROUTE_HOSTS_VAR);
    expect(spec).toMatchObject({ required: false, group: 'pack-service' });
    expect(spec?.appliesTo({})).toBe(true);
    expect(spec?.appliesTo({ component: 'server' })).toBe(true);
    expect(spec?.appliesTo({ component: 'pack-service' })).toBe(false);
    expect(spec?.description).toContain('`attach-route-host-not-allowed`');
    expect(spec?.description).toContain('`system:attaches`');
  });
});
