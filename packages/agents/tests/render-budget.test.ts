// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tenant's renders count toward its render budget: a render done as its
 * work is charged, and once the budget is spent the next is refused,
 * retryably, rather than failing as the template's fault. The window's
 * arithmetic is the bounds' (`TenantTimeBudget`'s tests).
 */

import {
  HOSTED_BOUNDS,
  SELF_HOSTED_BOUNDS,
  TenantBudgetError,
  type TenantInputBounds,
  runAsTenant,
} from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { afterEach, describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import { TemplateRenderBudgetError } from '../src/index.js';
import { renderTenantTemplate } from '../src/liquid.js';
import { renderInstructions } from '../src/prompt.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** The hosted bounds with a render budget a single render spends. */
const SPENT_BY_ONE: TenantInputBounds = { ...HOSTED_BOUNDS, templateRenderBudgetMs: 0.001 };

const render = () => renderTenantTemplate('{{ name | upcase }}', { name: 'acme' });

function refusal(run: () => unknown): TemplateRenderBudgetError {
  try {
    run();
  } catch (error) {
    if (error instanceof TemplateRenderBudgetError) return error;
    throw error;
  }
  throw new Error('not refused');
}

describe('the render budget', () => {
  test('the hosted bounds give each tenant 5,000 ms of rendering a minute; self-hosted, no limit', () => {
    expect(HOSTED_BOUNDS.templateRenderBudgetMs).toBe(5_000);
    expect(SELF_HOSTED_BOUNDS.templateRenderBudgetMs).toBe(Number.POSITIVE_INFINITY);
  });

  test('a render done as a tenant’s work is charged; past the budget, the next is refused', () => {
    restore = overrideTenantInputBounds(SPENT_BY_ONE);
    expect(runAsTenant('tenant-a', render)).toBe('ACME');
    const error = refusal(() => runAsTenant('tenant-a', render));
    expect(error).toBeInstanceOf(TenantBudgetError);
    expect(error).toMatchObject({
      code: 'template-render-budget-exceeded',
      limit: 'template-render-time',
      budgetMs: 0.001,
    });
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(error.message).toMatch(
      /^Templates rendered for this tenant took its budget of 0\.001 ms in the last 60 seconds: try again in \d+ s\.$/,
    );
  });

  test('another tenant’s renders are its own', () => {
    restore = overrideTenantInputBounds(SPENT_BY_ONE);
    runAsTenant('tenant-a', render);
    refusal(() => runAsTenant('tenant-a', render));
    expect(runAsTenant('tenant-b', render)).toBe('ACME');
  });

  test('outside any tenant’s scope, nothing is charged', () => {
    restore = overrideTenantInputBounds(SPENT_BY_ONE);
    for (let i = 0; i < 3; i += 1) expect(render()).toBe('ACME');
  });

  test('under the self-hosted bounds, a tenant’s renders are never refused', () => {
    restore = overrideTenantInputBounds(SELF_HOSTED_BOUNDS);
    for (let i = 0; i < 3; i += 1) expect(runAsTenant('tenant-a', render)).toBe('ACME');
  });

  test('renderInstructions throws the refusal: it isn’t a failure of the template', () => {
    const made = defineAgent({
      id: 'acme.budget',
      version: '1.0.0',
      name: 'Budget',
      instructions: 'You help {{ customer }}.',
      parameters: [{ name: 'customer', type: 'string', required: true }],
      capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
    });
    if (made.kind === 'err') throw new Error(made.error.message);
    const instructions = () => renderInstructions(made.value, { parameters: { customer: 'Acme' } });
    restore = overrideTenantInputBounds(SPENT_BY_ONE);
    const first = runAsTenant('tenant-a', instructions);
    expect(first.ok && first.value.rendered).toBe('You help Acme.');
    refusal(() => runAsTenant('tenant-a', instructions));
  });
});
