// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// FGA VOCABULARY — builds the OpenFGA `user`/`relation`/`object` tuple
// strings. Callers deal in typed EntityRefs and call tuplesForCreate /
// tuplesForDelete and the grant helpers below; principal subjects come
// from `fgaSubject` (`principal.ts`).
//
// Keeping the tuple format here means another authorization backend
// changes this file, not its callers.
//

import type {
  AgentId,
  FlowId,
  GuardrailId,
  OrgId,
  ProjectId,
  RunId,
  TeamId,
  TenantId,
  ToolId,
  UserId,
} from '@kindgi/types';

import type { TupleIntent } from './enqueue.js';

// @kindgi/types has no branded EvalSuiteId / SecretId / EnvId /
// McpEndpointId; these aliases are plain strings.
type EvalSuiteId = string;
type SecretId = string;
type EnvId = string;
type McpEndpointId = string;

// ============================================================
// SUBJECT HELPERS
// ============================================================

export function userSubject(id: UserId): string {
  return `user:${id}`;
}

export function teamMemberSubject(id: TeamId): string {
  return `team:${id}#member`;
}

// ============================================================
// OBJECT HELPERS
// ============================================================

export function tenantObject(id: TenantId): string {
  return `tenant:${id}`;
}

export function orgObject(id: OrgId): string {
  return `org:${id}`;
}

export function teamObject(id: TeamId): string {
  return `team:${id}`;
}

export function projectObject(id: ProjectId): string {
  return `project:${id}`;
}

export function agentObject(id: AgentId): string {
  return `agent:${id}`;
}

export function flowObject(id: FlowId): string {
  return `flow:${id}`;
}

export function toolObject(id: ToolId): string {
  return `tool:${id}`;
}

export function guardrailObject(id: GuardrailId): string {
  return `guardrail:${id}`;
}

export function evalSuiteObject(id: EvalSuiteId): string {
  return `eval_suite:${id}`;
}

export function secretObject(id: SecretId): string {
  return `secret:${id}`;
}

export function envObject(id: EnvId): string {
  return `env:${id}`;
}

export function mcpEndpointObject(id: McpEndpointId): string {
  return `mcp_endpoint:${id}`;
}

export function runObject(id: RunId): string {
  return `run:${id}`;
}

// ============================================================
// SCOPE HELPER — for polymorphic config entities
// ============================================================

export type Scope =
  | { readonly kind: 'tenant'; readonly tenantId: TenantId }
  | { readonly kind: 'org'; readonly tenantId: TenantId; readonly orgId: OrgId }
  | { readonly kind: 'project'; readonly tenantId: TenantId; readonly projectId: ProjectId };

export function scopeSubject(scope: Scope): string {
  switch (scope.kind) {
    case 'tenant':
      return tenantObject(scope.tenantId);
    case 'org':
      return orgObject(scope.orgId);
    case 'project':
      return projectObject(scope.projectId);
  }
}

// ============================================================
// ENTITY REFS — typed carriers passed to the tuple generators
// ============================================================

export type EntityRef =
  // Structural
  | {
      readonly kind: 'org';
      readonly id: OrgId;
      readonly tenantId: TenantId;
    }
  | {
      readonly kind: 'project';
      readonly id: ProjectId;
      readonly tenantId: TenantId;
      readonly orgId?: OrgId;
    }
  | {
      readonly kind: 'team';
      readonly id: TeamId;
      readonly tenantId: TenantId;
      readonly orgId?: OrgId;
    }
  // Content (project-scoped)
  | {
      readonly kind: 'agent';
      readonly id: AgentId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: 'flow';
      readonly id: FlowId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: 'tool';
      readonly id: ToolId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: 'guardrail';
      readonly id: GuardrailId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: 'eval_suite';
      readonly id: EvalSuiteId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    }
  // Config (polymorphic scope)
  | {
      readonly kind: 'secret';
      readonly id: SecretId;
      readonly tenantId: TenantId;
      readonly scope: Scope;
    }
  | {
      readonly kind: 'env';
      readonly id: EnvId;
      readonly tenantId: TenantId;
      readonly scope: Scope;
    }
  | {
      readonly kind: 'mcp_endpoint';
      readonly id: McpEndpointId;
      readonly tenantId: TenantId;
      readonly scope: Scope;
    }
  // Runtime
  | {
      readonly kind: 'run';
      readonly id: RunId;
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
    };

// ============================================================
// TUPLE GENERATORS FOR CREATE / DELETE
// ============================================================

export function tuplesForCreate(entity: EntityRef, creatorUserId?: UserId): TupleIntent[] {
  switch (entity.kind) {
    case 'org': {
      const tuples: TupleIntent[] = [
        {
          operation: 'write',
          user: tenantObject(entity.tenantId),
          relation: 'parent',
          object: orgObject(entity.id),
        },
      ];
      if (creatorUserId !== undefined) {
        tuples.push({
          operation: 'write',
          user: userSubject(creatorUserId),
          relation: 'admin',
          object: orgObject(entity.id),
        });
      }
      return tuples;
    }

    case 'team': {
      const tuples: TupleIntent[] = [
        {
          operation: 'write',
          user:
            entity.orgId !== undefined ? orgObject(entity.orgId) : tenantObject(entity.tenantId),
          relation: 'parent',
          object: teamObject(entity.id),
        },
      ];
      if (creatorUserId !== undefined) {
        tuples.push({
          operation: 'write',
          user: userSubject(creatorUserId),
          relation: 'admin',
          object: teamObject(entity.id),
        });
      }
      return tuples;
    }

    case 'project': {
      const tuples: TupleIntent[] = [
        {
          operation: 'write',
          user:
            entity.orgId !== undefined ? orgObject(entity.orgId) : tenantObject(entity.tenantId),
          relation: 'parent',
          object: projectObject(entity.id),
        },
      ];
      if (creatorUserId !== undefined) {
        tuples.push({
          operation: 'write',
          user: userSubject(creatorUserId),
          relation: 'owner',
          object: projectObject(entity.id),
        });
      }
      return tuples;
    }

    case 'agent':
    case 'flow':
    case 'tool':
    case 'guardrail':
    case 'eval_suite': {
      const object = contentObject(entity);
      const tuples: TupleIntent[] = [
        {
          operation: 'write',
          user: projectObject(entity.projectId),
          relation: 'parent',
          object,
        },
      ];
      if (creatorUserId !== undefined) {
        tuples.push({
          operation: 'write',
          user: userSubject(creatorUserId),
          relation: 'owner',
          object,
        });
      }
      return tuples;
    }

    case 'secret':
    case 'env':
    case 'mcp_endpoint': {
      const object = configObject(entity);
      const tuples: TupleIntent[] = [
        {
          operation: 'write',
          user: scopeSubject(entity.scope),
          relation: 'scope',
          object,
        },
      ];
      if (creatorUserId !== undefined) {
        tuples.push({
          operation: 'write',
          user: userSubject(creatorUserId),
          relation: 'admin',
          object,
        });
      }
      return tuples;
    }

    case 'run':
      // Runs are system-created; no `owner` role (read access comes
      // through the parent project).
      return [
        {
          operation: 'write',
          user: projectObject(entity.projectId),
          relation: 'parent',
          object: runObject(entity.id),
        },
      ];
  }
}

export function tuplesForDelete(entity: EntityRef): TupleIntent[] {
  // Deletes only the parent/scope tuple written at create time. Role
  // and grant tuples added later (membership / grant helpers below)
  // are removed separately by whoever wrote them. Orphan tuples are
  // safe — they only reference objects that no longer exist.
  switch (entity.kind) {
    case 'org':
      return [
        {
          operation: 'delete',
          user: tenantObject(entity.tenantId),
          relation: 'parent',
          object: orgObject(entity.id),
        },
      ];
    case 'team':
      return [
        {
          operation: 'delete',
          user:
            entity.orgId !== undefined ? orgObject(entity.orgId) : tenantObject(entity.tenantId),
          relation: 'parent',
          object: teamObject(entity.id),
        },
      ];
    case 'project':
      return [
        {
          operation: 'delete',
          user:
            entity.orgId !== undefined ? orgObject(entity.orgId) : tenantObject(entity.tenantId),
          relation: 'parent',
          object: projectObject(entity.id),
        },
      ];
    case 'agent':
    case 'flow':
    case 'tool':
    case 'guardrail':
    case 'eval_suite':
      return [
        {
          operation: 'delete',
          user: projectObject(entity.projectId),
          relation: 'parent',
          object: contentObject(entity),
        },
      ];
    case 'secret':
    case 'env':
    case 'mcp_endpoint':
      return [
        {
          operation: 'delete',
          user: scopeSubject(entity.scope),
          relation: 'scope',
          object: configObject(entity),
        },
      ];
    case 'run':
      return [
        {
          operation: 'delete',
          user: projectObject(entity.projectId),
          relation: 'parent',
          object: runObject(entity.id),
        },
      ];
  }
}

// ============================================================
// MEMBERSHIP / GRANT TUPLES
// ============================================================

export type TeamRole = 'member' | 'admin';
export type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer';

export function teamMembershipTuple(
  op: 'write' | 'delete',
  teamId: TeamId,
  userId: UserId,
  role: TeamRole,
): TupleIntent {
  return {
    operation: op,
    user: userSubject(userId),
    relation: role,
    object: teamObject(teamId),
  };
}

export function projectMembershipTuple(
  op: 'write' | 'delete',
  projectId: ProjectId,
  userId: UserId,
  role: ProjectRole,
): TupleIntent {
  return {
    operation: op,
    user: userSubject(userId),
    relation: role,
    object: projectObject(projectId),
  };
}

export function teamProjectGrantTuple(
  op: 'write' | 'delete',
  projectId: ProjectId,
  teamId: TeamId,
  role: Exclude<ProjectRole, 'owner'>,
): TupleIntent {
  return {
    operation: op,
    user: teamMemberSubject(teamId),
    relation: role,
    object: projectObject(projectId),
  };
}

// ============================================================
// MACHINE-SUBJECT TUPLES
// ============================================================
//
// Least-privilege grants admitting `agent:X` OR `service_account:X`
// as subject on the narrow capability relations of the FGA model:
//
//   tool.invoker         — can invoke this tool
//   flow.executor       — can execute this flow
//   eval_suite.executor  — can execute this suite
//   agent.caller         — can invoke this agent (agent-agent + SA-agent)
//   secret.reader        — can read this secret
//   env.reader           — can read this env var
//   mcp_endpoint.reader  — can talk to this MCP endpoint
//

export type MachineSubject =
  | { readonly kind: 'agent'; readonly id: AgentId | string }
  | { readonly kind: 'service_account'; readonly id: string };

export type AgentAccessResource =
  | { readonly type: 'tool'; readonly id: ToolId }
  | { readonly type: 'flow'; readonly id: FlowId }
  | { readonly type: 'eval_suite'; readonly id: EvalSuiteId }
  | { readonly type: 'agent'; readonly id: AgentId }
  | { readonly type: 'secret'; readonly id: SecretId }
  | { readonly type: 'env'; readonly id: EnvId }
  | { readonly type: 'mcp_endpoint'; readonly id: McpEndpointId };

function machineSubjectString(subject: MachineSubject): string {
  return `${subject.kind}:${subject.id}`;
}

/**
 * Generic machine-subject grant. Works for both `agent` and
 * `service_account` — the capability relations admit both.
 */
export function machineAccessTuple(
  op: 'write' | 'delete',
  subject: MachineSubject,
  resource: AgentAccessResource,
): TupleIntent {
  const subjectString = machineSubjectString(subject);
  switch (resource.type) {
    case 'tool':
      return {
        operation: op,
        user: subjectString,
        relation: 'invoker',
        object: toolObject(resource.id),
      };
    case 'flow':
      return {
        operation: op,
        user: subjectString,
        relation: 'executor',
        object: flowObject(resource.id),
      };
    case 'eval_suite':
      return {
        operation: op,
        user: subjectString,
        relation: 'executor',
        object: evalSuiteObject(resource.id),
      };
    case 'agent':
      return {
        operation: op,
        user: subjectString,
        relation: 'caller',
        object: agentObject(resource.id),
      };
    case 'secret':
      return {
        operation: op,
        user: subjectString,
        relation: 'reader',
        object: secretObject(resource.id),
      };
    case 'env':
      return {
        operation: op,
        user: subjectString,
        relation: 'reader',
        object: envObject(resource.id),
      };
    case 'mcp_endpoint':
      return {
        operation: op,
        user: subjectString,
        relation: 'reader',
        object: mcpEndpointObject(resource.id),
      };
  }
}

/**
 * Agent-subject shorthand for
 * `machineAccessTuple(op, { kind: 'agent', id: agentId }, resource)`.
 */
export function agentAccessTuple(
  op: 'write' | 'delete',
  agentId: AgentId,
  resource: AgentAccessResource,
): TupleIntent {
  return machineAccessTuple(op, { kind: 'agent', id: agentId }, resource);
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

function contentObject(
  entity: Extract<EntityRef, { kind: 'agent' | 'flow' | 'tool' | 'guardrail' | 'eval_suite' }>,
): string {
  switch (entity.kind) {
    case 'agent':
      return agentObject(entity.id);
    case 'flow':
      return flowObject(entity.id);
    case 'tool':
      return toolObject(entity.id);
    case 'guardrail':
      return guardrailObject(entity.id);
    case 'eval_suite':
      return evalSuiteObject(entity.id);
  }
}

function configObject(
  entity: Extract<EntityRef, { kind: 'secret' | 'env' | 'mcp_endpoint' }>,
): string {
  switch (entity.kind) {
    case 'secret':
      return secretObject(entity.id);
    case 'env':
      return envObject(entity.id);
    case 'mcp_endpoint':
      return mcpEndpointObject(entity.id);
  }
}
