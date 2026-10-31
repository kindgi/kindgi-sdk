// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's queue rules and the queue they fill: which runs need a
 * person's correction. `client.projects.queueRules` and
 * `client.projects.expertQueue`.
 *
 * @wire /v1/projects/:projectId/queue-rules, /v1/projects/:projectId/expert-queue
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  ExpertQueueItem,
  ExpertQueueItemRule,
  ExpertQueuePage,
  ExpertQueueRecentInput,
  ExpertQueueRecentQueued,
  ExpertQueueState,
  QueueRule,
  QueueRuleGroupResult,
  QueueRulePage,
  QueueRulePatch,
  QueueRulePreview,
  QueueRuleResultGroup,
  QueueRuleResults,
  QueueRuleSpec,
  QueueRuleUnregisterResult,
  QueueRuleWhen,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type {
  QueueRuleGroupResult,
  ExpertQueueItemRule,
  ExpertQueueItem,
  ExpertQueuePage,
  ExpertQueueRecentInput,
  ExpertQueueState,
  ExpertQueueRecentQueued,
  QueueRuleResultGroup,
  QueueRule,
  QueueRulePage,
  QueueRulePatch,
  QueueRulePreview,
  QueueRuleResults,
  QueueRuleSpec,
  QueueRuleWhen,
};

export interface ExpertQueueFilter {
  readonly state?: ExpertQueueState;
  readonly agentId?: string;
  readonly ruleId?: string;
  readonly correctorGroupId?: string;
  /** What the caller is asked to correct. */
  readonly forMe?: boolean;
  readonly addedAfter?: string;
  readonly closedAfter?: string;
  /** `0` for the `total` alone. */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface QueueRulePreviewInput extends QueueRuleWhen {
  readonly sample?: number;
  /** How many recent runs to look at, 1 to 500. Default 100. */
  readonly last?: number;
  /** An existing rule's id: sample as it does, so `matched` is exactly the runs it would take. */
  readonly ruleId?: string;
}

export interface QueueRulesClient {
  /** @wire GET /v1/projects/:projectId/queue-rules */
  list(
    projectId: string,
    filter?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<QueueRulePage>;
  /** @wire POST /v1/projects/:projectId/queue-rules */
  create(
    projectId: string,
    spec: QueueRuleSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<QueueRule>;
  /** @wire GET /v1/projects/:projectId/queue-rules/:ruleId */
  get(projectId: string, ruleId: string): Promise<QueueRule>;
  /** A new version with these fields changed. @wire PATCH /v1/projects/:projectId/queue-rules/:ruleId */
  update(projectId: string, ruleId: string, patch: QueueRulePatch): Promise<QueueRule>;
  /** @wire POST /v1/projects/:projectId/queue-rules/:ruleId/unregister */
  unregister(projectId: string, ruleId: string): Promise<QueueRuleUnregisterResult>;
  /** Every version, newest first. @wire GET /v1/projects/:projectId/queue-rules/:ruleId/versions */
  versions(
    projectId: string,
    ruleId: string,
    filter?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<QueueRulePage>;
  /** By the rule's version and the agent's, never pooled. @wire GET /v1/projects/:projectId/queue-rules/:ruleId/results */
  results(projectId: string, ruleId: string, since?: string): Promise<QueueRuleResults>;
  /** What a rule would have queued. @wire GET /v1/projects/:projectId/queue-rules/preview */
  preview(projectId: string, input: QueueRulePreviewInput): Promise<QueueRulePreview>;
  /** Queue the rule's matches among recent runs, to catch it up on runs that ended before it was there. @wire POST /v1/projects/:projectId/queue-rules/:ruleId/queue-recent */
  queueRecent(
    projectId: string,
    ruleId: string,
    input: ExpertQueueRecentInput,
  ): Promise<ExpertQueueRecentQueued>;
}

export interface ExpertQueueClient {
  /** @wire GET /v1/projects/:projectId/expert-queue */
  list(projectId: string, filter?: ExpertQueueFilter): Promise<ExpertQueuePage>;
  /** @wire POST /v1/projects/:projectId/expert-queue/:runId/dismiss */
  dismiss(projectId: string, runId: string, reason?: string): Promise<ExpertQueueItem>;
  /** @wire POST /v1/projects/:projectId/expert-queue/:runId/reopen */
  reopen(projectId: string, runId: string): Promise<ExpertQueueItem>;
}

const seg = (s: string): string => encodeURIComponent(s);
const page = (filter?: { readonly limit?: number; readonly cursor?: string }) => ({
  ...(filter?.limit !== undefined && { limit: filter.limit }),
  ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
});

export function makeQueueRulesClient(transport: Transport): QueueRulesClient {
  return {
    list: (projectId, filter) =>
      transport.request<QueueRulePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/queue-rules`,
        query: page(filter),
      }),
    create: (projectId, spec, options) =>
      transport.request<QueueRule>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/queue-rules`,
        body: spec,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      }),
    get: (projectId, ruleId) =>
      transport.request<QueueRule>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}`,
      }),
    update: (projectId, ruleId, patch) =>
      transport.request<QueueRule>({
        method: 'PATCH',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}`,
        body: patch,
      }),
    unregister: (projectId, ruleId) =>
      transport.request<QueueRuleUnregisterResult>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}/unregister`,
      }),
    versions: (projectId, ruleId, filter) =>
      transport.request<QueueRulePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}/versions`,
        query: page(filter),
      }),
    results: (projectId, ruleId, since) =>
      transport.request<QueueRuleResults>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}/results`,
        query: { ...(since !== undefined && { since }) },
      }),
    preview: (projectId, input) =>
      transport.request<QueueRulePreview>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/queue-rules/preview`,
        query: {
          ...(input.agentIds !== undefined && { agentIds: input.agentIds.join(',') }),
          ...(input.flowIds !== undefined && { flowIds: input.flowIds.join(',') }),
          ...(input.versions !== undefined && { versions: input.versions.join(',') }),
          ...(input.status !== undefined && { status: input.status.join(',') }),
          ...(input.includeDryRuns !== undefined && { includeDryRuns: input.includeDryRuns }),
          ...(input.sample !== undefined && { sample: input.sample }),
          ...(input.last !== undefined && { last: input.last }),
          ...(input.ruleId !== undefined && { ruleId: input.ruleId }),
        },
      }),
    queueRecent: (projectId, ruleId, input) =>
      transport.request<ExpertQueueRecentQueued>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/queue-rules/${seg(ruleId)}/queue-recent`,
        body: {
          ...(input.last !== undefined && { last: input.last }),
          ...(input.since !== undefined && { since: input.since }),
        },
      }),
  };
}

export function makeExpertQueueClient(transport: Transport): ExpertQueueClient {
  return {
    list: (projectId, filter) =>
      transport.request<ExpertQueuePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/expert-queue`,
        query: {
          ...(filter?.state !== undefined && { state: filter.state }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
          ...(filter?.ruleId !== undefined && { ruleId: filter.ruleId }),
          ...(filter?.correctorGroupId !== undefined && {
            correctorGroupId: filter.correctorGroupId,
          }),
          ...(filter?.forMe !== undefined && { forMe: filter.forMe }),
          ...(filter?.addedAfter !== undefined && { addedAfter: filter.addedAfter }),
          ...(filter?.closedAfter !== undefined && { closedAfter: filter.closedAfter }),
          ...page(filter),
        },
      }),
    dismiss: (projectId, runId, reason) =>
      transport.request<ExpertQueueItem>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/expert-queue/${seg(runId)}/dismiss`,
        body: reason === undefined ? {} : { reason },
      }),
    reopen: (projectId, runId) =>
      transport.request<ExpertQueueItem>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/expert-queue/${seg(runId)}/reopen`,
      }),
  };
}
