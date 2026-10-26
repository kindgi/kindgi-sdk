// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { MailCallError, isMailCallError, isMailScopeMissing } from '../src/mail.js';

describe('MailCallError', () => {
  it('names the status and the reason, and nothing else', () => {
    const error = new MailCallError(403, 'insufficientPermissions');
    expect(error.status).toBe(403);
    expect(error.reason).toBe('insufficientPermissions');
    expect(error.name).toBe('MailCallError');
    expect(error.message).toBe('the mail call failed with 403 (insufficientPermissions)');
  });

  it('leaves the reason out when the answer has none', () => {
    const error = new MailCallError(502);
    expect(error.reason).toBeUndefined();
    expect(error.message).toBe('the mail call failed with 502');
  });

  it('is recognized by its symbol, so another copy of the package agrees', () => {
    expect(isMailCallError(new MailCallError(429))).toBe(true);
    expect(
      isMailCallError(
        Object.assign(new Error('x'), { [Symbol.for('kindgi.connections.mail-call-error')]: true }),
      ),
    ).toBe(true);
    expect(isMailCallError(new Error('the mail call failed with 403'))).toBe(false);
    expect(isMailCallError(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
    expect(isMailCallError(null)).toBe(false);
  });
});

describe('isMailScopeMissing', () => {
  it("is Gmail's 403 for a missing scope, by either of its reasons", () => {
    expect(isMailScopeMissing(new MailCallError(403, 'insufficientPermissions'))).toBe(true);
    expect(isMailScopeMissing(new MailCallError(403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'))).toBe(
      true,
    );
  });

  it("is Graph's 403 for a missing scope", () => {
    expect(isMailScopeMissing(new MailCallError(403, 'ErrorAccessDenied'))).toBe(true);
  });

  it("isn't another 403, the same reason with another status, or any other error", () => {
    expect(isMailScopeMissing(new MailCallError(403, 'rateLimitExceeded'))).toBe(false);
    expect(isMailScopeMissing(new MailCallError(403, 'dailyLimitExceeded'))).toBe(false);
    expect(isMailScopeMissing(new MailCallError(403, 'ErrorItemNotFound'))).toBe(false);
    expect(isMailScopeMissing(new MailCallError(403))).toBe(false);
    expect(isMailScopeMissing(new MailCallError(400, 'insufficientPermissions'))).toBe(false);
    expect(isMailScopeMissing(new MailCallError(401, 'ErrorAccessDenied'))).toBe(false);
    expect(
      isMailScopeMissing(
        Object.assign(new Error('x'), { status: 403, reason: 'ErrorAccessDenied' }),
      ),
    ).toBe(false);
    expect(isMailScopeMissing(undefined)).toBe(false);
  });
});
