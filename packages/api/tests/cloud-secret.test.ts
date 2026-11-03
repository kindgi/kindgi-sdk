// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { CLOUD_SECRET_FORM, parseCloudSecretVersion } from '@kindgi/types';

describe('parseCloudSecretVersion', () => {
  test.each([
    ['projects/acme-prod/secrets/stripe-key/versions/3', 'acme-prod', 'stripe-key', '3'],
    ['projects/123456789012/secrets/STRIPE_KEY/versions/12', '123456789012', 'STRIPE_KEY', '12'],
    ['projects/acme-p/secrets/a/versions/1', 'acme-p', 'a', '1'],
  ])('%s is a numbered version', (raw, project, secret, version) => {
    expect(parseCloudSecretVersion(raw)).toEqual({
      kind: 'ok',
      value: { project, secret, version },
    });
  });

  test.each([
    'projects/acme-prod/secrets/stripe-key/versions/latest',
    'projects/acme-prod/secrets/stripe-key/versions/prod-alias',
  ])('%s is refused: a version is a number, never latest or an alias', (raw) => {
    const r = parseCloudSecretVersion(raw);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.message).toContain('numbered version');
  });

  test.each([
    'projects/acme-prod/secrets/stripe-key/versions/0',
    'projects/acme-prod/secrets/stripe-key/versions/03',
    'projects/acme-prod/secrets/stripe-key',
    'projects/acme-prod/secrets/stripe-key/versions/3/',
    '/projects/acme-prod/secrets/stripe-key/versions/3',
    'projects/Acme-Prod/secrets/stripe-key/versions/3',
    'projects/acme/secrets/stripe-key/versions/3',
    'projects/acme-prod-/secrets/stripe-key/versions/3',
    'projects/0123/secrets/stripe-key/versions/3',
    'projects/acme-prod/secrets/stripe.key/versions/3',
    'projects/acme-prod/secrets/stripe-key/versions/3?x=1',
    'locations/us/secrets/stripe-key/versions/3',
    '',
  ])('%j is refused, and the message never quotes it', (raw) => {
    const r = parseCloudSecretVersion(raw);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.message).toContain(CLOUD_SECRET_FORM);
      if (raw.length > 0) expect(r.message).not.toContain(raw);
    }
  });

  test('a secret 256 long is refused, 255 is not', () => {
    const at = (n: number) => `projects/acme-prod/secrets/${'s'.repeat(n)}/versions/1`;
    expect(parseCloudSecretVersion(at(255)).kind).toBe('ok');
    expect(parseCloudSecretVersion(at(256)).kind).toBe('err');
  });

  test("a pack service's own copy (kp-) is never one", () => {
    const r = parseCloudSecretVersion('projects/acme-prod/secrets/kp-d123-stripe/versions/1');
    expect(r).toEqual({
      kind: 'err',
      message:
        "A cloud secret can't be one whose id starts with `kp-`: those are the pack services' own copies.",
    });
    // Only the prefix: an id that holds it later is a secret like any other.
    expect(parseCloudSecretVersion('projects/acme-prod/secrets/acme-kp-x/versions/1').kind).toBe(
      'ok',
    );
  });

  test.each([undefined, null, 3, { path: 'projects/a/secrets/b/versions/1' }])(
    '%j is refused: a cloud secret is a string',
    (raw) => {
      const r = parseCloudSecretVersion(raw);
      expect(r).toEqual({
        kind: 'err',
        message: `A cloud secret is a string: ${CLOUD_SECRET_FORM}.`,
      });
    },
  );
});
