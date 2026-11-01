// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tenant policy the turn reads as it sets up, `model-routing` or
 * `tool-errors`, that can't be evaluated fails the turn with
 * `tenant-policy-unavailable` before its providers are set up: running
 * without it would skip the tenant's limits. (`hitl`'s, the same, is in
 * tenant-hitl.test.ts.)
 */

import { TenantBudgetError } from '@kindgi/bounds';
import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelProvider, ProviderRegistry } from '@kindgi/capabilities';
import { createToolRegistry } from '@kindgi/tools';
import type { Semver, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { resolveTurnEnvironment } from '../src/handlers/turn-environment.js';
import type { AgentId } from '../src/types.js';

const tenantId = 't-1' as TenantId;

const provider: ModelProvider = {
  metadata: {
    id: 'other',
    region: 'unspecified',
    models: [
      {
        name: 'other-model',
        contextWindow: 128_000,
        features: ['tool-use'],
        cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
      },
    ],
  },
  invoke: async () => {
    throw new Error('not called');
  },
};

type Evaluate = (kind: string) => Promise<unknown>;

/** A turn under `evaluate`, and how many times its providers were set up (`hydrate`). */
function turn(evaluate: Evaluate): { ctx: TurnContext; hydrated: () => number } {
  const r = defineAgent({
    id: 'pack.agent' as AgentId,
    version: '1.0.0' as Semver,
    name: 'Agent',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  let hydrations = 0;
  const providerRegistry: ProviderRegistry = {
    ...createProviderRegistry([{ tenantId, provider }]).registry,
    hydrate: async () => {
      hydrations += 1;
    },
  };
  const ctx = {
    input: { tenantId, conversationId: 'conv-1', agent: r.value },
    bindings: {
      toolRegistry: createToolRegistry([]),
      providerRegistry,
      policyRegistry: { evaluate },
    },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
  return { ctx, hydrated: () => hydrations };
}

/** What `run` rejected with, or a failure of the test when it resolved. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('the turn set up');
}

/** Evaluates every kind as "no policy", except `failing`, which throws `error`. */
function failingFor(failing: string, error: unknown): Evaluate {
  return async (kind) => {
    if (kind === failing) throw error;
    return undefined;
  };
}

describe("a tenant policy the turn can't evaluate as it sets up", () => {
  test.each(['model-routing', 'tool-errors'] as const)(
    '%s: the turn fails with tenant-policy-unavailable, before its providers are set up',
    async (kind) => {
      const { ctx, hydrated } = turn(failingFor(kind, new Error('policy store unreachable')));
      const error = await rejectionOf(resolveTurnEnvironment(ctx));
      expect(error).toBeInstanceOf(AgentTurnFailure);
      expect((error as AgentTurnFailure).payload).toEqual({
        code: 'tenant-policy-unavailable',
        message: `The workspace's ${kind} policy could not be applied: policy store unreachable`,
        policyKind: kind,
      });
      expect(hydrated()).toBe(0);
    },
  );

  test.each(['model-routing', 'tool-errors'] as const)(
    "%s: work the tenant's budget refused isn't the policy's failure: the refusal goes on to the turn",
    async (kind) => {
      const refusal = new TenantBudgetError('over the budget', 'schema-compile-time', 2_000, 1_500);
      const { ctx } = turn(failingFor(kind, refusal));
      expect(await rejectionOf(resolveTurnEnvironment(ctx))).toBe(refusal);
    },
  );

  test('with both evaluated, the turn routes', async () => {
    const asked: string[] = [];
    const { ctx, hydrated } = turn(async (kind) => {
      asked.push(kind);
      return undefined;
    });
    const routed = await resolveTurnEnvironment(ctx);
    expect(routed).toMatchObject({ providerId: 'other', model: 'other-model' });
    expect(asked).toEqual(['model-routing', 'tool-errors']);
    expect(hydrated()).toBe(1);
  });
});
