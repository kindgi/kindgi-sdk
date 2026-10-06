// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { DefineAgentSpec } from '@kindgi/agents';
import type { AgentId, Semver } from '@kindgi/types';

import type {
  Agent,
  AgentCollectionPage,
  DeriveAgentVersionBody,
  GatePolicyResolution,
  LivePinList,
  LiveScope,
  LiveVersionResolution,
  Promotion,
  PromotionCheck,
  PromotionPage,
  ScopeSegment,
  UnregisterAgentResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/**
 * Agents resource — versioned catalog + lifecycle.
 *
 * `@kindgi/agents` composes capabilities + tools + memory +
 * guardrails + instructions. Agent execution is a bounded loop that
 * runs on the kernel.
 *
 * SDK/API primitives are ID-taking and serializable. `define` accepts
 * the same declarative spec as `defineAgent`; the runtime primitive's
 * `Agent` value is server-side, referenced by `AgentId`.
 */
export interface AgentsClient {
  /**
   * Publish an agent definition into a project. Server validates via
   * `@kindgi/agents.defineAgent`. `409 agent-already-registered`
   * on conflicting `(id, version)`; `400 bad-input` when `projectId`
   * does not name a project in the tenant.
   *
   * `spec` is the same value `defineAgent` accepts; the project it
   * lands in is `options.projectId`, sent next to the spec fields in
   * the request body.
   *
   * @wire POST /v1/agents
   */
  define(spec: DefineAgentSpec, options: DefineAgentOptions): Promise<AgentId>;

  /** @wire GET /v1/agents */
  list(filter?: ListAgentsFilter): Promise<AgentCollectionPage>;

  /** @wire GET /v1/agents/:agentId — latest active version */
  get(agentId: AgentId): Promise<Agent>;

  readonly versions: AgentVersionsClient;

  /** Which version runs where: live versions per scope, rollback and unpin. */
  readonly live: AgentLiveClient;

  /** Making a version live for a scope, and the history of those changes. */
  readonly promotions: AgentPromotionsClient;

  /** The gate policy a promotion for a scope is checked against. */
  readonly gatePolicy: AgentGatePolicyClient;

  /**
   * Un-tombstone a specific previously-unregistered version.
   *
   * @deprecated Use `agents.versions.reinstate`; removed in 0.2.
   * @wire POST /v1/agents/:agentId/versions/:version/reinstate
   */
  reinstateVersion(
    agentId: AgentId,
    version: Semver,
    options?: MutationOptions,
  ): Promise<ReinstateAgentVersionResult>;
}

export interface AgentVersionsClient {
  /** @wire GET /v1/agents/:agentId/versions */
  list(agentId: AgentId, filter?: ListVersionsFilter): Promise<AgentCollectionPage>;
  /** @wire GET /v1/agents/:agentId/versions/:version */
  get(agentId: AgentId, version: Semver): Promise<Agent>;
  /**
   * Tombstone a specific version. Reversible via
   * `agents.versions.reinstate`. Unregistering an unknown or
   * already-tombstoned version fails with `404 agent-not-found`.
   *
   * @wire POST /v1/agents/:agentId/versions/:version/unregister
   */
  unregister(
    agentId: AgentId,
    version: Semver,
    options?: MutationOptions,
  ): Promise<UnregisterAgentResult>;
  /**
   * Un-tombstone a specific previously-unregistered version. Idempotent:
   * reinstating an active version returns `wasTombstoned: false`.
   *
   * @wire POST /v1/agents/:agentId/versions/:version/reinstate
   */
  reinstate(
    agentId: AgentId,
    version: Semver,
    options?: MutationOptions,
  ): Promise<ReinstateAgentVersionResult>;
  /**
   * Derive a new version from a pinned one with some data-block pins
   * swapped (an expert's edit, no code change). Numbered the next free
   * patch after the agent's highest version. Needs `publish` on the agent.
   *
   * @wire POST /v1/agents/:agentId/versions
   */
  derive(
    agentId: AgentId,
    input: DeriveAgentVersionInput,
    options?: MutationOptions,
  ): Promise<Agent>;
}

/** Body of `POST /v1/agents/{agentId}/versions`. */
export type DeriveAgentVersionInput = DeriveAgentVersionBody;

/**
 * Live versions. A run that doesn't name its version uses the live
 * version of the most specific scope that has one (segment path,
 * project, org, tenant), else the latest registered version.
 */
export interface AgentLiveClient {
  /**
   * The version a run would use for a project and segment path, and why
   * (`via: 'live'` with the scope, or `via: 'latest'`).
   *
   * @wire GET /v1/agents/:agentId/live
   */
  resolve(agentId: AgentId | string, where?: LiveWhere): Promise<LiveVersionResolution>;
  /** @wire GET /v1/agents/:agentId/live-versions — every scope with a pin */
  list(agentId: AgentId | string): Promise<LivePinList>;
  /**
   * Back to the scope's previous live version, or `toVersion`.
   * `409 nothing-to-roll-back` when there is none; `409 not-pinned`
   * when the scope has no pin.
   *
   * @wire POST /v1/agents/:agentId/live/rollback
   */
  rollback(
    agentId: AgentId | string,
    input: RollbackLiveInput,
    options?: MutationOptions,
  ): Promise<Promotion>;
  /**
   * Remove the scope's own pin: its runs use the next scope up.
   * `409 not-pinned` when it has none.
   *
   * @wire POST /v1/agents/:agentId/live/unpin
   */
  unpin(
    agentId: AgentId | string,
    input: UnpinLiveInput,
    options?: MutationOptions,
  ): Promise<Promotion>;
}

export interface AgentPromotionsClient {
  /**
   * Make `version` live for `scope`, from the next run. Open
   * conversations keep their version. `404 agent-version-not-found`
   * when the version isn't registered and active.
   *
   * With a gate policy for the scope, the promotion is checked first,
   * against the comparison named by `evalRunId`. The answer's `status`
   * says what happened: `promoted`, or `pending-approval` (a reviewer
   * must approve it; `approvalId`). A refusal throws a `KindgiApiError`
   * whose `error.serverCode` is `gate-failed`, with `promotionId`,
   * `policy` and every check in `error.fields`.
   *
   * @wire POST /v1/agents/:agentId/promotions
   */
  create(
    agentId: AgentId | string,
    input: PromoteInput,
    options?: MutationOptions,
  ): Promise<Promotion>;
  /**
   * What `create` with the same input would do, recording nothing:
   * `would-promote`, `needs-approval` (with the approval it needs) or
   * `gate-failed`, with every check.
   *
   * @wire POST /v1/agents/:agentId/promotions/check
   */
  check(agentId: AgentId | string, input: PromoteInput): Promise<PromotionCheck>;
  /** @wire GET /v1/agents/:agentId/promotions — newest first */
  list(agentId: AgentId | string, filter?: ListPromotionsFilter): Promise<PromotionPage>;
  /** @wire GET /v1/agents/:agentId/promotions/:promotionId */
  get(agentId: AgentId | string, promotionId: string): Promise<Promotion>;
}

export interface AgentGatePolicyClient {
  /**
   * The gate policy a promotion for `scope` is checked against: the most
   * specific scope with one, at its latest active version; `policy: null`
   * when none applies.
   *
   * @wire GET /v1/agents/:agentId/gate-policy
   */
  resolve(agentId: AgentId | string, scope: LiveScope): Promise<GatePolicyResolution>;
}

/** Where a run would happen: its project and segment path (coarse to fine). */
export interface LiveWhere {
  readonly projectId?: string;
  readonly segments?: readonly ScopeSegment[];
}

export interface PromoteInput {
  readonly version: string;
  readonly scope: LiveScope;
  readonly reason?: string;
  /** The eval run behind the decision, kept on the record. */
  readonly evalRunId?: string;
}

export interface RollbackLiveInput {
  readonly scope: LiveScope;
  /** An earlier version to go back to; default: the scope's previous live version. */
  readonly toVersion?: string;
  readonly reason?: string;
}

export interface UnpinLiveInput {
  readonly scope: LiveScope;
  readonly reason?: string;
}

export interface ListPromotionsFilter {
  /** Only this scope's history. */
  readonly scope?: LiveScope;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListAgentsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly name?: string;
}

export interface ListVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export interface DefineAgentOptions {
  /** Project the agent is published into. `POST /v1/agents` requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface ReinstateAgentVersionResult {
  readonly agentId: AgentId;
  readonly version: Semver;
  readonly wasTombstoned: boolean;
}

interface PublishAgentResult {
  readonly agentId: string;
  readonly version: string;
}

interface ReinstateAgentVersionWire {
  readonly agentId: string;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

export function makeAgentsClient(transport: Transport): AgentsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  const versions: AgentVersionsClient = {
    async list(agentId, filter) {
      return transport.request<AgentCollectionPage>({
        method: 'GET',
        path: `/v1/agents/${seg(agentId as unknown as string)}/versions`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(agentId, version) {
      return transport.request<Agent>({
        method: 'GET',
        path: `/v1/agents/${seg(agentId as unknown as string)}/versions/${seg(version as unknown as string)}`,
      });
    },
    async unregister(agentId, version, options) {
      return transport.request<UnregisterAgentResult>({
        method: 'POST',
        path: `/v1/agents/${seg(agentId as unknown as string)}/versions/${seg(version as unknown as string)}/unregister`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },
    async derive(agentId, input, options) {
      return transport.request<Agent>({
        method: 'POST',
        path: `/v1/agents/${seg(agentId as unknown as string)}/versions`,
        body: input,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },
    async reinstate(agentId, version, options) {
      const wire = await transport.request<ReinstateAgentVersionWire>({
        method: 'POST',
        path: `/v1/agents/${seg(agentId as unknown as string)}/versions/${seg(version as unknown as string)}/reinstate`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        agentId: wire.agentId as unknown as AgentId,
        version: wire.version as unknown as Semver,
        wasTombstoned: wire.wasTombstoned,
      };
    },
  };
  return {
    async define(spec, options) {
      const result = await transport.request<PublishAgentResult>({
        method: 'POST',
        path: '/v1/agents',
        body: { ...spec, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return result.agentId as unknown as AgentId;
    },
    async list(filter) {
      return transport.request<AgentCollectionPage>({
        method: 'GET',
        path: '/v1/agents',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.name !== undefined && { name: filter.name }),
        },
      });
    },
    async get(agentId) {
      return transport.request<Agent>({
        method: 'GET',
        path: `/v1/agents/${seg(agentId as unknown as string)}`,
      });
    },
    versions,
    reinstateVersion: (agentId, version, options) => versions.reinstate(agentId, version, options),
    live: {
      async resolve(agentId, where) {
        return transport.request<LiveVersionResolution>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/live`,
          query: {
            ...(where?.projectId !== undefined && { projectId: where.projectId }),
            ...(where?.segments !== undefined && { segment: where.segments.map(segmentParam) }),
          },
        });
      },
      async list(agentId) {
        return transport.request<LivePinList>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/live-versions`,
        });
      },
      async rollback(agentId, input, options) {
        return transport.request<Promotion>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/live/rollback`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async unpin(agentId, input, options) {
        return transport.request<Promotion>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/live/unpin`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
    promotions: {
      async create(agentId, input, options) {
        return transport.request<Promotion>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/promotions`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async check(agentId, input) {
        return transport.request<PromotionCheck>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/promotions/check`,
          body: input,
        });
      },
      async list(agentId, filter) {
        return transport.request<PromotionPage>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/promotions`,
          query: {
            ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async get(agentId, promotionId) {
        return transport.request<Promotion>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/promotions/${seg(promotionId)}`,
        });
      },
    },
    gatePolicy: {
      async resolve(agentId, scope) {
        return transport.request<GatePolicyResolution>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/gate-policy`,
          query: scopeQuery(scope),
        });
      },
    },
  };
}

/** A segment as a query value: `key:value`. */
function segmentParam(s: ScopeSegment): string {
  return `${s.key}:${s.value}`;
}

/** A scope as the history filter's query: `scopeKind`, `scopeId`, `segment`. */
export function scopeQuery(scope: LiveScope): Record<string, string | readonly string[]> {
  switch (scope.kind) {
    case 'tenant':
      return { scopeKind: 'tenant' };
    case 'org':
      return { scopeKind: 'org', scopeId: scope.orgId };
    case 'project':
      return { scopeKind: 'project', scopeId: scope.projectId };
    case 'segment':
      return {
        scopeKind: 'segment',
        scopeId: scope.projectId,
        segment: scope.path.map(segmentParam),
      };
  }
}
