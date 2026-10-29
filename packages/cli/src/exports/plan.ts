// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi exports create` reads: every kind of record the workspace
 * holds, with the route it's read from, and every other read route with
 * why it isn't one. `tests/exports-plan.test.ts` checks both against
 * `openapi.json`: every `GET` is in exactly one place, so a new read
 * route fails the test until someone classifies it.
 *
 * Each record is written as the route answers it, unchanged, so the API
 * reference documents the files. A top-level kind's file holds one record
 * per line. A child kind's line is `{ "parent": { <path params> }, "item": … }`,
 * so a line never depends on the item carrying its parent's id.
 */

/** How a route answers. */
export type Paging =
  /** `limit` + `cursor` in, `{ data, nextCursor, hasMore }` out, read to the last page. */
  | 'cursor'
  /** One answer, `{ data }`, holding every record. */
  | 'whole'
  /** One answer, one record. */
  | 'one';

/** Where a child kind's path parameters come from: each one, the field of the parent's record that fills it. */
export interface ParentRef {
  /** The parent kind's name; it comes earlier in the plan. */
  readonly kind: string;
  /** Path parameter -> the parent record's field. */
  readonly params: Readonly<Record<string, string>>;
}

/** A kind of record, and how it's read. */
export interface ExportKind {
  /** The file's name: `<name>.jsonl`. */
  readonly name: string;
  /** The read route, as `openapi.json` writes it. */
  readonly route: string;
  readonly paging: Paging;
  /** For a child kind: its parent, read once for each of the parent's records. */
  readonly parent?: ParentRef;
  /** Query parameters sent on every read: what the route leaves out unless asked. */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * Read once for each env name (`GET /v1/environments`) at each scope:
   * the tenant, each org, each project (with `inherit=false` in `query`,
   * so nothing is read twice). A child kind is read at its parent's env
   * and scope.
   */
  readonly envScoped?: true;
  /**
   * The full record is each item's own route (the list holds a summary):
   * the file holds what that route answers.
   */
  readonly item?: { readonly route: string; readonly params: Readonly<Record<string, string>> };
  /** Each record's bytes, written to `<dir>/<id>`. */
  readonly bytes?: {
    readonly route: string;
    readonly params: Readonly<Record<string, string>>;
    readonly dir: string;
  };
  /** Other read routes that answer these same records (each item's own route), so they're read here. */
  readonly covers?: readonly string[];
  /** Only a tenant admin reads the whole of it; anyone else reads part of it, or is refused. */
  readonly admin?: true;
}

const cursor = 'cursor' as const;
const whole = 'whole' as const;

/** In order: a parent comes before its children. */
export const EXPORT_PLAN: readonly ExportKind[] = [
  // The tenant and who's in it.
  { name: 'tenant', route: '/v1/tenant', paging: 'one' },
  { name: 'orgs', route: '/v1/orgs', paging: cursor, covers: ['/v1/orgs/{orgId}'] },
  { name: 'projects', route: '/v1/projects', paging: cursor, covers: ['/v1/projects/{projectId}'] },
  { name: 'teams', route: '/v1/teams', paging: cursor, covers: ['/v1/teams/{teamId}'] },
  {
    name: 'team-memberships',
    route: '/v1/teams/{teamId}/memberships',
    paging: cursor,
    parent: { kind: 'teams', params: { teamId: 'id' } },
    admin: true,
  },
  {
    name: 'team-project-grants',
    route: '/v1/teams/{teamId}/project-grants',
    paging: cursor,
    parent: { kind: 'teams', params: { teamId: 'id' } },
    admin: true,
  },
  {
    name: 'project-memberships',
    route: '/v1/projects/{projectId}/memberships',
    paging: cursor,
    parent: { kind: 'projects', params: { projectId: 'id' } },
  },
  {
    name: 'sites',
    route: '/v1/projects/{projectId}/sites',
    paging: cursor,
    parent: { kind: 'projects', params: { projectId: 'id' } },
    query: { includeUnregistered: 'true' },
    covers: ['/v1/projects/{projectId}/sites/{siteId}'],
    admin: true,
  },
  {
    name: 'users',
    route: '/v1/identity/users',
    paging: cursor,
    query: { includeUnregistered: 'true', include: 'grants' },
    covers: ['/v1/identity/users/{userId}', '/v1/identity/users/{userId}/grants'],
    admin: true,
  },
  {
    name: 'user-sessions',
    route: '/v1/identity/users/{userId}/sessions',
    paging: whole,
    parent: { kind: 'users', params: { userId: 'userId' } },
    admin: true,
  },
  {
    name: 'user-second-factors',
    route: '/v1/identity/users/{userId}/second-factor',
    paging: 'one',
    parent: { kind: 'users', params: { userId: 'userId' } },
    admin: true,
  },
  {
    name: 'service-accounts',
    route: '/v1/service-accounts',
    paging: cursor,
    query: { includeUnregistered: 'true' },
    covers: ['/v1/service-accounts/{serviceAccountId}'],
    admin: true,
  },
  {
    name: 'api-keys',
    route: '/v1/tokens',
    paging: cursor,
    covers: ['/v1/tokens/{tokenId}'],
    admin: true,
  },
  {
    name: 'signing-keys',
    route: '/v1/signing-keys',
    paging: cursor,
    query: { includeRevoked: 'true' },
    covers: ['/v1/signing-keys/{keyId}'],
  },
  {
    name: 'reviewers',
    route: '/v1/approvals/reviewers',
    paging: cursor,
    covers: ['/v1/approvals/reviewers/{reviewerId}'],
  },
  {
    name: 'identity-providers',
    route: '/v1/auth/providers',
    paging: whole,
    covers: ['/v1/auth/providers/{providerId}'],
  },
  { name: 'sign-in-settings', route: '/v1/auth/settings', paging: 'one', admin: true },

  // Settings.
  { name: 'environments', route: '/v1/environments', paging: cursor, admin: true },
  { name: 'environment-orders', route: '/v1/environment-orders', paging: cursor, admin: true },
  {
    name: 'env',
    route: '/v1/env',
    paging: cursor,
    envScoped: true,
    query: { inherit: 'false' },
    covers: ['/v1/env/{name}'],
  },
  {
    name: 'secrets',
    route: '/v1/secrets',
    paging: cursor,
    envScoped: true,
    query: { inherit: 'false', includeRevoked: 'true' },
    covers: ['/v1/secrets/{name}'],
  },
  {
    name: 'secret-versions',
    route: '/v1/secrets/{name}/versions',
    paging: cursor,
    parent: { kind: 'secrets', params: { name: 'name' } },
    envScoped: true,
    covers: ['/v1/secrets/{name}/versions/{versionId}'],
  },
  { name: 'tenant-config', route: '/v1/tenant/config', paging: cursor },
  {
    name: 'connection-apps',
    route: '/v1/connection-apps',
    paging: cursor,
    query: { includeRemoved: 'true' },
    covers: ['/v1/connection-apps/{appId}'],
    admin: true,
  },
  {
    name: 'connections',
    route: '/v1/connections',
    paging: cursor,
    query: { includeRemoved: 'true' },
    covers: ['/v1/connections/{connectionId}'],
    admin: true,
  },

  // What the packs and the console registered.
  {
    name: 'agents',
    route: '/v1/agents',
    paging: cursor,
    query: { includeRetired: 'true' },
    covers: ['/v1/agents/{agentId}'],
  },
  {
    name: 'agent-versions',
    route: '/v1/agents/{agentId}/versions',
    paging: cursor,
    parent: { kind: 'agents', params: { agentId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/agents/{agentId}/versions/{version}'],
  },
  {
    name: 'agent-live-versions',
    route: '/v1/agents/{agentId}/live-versions',
    paging: whole,
    parent: { kind: 'agents', params: { agentId: 'id' } },
  },
  {
    name: 'agent-promotions',
    route: '/v1/agents/{agentId}/promotions',
    paging: cursor,
    parent: { kind: 'agents', params: { agentId: 'id' } },
    covers: ['/v1/agents/{agentId}/promotions/{promotionId}'],
  },
  {
    name: 'gate-policies',
    route: '/v1/gate-policies',
    paging: cursor,
    covers: ['/v1/gate-policies/{policyId}'],
  },
  {
    name: 'gate-policy-versions',
    route: '/v1/gate-policies/{policyId}/versions',
    paging: whole,
    parent: { kind: 'gate-policies', params: { policyId: 'id' } },
    covers: ['/v1/gate-policies/{policyId}/versions/{version}'],
  },
  {
    name: 'flows',
    route: '/v1/flows',
    paging: cursor,
    query: { includeRetired: 'true' },
    covers: ['/v1/flows/{flowId}'],
  },
  {
    name: 'flow-versions',
    route: '/v1/flows/{flowId}/versions',
    paging: cursor,
    parent: { kind: 'flows', params: { flowId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/flows/{flowId}/versions/{version}'],
  },
  {
    name: 'tools',
    route: '/v1/tools',
    paging: cursor,
    query: { includeRetired: 'true' },
    covers: ['/v1/tools/{toolId}'],
  },
  {
    name: 'tool-versions',
    route: '/v1/tools/{toolId}/versions',
    paging: cursor,
    parent: { kind: 'tools', params: { toolId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/tools/{toolId}/versions/{version}'],
  },
  {
    name: 'guardrails',
    route: '/v1/guardrails',
    paging: cursor,
    covers: ['/v1/guardrails/{guardrailId}'],
  },
  { name: 'blocks', route: '/v1/blocks', paging: cursor, covers: ['/v1/blocks/{blockId}'] },
  {
    name: 'block-versions',
    route: '/v1/blocks/{blockId}/versions',
    paging: cursor,
    parent: { kind: 'blocks', params: { blockId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/blocks/{blockId}/versions/{version}'],
  },
  { name: 'policies', route: '/v1/policies', paging: cursor, covers: ['/v1/policies/{policyId}'] },
  {
    name: 'policy-versions',
    route: '/v1/policies/{policyId}/versions',
    paging: cursor,
    parent: { kind: 'policies', params: { policyId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/policies/{policyId}/versions/{version}'],
  },
  {
    name: 'mcp-endpoints',
    route: '/v1/mcp/endpoints',
    paging: cursor,
    covers: ['/v1/mcp/endpoints/{endpointId}'],
  },
  {
    name: 'capabilities',
    route: '/v1/capabilities',
    paging: cursor,
    covers: ['/v1/capabilities/{capabilityId}'],
  },
  {
    name: 'providers',
    route: '/v1/providers',
    paging: cursor,
    covers: ['/v1/providers/{providerId}'],
  },
  {
    name: 'provider-capabilities',
    route: '/v1/providers/{providerId}/capabilities',
    paging: whole,
    parent: { kind: 'providers', params: { providerId: 'id' } },
  },
  {
    name: 'judge-classes',
    route: '/v1/judge-classes',
    paging: cursor,
    covers: ['/v1/judge-classes/{judgeClassId}'],
  },
  {
    name: 'eval-suites',
    route: '/v1/eval-suites',
    paging: cursor,
    query: { includeRetired: 'true' },
    covers: ['/v1/eval-suites/{suiteId}'],
  },
  {
    name: 'eval-suite-versions',
    route: '/v1/eval-suites/{suiteId}/versions',
    paging: cursor,
    parent: { kind: 'eval-suites', params: { suiteId: 'id' } },
    query: { includeTombstoned: 'true' },
    covers: ['/v1/eval-suites/{suiteId}/versions/{version}'],
  },
  {
    name: 'eval-cases',
    route: '/v1/eval-suites/{suiteId}/versions/{version}/cases',
    paging: cursor,
    parent: { kind: 'eval-suite-versions', params: { suiteId: 'id', version: 'version' } },
  },
  {
    name: 'judging-rules',
    route: '/v1/projects/{projectId}/judging-rules',
    paging: cursor,
    parent: { kind: 'projects', params: { projectId: 'id' } },
    covers: ['/v1/projects/{projectId}/judging-rules/{ruleId}'],
  },
  {
    name: 'judging-rule-versions',
    route: '/v1/projects/{projectId}/judging-rules/{ruleId}/versions',
    paging: cursor,
    parent: { kind: 'judging-rules', params: { projectId: 'projectId', ruleId: 'ruleId' } },
  },
  {
    name: 'deployments',
    route: '/v1/deployments',
    paging: cursor,
    covers: ['/v1/deployments/{deploymentId}'],
  },
  {
    name: 'schedules',
    route: '/v1/schedules',
    paging: cursor,
    covers: ['/v1/schedules/{triggerId}'],
  },
  {
    name: 'schedule-fires',
    route: '/v1/schedules/{triggerId}/fires',
    paging: cursor,
    parent: { kind: 'schedules', params: { triggerId: 'triggerId' } },
  },
  { name: 'webhooks', route: '/v1/webhooks', paging: cursor, covers: ['/v1/webhooks/{triggerId}'] },
  {
    name: 'webhook-fires',
    route: '/v1/webhooks/{triggerId}/fires',
    paging: cursor,
    parent: { kind: 'webhooks', params: { triggerId: 'triggerId' } },
  },
  {
    name: 'mail-triggers',
    route: '/v1/mail-triggers',
    paging: cursor,
    covers: ['/v1/mail-triggers/{triggerId}'],
  },
  {
    name: 'mail-trigger-fires',
    route: '/v1/mail-triggers/{triggerId}/fires',
    paging: cursor,
    parent: { kind: 'mail-triggers', params: { triggerId: 'triggerId' } },
  },
  {
    name: 'webhook-endpoints',
    route: '/v1/webhook-endpoints',
    paging: cursor,
    covers: ['/v1/webhook-endpoints/{endpointId}'],
    admin: true,
  },
  {
    name: 'webhook-deliveries',
    route: '/v1/webhook-endpoints/{endpointId}/deliveries',
    paging: cursor,
    parent: { kind: 'webhook-endpoints', params: { endpointId: 'endpointId' } },
  },

  // What ran, and what came of it.
  {
    name: 'runs',
    route: '/v1/runs',
    paging: cursor,
    query: { replays: 'include', include: 'output' },
    covers: ['/v1/runs/{runId}'],
  },
  {
    name: 'run-journals',
    route: '/v1/runs/{runId}/journal',
    paging: cursor,
    parent: { kind: 'runs', params: { runId: 'id' } },
  },
  {
    name: 'conversations',
    route: '/v1/conversations',
    paging: cursor,
    query: { replays: 'include' },
    covers: ['/v1/conversations/{conversationId}'],
  },
  {
    name: 'conversation-messages',
    route: '/v1/conversations/{conversationId}/messages',
    paging: cursor,
    parent: { kind: 'conversations', params: { conversationId: 'id' } },
  },
  {
    name: 'approvals',
    route: '/v1/approvals',
    paging: cursor,
    covers: ['/v1/approvals/{approvalId}'],
    admin: true,
  },
  {
    name: 'memory-facts',
    route: '/v1/memory/facts',
    paging: cursor,
    covers: ['/v1/memory/facts/{factId}'],
    admin: true,
  },
  {
    name: 'memory-fact-revisions',
    route: '/v1/memory/facts/{factId}/revisions',
    paging: whole,
    parent: { kind: 'memory-facts', params: { factId: 'id' } },
  },
  {
    name: 'memory-erasures',
    route: '/v1/memory/erasures',
    paging: cursor,
    covers: ['/v1/memory/erasures/{erasureId}'],
  },
  {
    name: 'memory-erasure-ledger',
    route: '/v1/memory/erasures/export',
    paging: whole,
    admin: true,
  },
  {
    name: 'proposals',
    route: '/v1/proposals',
    paging: cursor,
    covers: ['/v1/proposals/{proposalId}'],
  },
  {
    name: 'improvement-passes',
    route: '/v1/improvement-passes',
    paging: cursor,
    covers: ['/v1/improvement-passes/{passId}'],
  },
  {
    name: 'provenance',
    route: '/v1/provenance',
    paging: cursor,
    item: { route: '/v1/provenance/{runId}', params: { runId: 'runId' } },
  },
  {
    name: 'judgments',
    route: '/v1/judgments',
    paging: cursor,
    item: { route: '/v1/judgments/{judgmentId}', params: { judgmentId: 'id' } },
  },
  {
    name: 'judging-queue',
    route: '/v1/projects/{projectId}/judging-queue',
    paging: cursor,
    parent: { kind: 'projects', params: { projectId: 'id' } },
  },
  { name: 'observations', route: '/v1/observations', paging: cursor },
  {
    name: 'eval-runs',
    route: '/v1/eval-runs',
    paging: cursor,
    covers: ['/v1/eval-runs/{runId}'],
  },
  {
    name: 'cost-records',
    route: '/v1/cost/records',
    paging: cursor,
    query: { include: 'rawUsage' },
    covers: ['/v1/cost/records/{recordId}'],
  },
  {
    name: 'compliance-evidence',
    route: '/v1/compliance/evidence',
    paging: cursor,
    covers: ['/v1/compliance/evidence/{evidenceId}'],
    admin: true,
  },
  { name: 'sign-ins', route: '/v1/audit/sign-ins', paging: cursor, admin: true },
  { name: 'access-decisions', route: '/v1/audit/authz', paging: cursor },
  {
    name: 'artifacts',
    route: '/v1/artifacts',
    paging: cursor,
    bytes: { route: '/v1/artifacts/{blobId}', params: { blobId: 'blobId' }, dir: 'artifacts' },
  },
  { name: 'export-signing-keys', route: '/v1/export-signing-keys', paging: whole },
];

/** The read routes that aren't exported, each with why. */
export const EXCLUDED: Readonly<Record<string, string>> = {
  // The server, not the workspace.
  '/health': 'the server, not the workspace',
  '/v1/openapi.json': 'the server, not the workspace',
  '/v1/license': 'the server, not the workspace',
  '/v1/license/usage': 'the server, not the workspace',
  '/v1/runtime': 'the server, not the workspace',
  '/v1/adapters': 'the server, not the workspace: the adapters the deployment wired at boot',
  '/v1/adapters/{adapterId}':
    'the server, not the workspace: the adapters the deployment wired at boot',
  '/v1/connection-entries':
    'the server, not the workspace: the apps its deployment ships entries for',
  '/v1/system/keys': "the server's operator routes",
  '/v1/system/tenants': "the server's operator routes",
  '/v1/system/tenants/{tenantId}': "the server's operator routes",
  '/v1/system/tenants/{tenantId}/admins': "the server's operator routes",
  '/v1/system/tenants/{tenantId}/limits': "the server's operator routes",
  '/v1/system/whoami': "the server's operator routes",
  '/v1/system/deployments': "the server's operator routes",
  '/v1/system/pack-env': "the server's operator routes",
  '/v1/system/usage': "the server's operator routes",
  '/v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env':
    "the server's operator routes",
  // The caller, not the workspace.
  '/v1/identity/whoami': 'the caller, not the workspace',
  '/v1/identity/me/permissions': 'the caller, not the workspace',
  '/v1/identity/me/second-factor': 'the caller, not the workspace',
  '/v1/auth/sign-in-options': 'the caller, not the workspace',
  '/v1/auth/providers/{providerId}/sign-in': 'the caller, not the workspace',
  // Live views of records exported elsewhere.
  '/v1/runs/{runId}/stream': 'a live view of run-journals',
  '/v1/runs/{runId}/progress': 'a live view of runs',
  '/v1/runs/{runId}/progress/stream': 'a live view of runs',
  '/v1/eval-runs/{runId}/events': 'a live view of eval-runs',
  '/v1/secrets/{name}/rotations/{rotationId}/events': 'a live view of a rotation',
  // Computed from records that are exported, not stored.
  '/v1/runs/failures': 'computed from runs',
  '/v1/cost/aggregate': 'computed from cost-records',
  '/v1/usage':
    'computed from runs, approvals, cost-records and projects (the metering ledger counts them)',
  '/v1/agents/{agentId}/live': 'computed from agent-live-versions',
  '/v1/agents/{agentId}/gate-policy': 'computed from gate-policies',
  '/v1/agents/{agentId}/projects': 'computed from agent-versions and deployments',
  '/v1/guardrails/{guardrailId}/outcomes': 'computed from runs',
  '/v1/projects/{projectId}/judging-rules/preview': 'computed from judging-rules and runs',
  '/v1/projects/{projectId}/judging-rules/{ruleId}/results': 'computed from judgments',
  '/v1/projects/{projectId}/access':
    'computed from project-memberships, team-project-grants, orgs and users',
  '/v1/projects/default': 'one of projects',
  '/v1/projects/{projectId}/team-grants': 'the same records as team-project-grants',
  '/v1/environment-orders/tenant': 'the same records as environment-orders',
  '/v1/environment-orders/orgs/{orgId}': 'the same records as environment-orders',
  '/v1/providers/{providerId}/check': "a live check of a provider's settings",
  '/v1/deployments/{deploymentId}/values':
    'computed from deployments, tools, agents, providers, secrets and env values',
  '/v1/retention/scheduled': 'computed from the retention policies and the records',
  '/v1/deployments/{deploymentId}/pack-env': 'computed from deployments, env and secrets',
  // Not listed by any route.
  '/v1/secrets/{name}/rotations/{rotationId}':
    "read by the id its rotation's request answered; no route lists rotations, and each rotation's versions are in secret-versions",
  '/v1/connections/requests/{requestId}':
    'read by the id its connect request answered; no route lists connect requests',
  // Read live from another server.
  '/v1/mcp/endpoints/{endpointId}/resources': "read live from the MCP endpoint's own server",
  '/v1/mcp/endpoints/{endpointId}/resources/{uri}': "read live from the MCP endpoint's own server",
  '/v1/mcp/endpoints/{endpointId}/prompts': "read live from the MCP endpoint's own server",
};
