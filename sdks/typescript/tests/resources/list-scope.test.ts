// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Approvals, conversations and provenance list by project or org, as
 * runs do (`scope` → `scopeKind` + `scopeId`); a conversation can be
 * opened in a project.
 */

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const EMPTY = { status: 200, body: JSON.stringify({ data: [], hasMore: false }) };

function client(responses: { status: number; body: string }[]) {
  const stub = recordingFetch(responses);
  return {
    stub,
    kindgi: createClient({ apiUrl: 'https://api.example.com', auth: AUTH, fetch: stub.fetch }),
  };
}

const query = (url: string | undefined) => new URL(url ?? '').searchParams;

describe('list by project or org', () => {
  it('approvals.list sends the scope', async () => {
    const { stub, kindgi } = client([EMPTY, EMPTY]);
    await kindgi.approvals.list({
      scope: { kind: 'project', projectId: 'p-1' },
      status: 'pending',
    });
    await kindgi.approvals.list({ scope: { kind: 'org', orgId: 'o-1' } });
    const project = query(stub.calls[0]?.url);
    expect([project.get('scopeKind'), project.get('scopeId'), project.get('status')]).toEqual([
      'project',
      'p-1',
      'pending',
    ]);
    const org = query(stub.calls[1]?.url);
    expect([org.get('scopeKind'), org.get('scopeId')]).toEqual(['org', 'o-1']);
  });

  it('conversations.list sends the scope', async () => {
    const { stub, kindgi } = client([EMPTY]);
    await kindgi.conversations.list({ scope: { kind: 'project', projectId: 'p-1' } });
    const sent = query(stub.calls[0]?.url);
    expect([sent.get('scopeKind'), sent.get('scopeId')]).toEqual(['project', 'p-1']);
  });

  it('provenance.query sends the scope', async () => {
    const { stub, kindgi } = client([EMPTY]);
    await kindgi.provenance.query({ scope: { kind: 'org', orgId: 'o-1' } });
    const sent = query(stub.calls[0]?.url);
    expect([sent.get('scopeKind'), sent.get('scopeId')]).toEqual(['org', 'o-1']);
  });

  it('no scope: none sent', async () => {
    const { stub, kindgi } = client([EMPTY]);
    await kindgi.approvals.list();
    expect(query(stub.calls[0]?.url).has('scopeKind')).toBe(false);
  });
});

describe('conversations.open in a project', () => {
  it('sends projectId', async () => {
    const { stub, kindgi } = client([
      {
        status: 201,
        body: JSON.stringify({
          id: '00000000-0000-4000-8000-0000000000c1',
          tenantId: '00000000-0000-4000-8000-000000000001',
          agentId: 'acme.desk-agent',
          agentVersion: '1.0.0',
          title: 'Order A-100',
          projectId: 'p-1',
          scope: {},
          status: 'open',
          openedAt: '2026-10-05T08:00:00.000Z',
          turnCount: 0,
        }),
      },
    ]);
    const opened = await kindgi.conversations.open({
      agentId: 'acme.desk-agent' as never,
      agentVersion: '1.0.0',
      projectId: 'p-1',
    });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toMatchObject({ projectId: 'p-1' });
    expect(opened.projectId).toBe('p-1');
  });
});
