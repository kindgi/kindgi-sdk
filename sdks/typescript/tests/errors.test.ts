// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { fromWire } from '../src/errors.js';

describe('fromWire — guardrail-violation', () => {
  it('hydrates the violations the server sends under details', () => {
    const err = fromWire({
      code: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii': Response contains an email",
      details: {
        violations: [
          {
            guardrailId: 'no-pii',
            result: { passed: false, reason: 'Response contains an email' },
            action: 'halt',
            severity: 'error',
            at: '2026-09-30T00:00:00.000Z',
          },
        ],
        evaluationErrors: [{ guardrailId: 'tone', message: 'check tone-v2 not registered' }],
      },
      requestId: 'req_1',
    });
    expect(err).toEqual({
      code: 'guardrail-violation',
      serverCode: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii': Response contains an email",
      violations: [
        {
          guardrailId: 'no-pii',
          severity: 'error',
          action: 'halt',
          reason: 'Response contains an email',
        },
      ],
      evaluationErrors: [{ guardrailId: 'tone', message: 'check tone-v2 not registered' }],
    });
  });

  it('is still a guardrail-violation when the server sends no details', () => {
    expect(
      fromWire({ code: 'guardrail-violation', message: "Turn blocked by guardrail 'no-pii'" }),
    ).toEqual({
      code: 'guardrail-violation',
      serverCode: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii'",
      violations: [],
      evaluationErrors: [],
    });
  });

  it('drops malformed entries and omits an absent reason', () => {
    const err = fromWire({
      code: 'guardrail-violation',
      message: 'blocked',
      details: {
        violations: [null, 'no-pii', { result: {} }, { guardrailId: 'max-length', result: {} }],
        evaluationErrors: [{ message: 'no id' }],
      },
    });
    expect(err).toEqual({
      code: 'guardrail-violation',
      serverCode: 'guardrail-violation',
      message: 'blocked',
      violations: [{ guardrailId: 'max-length', severity: 'unknown', action: 'unknown' }],
      evaluationErrors: [],
    });
  });
});

describe('fromWire — conflicts', () => {
  it.each([
    'slug-conflict',
    'project-default-already-exists',
    'registry-read-only',
    'nothing-to-roll-back',
    'not-pinned',
    'agent-version-live',
    'promotion-superseded',
    'gate-policy-already-registered',
    'gate-policy-needs-pin',
    'gate-policy-descendant-unpinned',
    'service-account-name-taken',
    'service-account-unregistered',
    'identity-user-email-taken',
  ])('a %s is a conflict, its code the reason', (code) => {
    expect(fromWire({ code, message: 'taken' })).toEqual({
      code: 'conflict',
      serverCode: code,
      message: 'taken',
      reason: code,
    });
  });
});

describe('fromWire — live versions', () => {
  it.each([
    ['agent-version-not-found', 'agent-version'],
    ['promotion-not-found', 'promotion'],
    ['principal-not-found', 'principal'],
    ['service-account-not-found', 'service-account'],
  ])('a %s is a not-found of a %s', (code, kind) => {
    expect(fromWire({ code, message: 'gone' })).toMatchObject({
      code: 'not-found',
      resource: { kind },
    });
  });

  it.each([
    'role-exceeds-principal',
    'key-project-mismatch',
    'identity-providers-operator-managed',
  ])('a %s is forbidden', (code) => {
    expect(fromWire({ code, message: 'no' })).toMatchObject({
      code: 'auth',
      reason: 'forbidden',
      serverCode: code,
    });
  });

  it('a provider registration its adapter refuses (422) is an invalid request, with its issues', () => {
    const issues = [
      { path: '/adapter_config/api', message: 'adapter_config.api must be one of …' },
    ];
    expect(
      fromWire({ code: 'provider-config-invalid', message: 'm', details: { issues } }, 422),
    ).toMatchObject({ code: 'invalid-request', serverCode: 'provider-config-invalid', issues });
  });

  it('a scope-invalid is an invalid request', () => {
    expect(fromWire({ code: 'scope-invalid', message: 'no such project' })).toMatchObject({
      code: 'invalid-request',
    });
  });

  it("a guardrail-config-invalid (422) is an invalid request with the check's issues", () => {
    const issue = { path: '/config/maxChars', message: 'must be > 0' };
    expect(
      fromWire(
        { code: 'guardrail-config-invalid', message: 'm', details: { issues: [issue] } },
        422,
      ),
    ).toMatchObject({
      code: 'invalid-request',
      serverCode: 'guardrail-config-invalid',
      issues: [issue],
    });
  });
});

describe('fromWire — a code this client does not list is read by its HTTP status', () => {
  it.each([
    [404, { code: 'not-found', resource: { kind: 'org', id: 'o-1' } }],
    [410, { code: 'not-found' }],
    [400, { code: 'invalid-request', issues: [] }],
    [413, { code: 'invalid-request', issues: [] }],
    [409, { code: 'conflict', reason: 'org-not-found' }],
    // 422 stays a server error: the docs match its codes there.
    [422, { code: 'server', serverCode: 'org-not-found' }],
    [401, { code: 'auth', reason: 'unauthenticated' }],
    [403, { code: 'auth', reason: 'forbidden' }],
    [429, { code: 'rate-limited' }],
    [500, { code: 'server', serverCode: 'org-not-found' }],
    [undefined, { code: 'server', serverCode: 'org-not-found' }],
  ] as const)('status %s', (status, expected) => {
    expect(
      fromWire({ code: 'org-not-found', message: 'm', details: { id: 'o-1' } }, status),
    ).toMatchObject({ ...expected, serverCode: 'org-not-found' });
  });

  it.each(['budget-exceeded', 'agent-turn-aborted', 'output-schema-violation'])(
    'a documented 422, %s, is still a server error with its serverCode',
    (code) => {
      expect(fromWire({ code, message: 'm' }, 422)).toMatchObject({
        code: 'server',
        serverCode: code,
      });
    },
  );

  it.each([
    'eval-suite-already-registered',
    'policy-already-registered',
    'version-already-exists',
    'approval-already-decided',
  ])('%s is a conflict (listed)', (code) => {
    expect(fromWire({ code, message: 'm' }, 409)).toMatchObject({ code: 'conflict', reason: code });
  });

  it('a listed code keeps its class whatever the status', () => {
    expect(fromWire({ code: 'slug-conflict', message: 'm' }, 500)).toMatchObject({
      code: 'conflict',
    });
  });

  it("every code the API documents is in its status's family, and keeps its serverCode", () => {
    const spec = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('@kindgi/api/openapi.json'), 'utf8'),
    ) as {
      components: { schemas: { WireError: { 'x-error-codes': Record<string, number> } } };
    };
    const codes = Object.entries(spec.components.schemas.WireError['x-error-codes']);
    expect(codes.length).toBeGreaterThan(100);
    const wrong = codes
      .map(([code, status]) => ({
        code,
        status,
        family: fromWire({ code, message: 'm' }, status).code,
      }))
      .filter(({ code, status, family }) => family !== expectedFamily(code, status))
      .map(
        ({ code, status, family }) =>
          `${code} (${status}): ${family}, not ${expectedFamily(code, status)}`,
      );
    expect(wrong).toEqual([]);
    const withoutCode = codes
      .filter(([code, status]) => {
        const error = fromWire({ code, message: 'm' }, status) as { serverCode?: string };
        return error.serverCode !== code;
      })
      .map(([code]) => code);
    expect(withoutCode).toEqual([]);
  });
});

/**
 * The family a documented code belongs in: its HTTP status's (`x-error-codes`
 * in openapi.json), except where this client classifies a code on purpose.
 */
function expectedFamily(code: string, status: number): string {
  const exceptions: Record<string, string> = {
    // Its own variant, with the violations.
    'guardrail-violation': 'guardrail-violation',
    // A provider registration the adapter refuses: an invalid request, with its issues.
    'provider-config-invalid': 'invalid-request',
    // A guardrail whose config its check refuses: the same.
    'guardrail-config-invalid': 'invalid-request',
  };
  if (exceptions[code] !== undefined) return exceptions[code];
  const byStatus: Record<number, string> = {
    400: 'invalid-request',
    413: 'invalid-request',
    401: 'auth',
    403: 'auth',
    404: 'not-found',
    410: 'not-found',
    409: 'conflict',
    429: 'rate-limited',
  };
  // 422 and 5xx are server errors: the docs match their codes by `serverCode`.
  return byStatus[status] ?? 'server';
}
