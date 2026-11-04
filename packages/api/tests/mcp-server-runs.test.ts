// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/mcp`'s run tools: one per agent and flow its author exposed that the
 * person can see, each started as the person and followed up to the wait
 * limit; `kindgi.run_state`; and the run view. A stand-in `/v1` answers as
 * the routes would, as the person (the routes' own checks are theirs), and
 * records what the tools asked of it.
 */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import type { TokenResolution } from '../src/index.js';
import { mountMcpServer } from '../src/mcp-server/endpoint.js';
import { type RunWait, agentTools, runStateTools } from '../src/mcp-server/run-tools.js';
import { RUN_VIEW_HTML, RUN_VIEW_MIME, RUN_VIEW_URI } from '../src/mcp-server/run-view.js';
import type { AppEnv } from '../src/types.js';
import { mcpRpc } from './support/mcp-rpc.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const RUN_ID = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const APPROVAL = '00000000-0000-4000-8000-0000000000d1';
const CONVERSATION = '00000000-0000-4000-8000-0000000000e1';
const STARTED = '2026-11-03T15:00:00.000Z';
const ENDED = '2026-11-03T15:00:20.000Z';
const CONSOLE = 'https://kindgi.test/console';
/** The tools' waits, short: the cap is 60 ms here, 25 s in a build. */
const WAIT = { waitMs: 60, firstCheckMs: 1, checkMs: 5 };
const WAIT_AGAIN = `call kindgi.run_state with runId ${RUN_ID} and waitSeconds 25`;

const SCOPES: Record<string, string[]> = {
  'chat-run': ['kindgi:read', 'kindgi:run'],
  'chat-read': ['kindgi:read'],
};

type Json = Record<string, unknown>;

const CLAUSES = {
  id: 'acme.clauses',
  version: '1.0.0',
  name: 'Clause compare',
  description: 'Compares two contracts clause by clause.',
  projectId: PROJECT,
  instructions: 'Never shown to a chat.',
  parameters: [
    { name: 'jurisdiction', type: 'string', description: 'Whose law.' },
    { name: 'asOf', type: 'date', required: false },
    { name: 'strict', type: 'boolean', default: false },
  ],
  mcp: { expose: true, readOnly: true },
};
const PLAIN = { id: 'acme.plain', version: '1.0.0', name: 'Plain', projectId: PROJECT };
const UNEXPOSED = { id: 'acme.quiet', version: '1.0.0', name: 'Quiet', mcp: { expose: false } };
const RETIRED = {
  id: 'acme.retired',
  version: '1.0.0',
  name: 'Retired',
  mcp: { expose: true },
  unregisteredAt: '2026-11-01T00:00:00.000Z',
};
const INTAKE = {
  id: 'acme.intake',
  version: '1.0.0',
  name: 'Intake',
  nodes: [],
  edges: [],
  mcp: { expose: true },
};

function agentRun(over: Json = {}): Json {
  return {
    id: RUN_ID,
    flowId: 'agent-turn',
    status: 'running',
    createdAt: STARTED,
    agent: { id: 'acme.clauses', version: '1.0.0', conversationId: CONVERSATION },
    ...over,
  };
}

const completed = (output: unknown): Json =>
  agentRun({ status: 'completed', completedAt: ENDED, output });

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

interface HarnessOptions {
  /** What `GET /v1/runs/:runId` answers at each check; the last one repeats. */
  readonly runs?: readonly Json[];
  /** `POST /v1/runs`'s status, when it refuses. */
  readonly refuseStart?: 400 | 403 | 404 | 429;
  readonly agentPages?: readonly (readonly Json[])[];
  readonly files?: readonly Json[];
  /** The run tools' wait; `WAIT` by default. */
  readonly wait?: RunWait;
}

function harness(options: HarnessOptions = {}) {
  const seen: Seen[] = [];
  const runs = options.runs ?? [completed({ response: { content: 'Clause 4 differs.' } })];
  const pages = options.agentPages ?? [[CLAUSES, PLAIN, UNEXPOSED, RETIRED]];
  let checks = 0;
  let starts = 0;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.use('/v1/*', async (c, next) => {
    const url = new URL(c.req.url);
    const key = c.req.header('idempotency-key');
    seen.push({
      method: c.req.method,
      path: `${url.pathname}${url.search}`,
      ...(c.req.method === 'POST' && { body: await c.req.json() }),
      ...(key !== undefined && { idempotencyKey: key }),
    });
    await next();
  });
  app.get('/v1/agents', (c) => {
    const at = Number(c.req.query('cursor') ?? '0');
    const more = at + 1 < pages.length;
    return c.json({ data: pages[at], hasMore: more, ...(more && { nextCursor: String(at + 1) }) });
  });
  app.get('/v1/agents/:agentId', (c) => {
    const agent = pages.flat().find((a) => a.id === c.req.param('agentId'));
    return agent ? c.json(agent) : c.json({ error: { code: 'agent-not-found' } }, 404);
  });
  app.get('/v1/flows', (c) => c.json({ data: [INTAKE], hasMore: false }));
  app.get('/v1/flows/:flowId', (c) =>
    c.req.param('flowId') === INTAKE.id
      ? c.json(INTAKE)
      : c.json({ error: { code: 'flow-not-found' } }, 404),
  );
  app.post('/v1/runs', (c) => {
    starts++;
    if (options.refuseStart === 400) {
      return c.json(
        {
          error: {
            code: 'validation-failed',
            message: 'The input is invalid.',
            details: { issues: [{ path: '/parameters/jurisdiction', message: 'is required' }] },
          },
        },
        400,
      );
    }
    if (options.refuseStart !== undefined) {
      return c.json({ error: { code: 'refused', message: 'internal words' } }, options.refuseStart);
    }
    return c.json({ ...agentRun({ status: 'pending' }), publicAccessToken: 'never-shown' }, 202);
  });
  app.get('/v1/runs/:runId', (c) => {
    if (c.req.param('runId') !== RUN_ID) return c.json({ error: { code: 'run-not-found' } }, 404);
    const run = runs[Math.min(checks, runs.length - 1)];
    checks++;
    return c.json(run);
  });
  app.get('/v1/artifacts', (c) => c.json({ data: options.files ?? [], hasMore: false }));

  mountMcpServer(
    app,
    {
      resolveToken: async (token): Promise<TokenResolution | null> => {
        const scopes = SCOPES[token];
        if (scopes === undefined) return null;
        return {
          tenantId,
          userId: 'alice' as UserId,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes,
        };
      },
      resourceMetadataUrl: 'https://kindgi.test/.well-known/oauth-protected-resource/mcp',
      consoleUrl: CONSOLE,
      version: '0.0.0-test',
    },
    [runStateTools(options.wait ?? WAIT), agentTools(options.wait ?? WAIT)],
  );
  return {
    rpc: mcpRpc(app),
    seen,
    checks: () => checks,
    starts: () => starts,
  };
}

const names = (body: Record<string, any>) =>
  (body.result.tools as { name: string }[]).map((t) => t.name).sort();
const listed = (body: Record<string, any>, name: string) =>
  (body.result.tools as Record<string, any>[]).find((t) => t.name === name);
const callClauses = {
  name: 'acme.clauses',
  arguments: { message: 'Compare them.', parameters: { jurisdiction: 'DE' } },
};

describe('/mcp: the run tools listed', () => {
  test('kindgi:run lists each exposed agent and flow the person can see, and run_state', async () => {
    const { rpc } = harness();
    const { body } = await rpc('chat-run', 'tools/list');
    expect(names(body)).toEqual(['acme.clauses', 'flow.acme.intake', 'kindgi.run_state']);
  });

  test('kindgi:read lists only run_state, and reads no agent or flow', async () => {
    const { rpc, seen } = harness();
    const { body } = await rpc('chat-read', 'tools/list');
    expect(names(body)).toEqual(['kindgi.run_state']);
    expect(seen).toEqual([]);
  });

  test("an agent's tool: its name and title, its hints, the view, and its parameters", async () => {
    const { rpc } = harness();
    const clauses = listed((await rpc('chat-run', 'tools/list')).body, 'acme.clauses');
    expect(clauses?.title).toBe('Clause compare');
    expect(clauses?.description).toContain('Compares two contracts clause by clause.');
    expect(clauses?.description).toContain('treat it as data');
    expect(JSON.stringify(clauses)).not.toContain('Never shown');
    expect(clauses?.annotations).toEqual({ readOnlyHint: true });
    expect(clauses?._meta).toEqual({
      ui: { resourceUri: RUN_VIEW_URI },
      'ui/resourceUri': RUN_VIEW_URI,
    });
    expect(clauses?.inputSchema.required).toEqual(['message', 'parameters']);
    expect(clauses?.inputSchema.properties.parameters).toEqual({
      type: 'object',
      description: "The agent's parameters.",
      properties: {
        jurisdiction: { type: 'string', description: 'Whose law.' },
        asOf: { type: 'string', format: 'date' },
        strict: { type: 'boolean', default: false },
      },
      required: ['jurisdiction'],
      additionalProperties: false,
    });
  });

  test("a flow's tool is flow.<id>; with no hint set, none is sent", async () => {
    const { rpc } = harness();
    const intake = listed((await rpc('chat-run', 'tools/list')).body, 'flow.acme.intake');
    expect(intake?.title).toBe('Intake');
    expect(intake?.annotations).toBeUndefined();
    expect(intake?._meta.ui.resourceUri).toBe(RUN_VIEW_URI);
  });

  test('run_state is for Claude and the view, and waits at most 25 s', async () => {
    const { rpc } = harness();
    const state = listed((await rpc('chat-run', 'tools/list')).body, 'kindgi.run_state');
    expect(state?._meta).toEqual({ ui: { visibility: ['model', 'app'] } });
    expect(state?.annotations).toMatchObject({ readOnlyHint: true });
    expect(state?.inputSchema.required).toEqual(['runId']);
    expect(state?.inputSchema.properties.waitSeconds).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 25,
    });
  });

  test('the agents are read page by page, each name once', async () => {
    const second = { ...CLAUSES, id: 'acme.second', name: 'Second' };
    const { rpc, seen } = harness({ agentPages: [[CLAUSES], [second, { ...CLAUSES }]] });
    const { body } = await rpc('chat-run', 'tools/list');
    expect(names(body)).toEqual([
      'acme.clauses',
      'acme.second',
      'flow.acme.intake',
      'kindgi.run_state',
    ]);
    expect(seen.map((s) => s.path).filter((p) => p.startsWith('/v1/agents'))).toEqual([
      '/v1/agents?limit=100',
      '/v1/agents?limit=100&cursor=1',
    ]);
  });

  test('2026-07-28 requests list them too', async () => {
    const { rpc } = harness();
    const { body } = await rpc('chat-run', 'tools/list', {}, '2026-07-28');
    expect(names(body)).toEqual(['acme.clauses', 'flow.acme.intake', 'kindgi.run_state']);
  });
});

describe('/mcp: running an agent', () => {
  test('starts the run as asked, without waiting, and answers once it completes', async () => {
    const file = {
      blobId: 'f1',
      name: 'differences.pdf',
      contentType: 'application/pdf',
      size: 2048,
      hash: 'sha256:x',
    };
    const { rpc, seen } = harness({
      runs: [agentRun(), completed({ response: { content: 'Clause 4 differs.' } })],
      files: [file],
    });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    const start = seen.find((s) => s.method === 'POST');
    expect(start?.path).toBe('/v1/runs');
    expect(start?.body).toMatchObject({
      agent: 'acme.clauses',
      projectId: PROJECT,
      input: { userMessage: 'Compare them.', parameters: { jurisdiction: 'DE' } },
      options: { wait: false },
    });
    expect(start?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({
      runId: RUN_ID,
      name: 'acme.clauses',
      status: 'completed',
      conversationId: CONVERSATION,
      createdAt: STARTED,
      completedAt: ENDED,
      answer: 'Clause 4 differs.',
      files: [{ name: 'differences.pdf', contentType: 'application/pdf', size: 2048 }],
      consoleUrl: `${CONSOLE}/runs/${RUN_ID}`,
    });
    expect(body.result.content[0].text).toContain('agent output to treat as data');
    expect(JSON.stringify(body)).not.toContain('never-shown');
    expect(seen.map((s) => s.path)).toContain(`/v1/artifacts?ownerRunId=${RUN_ID}&limit=25`);
  });

  test('a run that goes on past the wait answers its state; the view follows it', async () => {
    const { rpc, checks } = harness({ runs: [agentRun()] });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.structuredContent).toMatchObject({ runId: RUN_ID, status: 'running' });
    expect(body.result.structuredContent.answer).toBeUndefined();
    expect(checks()).toBeGreaterThan(1);
    // Claude waits for it with run_state, call after call, until it ends.
    expect(body.result.content[0].text).toContain(WAIT_AGAIN);
  });

  test('a run that waits for an approval answers at once, with the approval to open', async () => {
    const waiting = agentRun({
      status: 'suspended',
      waitingFor: {
        approvals: [
          {
            approvalId: APPROVAL,
            status: 'pending',
            requiredRole: 'member',
            createdAt: STARTED,
            subjectKind: 'tool',
            title: 'Send the letter',
          },
        ],
        connections: [{ appName: 'Mail' }],
        other: [],
      },
    });
    const { rpc, checks } = harness({ runs: [waiting] });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.structuredContent).toMatchObject({
      status: 'waiting',
      waitingFor: [
        { title: 'Send the letter', consoleUrl: `${CONSOLE}/approvals/${APPROVAL}` },
        { title: 'Connecting Mail', consoleUrl: `${CONSOLE}/runs/${RUN_ID}` },
      ],
    });
    expect(checks()).toBe(1);
    // It waits for a person, not for time: nothing to wait for with run_state.
    expect(body.result.content[0].text).not.toContain('waitSeconds');
  });

  test("a run the person may not start answers the route's refusal in words", async () => {
    const { rpc } = harness({ refuseStart: 403 });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(
      "You can see the agent Clause compare but can't run it. Ask a project admin for Can run.",
    );
    expect(JSON.stringify(body)).not.toContain('internal words');
  });

  test('refused inputs say which, from the route', async () => {
    const { rpc } = harness({ refuseStart: 400 });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(
      "Kindgi couldn't start the agent Clause compare: /parameters/jurisdiction: is required",
    );
  });

  test('a long answer is cut at 8,000 characters, and says so', async () => {
    const { rpc } = harness({ runs: [completed({ response: { content: 'x'.repeat(9_000) } })] });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.structuredContent.answer).toHaveLength(8_000);
    expect(body.result.structuredContent.truncated).toBe(true);
  });

  test("a typed agent's answer is its output, as JSON", async () => {
    const { rpc } = harness({
      runs: [completed({ response: { content: 'prose' }, output: { differs: [4] } })],
    });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.structuredContent.answer).toBe(JSON.stringify({ differs: [4] }, null, 2));
  });

  test('a failed run says why in a sentence', async () => {
    const { rpc } = harness({
      runs: [
        agentRun({
          status: 'failed',
          completedAt: ENDED,
          failure: { code: 'budget-exceeded', message: 'The turn ran out of steps.' },
        }),
      ],
    });
    const { body } = await rpc('chat-run', 'tools/call', callClauses);
    expect(body.result.structuredContent).toMatchObject({
      status: 'failed',
      failure: 'The turn ran out of steps.',
    });
  });

  test('an agent not exposed is no tool, and nothing is started', async () => {
    const { rpc, starts } = harness();
    const { body } = await rpc('chat-run', 'tools/call', {
      name: 'acme.plain',
      arguments: { message: 'Hi.' },
    });
    expect(body.error !== undefined || body.result?.isError === true).toBe(true);
    expect(starts()).toBe(0);
  });

  test('a flow tool starts the flow with its input', async () => {
    const flowRun = {
      id: RUN_ID,
      flowId: 'acme.intake',
      status: 'completed',
      createdAt: STARTED,
      completedAt: ENDED,
      output: { filed: true },
    };
    const { rpc, seen } = harness({ runs: [flowRun] });
    const { body } = await rpc('chat-run', 'tools/call', {
      name: 'flow.acme.intake',
      arguments: { input: { document: 'lease.pdf' } },
    });
    expect(seen.find((s) => s.method === 'POST')?.body).toEqual({
      flow: 'acme.intake',
      input: { document: 'lease.pdf' },
      options: { wait: false },
    });
    expect(body.result.structuredContent).toMatchObject({
      name: 'acme.intake',
      status: 'completed',
      answer: JSON.stringify({ filed: true }, null, 2),
    });
  });
});

describe('/mcp: run_state and the run view', () => {
  test('run_state reads the run, and no agent or flow list', async () => {
    const { rpc, seen } = harness();
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: RUN_ID },
    });
    expect(body.result.structuredContent).toMatchObject({ runId: RUN_ID, status: 'completed' });
    expect(seen.map((s) => s.path)).toEqual([
      `/v1/runs/${RUN_ID}`,
      `/v1/artifacts?ownerRunId=${RUN_ID}&limit=25`,
    ]);
  });

  test('without a wait, run_state reads a run that goes on once', async () => {
    const { rpc, checks } = harness({ runs: [agentRun()] });
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: RUN_ID },
    });
    expect(body.result.structuredContent).toMatchObject({ runId: RUN_ID, status: 'running' });
    expect(checks()).toBe(1);
  });

  test('with a wait, run_state answers as soon as the run ends', async () => {
    const { rpc, checks } = harness({
      runs: [agentRun(), agentRun(), completed({ response: { content: 'Clause 4 differs.' } })],
      // A cap with room for 3 checks on a busy machine: the run ends at the 3rd.
      wait: { ...WAIT, waitMs: 5_000 },
    });
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: RUN_ID, waitSeconds: 25 },
    });
    expect(body.result.structuredContent).toMatchObject({
      status: 'completed',
      answer: 'Clause 4 differs.',
    });
    expect(checks()).toBe(3);
    expect(body.result.content[0].text).not.toContain('waitSeconds');
  });

  test('its wait stops at the cap, and says to call again; the run goes on', async () => {
    const { rpc, checks } = harness({ runs: [agentRun()] });
    const asked = Date.now();
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: RUN_ID, waitSeconds: 25 },
    });
    expect(body.result.structuredContent).toMatchObject({ runId: RUN_ID, status: 'running' });
    expect(checks()).toBeGreaterThan(1);
    // The harness's cap is 60 ms: 25 s asked, the cap held.
    expect(Date.now() - asked).toBeLessThan(5_000);
    expect(body.result.content[0].text).toContain(WAIT_AGAIN);
  });

  test('a wait over 25 s is refused, and nothing is read', async () => {
    const { rpc, checks } = harness({ runs: [agentRun()] });
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: RUN_ID, waitSeconds: 26 },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('waitSeconds must be <= 25');
    expect(checks()).toBe(0);
  });

  test("a run the person can't see: a sentence, no detail", async () => {
    const { rpc } = harness();
    const { body } = await rpc('chat-read', 'tools/call', {
      name: 'kindgi.run_state',
      arguments: { runId: '00000000-0000-4000-8000-0000000000ff' },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(
      "There's no run 00000000-0000-4000-8000-0000000000ff you can see.",
    );
  });

  test('the view is served as an MCP App', async () => {
    const { rpc } = harness();
    const { body } = await rpc('chat-read', 'resources/read', { uri: RUN_VIEW_URI });
    const [view] = body.result.contents as { uri: string; mimeType: string; text: string }[];
    expect(view?.uri).toBe(RUN_VIEW_URI);
    expect(view?.mimeType).toBe(RUN_VIEW_MIME);
    expect(view?.text).toBe(RUN_VIEW_HTML);
  });

  test('the view sends no message as the person, and reads run_state with no wait', () => {
    expect(RUN_VIEW_HTML).not.toContain('ui/message');
    expect(RUN_VIEW_HTML).toContain(
      'request("tools/call", { name: "kindgi.run_state", arguments: { runId: state.runId } })',
    );
    expect(RUN_VIEW_HTML).not.toContain('waitSeconds');
    expect(RUN_VIEW_HTML).not.toContain('innerHTML');
  });
});
