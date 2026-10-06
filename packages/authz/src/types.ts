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
};

// Which verbs are meaningful for which object types. A PEP uses this to
// reject e.g. `rotate` on `agent:X` before calling FGA.
export const OBJECT_ACTIONS: Record<ObjectType, readonly Action[]> = {
  tenant: ['read', 'admin'],
  org: ['read', 'admin'],
  team: ['read', 'admin'],
  project: ['read', 'write', 'admin', 'delete'],
  user: [],

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

export interface ResourceRef {
  readonly type: ObjectType;
  readonly id: string;
}

export function resourceKey(ref: ResourceRef): string {
  return `${ref.type}:${ref.id}`;
}
