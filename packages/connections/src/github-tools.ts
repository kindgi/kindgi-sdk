// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/connections/github/tools` — tools that act with the company's
 * GitHub connection, on the repositories its installation can reach. A pack
 * includes one by exporting it as a tool under an id the pack names: a tool
 * folder whose `index.ts` is
 * `export default githubIssuesList({ id: 'acme.github.issues.list' })`. The
 * id is the pack's because a tool id is the tenant's, filed under the first
 * project that publishes it.
 */

import type { Tool, ToolContext } from '@kindgi/tools';

import { appFetch } from './app-fetch.js';
import { type AppToolOptions, appTool } from './app-tool.js';
import { github } from './github.js';

export type { AppToolOptions } from './app-tool.js';

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'kindgi-connections',
} as const;
/** The most of an issue's body a list carries: enough to triage it. */
const BODY_CHARS = 4_000;
/** Pages of 100 labels read at most: a repository with more is rare. */
const LABEL_PAGES = 5;

const OWNER = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$',
  description: 'The account the repository is on, an organization or a user: "acme".',
} as const;
const REPO = {
  type: 'string',
  pattern: '^[A-Za-z0-9._-]{1,100}$',
  not: { enum: ['.', '..'] },
  description: 'The repository\'s name: "widgets".',
} as const;
const LABEL = { type: 'string', minLength: 1, maxLength: 50, pattern: '^[^,]+$' } as const;

export interface GithubRepoInput {
  readonly owner: string;
  readonly repo: string;
}

export interface GithubIssuesListInput extends GithubRepoInput {
  readonly state?: 'open' | 'closed' | 'all';
  /** Only issues with every one of these labels. */
  readonly labels?: readonly string[];
  /** Only issues updated at or after this time (ISO 8601). */
  readonly since?: string;
  readonly perPage?: number;
}

export interface GithubIssue {
  readonly number: number;
  readonly title: string;
  /** The first 4,000 characters of its body; empty when it has none. */
  readonly body: string;
  readonly labels: readonly string[];
  /** The login of whoever opened it; absent for a deleted account. */
  readonly author?: string;
  readonly createdAt: string;
  readonly url: string;
}

export interface GithubIssuesListOutput {
  readonly issues: readonly GithubIssue[];
}

export interface GithubLabelsListOutput {
  readonly labels: readonly { readonly name: string; readonly description?: string }[];
}

export interface GithubIssuesAddLabelsInput extends GithubRepoInput {
  readonly issueNumber: number;
  readonly labels: readonly string[];
}

export interface GithubIssuesAddLabelsOutput {
  /** Every label the issue has now. */
  readonly labels: readonly string[];
}

const READS = [
  { kind: 'reads', resource: 'external:github' },
  { kind: 'network', resource: 'external:github' },
] as const;
const NETWORK = { kind: 'allowlist', hosts: ['api.github.com'] } as const;

const ISSUES_LIST: Omit<Tool<GithubIssuesListInput, GithubIssuesListOutput>, 'id'> = {
  description:
    "List a repository's issues, newest first, with the start of each body: open ones unless `state` says otherwise, only those with every label in `labels`, only those updated since `since`. Pull requests aren't listed. Reads only.",
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['owner', 'repo'],
    properties: {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      labels: { type: 'array', maxItems: 10, items: LABEL },
      since: { type: 'string', format: 'date-time' },
      perPage: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['issues'],
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['number', 'title', 'body', 'labels', 'createdAt', 'url'],
          properties: {
            number: { type: 'integer' },
            title: { type: 'string' },
            body: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            author: { type: 'string' },
            createdAt: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
    },
  },
  effects: READS,
  mutating: false,
  network: NETWORK,
  needsSpec: {
    connections: { github: { app: 'github', permissions: ['issues.read'], as: 'company' } },
  },
  handler: async (input, ctx) => {
    const q = new URLSearchParams({
      state: input.state ?? 'open',
      per_page: String(input.perPage ?? 30),
      sort: 'created',
      direction: 'desc',
    });
    if (input.labels !== undefined && input.labels.length > 0)
      q.set('labels', input.labels.join(','));
    if (input.since !== undefined) q.set('since', input.since);
    const items = await githubJson(ctx, 'github.issues.list', input, `/issues?${q}`);
    if (!Array.isArray(items)) throw new Error("GitHub's issue list wasn't a list.");
    const issues: GithubIssue[] = [];
    for (const raw of items as RawIssue[]) {
      // GitHub lists pull requests as issues too.
      if (raw.pull_request !== undefined) continue;
      const author = raw.user?.login;
      issues.push({
        number: raw.number,
        title: raw.title,
        body: (raw.body ?? '').slice(0, BODY_CHARS),
        labels: (raw.labels ?? []).map(labelName).filter((n) => n !== ''),
        ...(typeof author === 'string' && { author }),
        createdAt: raw.created_at,
        url: raw.html_url,
      });
    }
    return { issues };
  },
};

const LABELS_LIST: Omit<Tool<GithubRepoInput, GithubLabelsListOutput>, 'id'> = {
  description:
    'List the labels a repository has, with what each is for. Adding labels to an issue takes only these. Reads only.',
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['owner', 'repo'],
    properties: { owner: OWNER, repo: REPO },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
      labels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string' }, description: { type: 'string' } },
        },
      },
    },
  },
  effects: READS,
  mutating: false,
  network: NETWORK,
  needsSpec: {
    connections: { github: { app: 'github', permissions: ['issues.read'], as: 'company' } },
  },
  handler: async (input, ctx) => ({
    labels: await repoLabels(ctx, 'github.labels.list', input),
  }),
};

const ADD_LABELS: Omit<Tool<GithubIssuesAddLabelsInput, GithubIssuesAddLabelsOutput>, 'id'> = {
  description:
    "Add labels to an issue, keeping the ones it has. Only labels the repository already has (its label list): it never makes a new one. Returns every label the issue has now. In a run no person started, each call waits for a person's yes.",
  version: '1.0.0',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['owner', 'repo', 'issueNumber', 'labels'],
    properties: {
      owner: OWNER,
      repo: REPO,
      issueNumber: { type: 'integer', minimum: 1 },
      labels: { type: 'array', minItems: 1, maxItems: 10, items: LABEL },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: { labels: { type: 'array', items: { type: 'string' } } },
  },
  effects: [
    { kind: 'writes', resource: 'external:github' },
    { kind: 'external-side-effect', resource: 'external:github', notes: 'Labels an issue.' },
  ],
  mutating: true,
  // Labels are what people sort and notify by: in a run no person started,
  // a person says yes to each change.
  needsApprovalWhenUnattended: true,
  network: NETWORK,
  needsSpec: {
    connections: { github: { app: 'github', permissions: ['issues.write'], as: 'company' } },
  },
  handler: async (input, ctx) => {
    // GitHub makes a label that doesn't exist yet: a model's guess shouldn't add one.
    const have = new Set(
      (await repoLabels(ctx, 'github.issues.add-labels', input)).map((l) => l.name.toLowerCase()),
    );
    const unknown = input.labels.filter((l) => !have.has(l.toLowerCase()));
    if (unknown.length > 0) {
      throw new Error(
        `${input.owner}/${input.repo} has no label ${unknown.map((l) => `"${l}"`).join(', ')}: the repository's label list has the ones it can take.`,
      );
    }
    const now = await githubJson(
      ctx,
      'github.issues.add-labels',
      input,
      `/issues/${input.issueNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
    );
    if (!Array.isArray(now)) throw new Error("GitHub's answer wasn't the issue's labels.");
    return { labels: (now as unknown[]).map(labelName).filter((n) => n !== '') };
  },
};

/** A tool, under the id the pack names, that lists a repository's issues (not its pull requests), with the start of each body. */
export function githubIssuesList(
  options: AppToolOptions,
): Tool<GithubIssuesListInput, GithubIssuesListOutput> {
  return appTool(ISSUES_LIST, options);
}

/** A tool, under the id the pack names, that lists a repository's labels. */
export function githubLabelsList(
  options: AppToolOptions,
): Tool<GithubRepoInput, GithubLabelsListOutput> {
  return appTool(LABELS_LIST, options);
}

/** A tool, under the id the pack names, that adds labels the repository already has to an issue. */
export function githubIssuesAddLabels(
  options: AppToolOptions,
): Tool<GithubIssuesAddLabelsInput, GithubIssuesAddLabelsOutput> {
  return appTool(ADD_LABELS, options);
}

interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly labels?: readonly unknown[];
  readonly user?: { readonly login?: unknown } | null;
  readonly created_at: string;
  readonly html_url: string;
  readonly pull_request?: unknown;
}

/** A label's name: GitHub gives an object, or (in older answers) a bare string. */
function labelName(l: unknown): string {
  if (typeof l === 'string') return l;
  const name = (l as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

async function repoLabels(
  ctx: ToolContext,
  toolId: string,
  repo: GithubRepoInput,
): Promise<{ name: string; description?: string }[]> {
  const labels: { name: string; description?: string }[] = [];
  for (let page = 1; page <= LABEL_PAGES; page++) {
    const list = await githubJson(ctx, toolId, repo, `/labels?per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error("GitHub's label list wasn't a list.");
    for (const l of list as { name?: unknown; description?: unknown }[]) {
      if (typeof l.name !== 'string') continue;
      labels.push({
        name: l.name,
        ...(typeof l.description === 'string' &&
          l.description !== '' && { description: l.description }),
      });
    }
    if (list.length < 100) break;
  }
  return labels;
}

/**
 * A call under the repository, its JSON answer, or an error in GitHub's
 * words. `toolId` is the operation's own name (`github.labels.list`),
 * whatever id the pack gave the tool: the entry's rate limits charge by it.
 */
async function githubJson(
  ctx: ToolContext,
  toolId: string,
  repo: GithubRepoInput,
  path: string,
  init: { readonly method?: 'POST'; readonly body?: string } = {},
): Promise<unknown> {
  const where = `${repo.owner}/${repo.repo}`;
  const res = await appFetch(ctx, {
    entry: github,
    connection: 'github',
    toolId,
    url: `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${path}`,
    ...(init.method !== undefined && { method: init.method }),
    headers: init.body !== undefined ? { ...HEADERS, 'content-type': 'application/json' } : HEADERS,
    ...(init.body !== undefined && { body: init.body }),
  });
  if (res.ok) return res.json();
  const says = await githubSays(res);
  if (res.status === 404) {
    throw new Error(
      `GitHub found nothing at ${where}${path.split('?')[0]} that the connection can reach: the repository or issue doesn't exist, or the app isn't installed on it. (${says})`,
    );
  }
  throw new Error(`GitHub refused the call on ${where} (HTTP ${res.status}): ${says}`);
}

/** GitHub's own message, else the HTTP status. */
async function githubSays(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  } catch {
    // Not JSON: the status says enough.
  }
  return `HTTP ${res.status}`;
}
