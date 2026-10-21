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
 *     answer again is accepted again). It says nothing about the run: who
 *     holds the link isn't a run reader;
 *   - `400 wait-token-output-invalid` (`details.issues`): it doesn't fit the
 *     tool's output schema, and the wait stays open for a fixed one;
 *     `400 bad-input`: the body isn't JSON, or nests too deep;
 *   - `404 wait-token-not-found`: no such token, or a wrong secret, never
 *     told apart; also on a runtime that can't pause runs;
 *   - `409 wait-token-closed` (`details.state`): the wait is over;
 *   - `413 request-too-large` (`details.maxBytes`): past 1 MiB;
 *   - `415 unsupported-media-type`: a body that isn't JSON. An empty body is `{}`.
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
import { readCapped } from '../read-capped.js';
import { resumeInline } from '../resume-inline.js';
import { WEBHOOK_BODY_LIMITS } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import type { WaitTokenBinding, WaitTokenRefusal } from '../wait-token-binding.js';

/** The most an answer may be: 1 MiB, as a webhook delivery before its trigger is found. */
export const WAIT_TOKEN_ANSWER_MAX_BYTES = WEBHOOK_BODY_LIMITS.maxBytes;

export interface WaitTokensRouterOptions {
  /** Absent: every token is `404 wait-token-not-found` (this runtime can't pause runs). */
  readonly binding?: WaitTokenBinding;
  /** Resumes a run whose wait the answer resolved, in the same request. */
  readonly runHandler: RunHandlerBinding;
}

export function waitTokensRouter(options: WaitTokensRouterOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/:token/complete', async (c) => {
    const answer = await readAnswer(c);
    if (answer.kind === 'refused') return answer.response;
    if (options.binding === undefined) return refusal(c, { code: 'wait-token-not-found' });
    const taken = await options.binding.complete({
      via: 'link',
      token: c.req.param('token'),
      output: answer.output,
    });
    if (taken.kind === 'err') return refusal(c, taken.error);
    if (taken.value.resolved) {
      const trace = c.get('trace');
      const resumed = await resumeInline(
        options.runHandler,
        taken.value.tenantId,
        taken.value.runId,
        { traceId: trace.traceId, spanId: trace.spanId },
      );
      // The answer is the runtime's either way: the run resumes later.
      if (resumed.kind === 'failed') {
        c.get('log').warn('resume after a wait token answer failed; the runtime resumes it later', {
          code: resumed.code,
        });
      }
    }
    return c.json({ status: 'accepted' as const }, 200);
  });

  return r;
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
  c.status(statusFor(refused.code) as never);
  return c.json(toWireError(refusalBody(refused), c.get('requestId')));
}

function refusalBody(refused: WaitTokenRefusal) {
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
  }
}
