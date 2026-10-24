// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/wait-tokens/{token}/complete`: another system answers a run
 * paused on one of its tool calls (a pack tool that declares `pauses`).
 *
 * Outside the bearer chain (mounted ahead of `/v1`), as the webhook
 * receiver is: the system that answers has no Kindgi key, and a bearer
 * token, if sent, is never read. The token in the path is the credential:
 * it names one wait of one run, so the answer can complete nothing else.
 * The body is the answer itself, the tool's output, as the other system
 * posts it.
 *
 * The answers:
 *   - `200 { status: 'accepted' }`: the runtime has the answer (the same
 *     answer again is accepted again). It comes at once, and the run
 *     resumes behind it. It says nothing about the run: who holds the link
 *     isn't a run reader. An answer that came before the run reached its
 *     wait is held for it, and dropped if the run never waits on this
 *     token (the tool answered at once, or its step was retried); the link
 *     then answers `409 wait-token-closed`, `unused`;
 *   - `400 wait-token-output-invalid` (`details.issues`): it doesn't fit the
 *     tool's output schema, and the wait stays open for a fixed one;
 *     `400 bad-input`: the body isn't JSON, or nests too deep;
 *   - `404 wait-token-not-found`: no such token, or a wrong secret, never
 *     told apart; also on a runtime that can't pause runs;
 *   - `409 wait-token-closed` (`details.state`): the wait is over;
 *   - `409 tenant-closing`, `409 tenant-suspended` (`details.state`), `409
 *     project-suspended`: nothing runs where the run is, and closing or
 *     suspending cancels its runs, so the answer isn't taken. An answer is
 *     a write to a run that's already there, so it's refused as the
 *     tenant's writes are; a webhook delivery would start a new run, so a
 *     suspended tenant's or project's is answered `202` skipped, and a
 *     closing tenant takes none (`409 tenant-closing`).
 *     `503 tenant-state-unavailable` (`Retry-After`) when the tenant's
 *     state can't be read;
 *   - `413 request-too-large` (`details.maxBytes`): past 1 MiB;
 *   - `415 unsupported-media-type`: a body that isn't JSON. An empty body is `{}`;
 *   - `429 rate-limit-exceeded` (`Retry-After`): past
 *     {@link WAIT_TOKEN_LINK_REQUESTS_PER_CLIENT_PER_MINUTE} requests from
 *     this client in a minute, counted before the body is read or the token
 *     looked up. Nothing was taken: send the answer again then.
 *
 * The access line writes the route's pattern, never the token
 * (`request-log.ts`).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';

import { tenantInputBounds } from '@kindgi/bounds';

import { statusFor, toWireError } from '../errors.js';
import type { RunHandlerBinding } from '../handler-binding.js';
import { deepJsonRefusal, nestsDeeperThan } from '../middleware/request-body.js';
import { frozenTenantRefusal } from '../middleware/tenant-state.js';
import {
  type RateLimitStore,
  type RateLimitTake,
  createInMemoryRateLimitStore,
  nearestForwardedClient,
} from '../rate-limit-store.js';
import { readCapped } from '../read-capped.js';
import { resumeInline } from '../resume-inline.js';
import { WEBHOOK_BODY_LIMITS } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import type {
  WaitTokenAccepted,
  WaitTokenBinding,
  WaitTokenRefusal,
} from '../wait-token-binding.js';

/** The most an answer may be: 1 MiB, as a webhook delivery before its trigger is found. */
export const WAIT_TOKEN_ANSWER_MAX_BYTES = WEBHOOK_BODY_LIMITS.maxBytes;

/**
 * Requests a client may make to wait token links in a minute, counted
 * before the body is read or the token looked up; past them, `429`. Far
 * above what one system answering its own runs sends, and a guard on the
 * work only: the token's secret is what keeps a link from being guessed.
 */
export const WAIT_TOKEN_LINK_REQUESTS_PER_CLIENT_PER_MINUTE = 600;

const MINUTE_MS = 60_000;

export interface WaitTokensRouterOptions {
  /** Absent: every token is `404 wait-token-not-found` (this runtime can't pause runs). */
  readonly binding?: WaitTokenBinding;
  /** Resumes a run whose wait the answer resolved, behind the answer. */
  readonly runHandler: RunHandlerBinding;
  /**
   * Who the client is, the key of the per-client limit; `undefined` when
   * clients can't be told apart, which turns the limit off. Default: the
   * nearest `X-Forwarded-For` hop, else one shared bucket.
   */
  readonly clientAddress?: (request: Request) => string | undefined;
  /**
   * Where the counts live. Default: this process's memory, so each
   * instance counts on its own. If it fails, the request is let through
   * (the limit is a speed bump, not a lock) and the failure logged, at
   * most once a minute.
   */
  readonly rateLimitStore?: RateLimitStore;
}

export function waitTokensRouter(options: WaitTokensRouterOptions): Hono<AppEnv> {
  const clientAddress = options.clientAddress ?? nearestForwardedClient;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();
  let lastWarnedAt: number | undefined;

  /** A take from the store; `allowed` when the store fails (logged, at most once a minute). */
  async function take(c: Context<AppEnv>, client: string): Promise<RateLimitTake> {
    try {
      return await store.take({
        key: `wait-token-link:${client}`,
        limit: WAIT_TOKEN_LINK_REQUESTS_PER_CLIENT_PER_MINUTE,
        windowMs: MINUTE_MS,
      });
    } catch (cause) {
      const at = Date.now();
      if (lastWarnedAt === undefined || at - lastWarnedAt >= MINUTE_MS) {
        c.get('log').warn(
          `wait token link: the rate-limit store failed, so requests aren't counted: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        lastWarnedAt = at;
      }
      return { allowed: true };
    }
  }

  const r = new Hono<AppEnv>();

  r.post('/:token/complete', async (c) => {
    const client = clientAddress(c.req.raw);
    if (client !== undefined) {
      const taken = await take(c, client);
      if (!taken.allowed) {
        c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
        c.status(statusFor('rate-limit-exceeded') as never);
        return c.json(
          toWireError(
            {
              code: 'rate-limit-exceeded',
              message: 'Too many requests from this client: send the answer again shortly',
            },
            c.get('requestId'),
          ),
        );
      }
    }
    const answer = await readAnswer(c);
    if (answer.kind === 'refused') return answer.response;
    if (options.binding === undefined) return refusal(c, { code: 'wait-token-not-found' });
    const taken = await options.binding.complete({
      via: 'link',
      token: c.req.param('token'),
      output: answer.output,
    });
    if (taken.kind === 'err') return refusal(c, taken.error);
    if (taken.value.resolved) resumeBehind(c, options.runHandler, taken.value);
    return c.json({ status: 'accepted' as const }, 200);
  });

  return r;
}

/**
 * Resume the run the answer released, not awaited. The run's next stretch
 * runs to its next wait or its end, model calls and tools, which can take
 * minutes; the system that answered waits for none of it, and its callback
 * client would time out first. The answer is the runtime's either way: a
 * failed resume is logged, and if it failed before it took the run, the
 * runtime's sweep resumes the run later. One cut after it took the run
 * fails with it, as any run does whose server stops. So the runtime needs
 * CPU outside requests, as its background turns and sweeps already do.
 */
function resumeBehind(
  c: Context<AppEnv>,
  runHandler: RunHandlerBinding,
  accepted: WaitTokenAccepted,
): void {
  const { traceId, spanId } = c.get('trace');
  const log = c.get('log');
  void resumeInline(runHandler, accepted.tenantId, accepted.runId, { traceId, spanId })
    .then((resumed) => {
      if (resumed.kind === 'failed') {
        log.warn('resume after a wait token answer failed', {
          runId: accepted.runId,
          code: resumed.code,
        });
      }
    })
    // `resumeInline` never rejects; this keeps a throwing logger from
    // becoming an unhandled rejection.
    .catch(() => undefined);
}

/**
 * The body as JSON, at most `WAIT_TOKEN_ANSWER_MAX_BYTES`: an empty body
 * is `{}`; any other needs a JSON content type.
 */
async function readAnswer(
  c: Context<AppEnv>,
): Promise<{ kind: 'ok'; output: unknown } | { kind: 'refused'; response: Response }> {
  const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) => {
    c.status(statusFor(code) as never);
    return {
      kind: 'refused' as const,
      response: c.json(toWireError({ code, message, ...extra }, c.get('requestId'))),
    };
  };
  const body = await readCapped(c.req.raw, WAIT_TOKEN_ANSWER_MAX_BYTES);
  if (body === 'too-large') {
    return refuse(
      'request-too-large',
      `The answer is over the limit of ${WAIT_TOKEN_ANSWER_MAX_BYTES} bytes`,
      { maxBytes: WAIT_TOKEN_ANSWER_MAX_BYTES },
    );
  }
  if (body.byteLength === 0) return { kind: 'ok', output: {} };
  if (!isJsonContentType(c.req.header('content-type'))) {
    return refuse(
      'unsupported-media-type',
      'The answer is JSON: send it with `Content-Type: application/json`',
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return refuse('bad-input', 'The answer is not valid JSON');
  }
  const maxDepth = tenantInputBounds().requestJsonMaxDepth;
  if (nestsDeeperThan(output, maxDepth)) {
    const deep = deepJsonRefusal(maxDepth);
    return refuse(deep.code, deep.message, { maxDepth });
  }
  return { kind: 'ok', output };
}

/** `application/json`, or a `+json` type, with any parameters. */
function isJsonContentType(header: string | undefined): boolean {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type);
}

/** A refusal on the wire; the messages never echo the token. */
export function refusal(c: Context<AppEnv>, refused: WaitTokenRefusal): Response {
  switch (refused.code) {
    // As every write of a frozen tenant is refused (`tenantStateGate`).
    case 'tenant-frozen':
      return frozenTenantRefusal(c, refused.state);
    default:
      c.status(statusFor(refused.code) as never);
      return c.json(toWireError(refusalBody(refused), c.get('requestId')));
  }
}

function refusalBody(refused: Exclude<WaitTokenRefusal, { code: 'tenant-frozen' }>) {
  switch (refused.code) {
    case 'wait-token-not-found':
      return { code: refused.code, message: 'No wait token matches this link' };
    case 'wait-token-closed':
      return {
        code: refused.code,
        message: `The wait is over (${refused.state}): it takes no other answer`,
        state: refused.state,
      };
    case 'wait-token-output-invalid':
      return {
        code: refused.code,
        message: "The answer doesn't fit the tool's output schema; the wait is still open",
        issues: refused.issues,
      };
    case 'project-suspended':
      return {
        code: refused.code,
        message:
          "The run's project is suspended, so nothing runs in it and its runs are cancelled; the answer wasn't taken",
      };
  }
}
