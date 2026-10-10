// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's judging rules and the queue they fill: which runs need a
 * person's judgment. `client.projects.judgingRules` and
 * `client.projects.judgingQueue`.
 *
 * @wire /v1/projects/:projectId/judging-rules, /v1/projects/:projectId/judging-queue
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  JudgingClassResult,
  JudgingItemRule,
  JudgingQueueItem,
  JudgingQueuePage,
  JudgingQueueState,
  JudgingResultGroup,
  JudgingRule,
  JudgingRulePage,
  JudgingRulePatch,
  JudgingRulePreview,
  JudgingRuleResults,
  JudgingRuleSpec,
  JudgingRuleUnregisterResult,
  JudgingRuleWhen,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type {
  JudgingClassResult,
  JudgingItemRule,
  JudgingQueueItem,
  JudgingQueuePage,
  JudgingQueueState,
  JudgingResultGroup,
  JudgingRule,
  JudgingRulePage,
  JudgingRulePatch,
  JudgingRulePreview,
  JudgingRuleResults,
  JudgingRuleSpec,
  JudgingRuleWhen,
};

export interface JudgingQueueFilter {
  readonly state?: JudgingQueueState;
  readonly agentId?: string;
  readonly ruleId?: string;
  readonly judgeClassId?: string;
  /** What the caller is asked to judge. */
  readonly forMe?: boolean;
  readonly addedAfter?: string;
  readonly closedAfter?: string;
  /** `0` for the `total` alone. */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface JudgingRulePreviewInput extends JudgingRuleWhen {
  readonly sample?: number;
  /** How many recent runs to look at, 1 to 500. Default 100. */
  readonly last?: number;
}

export interface JudgingRulesClient {
  /** @wire GET /v1/projects/:projectId/judging-rules */
  list(
    projectId: string,
    filter?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<JudgingRulePage>;
  /** @wire POST /v1/projects/:projectId/judging-rules */
  create(
    projectId: string,
    spec: JudgingRuleSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<JudgingRule>;
  /** @wire GET /v1/projects/:projectId/judging-rules/:ruleId */
  get(projectId: string, ruleId: string): Promise<JudgingRule>;
  /** A new version with these fields changed. @wire PATCH /v1/projects/:projectId/judging-rules/:ruleId */
  update(projectId: string, ruleId: string, patch: JudgingRulePatch): Promise<JudgingRule>;
  /** @wire POST /v1/projects/:projectId/judging-rules/:ruleId/unregister */
  unregister(projectId: string, ruleId: string): Promise<JudgingRuleUnregisterResult>;
  /** Every version, newest first. @wire GET /v1/projects/:projectId/judging-rules/:ruleId/versions */
  versions(
    projectId: string,
    ruleId: string,
    filter?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<JudgingRulePage>;
  /** By the rule's version and the agent's, never pooled. @wire GET /v1/projects/:projectId/judging-rules/:ruleId/results */
  results(projectId: string, ruleId: string, since?: string): Promise<JudgingRuleResults>;
  /** What a rule would have queued. @wire GET /v1/projects/:projectId/judging-rules/preview */
  preview(projectId: string, input: JudgingRulePreviewInput): Promise<JudgingRulePreview>;
}

export interface JudgingQueueClient {
  /** @wire GET /v1/projects/:projectId/judging-queue */
  list(projectId: string, filter?: JudgingQueueFilter): Promise<JudgingQueuePage>;
  /** @wire POST /v1/projects/:projectId/judging-queue/:runId/dismiss */
  dismiss(projectId: string, runId: string, reason?: string): Promise<JudgingQueueItem>;
  /** @wire POST /v1/projects/:projectId/judging-queue/:runId/reopen */
  reopen(projectId: string, runId: string): Promise<JudgingQueueItem>;
}

const seg = (s: string): string => encodeURIComponent(s);
const page = (filter?: { readonly limit?: number; readonly cursor?: string }) => ({
  ...(filter?.limit !== undefined && { limit: filter.limit }),
  ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
});

export function makeJudgingRulesClient(transport: Transport): JudgingRulesClient {
  return {
    list: (projectId, filter) =>
      transport.request<JudgingRulePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-rules`,
        query: page(filter),
      }),
    create: (projectId, spec, options) =>
      transport.request<JudgingRule>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/judging-rules`,
        body: spec,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      }),
    get: (projectId, ruleId) =>
      transport.request<JudgingRule>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-rules/${seg(ruleId)}`,
      }),
    update: (projectId, ruleId, patch) =>
      transport.request<JudgingRule>({
        method: 'PATCH',
        path: `/v1/projects/${seg(projectId)}/judging-rules/${seg(ruleId)}`,
        body: patch,
      }),
    unregister: (projectId, ruleId) =>
      transport.request<JudgingRuleUnregisterResult>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/judging-rules/${seg(ruleId)}/unregister`,
      }),
    versions: (projectId, ruleId, filter) =>
      transport.request<JudgingRulePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-rules/${seg(ruleId)}/versions`,
        query: page(filter),
      }),
    results: (projectId, ruleId, since) =>
      transport.request<JudgingRuleResults>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-rules/${seg(ruleId)}/results`,
        query: { ...(since !== undefined && { since }) },
      }),
    preview: (projectId, input) =>
      transport.request<JudgingRulePreview>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-rules/preview`,
        query: {
          ...(input.agentIds !== undefined && { agentIds: input.agentIds.join(',') }),
          ...(input.flowIds !== undefined && { flowIds: input.flowIds.join(',') }),
          ...(input.versions !== undefined && { versions: input.versions.join(',') }),
          ...(input.status !== undefined && { status: input.status.join(',') }),
          ...(input.includeDryRuns !== undefined && { includeDryRuns: input.includeDryRuns }),
          ...(input.sample !== undefined && { sample: input.sample }),
          ...(input.last !== undefined && { last: input.last }),
        },
      }),
  };
}

export function makeJudgingQueueClient(transport: Transport): JudgingQueueClient {
  return {
    list: (projectId, filter) =>
      transport.request<JudgingQueuePage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/judging-queue`,
        query: {
          ...(filter?.state !== undefined && { state: filter.state }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
          ...(filter?.ruleId !== undefined && { ruleId: filter.ruleId }),
          ...(filter?.judgeClassId !== undefined && { judgeClassId: filter.judgeClassId }),
          ...(filter?.forMe !== undefined && { forMe: filter.forMe }),
          ...(filter?.addedAfter !== undefined && { addedAfter: filter.addedAfter }),
          ...(filter?.closedAfter !== undefined && { closedAfter: filter.closedAfter }),
          ...page(filter),
        },
      }),
    dismiss: (projectId, runId, reason) =>
      transport.request<JudgingQueueItem>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/judging-queue/${seg(runId)}/dismiss`,
        body: reason === undefined ? {} : { reason },
      }),
    reopen: (projectId, runId) =>
      transport.request<JudgingQueueItem>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/judging-queue/${seg(runId)}/reopen`,
      }),
  };
}
