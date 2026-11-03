// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelToolDefinition } from '@kindgi/capabilities';
import type { ConnectionAccountChoices, ConnectionNeed } from '@kindgi/tools';

import { connectionNeedsOf, connectionPersonOf } from './connection-gate.js';
import type { TurnContext } from './context.js';
import { ACCOUNTS_INPUT } from './named-accounts.js';
import { connectionSetRefusal } from './replay.js';

/**
 * Ask, once for the turn, which of its tools' needs have a set the call
 * may name from (`ConnectionResolver.accountChoices`), and offer them to
 * the model: each such tool's input gains an optional `accounts` object.
 * Only a tool that may take a set is asked about (`connectionSetRefusal`).
 * Without a resolver that answers, nothing is offered.
 */
export async function offerAccounts(ctx: TurnContext, runId: string): Promise<void> {
  const served = ctx.bindings.connections;
  const tools = ctx.tools;
  if (served?.resolver.accountChoices === undefined || tools === undefined) return;
  const asked: { toolId: string; needs: Readonly<Record<string, ConnectionNeed>> }[] = [];
  for (const { tool } of tools.byName.values()) {
    const needs = connectionNeedsOf(tool);
    if (needs === undefined || connectionSetRefusal(tool) !== undefined) continue;
    asked.push({ toolId: tool.id as unknown as string, needs });
  }
  if (asked.length === 0) return;
  const person = connectionPersonOf(ctx.input.principal);
  const offered = await served.resolver.accountChoices({
    tenantId: ctx.input.tenantId,
    projectId: ctx.input.projectId,
    envName: served.envName,
    runId,
    target: { agentId: ctx.input.agent.id as unknown as string },
    ...(person !== undefined && { person: { userId: person } }),
    ...(ctx.input.mailbox !== undefined && { mailbox: ctx.input.mailbox }),
    tools: asked,
  });
  const kept: Record<string, ConnectionAccountChoices[string]> = {};
  for (const { toolId } of asked) {
    const needs = offered[toolId];
    if (needs !== undefined && Object.keys(needs).length > 0) kept[toolId] = needs;
  }
  if (Object.keys(kept).length === 0) return;
  ctx.accountChoices = kept;
  ctx.tools = {
    ...tools,
    definitions: tools.definitions.map((d) => {
      const needs = kept[d.name];
      return needs === undefined ? d : withAccountsInput(d, needs);
    }),
  };
}

/** A tool's definition with the `accounts` input its sets offer. */
function withAccountsInput(
  definition: ModelToolDefinition,
  needs: ConnectionAccountChoices[string],
): ModelToolDefinition {
  const schema = definition.inputSchema;
  const properties = (schema.properties ?? {}) as Readonly<Record<string, unknown>>;
  const accounts: Record<string, unknown> = {};
  for (const [need, set] of Object.entries(needs).sort(([a], [b]) => a.localeCompare(b))) {
    const fallback = set.members.find((m) => m.connectionId === set.default)?.name;
    accounts[need] = {
      type: 'string',
      enum: set.members.map((m) => m.name),
      description: `Which of these ${set.appName} connections this call reads, by name.${fallback === undefined ? '' : ` Leave it out to read ${fallback}.`}`,
    };
  }
  return {
    ...definition,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        [ACCOUNTS_INPUT]: {
          type: 'object',
          additionalProperties: false,
          description:
            'The connections this call reads, for those that have several to choose from.',
          properties: accounts,
        },
      },
    },
  };
}
