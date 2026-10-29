// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/agents/:agentId/projects`: the projects an agent runs in, the
 * one it was first published in first, named only when the caller reads
 * them. An environment order carries `acme.desk` from staging to prod;
 * `acme.solo` has one project; `acme.retired` was shipped to prod before
 * its every version was unregistered.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { CreateAppInput, TokenResolver } from '../src/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { type Grant, type ItemRow, grantsAuthz, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;
const OTHER = randomUUID() as ProjectId;

const SERVED = 'acme.desk';
const SOLO = 'acme.solo';
const RETIRED = 'acme.retired';

/** Each agent version: the project its record names, and whether it's still registered. */
const VERSIONS = [
  { id: SERVED, version: '1.0.0', projectId: STAGING, active: true },
  { id: SERVED, version: '1.1.0', projectId: STAGING, active: true },
  { id: SOLO, version: '1.0.0', projectId: OTHER, active: true },
  { id: RETIRED, version: '1.0.0', projectId: STAGING, active: false },
] as const;

/** What the binding answers: each agent's projects, the one it was first published in first. */
const ROWS: ItemRow[] = [
  { kind: 'agent', id: SERVED, projects: [STAGING, PROD] },
  { kind: 'agent', id: SOLO, projects: [OTHER] },
  { kind: 'agent', id: RETIRED, projects: [STAGING, PROD] },
];

/**
 * The agent registry over `VERSIONS`. `listed` records each versions
 * list asked. With `projectless`, no record names a project, as
 * `kindgi dev`'s pack read from disk.
 */
function agentRegistry(projectless: boolean) {
  const listed: Record<string, unknown>[] = [];
  const of = (agentId: string, all: boolean) =>
    VERSIONS.filter((v) => v.id === agentId && (all || v.active)).map((v) => ({
      id: v.id,
      version: v.version,
      ...(!projectless && { projectId: v.projectId }),
      tenantId,
      name: v.id,
      instructions: 'Answer the desk.',
      capabilities: [],
      tools: [],
      retrieval: [],
      guardrails: [],
      publishedAt: '2026-10-01T00:00:00.000Z',
    }));
  return {
    listed,
    async get({ agentId }: { agentId: string }) {
      return of(agentId, false).at(-1) ?? null;
    },
    async headExists({ agentId }: { agentId: string }) {
      return of(agentId, true).length > 0;
    },
    async listVersions(input: { agentId: string; limit: number; includeTombstoned?: boolean }) {
      listed.push({ ...input });
      return { data: of(input.agentId, input.includeTombstoned === true).slice(0, input.limit) };
    },
  };
}

const PEOPLE: Record<string, readonly Grant[]> = {
  both: [`read project:${STAGING}`, `read project:${PROD}`],
  prod: [`read project:${PROD}`],
  staging: [`read project:${STAGING}`],
  /** Reads `acme.desk` by a grant on it, and no project. */
  direct: [`read agent:${SERVED}`],
  /** Reads `acme.desk` by a grant on it, and staging. */
  desk: [`read agent:${SERVED}`, `read project:${STAGING}`],
  solo: [`read agent:${SOLO}`, `read project:${OTHER}`],
  nobody: [],
};

const resolveToken: TokenResolver = async (token) => {
  const [who, keyProject] = token.split('@');
  if (who === undefined || !(who in PEOPLE)) return null;
  return {
    tenantId,
    userId: who as UserId,
    ...(keyProject !== undefined && { tokenProjectId: keyProject }),
  };
};

/**
 * The app over the three agents. Without `served`, no item-projects
 * binding: every agent has one project. Without `authorized`, no
 * authorizer.
 */
function harness(opts: { served?: boolean; authorized?: boolean; projectless?: boolean } = {}) {
  const registry = agentRegistry(opts.projectless === true);
  const items = itemProjects(ROWS);
  const authz = grantsAuthz(PEOPLE, { [`agent:${SERVED}`]: STAGING, [`agent:${SOLO}`]: OTHER });
  const app = createApp({
    ...createStubAppBindings(),
    agentRegistry: registry,
    resolveToken,
    ...(opts.authorized !== false && { authz: authz.authz }),
    ...(opts.served !== false && { itemProjects: items }),
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as unknown as CreateAppInput);
  const get = async (who: string, path: string) => {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${who}`, 'x-request-id': 'req-agent-projects' },
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  /** The projects answered, in order; fails on anything but a 200. */
  const projectsOf = async (who: string, agentId: string) => {
    const res = await get(who, `/v1/agents/${agentId}/projects`);
    expect(res.status, res.text).toBe(200);
    return (res.body.data as { projectId: string }[]).map((p) => p.projectId);
  };
  return { get, projectsOf, items: items.asked, listed: registry.listed };
}

describe('GET /v1/agents/:agentId/projects', () => {
  test('its first project first, then the others, each once', async () => {
    const { projectsOf, get } = harness();
    expect(await projectsOf('both', SERVED)).toEqual([STAGING, PROD]);
    const res = await get('both', `/v1/agents/${SERVED}/projects`);
    expect(res.body).toEqual({ data: [{ projectId: STAGING }, { projectId: PROD }] });
  });

  test('only the projects the caller reads, its first one included', async () => {
    const { projectsOf } = harness();
    expect(await projectsOf('prod', SERVED)).toEqual([PROD]);
    expect(await projectsOf('staging', SERVED)).toEqual([STAGING]);
    // A grant on the agent alone reads it, and names no project.
    expect(await projectsOf('direct', SERVED)).toEqual([]);
  });

  test('a key limited to a project names that project alone, whatever its owner reads', async () => {
    const { projectsOf } = harness();
    expect(await projectsOf(`both@${PROD}`, SERVED)).toEqual([PROD]);
  });

  test('the binding is asked once a request, though the rights and the route both need it', async () => {
    const { projectsOf, items } = harness();
    await projectsOf('both', SERVED);
    expect(items.filter((a) => a === `projectsOf agent ${SERVED}`)).toHaveLength(1);
  });

  test('a caller who may not read the agent: the refusal GET /:agentId gives', async () => {
    const { get } = harness();
    for (const id of [SERVED, SOLO]) {
      const projects = await get('nobody', `/v1/agents/${id}/projects`);
      const agent = await get('nobody', `/v1/agents/${id}`);
      expect(projects.status, projects.text).toBe(403);
      expect(projects.status).toBe(agent.status);
      expect(projects.body.error.code).toBe(agent.body.error.code);
    }
  });

  test('an agent with one project: that project, for a caller who reads it', async () => {
    const { projectsOf } = harness();
    expect(await projectsOf('solo', SOLO)).toEqual([OTHER]);
  });

  test('a retired agent still answers, with the projects it was shipped into', async () => {
    const { projectsOf } = harness();
    expect(await projectsOf('both', RETIRED)).toEqual([STAGING, PROD]);
    expect(await projectsOf('prod', RETIRED)).toEqual([PROD]);
  });

  test('no such agent: 404 agent-not-found, with the binding or without', async () => {
    for (const served of [true, false]) {
      const { get } = harness({ served, authorized: false });
      const res = await get('nobody', '/v1/agents/acme.missing/projects');
      expect(res.status, res.text).toBe(404);
      expect(res.body.error.code).toBe('agent-not-found');
    }
  });

  test('no authorizer: every project is named', async () => {
    const { projectsOf } = harness({ authorized: false });
    expect(await projectsOf('nobody', SERVED)).toEqual([STAGING, PROD]);
  });

  test('no binding: the project its record names, alone', async () => {
    const { projectsOf } = harness({ served: false });
    expect(await projectsOf('desk', SERVED)).toEqual([STAGING]);
    expect(await projectsOf('direct', SERVED)).toEqual([]);
    expect(await projectsOf('solo', SOLO)).toEqual([OTHER]);
  });

  test('no binding and no authorizer: a retired agent answers its project from its unregistered versions', async () => {
    const { projectsOf, listed } = harness({ served: false, authorized: false });
    expect(await projectsOf('nobody', RETIRED)).toEqual([STAGING]);
    expect(listed).toEqual([{ tenantId, agentId: RETIRED, limit: 1, includeTombstoned: true }]);
  });

  test('no binding, and records that name no project (`kindgi dev`): no project named', async () => {
    const { projectsOf } = harness({ served: false, authorized: false, projectless: true });
    expect(await projectsOf('nobody', SERVED)).toEqual([]);
  });
});
