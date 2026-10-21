// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run paused until another system answers: the answer through the wait
 * token's link (`POST /v1/wait-tokens/{token}/complete`, no bearer) or
 * through `POST /v1/runs/{runId}/resume` with a `pause:` waitpoint (write
 * on the run's project and execute on what it runs), the run resumed in
 * the same request, and the run's `waitingFor.tokens`. The token never
 * reaches a log line.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { JournalEntry, KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, Result, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  CompleteWaitTokenInput,
  FlowRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  WaitTokenAccepted,
  WaitTokenBinding,
  WaitTokenRefusal,
  WaitingToken,
} from '../src/index.js';
import { loggablePath } from '../src/middleware/request-log.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'wait-tokens-api-key';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const PROJECT = randomUUID() as ProjectId;
const FLOW = 'acme.carrier-booking';
/** A link's token: the credential, never in a log line. */
const LINK_TOKEN = 'kgi_wt_tenant_id_link-secret-7f3a';
const PAUSE_ID = 'pause:acme-key:1';
const at = '2026-10-21T15:00:00.000Z';
const ANSWER = { confirmedAt: '2026-10-21T16:00:00Z' };

const WAITING: WaitingToken = {
  tokenId: PAUSE_ID,
  name: "the carrier's pickup confirmation",
  tool: { id: 'acme.carrier.book-pickup', version: '1.0.0', callId: 'call-0' },
  createdAt: at,
  timesOutAt: '2026-10-22T15:00:00.000Z',
};

interface Options {
  /** `false`: a runtime that pauses no run. */
  readonly waitTokens?: false;
  readonly complete?: (
    input: CompleteWaitTokenInput,
  ) => Result<Omit<WaitTokenAccepted, 'tenantId' | 'runId'>, WaitTokenRefusal>;
  readonly waiting?: () => Promise<readonly WaitingToken[]>;
  readonly grants?: readonly string[];
  readonly resumeThrows?: boolean;
  /** The resume runs on and never settles, as a long stretch of the run would. */
  readonly resumeHangs?: boolean;
}

function harness(options: Options = {}) {
  const run: KernelRunRecord = {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: PROJECT,
    flowId: FLOW,
    flowVersion: '1.0.0',
    status: 'suspended',
    input: {},
    dryRun: false,
    createdAt: at as Timestamp,
    updatedAt: at as Timestamp,
  };
  let current = run;
  const completed: CompleteWaitTokenInput[] = [];
  const resumed: RunId[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const journal: JournalEntry[] = [
    {
      sequence: 1,
      kind: 'wait.suspended',
      payload: { tokenId: PAUSE_ID, timeoutMs: 86_400_000 },
      timestamp: at,
    } as unknown as JournalEntry,
  ];
  const waitTokens: WaitTokenBinding = {
    complete: async (input) => {
      completed.push(input);
      const answered = options.complete?.(input) ?? {
        kind: 'ok',
        value: { status: 'accepted', resolved: true },
      };
      return answered.kind === 'err'
        ? answered
        : { kind: 'ok', value: { ...answered.value, tenantId, runId: run.runId } };
    },
    waiting: options.waiting ?? (async () => [WAITING]),
  };
  const runHandler = {
    resumeRun: async ({ runId }: { runId: RunId }) => {
      resumed.push(runId);
      if (options.resumeThrows === true) throw new Error('the resume broke');
      if (options.resumeHangs === true) return new Promise(() => {});
      current = { ...run, status: 'completed', output: ANSWER };
      return { kind: 'ok', runId };
    },
  } as unknown as RunHandlerBinding;
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = options.grants?.includes(`${action} ${r.type}:${r.id}`) === true;
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const stubs = createStubAppBindings();
  const kernelRun = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => (id === run.runId ? current : null),
    readJournal: async () => ({ kind: 'ok', value: journal }),
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run: kernelRun },
    resolveToken,
    runHandler,
    logger: createLogger({ level: 'debug', write: (l) => lines.push(l) }),
    ...(options.waitTokens !== false && { waitTokens }),
    ...(options.grants !== undefined && {
      flowRegistry: { get: async () => ({ id: FLOW }) } as unknown as FlowRegistryBinding,
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, r) => decide(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  /** Another system's answer: no `Authorization` header. */
  const answer = (
    body: string | undefined,
    headers: Record<string, string> = { 'content-type': 'application/json' },
    token = LINK_TOKEN,
  ) =>
    app.request(`/v1/wait-tokens/${token}/complete`, {
      method: 'POST',
      headers,
      ...(body !== undefined && { body }),
    });
  const resume = (body: unknown) =>
    app.request(`/v1/runs/${run.runId}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, run, completed, resumed, asked, lines, answer, resume };
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;

describe('the link', () => {
  test('takes the answer with no key, resumes the run, and says only that it has it', async () => {
    const h = harness();
    const res = await h.answer(JSON.stringify(ANSWER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(h.completed).toEqual([{ via: 'link', token: LINK_TOKEN, output: ANSWER }]);
    expect(h.resumed).toEqual([h.run.runId]);
  });

  test('an answer before the run reaches its wait is held: nothing to resume yet', async () => {
    const h = harness({
      complete: () => ({ kind: 'ok', value: { status: 'accepted', resolved: false } }),
    });
    expect((await h.answer(JSON.stringify(ANSWER))).status).toBe(200);
    expect(h.resumed).toEqual([]);
  });

  test("a resume that fails doesn't fail the answer: it's logged, and the runtime resumes the run later", async () => {
    const h = harness({ resumeThrows: true });
    const res = await h.answer(JSON.stringify(ANSWER));
    expect(res.status).toBe(200);
    expect(h.resumed).toEqual([h.run.runId]);
    await vi.waitFor(() =>
      expect(h.lines.some((l) => l.includes('resume after a wait token answer failed'))).toBe(true),
    );
  });

  test("answers at once, while the run's resume goes on behind the answer", async () => {
    const h = harness({ resumeHangs: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<'held'>((resolve) => {
      timer = setTimeout(() => resolve('held'), 1_000);
    });
    const res = await Promise.race([h.answer(JSON.stringify(ANSWER)), held]);
    clearTimeout(timer);
    expect(res).not.toBe('held');
    expect((res as Response).status).toBe(200);
    expect(h.resumed).toEqual([h.run.runId]);
  });

  test('an empty body is {}, with or without a content type', async () => {
    const h = harness();
    expect((await h.answer(undefined, {})).status).toBe(200);
    expect((await h.answer('')).status).toBe(200);
    expect(h.completed.map((c) => c.output)).toEqual([{}, {}]);
  });

  test('takes a +json content type, with parameters', async () => {
    const h = harness();
    const res = await h.answer(JSON.stringify(ANSWER), {
      'content-type': 'application/vnd.acme.pickup+json; charset=utf-8',
    });
    expect(res.status).toBe(200);
  });

  test.each([
    ['text/plain', 'confirmed'],
    ['application/x-www-form-urlencoded', 'confirmedAt=now'],
  ])('a %s body is 415 unsupported-media-type, and nothing is taken', async (type, body) => {
    const h = harness();
    const res = await h.answer(body, { 'content-type': type });
    expect(res.status).toBe(415);
    expect((await errorOf(res)).code).toBe('unsupported-media-type');
    expect(h.completed).toEqual([]);
  });

  test('a body that is not JSON is 400 bad-input', async () => {
    const h = harness();
    const res = await h.answer('{"confirmedAt":');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('bad-input');
    expect(h.completed).toEqual([]);
  });

  test('past 1 MiB is 413 request-too-large, read no further', async () => {
    const h = harness();
    const res = await h.answer(JSON.stringify({ note: 'x'.repeat(1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({
      code: 'request-too-large',
      details: { maxBytes: 1024 * 1024 },
    });
    expect(h.completed).toEqual([]);
  });

  test.each([
    [{ code: 'wait-token-not-found' } as const, 404, undefined],
    [{ code: 'wait-token-closed', state: 'timed-out' } as const, 409, { state: 'timed-out' }],
    [
      { code: 'wait-token-output-invalid', issues: [{ path: '/confirmedAt' }] } as const,
      400,
      { issues: [{ path: '/confirmedAt' }] },
    ],
  ])('the binding refuses %o: %i', async (refusal, status, details) => {
    const h = harness({ complete: () => ({ kind: 'err', error: refusal }) });
    const res = await h.answer(JSON.stringify(ANSWER));
    expect(res.status).toBe(status);
    const error = await errorOf(res);
    expect(error.code).toBe(refusal.code);
    expect(error.details).toEqual(details);
    expect(error.message).not.toContain(LINK_TOKEN);
    expect(h.resumed).toEqual([]);
  });

  test('on a runtime that pauses no run, every link is 404 wait-token-not-found', async () => {
    const h = harness({ waitTokens: false });
    const res = await h.answer(JSON.stringify(ANSWER));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('wait-token-not-found');
  });

  test('the token never reaches a log line, on the route or off it', async () => {
    const h = harness({
      complete: () => ({ kind: 'err', error: { code: 'wait-token-not-found' } }),
    });
    await h.answer(JSON.stringify(ANSWER));
    // No route for a GET: the access line writes the raw path, with the token cut.
    await h.app.request(`/v1/wait-tokens/${LINK_TOKEN}/complete`, { method: 'GET' });
    const routes = h.lines.map((l) => (JSON.parse(l) as { route?: string }).route);
    expect(routes).toContain('/v1/wait-tokens/:token/complete');
    expect(h.lines.join('\n')).not.toContain(LINK_TOKEN);
  });

  test('loggablePath cuts the token from a wait token path, and leaves others', () => {
    expect(loggablePath(`/v1/wait-tokens/${LINK_TOKEN}/complete`)).toBe(
      '/v1/wait-tokens/:token/complete',
    );
    expect(loggablePath(`/v1/wait-tokens/${LINK_TOKEN}`)).toBe('/v1/wait-tokens/:token');
    expect(loggablePath('/v1/runs/abc')).toBe('/v1/runs/abc');
  });
});

describe('POST /v1/runs/{runId}/resume with a pause', () => {
  test('answers the wait as the other system would, resumes the run, and answers the run', async () => {
    const h = harness();
    const res = await h.resume({ waitpointId: PAUSE_ID, value: ANSWER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: h.run.runId,
      status: 'completed',
      output: ANSWER,
    });
    expect(h.completed).toEqual([
      expect.objectContaining({
        via: 'api',
        tenantId,
        runId: h.run.runId,
        tokenId: PAUSE_ID,
        output: ANSWER,
      }),
    ]);
    expect(h.resumed).toEqual([h.run.runId]);
  });

  test('no value is {}, as an empty body on the link; a null is the answer, as on the link', async () => {
    const h = harness();
    await h.resume({ waitpointId: PAUSE_ID });
    expect(h.completed[0]?.output).toEqual({});
    await h.resume({ waitpointId: PAUSE_ID, value: null });
    expect(h.completed[1]?.output).toBeNull();
  });

  test('a run still waiting answers what it waits for', async () => {
    const h = harness({
      complete: () => ({ kind: 'ok', value: { status: 'accepted', resolved: false } }),
    });
    const body = (await (await h.resume({ waitpointId: PAUSE_ID, value: ANSWER })).json()) as {
      status: string;
      waitingFor: unknown;
    };
    expect(body.status).toBe('suspended');
    expect(body.waitingFor).toEqual({ approvals: [], other: [], tokens: [WAITING] });
  });

  test('a wait that is over is 409 wait-token-closed, with its state', async () => {
    const h = harness({
      complete: () => ({ kind: 'err', error: { code: 'wait-token-closed', state: 'completed' } }),
    });
    const res = await h.resume({ waitpointId: PAUSE_ID, value: { other: true } });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: 'wait-token-closed',
      details: { state: 'completed' },
    });
    expect(h.resumed).toEqual([]);
  });

  test('a field the body does not take is 400 bad-input', async () => {
    const h = harness();
    const res = await h.resume({ waitpointId: PAUSE_ID, output: ANSWER });
    expect(res.status).toBe(400);
    expect(h.completed).toEqual([]);
  });

  test('needs execute on what the run runs, beside write on its project: who answers stands in for the other system', async () => {
    const writeOnly = harness({ grants: [`write project:${PROJECT}`] });
    const refused = await writeOnly.resume({ waitpointId: PAUSE_ID, value: ANSWER });
    expect(refused.status).toBe(403);
    expect(writeOnly.asked).toEqual([`write project:${PROJECT}`, `execute flow:${FLOW}`]);
    expect(writeOnly.completed).toEqual([]);

    const both = harness({ grants: [`write project:${PROJECT}`, `execute flow:${FLOW}`] });
    expect((await both.resume({ waitpointId: PAUSE_ID, value: ANSWER })).status).toBe(200);
    expect(both.completed).toHaveLength(1);
    expect(both.completed[0]).toHaveProperty('principal');
  });
});

describe("a suspended run's waitingFor", () => {
  test('lists its waits for an answer under tokens, never as unattributed', async () => {
    const h = harness();
    const res = await h.app.request(`/v1/runs/${h.run.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { waitingFor: unknown };
    expect(body.waitingFor).toEqual({ approvals: [], other: [], tokens: [WAITING] });
  });

  test("when they can't be read, the waits stay unattributed and tokens is left out", async () => {
    const h = harness({
      waiting: async () => {
        throw new Error('the token store is gone');
      },
    });
    const res = await h.app.request(`/v1/runs/${h.run.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { waitingFor: unknown };
    expect(body.waitingFor).toEqual({
      approvals: [],
      other: [{ what: 'unattributed', tokenId: PAUSE_ID, timesOutAt: '2026-10-22T15:00:00.000Z' }],
    });
  });

  test('on a runtime that pauses no run, tokens is left out', async () => {
    const h = harness({ waitTokens: false });
    const res = await h.app.request(`/v1/runs/${h.run.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { waitingFor: Record<string, unknown> };
    expect(body.waitingFor).not.toHaveProperty('tokens');
  });
});
