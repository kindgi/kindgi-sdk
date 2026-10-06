// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { DefineAgentSpec } from '@kindgi/agents';
import type { AgentId, Semver } from '@kindgi/types';

import type {
  Agent,
  AgentCollectionPage,
  DeriveAgentVersionBody,
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
  };
}
