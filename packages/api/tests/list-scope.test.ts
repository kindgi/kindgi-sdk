// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Approvals, conversations and provenance list by project, as runs do:
 * `?scopeKind=project|org&scopeId=…` reaches each binding as a
 * `ListScope`; no scope, or `tenant`, lists the whole tenant; a scope id
 * that isn't a UUID is a 400 before any query. A conversation can be
 * opened in a project, which must be the tenant's.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding } from '@kindgi/agents';
import type { ProjectBinding } from '@kindgi/platform';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  HitlBinding,
  ProvenanceBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID();
const defaultProjectId = randomUUID();
const orgId = randomUUID();
const TOKEN = 'list-scope-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

const conversation = {
  id: randomUUID(),
  tenantId,
  agentId: 'acme.desk-agent',
  agentVersion: '1.0.0',
  title: 'Order A-100',
  projectId,
  scope: {},
  openedAt: '2026-10-05T08:00:00.000Z',
  turnCount: 0,
};

function harness(options: { readonly defaultProject?: boolean } = {}) {
  const seen: { approvals: unknown[]; conversations: unknown[]; provenance: unknown[] } = {
    approvals: [],
    conversations: [],
    provenance: [],
  };
  const opened: unknown[] = [];
  const stubs = createStubAppBindings();
  const hitlBinding = {
    listApprovals: async (input: unknown) => {
      seen.approvals.push(input);
      return { kind: 'ok', value: { approvals: [] } };
    },
  } as unknown as HitlBinding;
  const conversationBinding = {
    ...stubs.conversationBinding,
    listConversationsPage: async (input: unknown) => {
      seen.conversations.push(input);
      return { kind: 'ok', value: { data: [conversation], hasMore: false } };
    },
    openConversation: async (input: Record<string, unknown>) => {
      opened.push(input);
      return { kind: 'ok', value: { ...conversation, projectId: input.projectId } };
    },
  } as unknown as ConversationBinding;
  const provenanceBinding = {
    listRecords: async (input: unknown) => {
      seen.provenance.push(input);
      return {
        kind: 'ok',
        value: {
          records: [
            {
              id: randomUUID(),
              runId: randomUUID(),
              tenantId,
              version: '1.0.0',
              createdAt: '2026-10-05T08:00:00.000Z',
              signed: false,
              projectId,
            },
          ],
        },
      };
    },
  } as unknown as ProvenanceBinding;
  const projectBinding = {
    get: async (_t: TenantId, id: string) => (id === projectId ? { id } : undefined),
    getDefault: async () =>
      options.defaultProject === false ? undefined : { id: defaultProjectId },
  } as unknown as ProjectBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    provenanceBinding,
    projectBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
  return { app, seen, opened };
}

async function call(
  path: string,
  body?: unknown,
  options: { readonly defaultProject?: boolean } = {},
) {
  const h = harness(options);
  const res = await h.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, ...h };
}

const LISTS = [
  ['/v1/approvals', 'approvals'],
  ['/v1/conversations', 'conversations'],
  ['/v1/provenance', 'provenance'],
] as const;

describe.each(LISTS)('GET %s by project', (path, key) => {
  test("a project scope reaches the binding as that project's ListScope", async () => {
    const answer = await call(`${path}?scopeKind=project&scopeId=${projectId}`);
    expect(answer.status).toBe(200);
    expect(answer.seen[key]).toEqual([
      expect.objectContaining({ scope: { kind: 'project', projectId } }),
    ]);
  });

  test("an org scope reaches it as the org's", async () => {
    const answer = await call(`${path}?scopeKind=org&scopeId=${orgId}`);
    expect(answer.status).toBe(200);
    expect(answer.seen[key]).toEqual([expect.objectContaining({ scope: { kind: 'org', orgId } })]);
  });

  test('no scope, or the tenant: no scope filter', async () => {
    for (const query of ['', '?scopeKind=tenant']) {
      const answer = await call(`${path}${query}`);
      expect(answer.status).toBe(200);
      expect(answer.seen[key][0]).not.toHaveProperty('scope');
    }
  });

  test('a scope id that is not a UUID: 400 scope-invalid, and no query', async () => {
    const answer = await call(`${path}?scopeKind=project&scopeId=acme-desk`);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'scope-invalid',
      message:
        'scope query parameters malformed: scopeId must be a project id (a UUID), got "acme-desk"',
    });
    expect(answer.seen[key]).toEqual([]);
  });

  test('a malformed scope: 400 scope-invalid', async () => {
    const answer = await call(`${path}?scopeKind=project`);
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'scope-invalid' });
  });
});

describe('the records say their project', () => {
  test('a conversation and a provenance record carry projectId', async () => {
    const conversations = await call('/v1/conversations');
    expect((conversations.json.data as Record<string, unknown>[])[0]).toMatchObject({ projectId });
    const provenance = await call('/v1/provenance');
    expect((provenance.json.data as Record<string, unknown>[])[0]).toMatchObject({ projectId });
  });
});

describe('POST /v1/conversations in a project', () => {
  const open = { agentId: 'acme.desk-agent', agentVersion: '1.0.0' };

  test("a project of the tenant's: the conversation is opened in it", async () => {
    const answer = await call('/v1/conversations', { ...open, projectId });
    expect(answer.status).toBe(201);
    expect(answer.opened).toEqual([expect.objectContaining({ projectId })]);
    expect(answer.json).toMatchObject({ projectId });
  });

  test("no projectId: the tenant's Default project, as for a run", async () => {
    const answer = await call('/v1/conversations', open);
    expect(answer.status).toBe(201);
    expect(answer.opened).toEqual([expect.objectContaining({ projectId: defaultProjectId })]);
  });

  test('no projectId and no Default project: opened without one, not refused', async () => {
    const answer = await call('/v1/conversations', open, { defaultProject: false });
    expect(answer.status).toBe(201);
    expect(answer.opened[0]).not.toHaveProperty('projectId');
  });

  test('a project the tenant has not: 400, nothing opened', async () => {
    const other = randomUUID();
    const answer = await call('/v1/conversations', { ...open, projectId: other });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'bad-input',
      message: `\`projectId\` "${other}" does not resolve to a project in this tenant`,
    });
    expect(answer.opened).toEqual([]);
  });

  test('a projectId that is not a UUID: 400, nothing opened', async () => {
    const answer = await call('/v1/conversations', { ...open, projectId: 'acme-desk' });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      message: '`projectId` must be a project id (a UUID) when supplied',
    });
    expect(answer.opened).toEqual([]);
  });
});

describe("GET /v1/conversations leaves a comparison's replay conversations out", () => {
  test('by default the binding is asked to exclude them', async () => {
    const answer = await call('/v1/conversations');
    expect(answer.status).toBe(200);
    expect(answer.seen.conversations[0]).toMatchObject({ replays: 'exclude' });
  });

  test('replays=include or only reaches the binding as asked', async () => {
    for (const replays of ['include', 'only', 'exclude']) {
      const answer = await call(`/v1/conversations?replays=${replays}`);
      expect(answer.status).toBe(200);
      expect(answer.seen.conversations[0]).toMatchObject({ replays });
    }
  });

  test('any other value: 400, and no query', async () => {
    const answer = await call('/v1/conversations?replays=all');
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({
      code: 'bad-input',
      message: '`replays` must be `exclude`, `include` or `only`',
    });
    expect(answer.seen.conversations).toEqual([]);
  });
});
