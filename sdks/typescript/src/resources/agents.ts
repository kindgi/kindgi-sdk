// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { DefineAgentSpec } from '@kindgi/agents';
import type { AgentId, Semver } from '@kindgi/types';

import type {
  AddTestCaseBody,
  Agent,
  AgentCollectionPage,
  AgentPinScope,
  AgentPinnedVersionList,
  AgentPinnedVersionResolution,
  AgentProjectList,
  AgentTestSet,
  Pin,
  PinAnswer,
  PinCheck,
  PinPage,
  ReleaseGateResolution,
  ScopeSegment,
  SetAgentOwnerResult,
  TestCase,
  TestCaseCollectionPage,
  UnregisterAgentResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import type { GetLatestOptions } from '../types.js';

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
   * does not name a project in the workspace.
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

  /**
   * The highest active version (`GetLatestOptions`), which numbers the
   * next one. What a project runs is `projects`.
   *
   * @wire GET /v1/agents/:agentId
   */
  get(agentId: AgentId, options?: GetLatestOptions): Promise<Agent>;

  /**
   * The projects the agent runs in: its first project first, then each
   * project a deployment that isn't retired shipped a version of it into,
   * among those the caller can read. A retired agent still answers.
   *
   * Each project says what a run there that names no version gets
   * (`runs`) and why (`follows`): a pin that covers the project, else its
   * Latest. Latest moves only when a deployment into the project ships a
   * version, or when a person publishes a full version or adds one as the
   * latest version. `segments` lists the pins on segments inside the
   * project, and `highest` is the agent's highest version.
   *
   * @wire GET /v1/agents/:agentId/projects
   */
  projects(agentId: AgentId | string): Promise<AgentProjectList>;

  /**
   * Set the agent's owner: the person its corrections go to when they need
   * the owner. Setting it again replaces the one before. Needs `admin` on
   * the agent. `get` answers it as `owner`.
   *
   * @wire PUT /v1/agents/:agentId/owner
   */
  setOwner(agentId: AgentId | string, userId: string): Promise<SetAgentOwnerResult>;

  readonly versions: AgentVersionsClient;

  /** Which version runs where: pin a version for a scope, unpin it, and the history of those changes. */
  readonly pinned: AgentPinnedClient;

  /** The release gate a pin for a scope is checked against. */
  readonly releaseGate: AgentReleaseGateClient;

  /** The cases a version of the agent is checked on: its corrections, and cases added by hand. */
  readonly testSet: AgentTestSetClient;

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
}

/**
 * Pinned versions. A run that doesn't name its version uses the pinned
 * version of the most specific scope that has one (segment path,
 * project, org, workspace), else the latest registered version.
 */
export interface AgentPinnedClient {
  /**
   * The version a run would use for a project and segment path, and why
   * (`via: 'pinned'` with the scope, or `via: 'latest'`).
   *
   * @wire GET /v1/agents/:agentId/pinned
   */
  resolve(
    agentId: AgentId | string,
    where?: AgentPinnedWhere,
  ): Promise<AgentPinnedVersionResolution>;
  /** @wire GET /v1/agents/:agentId/pinned-versions: every scope with a pin */
  list(agentId: AgentId | string): Promise<AgentPinnedVersionList>;
  /**
   * Pin `version` for `scope`, from the next run. Open
   * conversations keep their version. `404 agent-version-not-found`
   * when the version isn't registered and active. `409
   * nothing-runs-in-scope` when no version of the agent runs in the scope
   * yet (no pin, and no Latest): deploy or publish one into the project
   * first; into a later environment, promote a build that ships one.
   *
   * With a release gate for the scope, the pin is checked first,
   * against the comparison named by `testRunId`. The answer's
   * `pin.status` says what happened: `pinned`, or `pending-approval` (a
   * reviewer must approve it; `pin.approvalId`). A refusal throws a
   * `KindgiApiError` whose `error.serverCode` is `gate-failed`, with
   * `changeId`, `releaseGate` and every check in `error.fields`.
   *
   * `testRuns` are the test runs that check the version in each project
   * whose running version it changes and that has active cases: the run
   * `testRunId` names, reused, whose outcome is in `fixed` and
   * `reopened`, or one started, whose outcome changes the corrections
   * when it ends.
   *
   * A pin that would take a project that follows Latest now off it throws
   * `pin-stops-latest` (409), with each such project in the details,
   * unless `stopFollowingLatest` is set.
   *
   * @wire POST /v1/agents/:agentId/pinned/pin
   */
  pin(
    agentId: AgentId | string,
    input: AgentPinInput,
    options?: MutationOptions,
  ): Promise<PinAnswer>;
  /**
   * What `pin` with the same input would do, recording nothing:
   * `would-pin`, `needs-approval` (with the approval it needs) or
   * `gate-failed`, with every check.
   *
   * @wire POST /v1/agents/:agentId/pinned/check
   */
  check(agentId: AgentId | string, input: AgentPinInput): Promise<PinCheck>;
  /**
   * Remove the scope's own pin: its runs use the next scope up.
   * `409 not-pinned` when it has none. The answer's `pin` is the unpin
   * change. An unpin never waits for an approval.
   *
   * `testRuns` are the test runs that check the version each project
   * runs now, in each project whose running version the unpin changes
   * and that has active cases. Their outcomes change the corrections
   * when they end.
   *
   * @wire POST /v1/agents/:agentId/pinned/unpin
   */
  unpin(
    agentId: AgentId | string,
    input: AgentUnpinInput,
    options?: MutationOptions,
  ): Promise<PinAnswer>;
  /** @wire GET /v1/agents/:agentId/pin-history: newest first */
  history(agentId: AgentId | string, filter?: ListPinHistoryFilter): Promise<PinPage>;
  /** @wire GET /v1/agents/:agentId/pin-history/:changeId */
  getChange(agentId: AgentId | string, changeId: string): Promise<Pin>;
}

export interface AgentReleaseGateClient {
  /**
   * The release gate a pin for `scope` is checked against: the most
   * specific scope with one, at its latest active version; `releaseGate: null`
   * when none applies.
   *
   * @wire GET /v1/agents/:agentId/release-gate
   */
  resolve(agentId: AgentId | string, scope: AgentPinScope): Promise<ReleaseGateResolution>;
}

/**
 * An agent's test set, read one project at a time. Its cases are the
 * agent's corrections there, except Won't fix and Removed ones, and cases
 * added by hand. It's computed when it's read.
 */
export interface AgentTestSetClient {
  /**
   * How many cases the project's test set of the agent has, active and
   * retired, and when the newest was added. Needs `read` on the project.
   *
   * @wire GET /v1/agents/:agentId/test-set
   */
  get(agentId: AgentId | string, projectId: string): Promise<AgentTestSet>;
  /**
   * The project's cases, newest added first. A retired case comes back
   * only with `includeRetired`.
   *
   * @wire GET /v1/agents/:agentId/test-set/cases
   */
  listCases(
    agentId: AgentId | string,
    filter: ListTestCasesFilter,
  ): Promise<TestCaseCollectionPage>;
  /**
   * Add a case by hand, from a correction's body on one of the agent's
   * finished runs. It has no status, isn't sorted, and nothing that counts
   * corrections counts it. Needs `publish` on the agent, or `write` on the
   * run's project for an agent in more than one project.
   *
   * @wire POST /v1/agents/:agentId/test-set/cases
   */
  addCase(
    agentId: AgentId | string,
    input: AddTestCaseBody,
    options?: MutationOptions,
  ): Promise<TestCase>;
  /**
   * Retire a case: it stays listed, and no test run checks it again.
   * There's no un-retire, and retiring a correction's case doesn't change
   * the correction's status. `409 test-case-retired` when it's retired
   * already. Needs what `addCase` needs, on the case's project.
   *
   * @wire POST /v1/agents/:agentId/test-set/cases/:caseId/retire
   */
  retireCase(
    agentId: AgentId | string,
    caseId: string,
    reason: string,
    options?: MutationOptions,
  ): Promise<TestCase>;
}

/** Where a run would happen: its project and segment path (coarse to fine). */
export interface AgentPinnedWhere {
  readonly projectId?: string;
  readonly segments?: readonly ScopeSegment[];
}

export interface AgentPinInput {
  readonly version: string;
  readonly scope: AgentPinScope;
  readonly reason?: string;
  /** The test run behind the decision, kept on the record. */
  readonly testRunId?: string;
  /**
   * Pin even when it takes a project that follows Latest now off it: the
   * project then runs the pinned version, not each new Latest, and the pin
   * records `stoppedFollowingLatest`. Without it, such a pin throws
   * `pin-stops-latest` (409). `check` ignores it.
   */
  readonly stopFollowingLatest?: boolean;
}

export interface AgentUnpinInput {
  readonly scope: AgentPinScope;
  readonly reason?: string;
}

export interface ListPinHistoryFilter {
  /** Only this scope's history. */
  readonly scope?: AgentPinScope;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListTestCasesFilter {
  readonly projectId: string;
  /** Retired cases too. Default: `false` (active ones only). */
  readonly includeRetired?: boolean;
  /** Only these kinds. Default: both. */
  readonly kinds?: readonly TestCase['kind'][];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListAgentsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly name?: string;
  /**
   * List retired agents too (every version unregistered), each as its
   * highest version with `unregisteredAt`. Default: `false`.
   */
  readonly includeRetired?: boolean;
}

export interface ListVersionsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * List unregistered versions too, each with `unregisteredAt` (a
   * retired agent's included). Default: `false` (active versions only).
   */
  readonly includeTombstoned?: boolean;
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
          ...(filter?.includeTombstoned === true && { includeTombstoned: 'true' }),
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
          ...(filter?.includeRetired === true && { includeRetired: 'true' }),
        },
      });
    },
    async get(agentId, options) {
      return transport.request<Agent>({
        method: 'GET',
        path: `/v1/agents/${seg(agentId as unknown as string)}`,
        query: { ...(options?.projectId !== undefined && { projectId: options.projectId }) },
      });
    },
    async projects(agentId) {
      return transport.request<AgentProjectList>({
        method: 'GET',
        path: `/v1/agents/${seg(agentId as string)}/projects`,
      });
    },
    async setOwner(agentId, userId) {
      return transport.request<SetAgentOwnerResult>({
        method: 'PUT',
        path: `/v1/agents/${seg(agentId as string)}/owner`,
        body: { userId },
      });
    },
    versions,
    reinstateVersion: (agentId, version, options) => versions.reinstate(agentId, version, options),
    pinned: {
      async resolve(agentId, where) {
        return transport.request<AgentPinnedVersionResolution>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/pinned`,
          query: {
            ...(where?.projectId !== undefined && { projectId: where.projectId }),
            ...(where?.segments !== undefined && { segment: where.segments.map(segmentParam) }),
          },
        });
      },
      async list(agentId) {
        return transport.request<AgentPinnedVersionList>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/pinned-versions`,
        });
      },
      async pin(agentId, input, options) {
        return transport.request<PinAnswer>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/pinned/pin`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async check(agentId, input) {
        return transport.request<PinCheck>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/pinned/check`,
          body: input,
        });
      },
      async unpin(agentId, input, options) {
        return transport.request<PinAnswer>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/pinned/unpin`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async history(agentId, filter) {
        return transport.request<PinPage>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/pin-history`,
          query: {
            ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async getChange(agentId, changeId) {
        return transport.request<Pin>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/pin-history/${seg(changeId)}`,
        });
      },
    },
    releaseGate: {
      async resolve(agentId, scope) {
        return transport.request<ReleaseGateResolution>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/release-gate`,
          query: scopeQuery(scope),
        });
      },
    },
    testSet: {
      async get(agentId, projectId) {
        return transport.request<AgentTestSet>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/test-set`,
          query: { projectId },
        });
      },
      async listCases(agentId, filter) {
        return transport.request<TestCaseCollectionPage>({
          method: 'GET',
          path: `/v1/agents/${seg(agentId as string)}/test-set/cases`,
          query: {
            projectId: filter.projectId,
            ...(filter.includeRetired === true && { include: 'retired' }),
            ...(filter.kinds !== undefined &&
              filter.kinds.length > 0 && { kind: filter.kinds.join(',') }),
            ...(filter.limit !== undefined && { limit: filter.limit }),
            ...(filter.cursor !== undefined && { cursor: filter.cursor }),
          },
        });
      },
      async addCase(agentId, input, options) {
        return transport.request<TestCase>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/test-set/cases`,
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
      async retireCase(agentId, caseId, reason, options) {
        return transport.request<TestCase>({
          method: 'POST',
          path: `/v1/agents/${seg(agentId as string)}/test-set/cases/${seg(caseId)}/retire`,
          body: { reason },
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
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
export function scopeQuery(scope: AgentPinScope): Record<string, string | readonly string[]> {
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
