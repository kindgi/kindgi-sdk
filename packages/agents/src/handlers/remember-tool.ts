// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in `kindgi_remember` tool, built for each turn of an
 * agent that declares `memory.remember`. It dispatches like any tool (the
 * agent's `hitl.tools` policy, replay and the tool error policy apply), but
 * it isn't in the tool registry: its input schema lists the agent's own
 * fact types, and its handler places the fact from the run, not from the
 * model's arguments.
 */

import { randomUUID } from 'node:crypto';

import type { ModelToolDefinition } from '@kindgi/capabilities';
import { type Tool, type ToolContext, defineTool } from '@kindgi/tools';
import type { Timestamp, ToolId } from '@kindgi/types';

import {
  DEFAULT_REMEMBER_DAYS,
  MAX_REMEMBER_KEY,
  MAX_REMEMBER_TEXT,
  REMEMBER_TOOL_ID,
  REMEMBER_TOOL_VERSION,
  rememberTarget,
  reviewReasons,
  runUserId,
} from '../remember.js';
import type { RememberPolicy } from '../types.js';

import type { TurnContext } from './context.js';

/** What the model sends. */
interface RememberArgs {
  readonly type: string;
  readonly content: string;
  readonly key?: string;
  readonly validUntil?: string;
}

/** What the model reads back, and what the turn's provenance is rebuilt from. */
export interface RememberToolOutput {
  /**
   * `remembered`: stored and used from now on. `pending-review`: stored,
   * but no read sees it until a person approves it. `not-remembered`:
   * nothing was stored (`reason` says why).
   */
  readonly status: 'remembered' | 'pending-review' | 'not-remembered';
  readonly factId?: string;
  readonly version?: number;
  /** `superseded` when it replaced the value this agent kept for the same `key`. */
  readonly outcome?: 'created' | 'superseded' | 'replayed';
  readonly reason?: string;
}

type TurnTools = NonNullable<TurnContext['tools']>;

/** The turn's tools, with `remember` added when the agent declares it. */
export function withRememberTool(ctx: TurnContext, tools: TurnTools): TurnTools {
  const policy = ctx.input.agent.memory?.remember;
  if (policy === undefined) return tools;
  const tool = rememberTool(ctx, policy);
  const definition: ModelToolDefinition = {
    name: tool.id,
    description: tool.description,
    inputSchema: tool.input as Readonly<Record<string, unknown>>,
  };
  const byName = new Map(tools.byName);
  byName.set(tool.id, {
    tool,
    resolvedVersion: REMEMBER_TOOL_VERSION,
    requestedRange: REMEMBER_TOOL_VERSION,
  });
  return { definitions: [...tools.definitions, definition], byName };
}

function rememberTool(ctx: TurnContext, policy: RememberPolicy): Tool {
  const defined = defineTool<RememberArgs, RememberToolOutput>({
    id: REMEMBER_TOOL_ID as ToolId,
    version: REMEMBER_TOOL_VERSION,
    description: description(policy),
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'content'],
      properties: {
        type: { type: 'string', enum: [...policy.types], description: 'What kind of fact it is.' },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REMEMBER_TEXT,
          description: 'The fact, in one or two plain sentences.',
        },
        key: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REMEMBER_KEY,
          description:
            'Optional name for what it is about (e.g. "preferred-language"). A new fact with the same type and key replaces the one you remembered before.',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
          description: 'Optional: when it stops being true.',
        },
      },
    },
    output: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['remembered', 'pending-review', 'not-remembered'] },
        factId: { type: 'string' },
        version: { type: 'integer' },
        outcome: { type: 'string', enum: ['created', 'superseded', 'replayed'] },
        reason: { type: 'string' },
      },
    },
    mutating: true,
    effects: [{ kind: 'writes', resource: 'memory:facts' }],
    handler: (args, toolCtx) => remember(ctx, policy, args, toolCtx),
  });
  // The schemas are fixed here: a failure is a bug, not an input problem.
  if (defined.kind === 'err') {
    throw new Error(`the built-in remember tool failed to build: ${defined.error.message}`);
  }
  return defined.value as Tool;
}

function description(policy: RememberPolicy): string {
  const whose =
    policy.scope === 'same-user'
      ? 'the person you are talking with'
      : policy.scope === 'same-conversation'
        ? 'this conversation'
        : policy.scope === 'same-project'
          ? 'everyone in this project, after a person approves it'
          : 'everyone, after a person approves it';
  return `Use ${REMEMBER_TOOL_ID} to remember a fact for later conversations, for ${whose}. Use it for lasting facts and preferences you were told, not for this turn's working notes. It is stored as unverified.`;
}

async function remember(
  ctx: TurnContext,
  policy: RememberPolicy,
  args: RememberArgs,
  toolCtx: ToolContext,
): Promise<RememberToolOutput> {
  const writer = ctx.bindings.memoryWriter;
  if (writer === undefined) {
    return notRemembered('Not remembered: this runtime cannot store agent memories.');
  }
  const userId = runUserId(ctx.input.principal);
  const participantId = ctx.conversation?.participantId ?? ctx.input.participantId;
  const target = rememberTarget(policy.scope, {
    tenantId: ctx.input.tenantId,
    projectId: ctx.input.projectId,
    conversationId: ctx.input.conversationId,
    ...(participantId !== undefined && { participantId }),
    ...(userId !== undefined && { userId }),
  });
  if (target.kind === 'refused') return notRemembered(target.reason);
  const toolIds = [...(ctx.tools?.byName.keys() ?? [])].filter((id) => id !== REMEMBER_TOOL_ID);
  const reasons = reviewReasons(policy, args.content, toolIds);
  const written = await writer.remember({
    tenantId: ctx.input.tenantId,
    scope: target.scope,
    type: args.type,
    content: { text: args.content, ...(args.key !== undefined && { key: args.key }) },
    subjects: target.subjects,
    agent: {
      id: ctx.input.agent.id as unknown as string,
      version: ctx.input.agent.version as unknown as string,
    },
    generatedBy: {
      runId: toolCtx.runId as unknown as string,
      stepId: `step:${ctx.usage.steps}`,
      // Dispatch always passes the call's id; without one, the write can't
      // be matched to an earlier attempt, but never to another call's.
      toolCallId: toolCtx.requestId ?? randomUUID(),
    },
    keepDays: policy.keepDays ?? DEFAULT_REMEMBER_DAYS,
    ...(args.validUntil !== undefined && { validUntil: args.validUntil as Timestamp }),
    ...(reasons.length > 0 && { review: { reasons } }),
  });
  // The store failed: the turn's tool error policy decides what happens.
  if (written.kind === 'err') throw new Error(written.error.message);
  const { fact, outcome } = written.value;
  const pending = fact.review === 'pending';
  return {
    status: pending ? 'pending-review' : 'remembered',
    factId: fact.id as unknown as string,
    version: fact.version,
    outcome,
    ...(pending && { reason: 'A person reviews it before it is used.' }),
  };
}

function notRemembered(reason: string): RememberToolOutput {
  return { status: 'not-remembered', reason };
}
