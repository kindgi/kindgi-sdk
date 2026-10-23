// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { type ToolConnection, invokeToolForTest } from '@kindgi/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { githubIssuesAddLabels, githubIssuesList, githubLabelsList } from '../src/github-tools.js';

const TOKEN = 'ghs_not-a-real-token';

function company(): { connections: { github: ToolConnection } } {
  return {
    connections: {
      github: {
        connectionId: randomUUID(),
        app: 'github',
        appName: 'GitHub',
        accessToken: TOKEN,
        account: { id: '9001', label: 'acme' },
      },
    },
  };
}

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** GitHub's API, stubbed by `METHOD path` (no query); anything else is a 404. */
function githubAnswering(routes: Record<string, (url: URL) => Response>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      sent.push({
        method,
        url: u,
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const route = routes[`${method} ${u.pathname}`];
      return route !== undefined
        ? route(u)
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }),
  );
  return sent;
}

const LABELS = [
  { name: 'bug', description: "Something isn't working" },
  { name: 'docs', description: '' },
  { name: 'question', description: null },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github.issues.list', () => {
  it("reads only, with the company's issues.read", () => {
    expect(githubIssuesList).toMatchObject({
      id: 'github.issues.list',
      mutating: false,
      needsSpec: {
        connections: { github: { app: 'github', permissions: ['issues.read'], as: 'company' } },
      },
      network: { kind: 'allowlist', hosts: ['api.github.com'] },
    });
    expect(githubIssuesList.needsApprovalWhenUnattended).toBeUndefined();
  });

  it("lists issues newest first, leaving out pull requests, with each body's start", async () => {
    const sent = githubAnswering({
      'GET /repos/acme/widgets/issues': () =>
        Response.json([
          {
            number: 12,
            title: 'Crash on start',
            body: `It crashes. ${'x'.repeat(5_000)}`,
            labels: [{ name: 'bug' }],
            user: { login: 'bo' },
            created_at: '2026-10-20T10:00:00Z',
            html_url: 'https://github.com/acme/widgets/issues/12',
          },
          {
            number: 11,
            title: 'Add a flag',
            labels: [],
            user: null,
            body: null,
            created_at: '2026-10-19T10:00:00Z',
            html_url: 'https://github.com/acme/widgets/issues/11',
          },
          {
            number: 10,
            title: 'A pull request',
            pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/10' },
            labels: [],
            user: { login: 'cy' },
            created_at: '2026-10-18T10:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/10',
          },
        ]),
    });
    const r = await invokeToolForTest(
      githubIssuesList,
      {
        owner: 'acme',
        repo: 'widgets',
        labels: ['bug', 'p1'],
        since: '2026-10-01T00:00:00Z',
        perPage: 50,
      },
      company(),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.issues.map((i) => i.number)).toEqual([12, 11]);
    expect(r.value.issues[0]).toMatchObject({
      title: 'Crash on start',
      labels: ['bug'],
      author: 'bo',
      createdAt: '2026-10-20T10:00:00Z',
      url: 'https://github.com/acme/widgets/issues/12',
    });
    expect(r.value.issues[0]?.body).toHaveLength(4_000);
    expect(r.value.issues[1]).toMatchObject({ body: '', labels: [] });
    expect(r.value.issues[1]).not.toHaveProperty('author');

    const q = sent[0]?.url.searchParams;
    expect(Object.fromEntries(q ?? [])).toEqual({
      state: 'open',
      per_page: '50',
      sort: 'created',
      direction: 'desc',
      labels: 'bug,p1',
      since: '2026-10-01T00:00:00Z',
    });
    expect(sent[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("a repository the installation can't reach says so, never with the token", async () => {
    githubAnswering({});
    const r = await invokeToolForTest(
      githubIssuesList,
      { owner: 'acme', repo: 'secret' },
      company(),
    );
    expect(r.kind === 'err' && r.error.code).toBe('handler-error');
    const message = r.kind === 'err' ? r.error.message : '';
    expect(message).toContain(
      'GitHub found nothing at acme/secret/issues that the connection can reach',
    );
    expect(message).not.toContain(TOKEN);
  });

  it("an owner or repository that isn't a plain name is refused before anything is sent", async () => {
    const sent = githubAnswering({});
    for (const input of [
      { owner: 'acme', repo: '..' },
      { owner: 'acme', repo: 'widgets/../../orgs' },
      { owner: 'acme/x', repo: 'widgets' },
      { owner: '-acme', repo: 'widgets' },
    ]) {
      const r = await invokeToolForTest(githubIssuesList, input, company());
      expect(r.kind === 'err' && r.error.code).toBe('input-validation-failed');
    }
    expect(sent).toHaveLength(0);
  });
});

describe('github.labels.list', () => {
  it("lists every label, page after page, with what it's for when it says", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `area-${i}`, description: null }));
    const sent = githubAnswering({
      'GET /repos/acme/widgets/labels': (u) =>
        Response.json(u.searchParams.get('page') === '1' ? many : LABELS),
    });
    const r = await invokeToolForTest(
      githubLabelsList,
      { owner: 'acme', repo: 'widgets' },
      company(),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.labels).toHaveLength(103);
    expect(r.value.labels.slice(100)).toEqual([
      { name: 'bug', description: "Something isn't working" },
      { name: 'docs' },
      { name: 'question' },
    ]);
    expect(sent.map((s) => s.url.searchParams.get('page'))).toEqual(['1', '2']);
  });
});

describe('github.issues.add-labels', () => {
  it("changes issues, with the company's issues.write, and asks first in a run no person started", () => {
    expect(githubIssuesAddLabels).toMatchObject({
      id: 'github.issues.add-labels',
      mutating: true,
      needsApprovalWhenUnattended: true,
      needsSpec: {
        connections: { github: { app: 'github', permissions: ['issues.write'], as: 'company' } },
      },
    });
  });

  it('adds labels the repository has and answers with every label the issue has now', async () => {
    const sent = githubAnswering({
      'GET /repos/acme/widgets/labels': () => Response.json(LABELS),
      'POST /repos/acme/widgets/issues/12/labels': () =>
        Response.json([{ name: 'bug' }, { name: 'docs' }]),
    });
    const r = await invokeToolForTest(
      githubIssuesAddLabels,
      { owner: 'acme', repo: 'widgets', issueNumber: 12, labels: ['Docs'] },
      company(),
    );
    expect(r).toEqual({ kind: 'ok', value: { labels: ['bug', 'docs'] } });
    const post = sent.find((s) => s.method === 'POST');
    expect(post?.body).toEqual({ labels: ['Docs'] });
    expect(post?.headers['content-type']).toBe('application/json');
  });

  it("a label the repository doesn't have is refused, naming it, and nothing is changed", async () => {
    const sent = githubAnswering({
      'GET /repos/acme/widgets/labels': () => Response.json(LABELS),
    });
    const r = await invokeToolForTest(
      githubIssuesAddLabels,
      { owner: 'acme', repo: 'widgets', issueNumber: 12, labels: ['bug', 'urgent'] },
      company(),
    );
    expect(r.kind === 'err' && r.error.message).toContain('acme/widgets has no label "urgent"');
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0);
  });
});
