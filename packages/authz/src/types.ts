// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// FGA authorization primitives — public shape.
//
// Owns:
//   - Object type enum (must match the `type X` declarations of the
//     authorization model the deployment's FGA store runs)
//   - Action verb enum (application-facing vocabulary for PEP callers)
//   - Action → computed-relation mapping (PEP → FGA check translation)
//   - Object → allowed-actions catalog (guards against category errors)
//   - Project-scoped type list (`PROJECT_SCOPED_TYPES`): the single source
//     of truth for which types role capabilities and `my-access` report
//
// Consumers:
//   - Principal construction (`principal.ts`) builds {actor, onBehalfOf?}
//   - PEPs check `ACTION_TO_RELATION[action]` on a resource through an
//     `AuthzCheckBinding` (`check.ts`)
//   - Policy executors reuse ObjectType for policy matching

export const OBJECT_TYPES = [
  // Structural / boundary
  'tenant',
  'org',
  'team',
  'project',
  'user',
  // A service account is a tenant-global, non-human identity, like `user`
  // not granted through project roles. `act_as` on it is a tenant-admin
  // delegation (naming it as a trigger's owner), never a project grant, so
  // it is kept out of `PROJECT_SCOPED_TYPES` below.
  'service_account',
  // Content (project-scoped, user-authored)
  'agent',
  'flow',
  'tool',
  'guardrail',
  'eval_suite',
  'trigger',
  'conversation',
  // Config (polymorphic scope)
  'secret',
  'env',
  'mcp_endpoint',
  // Runtime
  'run',
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export const ACTIONS = [
  'read',
  'write',
  'delete',
  'admin',
  'execute',
  'invoke',
  'publish',
  'rotate',
  'fire',
  'cancel',
  'promote',
  // Delegation: naming a principal as the one a trigger's runs act as.
  'act_as',
  // Running an agent in a project: asked of the project only
  // (`CHECK_ONLY_ACTIONS`).
  'call',
  // Being in the tenant at all, as a member, an admin or an observer:
  // asked of the tenant only (`CHECK_ONLY_ACTIONS`).
  'belong',
  // Being the tenant's observer, who can only view the projects they're
  // given: asked of the tenant only (`CHECK_ONLY_ACTIONS`).
  'only_view',
] as const;

export type Action = (typeof ACTIONS)[number];

export const ACTION_TO_RELATION: Record<Action, string> = {
  read: 'can_read',
  write: 'can_write',
  delete: 'can_delete',
  admin: 'can_admin',
  execute: 'can_execute',
  invoke: 'can_invoke',
  publish: 'can_publish',
  rotate: 'can_rotate',
  fire: 'can_fire',
  cancel: 'can_cancel',
  promote: 'can_promote',
  act_as: 'can_act_as',
  call: 'can_call',
  belong: 'can_belong',
  only_view: 'can_only_view',
};

// Which verbs are meaningful for which object types. A PEP uses this to
// reject e.g. `rotate` on `agent:X` before calling FGA.
export const OBJECT_ACTIONS: Record<ObjectType, readonly Action[]> = {
  tenant: ['read', 'admin'],
  org: ['read', 'admin'],
  team: ['read', 'admin'],
  project: ['read', 'write', 'admin', 'delete'],
  user: [],
  // Only `act_as`: a tenant admin may name this service account as a
  // trigger's owner (so the trigger's runs act as it). No read/write/etc.
  // here — the account's lifecycle is its binding's, not an authz object's.
  service_account: ['act_as'],

  agent: ['read', 'write', 'delete', 'admin', 'execute', 'publish', 'promote'],
  flow: ['read', 'write', 'delete', 'admin', 'execute', 'publish'],
  tool: ['read', 'write', 'delete', 'admin', 'invoke'],
  guardrail: ['read', 'write', 'delete', 'admin'],
  eval_suite: ['read', 'write', 'delete', 'admin', 'execute', 'publish'],
  trigger: ['read', 'write', 'delete', 'admin', 'fire'],
  conversation: ['read', 'write', 'delete', 'admin'],

  secret: ['read', 'write', 'delete', 'admin', 'rotate'],
  env: ['read', 'write', 'delete', 'admin'],
  mcp_endpoint: ['read', 'write', 'delete', 'admin'],

  run: ['read', 'cancel', 'delete'],
};

/**
 * Actions a check may ask of a type that `OBJECT_ACTIONS` doesn't list.
 * The model defines them, but nothing reports them: `OBJECT_ACTIONS` is
 * also the list a caller's permissions report and the role capabilities
 * name per type (`RoleActions`), and clients validate that list, so an
 * action added there is a change on the wire.
 *
 * A project's `call` and `execute` are what running an agent, a flow or
 * an eval suite asks of the project the run is in, when the item is
 * served by more than one project: `call` (an editor or a caller of the
 * project) for an agent, `execute` (an editor or an executor) for a flow
 * or a suite. They're the rights an item inherits from its project as
 * `execute`, asked of the project itself.
 *
 * A tenant's `belong` and `only_view` say who is in the tenant and who is
 * its observer. An observer reads only the projects they're given, so the
 * tenant's `read` isn't theirs. `belong` (a member, an admin or an
 * observer) is what the tenant's own record and the deployments read
 * floor ask instead. `only_view` is what the routes refused to an
 * observer ask: minting an API key, a public run link, a provenance
 * export.
 */
export const CHECK_ONLY_ACTIONS: Partial<Record<ObjectType, readonly Action[]>> = {
  tenant: ['belong', 'only_view'],
  project: ['call', 'execute'],
};

// Tenant-global identities and structural boundaries: object types that are
// NOT granted through project roles. A service account is one of these — its
// `act_as` is a tenant-admin delegation, not a project capability.
export const TENANT_GLOBAL_TYPES = ['tenant', 'org', 'team', 'user', 'service_account'] as const;

// The object types reported per-type in role capabilities (the API's
// `RoleActionsSchema` / `normalizeCapabilities`). ONE source of truth within
// this SDK: every consumer here imports this list, so the capabilities wire
// shape stays consistent. The runtime's `my-access` projection keeps its own
// positively-written list for now and so CAN differ; the runtime change that
// adds `service_account` switches that projection to import this list, after
// which the two can't drift. Tenant-global types (`TENANT_GLOBAL_TYPES`) are
// left out; new project-scoped content types are included automatically.
export const PROJECT_SCOPED_TYPES: readonly ObjectType[] = OBJECT_TYPES.filter(
  (t) => !(TENANT_GLOBAL_TYPES as readonly string[]).includes(t),
);

export interface ResourceRef {
  readonly type: ObjectType;
  readonly id: string;
}

export function resourceKey(ref: ResourceRef): string {
  return `${ref.type}:${ref.id}`;
}
