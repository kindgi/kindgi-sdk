// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A handler's throw says its causes, masked, with the call's own values
 * taken out first.
 */

import { createServer } from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ConnectionRejectedError, type ToolConnection } from '@kindgi/tools';

import { serializeCause, stringifyError } from '../src/error-text.js';
import type { HandlerContext, HandlerModule, ToolInvocationSpec } from '../src/handler-runner.js';
import { runCheck, runHandler } from '../src/handler-runner.js';
import { withoutSecrets } from '../src/secret-redaction.js';

const tool: ToolInvocationSpec = {
  id: 'acme.list-orders',
  modulePath: '/fake/orders.js',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
};

const ctx = (overrides: Partial<HandlerContext> = {}): HandlerContext => ({
  tenantId: 'tenant-1',
  runId: 'run-1',
  ...overrides,
});

const connection = (accessToken: string): ToolConnection => ({
  connectionId: 'c-1',
  app: 'mail',
  appName: 'Mail',
  accessToken,
  account: { id: 'a-1', label: 'orders@acme.example' } as ToolConnection['account'],
});

/** The handler-throw answer's message for a handler that throws `thrown`. */
async function thrownMessage(thrown: unknown, context: HandlerContext = ctx()): Promise<string> {
  const outcome = await runHandler({
    tool,
    input: {},
    ctx: context,
    importHandler: async (): Promise<HandlerModule> => () => {
      throw thrown;
    },
  });
  if (outcome.kind !== 'err') throw new Error('expected the handler to fail');
  return outcome.error.message;
}

function coded(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** undici's connect timeout, as `fetch` rejects with it. */
function fetchFailed(): TypeError {
  const timeout = coded(
    'Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)',
    'UND_ERR_CONNECT_TIMEOUT',
  );
  timeout.name = 'ConnectTimeoutError';
  return new TypeError('fetch failed', { cause: timeout });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a handler's throw says its causes", () => {
  test("fetch's failure says undici's reason", async () => {
    expect(await thrownMessage(fetchFailed())).toBe(
      'Handler for tool "acme.list-orders" threw: TypeError: fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)',
    );
  });

  test('an error with no cause reads as it did', async () => {
    expect(await thrownMessage(new Error('No order Z-9'))).toBe(
      'Handler for tool "acme.list-orders" threw: Error: No order Z-9',
    );
  });

  test("the wire's cause keeps today's shape", () => {
    const err = fetchFailed();
    expect(serializeCause(err)).toEqual({
      name: 'TypeError',
      message: 'fetch failed',
      stack: err.stack,
    });
    expect(serializeCause('x')).toBe('x');
    expect(serializeCause(undefined)).toBeNull();
  });

  test("a check's throw says its causes too", async () => {
    const outcome = await runCheck({
      check: { id: 'acme.cites', modulePath: '/fake/cites.js' },
      config: {},
      trace: {},
      importCheck: () => ({
        evaluate: () => {
          throw fetchFailed();
        },
      }),
    });
    expect(outcome.kind === 'err' && outcome.error.message).toBe(
      'Check "acme.cites" evaluate() threw: TypeError: fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)',
    );
  });

  test("the causes come before a pack image's missing-package hint", async () => {
    vi.stubEnv('KINDGI_IMAGE_DEPENDENCIES', 'loaded');
    const missing = coded(
      "Cannot find package 'acme-plugin' imported from /pack/x.js",
      'ERR_MODULE_NOT_FOUND',
      coded('resolve failed', 'ENOENT'),
    );
    const message = await thrownMessage(missing);
    expect(message).toMatch(
      /threw: Error: Cannot find package 'acme-plugin' imported from \/pack\/x\.js; caused by Error \[ENOENT\]: resolve failed\. acme-plugin isn't in this pack image/,
    );
  });

  test('a real fetch to a closed port says the refused address', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let thrown: unknown;
    try {
      await fetch(`http://127.0.0.1:${address.port}/orders`);
    } catch (err) {
      thrown = err;
    }
    const message = await thrownMessage(thrown);
    expect(message).toContain('threw: TypeError: fetch failed; caused by ');
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain(`127.0.0.1:${address.port}`);
  });
});

describe('the message is masked', () => {
  test("the error's own words: Bearer and a Kindgi token, whole", async () => {
    expect(
      await thrownMessage(new Error('Bearer abc123 rejected, key kgi_bt_0123456789abcdefWXYZ')),
    ).toBe(
      'Handler for tool "acme.list-orders" threw: Error: Bearer [redacted] rejected, key [redacted]',
    );
  });

  test('a thrown string too', async () => {
    expect(await thrownMessage('Bearer abc123 rejected')).toBe(
      'Handler for tool "acme.list-orders" threw: Bearer [redacted] rejected',
    );
    expect(stringifyError('plain words')).toBe('plain words');
  });

  test("an error whose message isn't a string reads as before", () => {
    expect(stringifyError(Object.assign(new Error(), { message: 42 }))).toBe('Error: 42');
  });
});

describe("the call's own values go first", () => {
  const DB = 'postgres://app:pw-0123@db.acme.internal:5432/orders';

  test('a sent connection string is [redacted] whole, host and all', async () => {
    const message = await thrownMessage(
      new Error(`connect to ${DB} failed`),
      ctx({ secrets: { DB } }),
    );
    expect(message).toBe(
      'Handler for tool "acme.list-orders" threw: Error: connect to [redacted] failed',
    );
    expect(message).not.toContain('db.acme.internal');
  });

  test("a sent value and a connection token straddling a cause's cut leave no start", async () => {
    const secret = 'S3cr3t-0123456789abcdefghijklmnopqrstuvw'; // 40 characters
    const token = 'ya29.A0ARrdaM-0123456789abcdefghijklmnopqrs';
    for (const [value, context] of [
      [secret, ctx({ secrets: { KEY: secret } })],
      [token, ctx({ connections: { mail: connection(token) } })],
    ] as const) {
      // The value straddles character 500; once it's [redacted], nothing is cut.
      const cause = new Error(`${'a'.repeat(460)} ${value} rejected`);
      const message = await thrownMessage(new Error('send failed', { cause }), context);
      for (let n = 4; n <= value.length; n += 1) expect(message).not.toContain(value.slice(0, n));
      expect(message).toContain('[redacted] rejected');
    }
  });

  test('a multi-line sent value is matched before the one-line step', async () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const message = await thrownMessage(
      new Error('sign failed', { cause: new Error(`bad key ${pem} given`) }),
      ctx({ secrets: { PEM: pem } }),
    );
    expect(message).toContain('; caused by Error: bad key [redacted] given');
    expect(message).not.toContain('MIIEvQ');
  });

  test('a sent value as it reads inside a JSON body is matched too', async () => {
    const quoted = 'pa"ss-0123';
    const body = JSON.stringify({ error: 'invalid', key: quoted });
    const message = await thrownMessage(
      new Error('login failed', { cause: new Error(`the service answered ${body}`) }),
      ctx({ secrets: { PASSWORD: quoted } }),
    );
    expect(message).toContain('"key":"[redacted]"');
    expect(message).not.toContain('ss-0123');
  });

  test("a sent value's start cut short at a line's end is replaced too", async () => {
    const secret = 'sk-acme-0123456789abcdef';
    const message = await thrownMessage(
      new Error('call failed', {
        cause: new Error(`body: key=${secret.slice(0, 12)}\n(truncated)`),
      }),
      ctx({ secrets: { KEY: secret } }),
    );
    expect(message).toContain('; caused by Error: body: key=[redacted] (truncated)');
  });

  test('a value of three characters is left as it is', async () => {
    expect(
      await thrownMessage(new Error('the abc step failed'), ctx({ secrets: { K: 'abc' } })),
    ).toBe('Handler for tool "acme.list-orders" threw: Error: the abc step failed');
  });

  test('a rejected connection still answers connection-rejected', async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx: ctx({ connections: { mail: connection('tok-0123456789') } }),
      importHandler: async (): Promise<HandlerModule> => () => {
        throw new ConnectionRejectedError('mail', 'the app answered 401');
      },
    });
    expect(outcome.kind === 'err' && outcome.error.code).toBe('connection-rejected');
  });

  test("the wire's cause holds no sent value", async () => {
    const outcome = await runHandler({
      tool,
      input: {},
      ctx: ctx({ secrets: { DB } }),
      importHandler: async (): Promise<HandlerModule> => () => {
        throw new Error(`connect to ${DB} failed`);
      },
    });
    if (outcome.kind !== 'err') throw new Error('expected the handler to fail');
    expect(JSON.stringify(outcome.error.cause)).not.toContain('db.acme.internal');
  });
});

describe('withoutSecrets', () => {
  test('an error that holds no value comes back as itself', () => {
    const err = fetchFailed();
    expect(withoutSecrets(err, ['not-there'])).toBe(err);
    expect(withoutSecrets(err, [])).toBe(err);
  });

  test("a copy keeps the error's prototype and own properties", () => {
    class AcmeError extends Error {
      readonly status = 401;
    }
    const err = Object.assign(new AcmeError('key k-0123 refused'), { code: 'E_AUTH' });
    const copy = withoutSecrets(err, ['k-0123']);
    expect(copy).not.toBe(err);
    expect(copy).toBeInstanceOf(AcmeError);
    expect(copy.message).toBe('key [redacted] refused');
    expect(copy.status).toBe(401);
    expect((copy as unknown as { code: string }).code).toBe('E_AUTH');
    expect(err.message).toBe('key k-0123 refused');
  });

  test('a property that throws is left out', () => {
    const err = new Error('key k-0123 refused');
    Object.defineProperty(err, 'detail', {
      get() {
        throw new Error('no');
      },
      enumerable: true,
    });
    const copy = withoutSecrets(err, ['k-0123']) as Error & { detail?: unknown };
    expect(copy.message).toBe('key [redacted] refused');
    expect(Object.getOwnPropertyNames(copy)).not.toContain('detail');
  });

  test('values are looked for 8 levels deep, and a cycle ends', () => {
    let chain: Error = new Error('deep k-0123');
    for (let i = 0; i < 12; i += 1) chain = new Error(`level ${i}`, { cause: chain });
    expect(() => withoutSecrets(chain, ['k-0123'])).not.toThrow();
    const loop = new Error('loop k-0123');
    Object.assign(loop, { cause: loop });
    const copy = withoutSecrets(loop, ['k-0123']);
    expect(copy.message).toBe('loop [redacted]');
  });

  test("a value that isn't a string is left out of the match", () => {
    const err = new Error('port 5432 refused');
    expect(withoutSecrets(err, [5432, { k: 'v' }])).toBe(err);
  });

  test("a secret's first part counts where the text stops: its end, a line break, a shortened quote", () => {
    const secret = 'sk-acme-0123456789abcdef';
    const first = secret.slice(0, 10);
    expect(withoutSecrets(new Error(`key ${first}`), [secret]).message).toBe('key [redacted]');
    expect(withoutSecrets(new Error(`key ${first}\r\nnext`), [secret]).message).toBe(
      'key [redacted]\r\nnext',
    );
    expect(withoutSecrets(new Error(`{"key":"${first}"...}`), [secret]).message).toBe(
      '{"key":"[redacted]"...}',
    );
  });

  test('a secret of several lines is hidden up to the line where the text goes on differently', () => {
    const err = new Error('got abcd\nefgh\nijkX');
    expect(withoutSecrets(err, ['abcd\nefgh\nijkl']).message).toBe('got [redacted]\nijkX');
  });

  test("a secret's first part the text goes on from is left as it is", () => {
    const err = new Error('key sk-acme-0123 is the test key');
    expect(withoutSecrets(err, ['sk-acme-0123456789abcdef'])).toBe(err);
  });

  test('a first part of three characters is left as it is', () => {
    const err = new Error('the step sk-');
    expect(withoutSecrets(err, ['sk-acme-0123456789abcdef'])).toBe(err);
    // Nor two, before the secret's own line break.
    const broken = new Error('x ab\ncX');
    expect(withoutSecrets(broken, ['ab\ncdefgh'])).toBe(broken);
  });

  test('matches that overlap or touch become one [redacted]', () => {
    const err = new Error('got abcd-efgh-ijkl and wxyz0123');
    expect(withoutSecrets(err, ['abcd-efgh', 'efgh-ijkl', 'wxyz', '0123']).message).toBe(
      'got [redacted] and [redacted]',
    );
  });

  test('another kind of object the error holds stands in as its JSON form, the secret taken out', () => {
    const err = Object.assign(new Error('request failed'), {
      url: new URL('https://shop.acme.example/orders?k=k-0123'),
      at: new Date(0),
    });
    const copy = withoutSecrets(err, ['k-0123']) as Error & { url: unknown; at: unknown };
    expect(copy.url).toBe('https://shop.acme.example/orders?k=[redacted]');
    expect(copy.at).toBe(err.at);
  });
});
