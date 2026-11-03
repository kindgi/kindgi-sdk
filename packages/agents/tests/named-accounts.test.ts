// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { ModelToolCall } from '@kindgi/capabilities';
import type {
  ConnectionAccountChoices,
  ConnectionAccountChoicesInput,
  ConnectionNeed,
} from '@kindgi/tools';

import type { TurnContext } from '../src/handlers/context.js';
import { toolArguments } from '../src/handlers/named-accounts.js';
import { offerAccounts } from '../src/handlers/offer-accounts.js';
import { connectionSetRefusal } from '../src/handlers/replay.js';

const notes: ConnectionNeed = { app: 'acme', permissions: ['notes.read'], as: 'company' };
const input = {
  type: 'object',
  properties: { q: { type: 'string' } },
  additionalProperties: false,
};
const set: ConnectionAccountChoices[string][string] = {
  appName: 'Acme',
  members: [
    { name: 'support', connectionId: 'conn-support' },
    { name: 'sales', connectionId: 'conn-sales' },
  ],
  default: 'conn-support',
};

/** A tool as the turn resolved it: read-only, needing Acme notes, unless told. */
function tool(id: string, more: Record<string, unknown> = {}) {
  return {
    id,
    description: `${id}.`,
    mutating: false,
    effects: [],
    input,
    needsSpec: { connections: { notes } },
    ...more,
  };
}

function turnWith(tools: readonly ReturnType<typeof tool>[], answer?: ConnectionAccountChoices) {
  const asked: ConnectionAccountChoicesInput[] = [];
  const ctx = {
    input: {
      tenantId: 't-1',
      projectId: 'p-1',
      agent: { id: 'acme.support' },
      principal: { actor: { kind: 'user', id: 'user-owner', tenantId: 't-1' } },
    },
    bindings: {
      connections: {
        envName: 'production',
        resolver: {
          resolveConnections: async () => {
            throw new Error('no call resolves here');
          },
          ...(answer !== undefined && {
            accountChoices: async (asking: ConnectionAccountChoicesInput) => {
              asked.push(asking);
              return answer;
            },
          }),
        },
      },
    },
    tools: {
      definitions: tools.map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: t.input,
      })),
      byName: new Map(
        tools.map((t) => [t.id, { tool: t, resolvedVersion: '1.0.0', requestedRange: '^1.0.0' }]),
      ),
    },
  } as unknown as TurnContext;
  return { ctx, asked };
}

describe('connectionSetRefusal: the one check for a tool that may take a set', () => {
  test('a tool that changes nothing may; one that changes things, sends on what it reads, or has its own accounts may not', () => {
    expect(connectionSetRefusal({ mutating: false })).toBeUndefined();
    expect(connectionSetRefusal({ mutating: false, effects: ['reads'] })).toBeUndefined();
    expect(connectionSetRefusal({})).toBe('changes');
    expect(connectionSetRefusal({ mutating: true })).toBe('changes');
    expect(
      connectionSetRefusal({ mutating: false, effects: [{ kind: 'sensitive-data-egress' }] }),
    ).toBe('sensitive-data-egress');
    expect(connectionSetRefusal({ mutating: false, input: { properties: { accounts: {} } } })).toBe(
      'accounts-input',
    );
    // Sending on what it reads is the reason that's given first.
    expect(
      connectionSetRefusal({
        mutating: false,
        effects: ['sensitive-data-egress'],
        input: { properties: { accounts: {} } },
      }),
    ).toBe('sensitive-data-egress');
  });
});

describe('offerAccounts: the sets a turn offers the model', () => {
  test('asks once, for the tools that may take a set, and offers each what comes back as an `accounts` input', async () => {
    const tools = [
      tool('acme.notes'),
      tool('acme.write', { mutating: true }),
      tool('acme.forward', { effects: ['sensitive-data-egress'] }),
      tool('acme.own', {
        input: { type: 'object', properties: { accounts: { type: 'object' } } },
      }),
      tool('acme.plain', { needsSpec: {} }),
    ];
    const { ctx, asked } = turnWith(tools, {
      'acme.notes': { notes: set },
      // Not asked about, so not offered, whatever comes back.
      'acme.write': { notes: set },
    });
    const before = ctx.tools?.definitions ?? [];
    await offerAccounts(ctx, 'run-1');

    expect(asked).toEqual([
      {
        tenantId: 't-1',
        projectId: 'p-1',
        envName: 'production',
        runId: 'run-1',
        target: { agentId: 'acme.support' },
        person: { userId: 'user-owner' },
        tools: [{ toolId: 'acme.notes', needs: { notes } }],
      },
    ]);
    expect(ctx.accountChoices).toEqual({ 'acme.notes': { notes: set } });
    const [offered, ...rest] = ctx.tools?.definitions ?? [];
    expect(offered?.inputSchema).toEqual({
      ...input,
      properties: {
        ...input.properties,
        accounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'The connections this call reads, for those that have several to choose from.',
          properties: {
            notes: {
              type: 'string',
              enum: ['support', 'sales'],
              description:
                'Which of these Acme connections this call reads, by name. Leave it out to read support.',
            },
          },
        },
      },
    });
    // The ids are the run's: the model sees only the names.
    expect(JSON.stringify(ctx.tools?.definitions)).not.toContain('conn-');
    expect(rest).toEqual(before.slice(1));
  });

  test('a resolver that offers no sets, or none for the turn, changes nothing', async () => {
    for (const answer of [undefined, {}, { 'acme.notes': {} }]) {
      const { ctx } = turnWith([tool('acme.notes')], answer);
      const before = ctx.tools;
      await offerAccounts(ctx, 'run-1');
      expect(ctx.accountChoices).toBeUndefined();
      expect(ctx.tools).toBe(before);
    }
  });

  test('a default no longer among the members is offered without a default to leave it to', async () => {
    const { ctx } = turnWith([tool('acme.notes')], {
      'acme.notes': { notes: { ...set, default: 'conn-gone' } },
    });
    await offerAccounts(ctx, 'run-1');
    const schema = ctx.tools?.definitions[0]?.inputSchema as {
      properties: { accounts: { properties: { notes: { description: string } } } };
    };
    expect(schema.properties.accounts.properties.notes.description).toBe(
      'Which of these Acme connections this call reads, by name.',
    );
  });
});

describe('toolArguments: what the tool runs with', () => {
  const call = (args: Record<string, unknown>): ModelToolCall => ({
    id: 'call-0',
    name: 'acme.notes',
    arguments: args,
  });

  test("the call's input without the `accounts` its turn offered; a tool offered none gets it whole", () => {
    const offeredTurn = {
      accountChoices: { 'acme.notes': { notes: set } },
    } as unknown as TurnContext;
    const plainTurn = {} as TurnContext;
    const notesTool = tool('acme.notes') as never;
    const named = call({ q: 'invoices', accounts: { notes: 'sales' } });
    expect(toolArguments(offeredTurn, named, notesTool)).toEqual({ q: 'invoices' });
    expect(toolArguments(plainTurn, named, notesTool)).toBe(named.arguments);
    const unnamed = call({ q: 'invoices' });
    expect(toolArguments(offeredTurn, unnamed, notesTool)).toBe(unnamed.arguments);
  });
});
