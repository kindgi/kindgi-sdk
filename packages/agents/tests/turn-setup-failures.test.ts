// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A turn that can't route names the tenant's registered providers its
 * registry couldn't set up (`ProviderRegistry.setupFailures`), read after
 * `hydrate`, so the 422 says why instead of `reasons: []`.
 */

import { createProviderRegistry } from '@kindgi/capabilities';
import type { ModelProvider, ProviderRegistry, ProviderSetupFailure } from '@kindgi/capabilities';
import { createToolRegistry } from '@kindgi/tools';
import type { Semver, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import { resolveTurnEnvironment } from '../src/handlers/turn-environment.js';
import type { AgentId } from '../src/types.js';

const tenantId = 't-1' as TenantId;

const bedrock: ProviderSetupFailure = {
  providerId: 'bedrock',
  message: `Provider "bedrock" can't be set up on this runtime.`,
};

function provider(id: string): ModelProvider {
  return {
    metadata: {
      id,
      region: 'unspecified',
      models: [
        {
          name: `${id}-model`,
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
}

/**
 * A storage-backed registry's shape: `list` and `setupFailures` read what
 * `hydrate` loaded, so both are empty until it has run.
 */
function hydratedRegistry(
  providers: readonly ModelProvider[],
  failures: readonly ProviderSetupFailure[],
): ProviderRegistry {
  const loaded = createProviderRegistry(providers.map((p) => ({ tenantId, provider: p }))).registry;
  let hydrated = false;
  return {
    ...loaded,
    list: (t) => (hydrated ? loaded.list(t) : []),
    hydrate: async () => {
      hydrated = true;
    },
    setupFailures: () => (hydrated ? failures : []),
  };
}

function turn(providerRegistry: ProviderRegistry): TurnContext {
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
  return {
    input: { tenantId, conversationId: 'conv-1', agent: r.value },
    bindings: { toolRegistry: createToolRegistry([]), providerRegistry },
    turnAbort: new AbortController(),
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnContext;
}

async function failureOf(run: Promise<unknown>): Promise<AgentTurnFailure['payload']> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AgentTurnFailure) return error.payload;
    throw error;
  }
  throw new Error('the turn routed');
}

const namedReason = {
  requirement: 'provider set up',
  satisfyingProviders: [],
  rejectingProviders: [
    {
      id: 'bedrock',
      reason: { code: 'provider-setup-failed', message: bedrock.message, providerId: 'bedrock' },
    },
  ],
};

describe('a turn whose provider could not be set up', () => {
  test("when it was the tenant's only provider, the failure names it and says why", async () => {
    const failure = await failureOf(resolveTurnEnvironment(turn(hydratedRegistry([], [bedrock]))));
    expect(failure).toMatchObject({
      code: 'capability-routing-failed',
      message: `No registered provider satisfies the capability declaration. ${bedrock.message}`,
      cause: { code: 'capability-unsatisfiable', reasons: [namedReason] },
    });
  });

  test('a resumed turn routed to it says so too', async () => {
    const failure = await failureOf(
      resolveTurnEnvironment(turn(hydratedRegistry([provider('other')], [bedrock])), {
        providerId: 'bedrock',
        model: 'bedrock-model',
      }),
    );
    expect(failure).toMatchObject({
      code: 'capability-routing-failed',
      message: `The turn was routed to bedrock/bedrock-model, which is no longer registered or allowed: No registered provider satisfies the capability declaration. ${bedrock.message}`,
      cause: {
        reasons: expect.arrayContaining([
          { ...namedReason, satisfyingProviders: ['other/other-model'] },
        ]),
      },
    });
  });

  test('another provider that was set up still takes the turn', async () => {
    const routed = await resolveTurnEnvironment(
      turn(hydratedRegistry([provider('other')], [bedrock])),
    );
    expect(routed).toMatchObject({ providerId: 'other', model: 'other-model' });
  });
});
