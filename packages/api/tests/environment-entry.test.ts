// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A later environment of an environment order takes builds only by
 * promotion: publishing an agent, a flow, a tool, a guardrail or a data
 * block through the API into one is refused with `409
 * environment-takes-promotions`, before anything is written. The first
 * environment, and a project in no order, take them as before. An eval
 * test set isn't refused: it's test data, published in any environment. The
 * deploy and derive refusals are tested with their routes.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { CreateAppInput, TokenResolver } from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { fullAppInput } from './support/full-app.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'environment-entry-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

/** Each publish route, the noun its refusal names, and the registry it would write to. */
const KINDS = [
  { path: '/v1/agents', noun: 'agent', registry: 'agentRegistry' },
  { path: '/v1/flows', noun: 'flow', registry: 'flowRegistry' },
  { path: '/v1/tools', noun: 'tool', registry: 'toolRegistry' },
  { path: '/v1/guardrails', noun: 'guardrail', registry: 'guardrailRegistry' },
  { path: '/v1/blocks', noun: 'data block', registry: 'blockRegistry' },
] as const;

/** Grants everything but the reads named in `denied`. */
function decision(denied: readonly string[], action: Action, resource: ResourceRef): Decision {
  const allowed = !denied.includes(`${action} ${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: denied',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/**
 * The app with every route mounted and every registry's publish counted,
 * over four projects: `staging1`, `staging2` and `prod` make an order
 * unless `ordered` is false, and `other` is in none. `hidesFirst`: run
 * with an authorizer that grants everything but reading `staging1`.
 */
async function harness(opts: { ordered?: boolean; hidesFirst?: boolean } = {}) {
  const input = fullAppInput();
  const project = async (name: string) => {
    const created = await input.projectBinding?.create(tenantId, {
      name,
      slug: `${name}-${randomUUID()}`,
    });
    if (created?.kind !== 'ok') throw new Error(`creating project ${name} failed`);
    return created.projectId as ProjectId;
  };
  const staging1 = await project('staging-1');
  const staging2 = await project('staging-2');
  const prod = await project('prod');
  const other = await project('other');
  const writes: string[] = [];
  const counted = <T extends { publish: (...args: never[]) => unknown }>(
    name: string,
    r: T,
  ): T => ({
    ...r,
    publish: (async (...args: never[]) => {
      writes.push(name);
      return r.publish(...args);
    }) as T['publish'],
  });
  const registries = Object.fromEntries(
    [...KINDS.map((k) => k.registry), 'testSetRegistry' as const].map((name) => [
      name,
      counted(name, input[name] as never),
    ]),
  ) as Partial<CreateAppInput>;
  const denied = opts.hidesFirst === true ? [`read project:${staging1}`] : undefined;
  const app = createApp({
    ...input,
    ...registries,
    resolveToken,
    ...(opts.ordered !== false && {
      environmentOrders: environmentOrders([[staging1, staging2, prod]]),
    }),
    ...(denied !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decision(denied, action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((resource) => decision(denied, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { post, writes, staging1, staging2, prod, other };
}

describe('publishing through the API into an environment order', () => {
  test.each(KINDS)(
    'a $noun into a later environment: 409 environment-takes-promotions, nothing written',
    async ({ path, noun }) => {
      const { post, writes, staging1, staging2 } = await harness();
      const res = await post(path, { projectId: staging2 });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe('environment-takes-promotions');
      expect(res.body.error.message).toBe(
        `This project is a later environment of its environment order (position 1), and a later environment takes builds only by promotion from the one before it. Publish the ${noun} in the order's first environment instead: what moves between environments is builds, so a version published through the API stays in the environment it was published in. Nothing was published.`,
      );
      expect(res.body.error.details).toEqual({ firstProjectId: staging1, position: 1 });
      expect(writes).toEqual([]);
    },
  );

  test.each(KINDS)('a $noun into the last environment names its place', async ({ path }) => {
    const { post, staging1, prod } = await harness();
    const res = await post(path, { projectId: prod });
    expect([res.status, res.body.error?.code]).toEqual([409, 'environment-takes-promotions']);
    expect(res.body.error.details).toEqual({ firstProjectId: staging1, position: 2 });
  });

  test.each(KINDS)(
    'a $noun into the first environment, or a project in no order, goes on to its checks',
    async ({ path }) => {
      const { post, staging1, other } = await harness();
      for (const projectId of [staging1, other]) {
        const res = await post(path, { projectId });
        expect(res.body.error?.code).not.toBe('environment-takes-promotions');
      }
    },
  );

  test.each(KINDS)('a $noun with no orders wired goes on to its checks', async ({ path }) => {
    const { post, staging2 } = await harness({ ordered: false });
    const res = await post(path, { projectId: staging2 });
    expect(res.body.error?.code).not.toBe('environment-takes-promotions');
  });

  test('an test set is published in a later environment: test data, not a build', async () => {
    const { post, writes, staging2 } = await harness();
    const res = await post('/v1/test-sets', {
      id: 'acme.drafting-accuracy',
      version: '1.0.0',
      kind: 'accuracy',
      spec: {
        cases: [{ input: 'draft a clause', expectedOutput: 'a clause' }],
        grader: { adapterId: 'eval-judge-ajv' },
      },
      projectId: staging2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(writes).toEqual(['testSetRegistry']);
  });

  test("a caller who can't read the first environment isn't told which it is", async () => {
    const { post, staging2 } = await harness({ hidesFirst: true });
    for (const { path } of KINDS) {
      const res = await post(path, { projectId: staging2 });
      expect([path, res.status, res.body.error?.code]).toEqual([
        path,
        409,
        'environment-takes-promotions',
      ]);
      expect(res.body.error.details).toEqual({ position: 1 });
    }
  });
});
