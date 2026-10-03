// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Agents schema — first-class conversation primitive.
 *
 * A conversation is a durable thread grouping many agent invocations
 * into one user-visible unit. Messages inside a conversation live as
 * memory facts of type `agent-message`, scoped to
 * `threadId = <conversation id>`. This split lets conversation
 * lifecycle (open/close, list, cheap turn-count updates) use a real
 * table while message content inherits memory's versioning +
 * retention + RLS + search infrastructure.
 *
 * `tenant_id` on every table; implementations enable row-level
 * security on `AGENTS_TENANT_SCOPED_TABLES` and run every statement in
 * a tenant-scoped connection so the RLS predicate has context.
 */

export const agentConversations = pgTable(
  'agent_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    /**
     * Agent id + version this conversation was opened with. Resuming
     * with a different version is refused — the agent's semantics may
     * have changed.
     */
    agentId: text('agent_id').notNull(),
    agentVersion: text('agent_version').notNull(),
    /**
     * Human-facing title. Auto-generated on first turn (typically from
     * the initial user message) or explicitly set. Not versioned — the
     * latest string wins.
     */
    title: text('title').notNull(),
    /**
     * Optional identifier for the human participant (email, user id,
     * SSO subject). Kept as text so the caller decides the shape.
     */
    participantId: text('participant_id'),
    /**
     * Structural scope — project id, matter id, etc. Persisted through
     * the versioning envelope so shape evolution is migrate-on-read.
     */
    scope: jsonb('scope').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the conversation is closed. Closed conversations are read-only. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Denormalized turn counter — incremented by `appendMessage` for
     * each turn's final (non-intermediate) agent message. Read by the
     * session HITL gate and the UI conversation list.
     */
    turnCount: integer('turn_count').notNull().default(0),
    /**
     * Denormalized last-activity timestamp. Kept in sync by
     * `appendMessage`. Enables cheap sort by recency in the UI list.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /**
     * Free-form metadata (participant details, feature flags,
     * conversation-level notes). Versioned envelope.
     */
    metadata: jsonb('metadata'),
  },
  (t) => ({
    tenantAgentIdx: index('agent_conversations_tenant_agent_idx').on(t.tenantId, t.agentId),
    tenantParticipantIdx: index('agent_conversations_tenant_participant_idx').on(
      t.tenantId,
      t.participantId,
    ),
    /** Partial index: open conversations sorted by recency. Used by the UI list. */
    openRecentIdx: index('agent_conversations_open_recent_idx')
      .on(t.tenantId, t.lastMessageAt.desc())
      .where(sql`${t.closedAt} IS NULL`),
  }),
);

export type AgentConversationRow = typeof agentConversations.$inferSelect;
export type NewAgentConversationRow = typeof agentConversations.$inferInsert;

/**
 * `agent_run_snapshots` — reconstruction envelope for a suspended agent
 * turn. Written by the setup handler on the FIRST execution of a run
 * (idempotent via the runId primary key); used by
 * `resumeAgentTurn(runId)` to rebuild the same `InvokeAgentInput` the
 * turn was invoked with — so kernel replay after a HITL waitpoint
 * resolution lands in an identical context.
 *
 * Owned by @kindgi/agents (not the kernel) so the kernel's
 * schema stays generic — the kernel has no notion of agents,
 * conversations, or participant identities.
 *
 * Idempotent insert: `runId` is the PK; implementations insert with
 * `ON CONFLICT (id) DO NOTHING` (or equivalent) so a replay is a
 * no-op. All fields are set at first execution and never modified.
 */
export const agentRunSnapshots = pgTable(
  'agent_run_snapshots',
  {
    /** `runId` — the kernel run this snapshot reconstructs. Primary key. */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** Agent id + version pinned at turn start. Same as agent_conversations. */
    agentId: text('agent_id').notNull(),
    agentVersion: text('agent_version').notNull(),
    /** Conversation this turn belongs to — required for the setup handler to load state. */
    conversationId: uuid('conversation_id').notNull(),
    /** The user message that started this turn. */
    userMessage: text('user_message').notNull(),
    /**
     * The turn's prompt parameters and structured input, as given to
     * `invokeAgent`. A resumed turn renders its instructions with the
     * same values. Versioned envelopes, like `principal`.
     */
    parameters: jsonb('parameters'),
    input: jsonb('input'),
    /** Optional participant identifier — mirrors InvokeAgentInput.participantId. */
    participantId: text('participant_id'),
    /** dryRun marker from the original invocation. Affects handler side-effect behavior. */
    dryRun: integer('dry_run').notNull().default(0),
    /**
     * Optional serialized Principal (authorization) from the original
     * invocation. Threaded back into the resumed TurnContext so tool
     * dispatch stays enforcement-consistent. Versioned envelope so shape
     * evolution is migrate-on-read.
     */
    principal: jsonb('principal'),
    /**
     * Optional authz config (`{fgaApiUrl}`) from the original invocation.
     * Threaded back into the resumed TurnContext.
     */
    authz: jsonb('authz'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('agent_run_snapshots_tenant_idx').on(t.tenantId),
  }),
);

export type AgentRunSnapshotRow = typeof agentRunSnapshots.$inferSelect;
export type NewAgentRunSnapshotRow = typeof agentRunSnapshots.$inferInsert;

/**
 * Tables that carry `tenant_id`; register them with the migration
 * runner so row-level security gets enabled on them.
 */
export const AGENTS_TENANT_SCOPED_TABLES = ['agent_conversations', 'agent_run_snapshots'] as const;
