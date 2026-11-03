// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `act_as` needs a real `service_account` object type (the PEP refuses an
 * unknown type/action pair), but that type must NOT reach the role
 * capabilities: `RoleActionsSchema` and `normalizeCapabilities` both iterate
 * `PROJECT_SCOPED_TYPES`, so a `service_account` on that list would put a
 * required, always-empty `service_account: []` on every role.
 *
 * `service_account` is tenant-global, so it's excluded by one source
 * (`TENANT_GLOBAL_TYPES`). These tests pin the result: the type exists and
 * carries `act_as`, the project-scoped set is byte-unchanged, and dropping
 * the exclusion fails loudly.
 */

import { describe, expect, test } from 'vitest';

import {
  ACTIONS,
  ACTION_TO_RELATION,
  OBJECT_ACTIONS,
  OBJECT_TYPES,
  PROJECT_SCOPED_TYPES,
  TENANT_GLOBAL_TYPES,
} from '@kindgi/authz';

import { RoleActionsSchema } from '../src/openapi/schemas.js';

/**
 * The project-scoped types, in order — the exact key set of the role
 * capabilities on the wire. Changing it is a wire change; adding
 * `service_account` here (dropping the exclusion) makes this fail.
 */
const PROJECT_SCOPED = [
  'project',
  'agent',
  'flow',
  'tool',
  'guardrail',
  'test_set',
  'trigger',
  'conversation',
  'secret',
  'env',
  'mcp_endpoint',
  'run',
] as const;

describe('the service_account type exists, for the PEP', () => {
  test('it is an object type with an act_as action and relation', () => {
    expect(OBJECT_TYPES).toContain('service_account');
    expect(ACTIONS).toContain('act_as');
    expect(OBJECT_ACTIONS.service_account).toEqual(['act_as']);
    expect(ACTION_TO_RELATION.act_as).toBe('can_act_as');
  });

  test('it is tenant-global, not project-scoped', () => {
    expect(TENANT_GLOBAL_TYPES).toContain('service_account');
    expect(PROJECT_SCOPED_TYPES).not.toContain('service_account');
  });
});

describe('the project-scoped set is byte-unchanged', () => {
  test('PROJECT_SCOPED_TYPES is exactly the expected list, in order', () => {
    expect([...PROJECT_SCOPED_TYPES]).toEqual([...PROJECT_SCOPED]);
  });

  test('it is OBJECT_TYPES minus the tenant-global ones — the exclusion is real', () => {
    const derived = OBJECT_TYPES.filter(
      (t) => !(TENANT_GLOBAL_TYPES as readonly string[]).includes(t),
    );
    expect([...PROJECT_SCOPED_TYPES]).toEqual(derived);
    // No tenant-global type (service_account among them) leaks onto the list.
    for (const global of TENANT_GLOBAL_TYPES) {
      expect(PROJECT_SCOPED_TYPES).not.toContain(global);
    }
  });
});

describe('the role-capabilities wire shape has not moved', () => {
  const schema = RoleActionsSchema as unknown as {
    required: readonly string[];
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };

  test('required and property keys are the project-scoped set, no service_account', () => {
    expect(schema.required).toEqual([...PROJECT_SCOPED]);
    expect(Object.keys(schema.properties)).toEqual([...PROJECT_SCOPED]);
    expect(schema.properties).not.toHaveProperty('service_account');
    expect(schema.additionalProperties).toBe(false);
  });

  test('every project-scoped type enumerates exactly its OBJECT_ACTIONS', () => {
    for (const type of PROJECT_SCOPED_TYPES) {
      const prop = schema.properties[type] as { items: { enum: readonly string[] } };
      expect(prop.items.enum).toEqual([...OBJECT_ACTIONS[type]]);
    }
  });
});
