// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The texts receiver (`/v1/texts-inbound/{tenantId}/{appId}`) over a fake
 * binding: what it passes the binding, and how it answers each outcome.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { EnvName, Result, TenantId, UserId } from '@kindgi/types';

import type {
  ConnectionError,
  TextsInboundAnswer,
  TextsInboundInput,
} from '../src/connection-binding.js';
import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { WEBHOOK_BODY_LIMITS } from '../src/trigger-binding.js';
import { noopConnections } from './support/full-app.js';

const tenantId = randomUUID() as TenantId;
const appId = randomUUID();
const path = `/v1/texts-inbound/${tenantId}/${appId}`;
const runHandler = {} as RunHandlerBinding;

/** What the fake binding answers, by the request's `x-acme-signature`; any other is refused. */
const OUTCOMES: Readonly<Record<string, Result<TextsInboundAnswer, ConnectionError>>> = {
  xml: { kind: 'ok', value: { contentType: 'text/xml', body: '<Response></Response>' } },
  plain: { kind: 'ok', value: { contentType: 'text/plain', body: 'challenge-1234' } },
  json: { kind: 'ok', value: { contentType: 'application/json', body: '{"received":true}' } },
  unavailable: {
    kind: 'err',
    error: { code: 'texts-inbound-unavailable', message: 'the credential could not be read' },
  },
  'store-down': {
    kind: 'err',
    error: { code: 'connection-store-failed', message: 'the store at db-7.internal is down' },
  },
  html: { kind: 'ok', value: { contentType: 'text/html' as never, body: '<p>hi</p>' } },
};

function makeApp(options: { texts?: boolean } = {}) {
  const received: TextsInboundInput[] = [];
  const tokensRead: string[] = [];
  const resolveToken: TokenResolver = async (token) => {
    tokensRead.push(token);
    return token === 'ana' ? { tenantId, userId: 'user-ana' as UserId } : null;
  };
  const { receiveTexts: _noop, ...withoutTexts } = noopConnections;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    envName: 'local' as EnvName,
    connections:
      options.texts === false
        ? withoutTexts
        : {
            ...withoutTexts,
            async receiveTexts(input) {
              received.push(input);
              return (
                OUTCOMES[input.headers['x-acme-signature'] ?? ''] ?? {
                  kind: 'err',
                  error: { code: 'texts-inbound-refused', message: 'the signature does not match' },
                }
              );
            },
          },
  });
  return { app, received, tokensRead };
}

type App = ReturnType<typeof makeApp>['app'];

function send(
  app: App,
  signature: string,
  options: { client?: string; to?: string; method?: 'GET' | 'POST'; body?: string } = {},
): Promise<Response> {
  const method = options.method ?? 'POST';
  return Promise.resolve(
    app.request(options.to ?? path, {
      method,
      headers: {
        'X-Acme-Signature': signature,
        'x-forwarded-for': options.client ?? '203.0.113.9',
        ...(method === 'POST' && { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(method === 'POST' && { body: options.body ?? 'From=%2B15550100&Body=Hi' }),
    }),
  );
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

describe('/v1/texts-inbound/{tenantId}/{appId}', () => {
  test('a POST needs no bearer: the binding gets the path with its query, the headers in lower case and the exact bytes', async () => {
    const { app, received } = makeApp();
    const res = await send(app, 'xml', { to: `${path}?status=1&To=%2B15550199` });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const [input] = received;
    expect(input).toMatchObject({
      tenantId,
      appId,
      method: 'POST',
      pathAndQuery: `${path}?status=1&To=%2B15550199`,
    });
    expect(input?.headers['x-acme-signature']).toBe('xml');
    expect(input?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.keys(input?.headers ?? {}).every((name) => name === name.toLowerCase())).toBe(
      true,
    );
    expect(new TextDecoder().decode(input?.rawBody)).toBe('From=%2B15550100&Body=Hi');
  });

  test('a GET handshake reaches the binding with its query and no body', async () => {
    const { app, received } = makeApp();
    const to = `${path}?hub.mode=subscribe&hub.verify_token=v-1&hub.challenge=1234`;
    const res = await send(app, 'plain', { method: 'GET', to });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-1234');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'GET', pathAndQuery: to });
    expect(received[0]?.rawBody).toHaveLength(0);
  });

  test.each([
    ['xml', 'text/xml; charset=UTF-8', '<Response></Response>'],
    ['plain', 'text/plain; charset=UTF-8', 'challenge-1234'],
    ['json', 'application/json', '{"received":true}'],
  ])(
    'a %s answer is a 200 in its own content type, its body as the binding gave it',
    async (signature, type, body) => {
      const { app } = makeApp();
      const res = await send(app, signature);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(await res.text()).toBe(body);
    },
  );

  test('a bearer token, if sent, is never read, nor passed on', async () => {
    const { app, received, tokensRead } = makeApp();
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: 'Bearer kgi_forged', 'X-Acme-Signature': 'xml' },
      body: 'Body=Hi',
    });
    expect(res.status).toBe(200);
    expect(tokensRead).toEqual([]);
    expect(received[0]?.headers).not.toHaveProperty('authorization');
  });

  test('every refusal is the same 401, whatever was wrong', async () => {
    const { app, received } = makeApp();
    const responses = [
      await send(app, 'forged'),
      await send(app, 'forged', { method: 'GET', to: `${path}?hub.challenge=1` }),
      await send(app, 'xml', { to: `/v1/texts-inbound/not-a-tenant/${appId}` }),
      await send(app, 'xml', { to: `/v1/texts-inbound/${tenantId}/not-an-app` }),
      await send(app, 'xml', { body: 'x'.repeat(WEBHOOK_BODY_LIMITS.maxBytes + 1) }),
    ];
    const bodies = await Promise.all(
      responses.map(async (res) => {
        expect(res.status).toBe(401);
        const error = await errorOf(res);
        return { code: error.code, message: error.message, details: error.details };
      }),
    );
    expect(bodies[0]).toEqual({
      code: 'texts-inbound-refused',
      message: "This request doesn't prove its sender",
      details: undefined,
    });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    // The malformed ids and the body over the cap never reached the binding.
    expect(received.map((input) => input.method)).toEqual(['POST', 'GET']);
  });

  test("a client past its refusals this minute gets a 429; its proven requests and another client's refusals don't", async () => {
    const { app } = makeApp();
    for (let i = 0; i < 60; i += 1) expect((await send(app, 'forged')).status).toBe(401);
    const limited = await send(app, 'forged');
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('rate-limit-exceeded');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await send(app, 'xml')).status).toBe(200);
    expect((await send(app, 'forged', { client: '198.51.100.7' })).status).toBe(401);
  });

  test("the server's own trouble is a 503, and the provider sends them again", async () => {
    const { app } = makeApp();
    const res = await send(app, 'unavailable');
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toMatchObject({
      code: 'texts-inbound-unavailable',
      message: "The texts couldn't be taken just now: send them again",
    });
  });

  test('any other code from the binding is the same 503, without its reason', async () => {
    const { app } = makeApp();
    const res = await send(app, 'store-down');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
      'texts-inbound-unavailable',
    );
    expect(text).not.toContain('connection-store-failed');
    expect(text).not.toContain('db-7');
  });

  test('an answer in a content type outside the three is never sent: a 503', async () => {
    const { app } = makeApp();
    const res = await send(app, 'html');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).not.toContain('text/html');
    expect((await errorOf(res)).code).toBe('texts-inbound-unavailable');
  });

  test("isn't mounted when the binding takes no texts", async () => {
    const { app } = makeApp({ texts: false });
    // Signed in, so the bearer chain lets it by, and no route answers it.
    for (const method of ['POST', 'GET'] as const) {
      const res = await app.request(path, {
        method,
        headers: { authorization: 'Bearer ana', 'X-Acme-Signature': 'xml' },
        ...(method === 'POST' && { body: 'Body=Hi' }),
      });
      expect(res.status).toBe(404);
    }
  });
});
