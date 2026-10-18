// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi exports create` against a stand-in server: each kind's file holds
 * the records as the server answered them (a child kind's with its parent),
 * read to the last page, at each env and scope, with each item's own route
 * where the plan says so, and an artifact's bytes. The manifest says each
 * kind's outcome. Rate limits are waited out, a `5xx` is sent again, and a
 * kind that fails doesn't stop the rest. `--resume` keeps what's done; the
 * signed exports are made for decided approvals and each run.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { EXPORT_PLAN } from '../src/exports/plan.js';
import { runCli } from '../src/main.js';

const API = 'https://api.acme.example';
const TENANT = 'tenant-acme';

let home: string;
let cwd: string;
let out: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
  out = join(cwd, 'export');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** What a path answers: its records, one record, or a handler. */
type Records = readonly unknown[] | Record<string, unknown>;
type Answer = Records | ((url: URL, init: RequestInit) => Response);

const templates = EXPORT_PLAN.flatMap((k) => [
  { route: k.route, paging: k.paging },
  ...(k.item !== undefined ? [{ route: k.item.route, paging: 'one' as const }] : []),
]).map((t) => ({ ...t, re: new RegExp(`^${t.route.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A stand-in server: each path answers what `answers` gives it (records
 * for a list, paged by `limit` and `cursor`; a record; or a handler), and
 * anything else as an empty list, or `{}`.
 */
function server(answers: Record<string, Answer> = {}, opts: { admin?: boolean } = {}) {
  const calls: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const defaults: Record<string, Answer> = {
    '/v1/identity/whoami': {
      tenantId: TENANT,
      scopes: [opts.admin === false ? 'member' : 'tenant-admin'],
      tenantAdmin: opts.admin ?? true,
    },
    '/v1/tenant': { id: TENANT, name: 'Acme', state: 'active' },
    '/v1/export-signing-keys': [{ keyId: 'ex_acme' }],
  };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer kgi_tk_acme');
    const answer = answers[url.pathname] ?? defaults[url.pathname];
    if (typeof answer === 'function') return answer(url, init);
    if (method === 'POST') {
      posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) as unknown });
      return json(200, answer ?? { kind: 'signed', path: url.pathname, bundle: 'YWNtZQ==' });
    }
    return routeAnswer(url, answer);
  }) as typeof fetch;
  return { fetchImpl, calls, posts };
}

/** What the server answers a route it doesn't mount. */
const notMounted = () => json(404, { error: { code: 'route-not-found', message: 'No route' } });

/** A read's answer: a record, the whole list, or the page `limit` and `cursor` ask for. */
function routeAnswer(url: URL, answer: Records | undefined): Response {
  const t = templates.find((x) => x.re.test(url.pathname));
  if (t === undefined && answer === undefined) {
    return notMounted();
  }
  if (t === undefined || t.paging === 'one') return json(200, answer ?? {});
  const records = (answer ?? []) as readonly unknown[];
  if (t.paging === 'whole') return json(200, { data: records });
  const limit = Number(url.searchParams.get('limit'));
  const from = Number(url.searchParams.get('cursor') ?? '0');
  const more = from + limit < records.length;
  return json(200, {
    data: records.slice(from, from + limit),
    hasMore: more,
    ...(more && { nextCursor: String(from + limit) }),
  });
}

async function cli(
  fake: ReturnType<typeof server>,
  args: readonly string[] = [],
  extra: { stopSignal?: AbortSignal } = {},
) {
  const progress: string[] = [];
  const pauses: number[] = [];
  const waits: number[] = [];
  const outcome = await runCli({
    argv: ['exports', 'create', `--out=${out}`, ...args, `--url=${API}`, '--token=kgi_tk_acme'],
    env: {},
    cwd,
    home,
    fetchImpl: fake.fetchImpl,
    exportsSeam: {
      progress: (line) => progress.push(line),
      now: () => new Date('2026-10-15T12:00:00.000Z'),
      pause: async (ms) => {
        pauses.push(ms);
      },
    },
    rateLimitWaits: {
      sleep: async (ms) => {
        waits.push(ms);
      },
      write: () => undefined,
    },
    ...(extra.stopSignal !== undefined && { stopSignal: extra.stopSignal }),
  });
  return { ...outcome, progress, pauses, waits };
}

async function lines(name: string): Promise<unknown[]> {
  const text = await readFile(join(out, `${name}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as unknown);
}

async function manifest(): Promise<{
  kinds: Record<
    string,
    {
      status: string;
      records?: number;
      reason?: string;
      error?: string;
      gone?: number;
      withoutMessages?: number;
    }
  >;
  finishedAt?: string;
  tenant: { id: string; state?: string };
  server: string;
  consistency: string;
  neverExported: string[];
}> {
  return JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
}

describe('kindgi exports create', () => {
  test('each kind is written as the server answers it, and the manifest says so', async () => {
    const fake = server({
      '/v1/agents': [{ id: 'agent-a', name: 'Triage' }],
      '/v1/agents/agent-a/versions': [
        { id: 'agent-a', version: '1.0.0' },
        { id: 'agent-a', version: '1.1.0' },
      ],
      '/v1/provenance': [{ runId: 'run-1', version: 1 }],
      '/v1/provenance/run-1': { runId: 'run-1', version: 1, dag: { nodes: [] }, signature: 'sig' },
      '/v1/artifacts': [{ blobId: 'blob-1', name: 'report.pdf' }],
      '/v1/artifacts/blob-1': () => new Response('%PDF-acme', { status: 200 }),
    });
    const res = await cli(fake);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(await lines('agents')).toEqual([{ id: 'agent-a', name: 'Triage' }]);
    expect(await lines('agent-versions')).toEqual([
      { parent: { agentId: 'agent-a' }, item: { id: 'agent-a', version: '1.0.0' } },
      { parent: { agentId: 'agent-a' }, item: { id: 'agent-a', version: '1.1.0' } },
    ]);
    // The list holds a summary; the file holds each item's own record.
    expect(await lines('provenance')).toEqual([
      { runId: 'run-1', version: 1, dag: { nodes: [] }, signature: 'sig' },
    ]);
    expect(await lines('artifacts')).toEqual([{ blobId: 'blob-1', name: 'report.pdf' }]);
    expect(await readFile(join(out, 'artifacts', 'blob-1'), 'utf8')).toBe('%PDF-acme');
    const m = await manifest();
    expect(m.kinds.agents).toEqual({
      status: 'ok',
      file: 'agents.jsonl',
      records: 1,
      at: '2026-10-15T12:00:00.000Z',
    });
    expect(m.kinds['agent-versions']).toMatchObject({ status: 'ok', records: 2 });
    expect(m.tenant).toEqual({ id: TENANT, state: 'active' });
    expect(m.server).toBe(API);
    expect(m.finishedAt).toBe('2026-10-15T12:00:00.000Z');
    expect(m.consistency).toContain('not one moment');
    expect(m.neverExported.join(' ')).toContain('Secret values');
    // Every kind in the plan, and the three signed exports, has an outcome.
    expect(Object.keys(m.kinds).sort()).toEqual(
      [
        ...EXPORT_PLAN.map((k) => k.name),
        'signed/approvals',
        'signed/provenance',
        'signed/compliance-evidence',
      ].sort(),
    );
    expect(res.stdout).toContain(`Exported to ${out}:`);
    // Nothing is left half-written.
    expect((await readdir(out)).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  test('reads what a route leaves out unless asked, and every page', async () => {
    const runs = Array.from({ length: 150 }, (_, i) => ({ id: `run-${i}` }));
    const journal = Array.from({ length: 120 }, (_, i) => ({ sequence: i + 1 }));
    const fake = server({ '/v1/runs': runs, '/v1/runs/run-0/journal': journal });
    const res = await cli(fake);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(await lines('runs')).toHaveLength(150);
    expect(fake.calls).toContain('GET /v1/runs?replays=include&include=output&limit=100');
    expect(fake.calls).toContain(
      'GET /v1/runs?replays=include&include=output&limit=100&cursor=100',
    );
    expect(fake.calls).toContain('GET /v1/agents?includeRetired=true&limit=100');
    // Each run's journal, a page each, and two for the one with 120 entries.
    expect(
      fake.calls.filter((c) => c.startsWith('GET /v1/runs/run-') && c.includes('/journal')),
    ).toHaveLength(151);
    expect(fake.calls).toContain('GET /v1/runs/run-0/journal?limit=100&cursor=100');
    const journals = (await lines('run-journals')) as {
      parent: { runId: string };
      item: unknown;
    }[];
    expect(journals.filter((l) => l.parent.runId === 'run-0').map((l) => l.item)).toEqual(journal);
  });

  test('env and secrets are read for each env name at each scope; a secret’s versions at its own', async () => {
    const fake = server({
      '/v1/environments': [{ envName: 'prod' }],
      '/v1/orgs': [{ id: 'org-1' }],
      '/v1/projects': [{ id: 'proj-1' }],
      '/v1/secrets': (url) =>
        json(200, {
          data:
            url.searchParams.get('scopeKind') === 'project'
              ? [
                  {
                    name: 'STRIPE_KEY',
                    envName: 'prod',
                    scope: { kind: 'project', tenantId: TENANT, projectId: 'proj-1' },
                  },
                ]
              : [],
          hasMore: false,
        }),
      '/v1/secrets/STRIPE_KEY/versions': [{ name: 'STRIPE_KEY', versionId: 'v1', value: null }],
    });
    const res = await cli(fake);
    expect(res.exitCode, res.stderr).toBe(0);
    const envReads = fake.calls.filter((c) => c.startsWith('GET /v1/env?'));
    expect(envReads).toEqual([
      'GET /v1/env?inherit=false&envName=prod&scopeKind=tenant&limit=100',
      'GET /v1/env?inherit=false&envName=prod&scopeKind=org&scopeId=org-1&limit=100',
      'GET /v1/env?inherit=false&envName=prod&scopeKind=project&scopeId=proj-1&limit=100',
    ]);
    // Revoked secrets too: their metadata is the workspace's.
    expect(fake.calls.filter((c) => c.startsWith('GET /v1/secrets?'))).toEqual([
      'GET /v1/secrets?inherit=false&includeRevoked=true&envName=prod&scopeKind=tenant&limit=100',
      'GET /v1/secrets?inherit=false&includeRevoked=true&envName=prod&scopeKind=org&scopeId=org-1&limit=100',
      'GET /v1/secrets?inherit=false&includeRevoked=true&envName=prod&scopeKind=project&scopeId=proj-1&limit=100',
    ]);
    expect(fake.calls).toContain(
      'GET /v1/secrets/STRIPE_KEY/versions?envName=prod&scopeKind=project&scopeId=proj-1&limit=100',
    );
    expect(await lines('secret-versions')).toEqual([
      {
        parent: { name: 'STRIPE_KEY' },
        item: { name: 'STRIPE_KEY', versionId: 'v1', value: null },
      },
    ]);
  });

  test('a 429 is waited out; a 5xx is sent again three times, then that kind fails and the rest go on', async () => {
    let flowsTries = 0;
    let agentsTries = 0;
    const fake = server({
      '/v1/agents': () => {
        agentsTries++;
        return agentsTries === 1
          ? json(
              429,
              { error: { code: 'rate-limit-exceeded', message: 'Slow down' } },
              { 'retry-after': '7' },
            )
          : json(200, { data: [{ id: 'agent-a' }], hasMore: false });
      },
      '/v1/flows': () => {
        flowsTries++;
        return json(503, { error: { code: 'unavailable', message: 'Down for a moment' } });
      },
    });
    const res = await cli(fake);
    expect(res.exitCode).toBe(1);
    expect(res.waits).toEqual([7000]);
    expect(agentsTries).toBe(2);
    expect(flowsTries).toBe(4);
    expect(res.pauses).toEqual([1000, 2000, 4000]);
    const m = await manifest();
    expect(m.kinds.agents).toMatchObject({ status: 'ok', records: 1 });
    expect(m.kinds.flows).toEqual({
      status: 'failed',
      error: `GET ${API}/v1/flows?includeRetired=true&limit=100 answered 503 unavailable: Down for a moment`,
    });
    expect(m.kinds['flow-versions']).toEqual({
      status: 'skipped',
      reason: "it's read for each record of flows, which wasn't exported",
    });
    expect(m.kinds.tools).toMatchObject({ status: 'ok' });
    await expect(readFile(join(out, 'flows.jsonl'))).rejects.toThrow();
    await expect(readFile(join(out, 'flows.jsonl.partial'))).rejects.toThrow();
    expect(res.stdout).toContain('flows: failed, GET');
    expect(res.stdout).toContain('--resume');
  });

  test('a route this server doesn’t serve is skipped, at the top or under a kind; a record gone before its children are read is counted', async () => {
    const fake = server({
      '/v1/compliance/evidence': notMounted,
      '/v1/environments': () =>
        json(501, { error: { code: 'environments-unsupported', message: 'No env names here' } }),
      '/v1/projects': [{ id: 'proj-1' }],
      '/v1/projects/proj-1/judging-rules': notMounted,
      '/v1/provenance': [{ runId: 'run-1' }],
      '/v1/provenance/run-1': () =>
        json(501, { error: { code: 'provenance-unsupported', message: 'No provenance here' } }),
      '/v1/artifacts': [{ blobId: 'blob-1' }],
      '/v1/artifacts/blob-1': notMounted,
      '/v1/conversations': [{ id: 'conv-1' }, { id: 'conv-2' }],
      '/v1/conversations/conv-1/messages': () =>
        json(404, { error: { code: 'not-found', message: 'Gone' } }),
      '/v1/conversations/conv-2/messages': [{ sequence: 1, text: 'hello' }],
    });
    const res = await cli(fake);
    expect(res.exitCode, res.stderr).toBe(0);
    const m = await manifest();
    expect(m.kinds['compliance-evidence']).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/compliance/evidence (404)",
    });
    expect(m.kinds['conversation-messages']).toMatchObject({ status: 'ok', records: 1, gone: 1 });
    expect(m.kinds['signed/compliance-evidence']).toEqual({
      status: 'skipped',
      reason: "it's made for each record of compliance-evidence, which wasn't exported",
    });
    expect(m.kinds['judging-rules']).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/projects/{projectId}/judging-rules (404)",
    });
    expect(m.kinds['judging-rule-versions']).toEqual({
      status: 'skipped',
      reason: "it's read for each record of judging-rules, which wasn't exported",
    });
    expect(m.kinds.provenance).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/provenance/{runId} (501)",
    });
    expect(m.kinds['judging-queue']).toMatchObject({ status: 'ok' });
    expect(m.kinds.artifacts).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/artifacts/{blobId} (404)",
    });
    await expect(readdir(join(out, 'artifacts'))).rejects.toThrow();
    expect(m.kinds.environments).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/environments (501)",
    });
    expect(m.kinds.secrets).toEqual({
      status: 'skipped',
      reason: "it's read for each record of environments, which wasn't exported",
    });
  });

  test('a list answered whole that says it has more fails, rather than holding part of it', async () => {
    const fake = server({
      '/v1/export-signing-keys': () => json(200, { data: [{ keyId: 'ex_acme' }], hasMore: true }),
    });
    const res = await cli(fake);
    expect(res.exitCode).toBe(1);
    expect((await manifest()).kinds['export-signing-keys']).toMatchObject({ status: 'failed' });
  });

  test('an artifact id that isn’t a safe file name fails the kind, and nothing is written outside the folder', async () => {
    const fake = server({ '/v1/artifacts': [{ blobId: '../escape' }] });
    const res = await cli(fake);
    expect(res.exitCode).toBe(1);
    expect((await manifest()).kinds.artifacts).toEqual({
      status: 'failed',
      error: 'An artifacts id "../escape" isn\'t a safe file name, so it can\'t be written.',
    });
    await expect(readFile(join(cwd, 'escape'))).rejects.toThrow();
    await expect(readdir(join(out, 'artifacts'))).rejects.toThrow();

    // What a run that died part way left goes when the kind is read again.
    await mkdir(join(out, 'artifacts'));
    await writeFile(join(out, 'artifacts/blob-stale'), 'acme');
    const again = await cli(
      server({
        '/v1/artifacts': [{ blobId: 'blob-1' }],
        '/v1/artifacts/blob-1': () => new Response('acme bytes'),
      }),
      ['--resume'],
    );
    expect(again.exitCode, again.stderr).toBe(0);
    expect(await readdir(join(out, 'artifacts'))).toEqual(['blob-1']);
  });

  test('the signed exports: each decided approval, each run, and the evidence', async () => {
    const fake = server({
      '/v1/approvals': [
        { id: 'appr-1', status: 'approved' },
        { id: 'appr-2', status: 'pending' },
        { id: 'appr-3', status: 'expired' },
      ],
      '/v1/provenance': [{ runId: 'run-1' }],
      '/v1/provenance/run-1': { runId: 'run-1' },
      '/v1/compliance/evidence': [{ id: 'ev-1' }],
      '/v1/approvals/appr-3/audit-bundle': (_url, init) =>
        JSON.parse(String(init.body)).includeMessages === true
          ? json(413, { error: { code: 'payload-too-large', message: 'Too big' } })
          : json(200, { kind: 'approval', bundle: 'c21hbGw=' }),
    });
    const res = await cli(fake);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(fake.posts.map((p) => p.path).sort()).toEqual([
      '/v1/approvals/appr-1/audit-bundle',
      '/v1/compliance/evidence/export',
      '/v1/provenance/run-1/export',
    ]);
    expect(fake.posts.find((p) => p.path.includes('appr-1'))?.body).toEqual({
      includeMessages: true,
    });
    expect(await readdir(join(out, 'signed', 'approvals'))).toEqual(['appr-1.json', 'appr-3.json']);
    expect(
      JSON.parse(await readFile(join(out, 'signed', 'approvals', 'appr-3.json'), 'utf8')),
    ).toEqual({
      kind: 'approval',
      bundle: 'c21hbGw=',
    });
    expect(await readdir(join(out, 'signed', 'provenance'))).toEqual(['run-1.json']);
    expect(
      JSON.parse(await readFile(join(out, 'signed', 'compliance-evidence.json'), 'utf8')),
    ).toMatchObject({
      path: '/v1/compliance/evidence/export',
    });
    const m = await manifest();
    expect(m.kinds['signed/approvals']).toMatchObject({
      status: 'ok',
      records: 2,
      withoutMessages: 1,
    });
    expect(m.kinds['signed/provenance']).toMatchObject({ status: 'ok', records: 1 });
  });

  test('--no-signed makes none; a server that signs nothing gets none asked of it', async () => {
    const records = {
      '/v1/approvals': [{ id: 'appr-1', status: 'approved' }],
      '/v1/provenance': [{ runId: 'run-1' }],
    };
    const none = server(records);
    expect((await cli(none, ['--no-signed'])).exitCode).toBe(0);
    expect(none.posts).toEqual([]);
    expect((await manifest()).kinds['signed/approvals']).toEqual({
      status: 'skipped',
      reason: '--no-signed',
    });

    await rm(out, { recursive: true, force: true });
    const unsigned = server({ ...records, '/v1/export-signing-keys': [] });
    expect((await cli(unsigned)).exitCode).toBe(0);
    expect(unsigned.posts).toEqual([]);
    expect((await manifest()).kinds['signed/provenance']).toEqual({
      status: 'skipped',
      reason: "this server doesn't sign exports (it lists no export signing keys)",
    });
  });

  test("someone who isn't a tenant admin is stopped, naming what would be skipped; with --yes those kinds are skipped", async () => {
    const refused = await cli(server({}, { admin: false }));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "You aren't a tenant admin here, so the export would skip team-memberships, team-project-grants, sites, users,",
    );
    expect(refused.stderr).toContain('pass --yes');
    await expect(readdir(out)).rejects.toThrow();

    const fake = server({}, { admin: false });
    const res = await cli(fake, ['--yes']);
    expect(res.exitCode, res.stderr).toBe(0);
    const m = await manifest();
    expect(m.kinds.users).toEqual({ status: 'skipped', reason: 'it needs a tenant admin' });
    expect(m.kinds.agents).toMatchObject({ status: 'ok' });
    expect(fake.calls.some((c) => c.startsWith('GET /v1/identity/users'))).toBe(false);
  });

  test('a folder that isn’t empty is refused without --resume', async () => {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'notes.txt'), 'acme');
    const fake = server();
    const res = await cli(fake);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(
      `${out} isn't empty. Name a new or empty folder with --out, or pass --resume`,
    );
    expect(fake.calls).toEqual(['GET /v1/identity/whoami']);
  });

  test('--resume keeps the kinds that are done, and reads again the rest and whatever is read from them', async () => {
    let flowsDown = true;
    const answers: Record<string, Answer> = {
      '/v1/agents': [{ id: 'agent-a' }],
      '/v1/flows': () =>
        flowsDown
          ? json(500, { error: { code: 'internal', message: 'Oops' } })
          : json(200, { data: [{ id: 'flow-a' }], hasMore: false }),
      '/v1/flows/flow-a/versions': [{ id: 'flow-a', version: '1' }],
    };
    expect((await cli(server(answers))).exitCode).toBe(1);
    flowsDown = false;
    const again = server(answers);
    const res = await cli(again, ['--resume']);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(again.calls.some((c) => c.startsWith('GET /v1/agents?'))).toBe(false);
    expect(again.calls).toContain('GET /v1/flows/flow-a/versions?includeTombstoned=true&limit=100');
    expect(await lines('flow-versions')).toEqual([
      { parent: { flowId: 'flow-a' }, item: { id: 'flow-a', version: '1' } },
    ]);
    const m = await manifest();
    expect(m.kinds.flows).toMatchObject({ status: 'ok', records: 1 });
    expect(m.kinds['flow-versions']).toMatchObject({ status: 'ok', records: 1 });
    expect(res.progress).toEqual(
      expect.arrayContaining(['flows: 1 record\n', 'flow-versions: 1 record\n']),
    );
    expect(res.progress.some((l) => l.startsWith('agents:'))).toBe(false);
  });

  test('--resume refuses an export of another tenant, and a folder with no export', async () => {
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, 'manifest.json'),
      JSON.stringify({ server: API, tenant: { id: 'tenant-other' }, kinds: {} }),
    );
    const res = await cli(server(), ['--resume']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(
      `holds an export of tenant tenant-other from ${API}, not of tenant ${TENANT}`,
    );

    await rm(out, { recursive: true, force: true });
    const none = await cli(server(), ['--resume']);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("has no manifest.json, so there's no export there to resume");
  });

  test('a signed export this server doesn’t serve is skipped; one that fails leaves none of its files', async () => {
    const fake = server({
      '/v1/approvals': [
        { id: 'appr-1', status: 'approved' },
        { id: 'appr-2', status: 'rejected' },
      ],
      '/v1/approvals/appr-2/audit-bundle': () =>
        json(400, { error: { code: 'invalid-request', message: 'No bundle' } }),
      '/v1/compliance/evidence/export': notMounted,
    });
    const res = await cli(fake);
    expect(res.exitCode).toBe(1);
    const m = await manifest();
    expect(m.kinds['signed/approvals']).toMatchObject({ status: 'failed' });
    await expect(readdir(join(out, 'signed/approvals'))).rejects.toThrow();
    expect(m.kinds['signed/compliance-evidence']).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/compliance/evidence/export (404)",
    });
    expect(m.kinds['signed/provenance']).toMatchObject({ status: 'ok' });

    // What a run that died part way left goes when the kind is read again.
    await mkdir(join(out, 'signed/approvals'), { recursive: true });
    await writeFile(join(out, 'signed/approvals/appr-stale.json'), '{}');
    const again = await cli(
      server({
        '/v1/approvals': [
          { id: 'appr-1', status: 'approved' },
          { id: 'appr-2', status: 'rejected' },
        ],
      }),
      ['--resume'],
    );
    expect(again.exitCode, again.stderr).toBe(0);
    expect((await readdir(join(out, 'signed/approvals'))).sort()).toEqual([
      'appr-1.json',
      'appr-2.json',
    ]);

    await rm(out, { recursive: true, force: true });
    const unserved = await cli(
      server({
        '/v1/provenance': [{ runId: 'run-1' }],
        '/v1/provenance/run-1': { runId: 'run-1' },
        '/v1/provenance/run-1/export': notMounted,
      }),
    );
    expect(unserved.exitCode, unserved.stderr).toBe(0);
    expect((await manifest()).kinds['signed/provenance']).toEqual({
      status: 'skipped',
      reason: "this server doesn't serve /v1/provenance/{runId}/export (404)",
    });
    await expect(readdir(join(out, 'signed/provenance'))).rejects.toThrow();
  });

  test.skipIf(process.platform === 'win32')(
    'only its owner may read the export: the folder, what’s in it, and an empty folder it was given',
    async () => {
      await mkdir(out);
      await chmod(out, 0o755);
      const fake = server({
        '/v1/artifacts': [{ blobId: 'blob-1' }],
        '/v1/artifacts/blob-1': () => new Response('acme bytes'),
        '/v1/approvals': [{ id: 'appr-1', status: 'approved' }],
      });
      const res = await cli(fake);
      expect(res.exitCode, res.stderr).toBe(0);
      const modes: Record<string, string> = {};
      for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);
        modes[path.slice(out.length + 1)] = ((await stat(path)).mode & 0o777).toString(8);
      }
      expect(((await stat(out)).mode & 0o777).toString(8)).toBe('700');
      expect(modes).toMatchObject({
        'manifest.json': '600',
        'agents.jsonl': '600',
        artifacts: '700',
        'artifacts/blob-1': '600',
        signed: '700',
        'signed/approvals': '700',
        'signed/approvals/appr-1.json': '600',
        'signed/compliance-evidence.json': '600',
      });
      const open = Object.entries(modes).filter(([, mode]) => mode !== '600' && mode !== '700');
      expect(open).toEqual([]);
    },
  );

  test('whoami names the tenant and says whether the caller is its admin, or its key’s scopes do', async () => {
    const scoped = server({
      '/v1/identity/whoami': { tenantId: TENANT, scopes: ['tenant-admin'] },
    });
    const res = await cli(scoped);
    expect(res.exitCode, res.stderr).toBe(0);
    expect((await manifest()).kinds.users).toMatchObject({ status: 'ok' });

    await rm(out, { recursive: true, force: true });
    const member = await cli(server({ '/v1/identity/whoami': { tenantId: TENANT, scopes: [] } }));
    expect(member.exitCode).toBe(1);
    expect(member.stderr).toContain("You aren't a tenant admin here");
    const decided = await cli(
      server({
        '/v1/identity/whoami': { tenantId: TENANT, scopes: ['tenant-admin'], tenantAdmin: false },
      }),
    );
    expect(decided.exitCode).toBe(1);
    expect(decided.stderr).toContain("You aren't a tenant admin here");
    // As the server decides it: a member key's scope, or a project key's, isn't a tenant admin's.
    for (const key of [{ role: 'member' }, { projectId: 'proj-1' }]) {
      const narrow = await cli(
        server({ '/v1/identity/whoami': { tenantId: TENANT, scopes: ['tenant-admin'], ...key } }),
      );
      expect(narrow.exitCode, JSON.stringify(key)).toBe(1);
      expect(narrow.stderr).toContain("You aren't a tenant admin here");
    }
    const full = await cli(
      server({
        '/v1/identity/whoami': { tenantId: TENANT, scopes: ['tenant-admin'], role: 'admin' },
      }),
    );
    expect(full.exitCode, full.stderr).toBe(0);
    await rm(out, { recursive: true, force: true });

    const nameless = await cli(server({ '/v1/identity/whoami': { scopes: ['tenant-admin'] } }));
    expect(nameless.exitCode).toBe(1);
    expect(nameless.stderr).toContain(
      'GET /v1/identity/whoami answered no tenantId, so the export has no tenant to name.',
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  test('the files agree only when the tenant was closing or suspended through every run', async () => {
    let state = 'active';
    let flowsDown = true;
    const answers: Record<string, Answer> = {
      '/v1/tenant': () => json(200, { id: TENANT, state }),
      '/v1/flows': () =>
        flowsDown
          ? json(500, { error: { code: 'internal', message: 'Oops' } })
          : json(200, { data: [], hasMore: false }),
    };
    expect((await cli(server(answers))).exitCode).toBe(1);
    state = 'closing';
    expect((await cli(server(answers), ['--resume'])).exitCode).toBe(1);
    expect((await manifest()).consistency).toMatch(/^Records can change while the export reads/);
    flowsDown = false;
    expect((await cli(server(answers), ['--resume'])).exitCode).toBe(0);
    const resumed = await manifest();
    expect(resumed.tenant.state).toBe('closing');
    expect(resumed.consistency).toMatch(/^Records can change while the export reads them/);

    await rm(out, { recursive: true, force: true });
    expect((await cli(server(answers))).exitCode).toBe(0);
    expect((await manifest()).consistency).toBe(
      'The tenant is closing: nothing in it changes but deletes, revocations and erasures, so the files agree with each other, but for one of those made while the export ran.',
    );

    // Suspended when it started, active again by the end.
    let reads = 0;
    answers['/v1/tenant'] = () =>
      json(200, { id: TENANT, state: reads++ === 0 ? 'suspended' : 'active' });
    await rm(out, { recursive: true, force: true });
    expect((await cli(server(answers))).exitCode).toBe(0);
    const thawed = await manifest();
    expect(reads).toBeGreaterThan(2);
    expect(thawed.tenant.state).toBe('active');
    expect(thawed.consistency).toMatch(/^Records can change while the export reads them/);
  });

  test('a kind skipped on a later run leaves none of what a run that stopped part way wrote of it', async () => {
    const refused = () => json(400, { error: { code: 'invalid-request', message: 'No' } });
    const first = await cli(
      server({
        '/v1/identity/users': refused,
        '/v1/approvals': [{ id: 'appr-1', status: 'approved' }],
        '/v1/approvals/appr-1/audit-bundle': refused,
        '/v1/compliance/evidence/export': refused,
      }),
    );
    expect(first.exitCode).toBe(1);
    // What a run that stopped part way could leave of each.
    await writeFile(join(out, 'users.jsonl'), '{}\n');
    await writeFile(join(out, 'users.jsonl.partial'), '{}\n');
    await mkdir(join(out, 'signed/approvals'), { recursive: true });
    await writeFile(join(out, 'signed/approvals/appr-1.json'), '{}');
    await writeFile(join(out, 'signed/compliance-evidence.json'), '{}');

    const again = await cli(
      server({ '/v1/identity/whoami': { tenantId: TENANT, scopes: [], tenantAdmin: false } }),
      ['--resume', '--yes', '--no-signed'],
    );
    expect(again.exitCode, again.stderr).toBe(0);
    const m = await manifest();
    for (const kind of ['users', 'signed/approvals', 'signed/compliance-evidence']) {
      expect(m.kinds[kind], kind).toMatchObject({ status: 'skipped' });
    }
    const left = await readdir(out, { recursive: true });
    // The provenance exports were done (none) in the first run, so their folder is kept.
    expect(left.filter((p) => p.startsWith('users') || p.startsWith('signed')).sort()).toEqual([
      'signed',
      'signed/provenance',
    ]);
  });

  test('--json prints the manifest', async () => {
    const res = await cli(server({ '/v1/agents': [{ id: 'agent-a' }] }), ['--json']);
    expect(res.exitCode, res.stderr).toBe(0);
    const printed = JSON.parse(res.stdout) as { kinds: Record<string, unknown> };
    expect(printed).toEqual(await manifest());
  });

  test('Ctrl+C stops it: the manifest has what was done, and no finish', async () => {
    const stop = new AbortController();
    const fake = server({
      '/v1/flows': () => {
        stop.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    const res = await cli(fake, [], { stopSignal: stop.signal });
    expect(res.exitCode).toBe(130);
    const m = await manifest();
    expect(m.finishedAt).toBeUndefined();
    expect(m.kinds.agents).toMatchObject({ status: 'ok' });
    expect(m.kinds.flows).toBeUndefined();
    expect(m.kinds.tools).toBeUndefined();
    expect(res.stdout).toContain('--resume');
  });
});
