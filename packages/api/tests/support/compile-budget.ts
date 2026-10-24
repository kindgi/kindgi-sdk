// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { expect } from 'vitest';

/** An answer as a test reads it: a `Response`, or a harness's status, headers and parsed body. */
type Answer =
  | Response
  | { readonly status: number; readonly headers: Headers; readonly body: unknown };

/**
 * What a publish answers when its tenant's compile budget refuses a
 * compile, with the budget the tests set (0 ms, nothing spent):
 * `429 rate-limit-exceeded` naming the budget, and `Retry-After: 1`.
 */
export async function expectCompileBudgetRefused(answer: Answer): Promise<void> {
  const body = answer instanceof Response ? await answer.clone().json() : answer.body;
  expect(answer.status, JSON.stringify(body)).toBe(429);
  expect(answer.headers.get('Retry-After')).toBe('1');
  expect(body).toMatchObject({
    error: { code: 'rate-limit-exceeded', details: { limit: 'schema-compile-time', budgetMs: 0 } },
  });
}
