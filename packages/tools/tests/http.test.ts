// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type RequestListener, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TenantId, ToolId } from '@kindgi/types';

import { defineTool, validateToolManifest } from '../src/define.js';
// Side-effect import so the 'http' synthesizer is registered.
import '../src/http.js';
import {
  type ConnectionRejectedError,
  type ToolConnection,
  isConnectionRejectedError,
} from '../src/connections.js';
import { invokeTool } from '../src/invoke.js';
import { getToolSpecSynthesizer } from '../src/spec-registry.js';
import type { HttpToolSpec, ToolContext } from '../src/types.js';

type HttpSpecOverrides = Partial<Omit<HttpToolSpec, 'kind'>>;

// -----------------------------------------------------------------------------
// Test scaffolding
// -----------------------------------------------------------------------------

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;

const ISSUE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    number: { type: 'integer' },
  },
  required: ['owner', 'repo', 'number'],
  additionalProperties: false,
} as const;

const ISSUE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
  },
  required: ['number', 'title'],
  additionalProperties: true,
} as const;

function baseSpec(over: HttpSpecOverrides = {}): HttpToolSpec {
  return {
    kind: 'http',
    method: 'GET',
    urlTemplate: 'https://api.example.com/repos/{owner}/{repo}/issues/{number}',
    ...over,
  };
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: TENANT,
    abortSignal: new AbortController().signal,
    ...over,
  };
}

function buildTool(over: HttpSpecOverrides = {}): ReturnType<typeof defineTool> {
  return defineTool({
    id: 'github.get-issue' as ToolId,
    description: 'Fetch a GitHub issue by owner + repo + number.',
    version: '1.0.0',
    input: ISSUE_INPUT_SCHEMA,
    output: ISSUE_OUTPUT_SCHEMA,
    spec: baseSpec(over),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown, init: { statusText?: string } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText: init.statusText ?? '',
    headers: { 'content-type': 'application/json' },
  });
}

// -----------------------------------------------------------------------------
// URL template substitution
// -----------------------------------------------------------------------------

describe('defineTool({spec: http}) — URL template substitution', () => {
  test('substitutes {param} placeholders from input, URL-encodes values', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 42, title: 'ok' }));
    const tool = buildTool();
    expect(tool.kind).toBe('ok');
    if (tool.kind !== 'ok') return;
    const invoked = await invokeTool(
      tool.value,
      { owner: 'anthropics', repo: 'claude code', number: 42 },
      makeCtx(),
    );
    expect(invoked.kind).toBe('ok');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/repos/anthropics/claude%20code/issues/42');
  });

  test('missing placeholder key surfaces as handler-error', async () => {
    // Input schema requires all three; construct a tool that references a key
    // NOT in the input schema — the URL substitution should throw.
    const brokenSpec: HttpToolSpec = {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://api.example.com/{missing}/{repo}',
    };
    const tool = defineTool({
      id: 'demo.broken' as ToolId,
      description: 'Broken url template.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { repo: { type: 'string' } },
        required: ['repo'],
        additionalProperties: false,
      } as const,
      output: { type: 'object', additionalProperties: true } as const,
      spec: brokenSpec,
    });
    expect(tool.kind).toBe('ok');
    if (tool.kind !== 'ok') return;
    const invoked = await invokeTool(tool.value, { repo: 'x' }, makeCtx());
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.code).toBe('handler-error');
      expect(invoked.error.message).toContain('{missing}');
    }
  });

  test('non-primitive value at a URL placeholder rejects with a clear error', async () => {
    // Schema-permissive tool: `owner` may be any shape. If the caller
    // hands in an object, URL substitution should refuse rather than
    // emit `[object Object]`.
    const tool = defineTool({
      id: 'demo.permissive' as ToolId,
      description: 'Permissive.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { owner: {} },
        required: ['owner'],
        additionalProperties: false,
      } as const,
      output: { type: 'object', additionalProperties: true } as const,
      spec: { kind: 'http', method: 'GET', urlTemplate: 'https://api.example.com/{owner}' },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: { nested: 'thing' } }, makeCtx());
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.code).toBe('handler-error');
      expect(invoked.error.message).toContain('must be a primitive');
    }
  });
});

// -----------------------------------------------------------------------------
// Where the request goes
// -----------------------------------------------------------------------------

describe('defineTool({spec: http}) — where the request goes', () => {
  const manifest = (urlTemplate: string) => ({
    id: 'acme.lookup',
    description: 'Look something up.',
    version: '1.0.0',
    input: { type: 'object', additionalProperties: true },
    output: { type: 'object', additionalProperties: true },
    spec: { kind: 'http', method: 'GET', urlTemplate },
  });

  test('placeholders fill the path and query only: never the scheme, host or port', () => {
    for (const urlTemplate of [
      'https://{host}/x',
      'https://api.{domain}/x',
      '{scheme}://api.example.com/x',
      'https://api.example.com:{port}/x',
      'https://{user}@api.example.com/x',
      'ftp://api.example.com/x',
      'https:///x',
    ]) {
      const r = validateToolManifest(manifest(urlTemplate));
      expect(r.kind, urlTemplate).toBe('err');
      if (r.kind === 'err') {
        expect(r.error.code).toBe('invalid-tool-definition');
        expect(r.error.message).toContain('spec.urlTemplate');
      }
    }
    expect(validateToolManifest(manifest('https://api.example.com/{id}?q={q}')).kind).toBe('ok');
    expect(validateToolManifest(manifest('http://localhost:8080/{id}')).kind).toBe('ok');
  });

  test("the handler sends through the runtime's fetch when given one", async () => {
    const seen: string[] = [];
    const runtimeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    const synthesize = getToolSpecSynthesizer('http');
    if (synthesize === undefined) throw new Error('no http synthesizer');
    const handler = synthesize(
      {
        kind: 'http',
        method: 'GET',
        urlTemplate: 'https://api.example.com/items/{id}',
      } as HttpToolSpec,
      'acme.lookup',
      { fetch: runtimeFetch },
    );
    expect(await handler({ id: 'a/b?c' }, makeCtx())).toEqual({ ok: true });
    // The value is encoded into the path: it can't add a path, query or host.
    expect(seen).toEqual(['https://api.example.com/items/a%2Fb%3Fc']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Authorization + secrets
// -----------------------------------------------------------------------------

describe('defineTool({spec: http}) — authorization / secret resolution', () => {
  test('bearer auth resolves secret_ref and sets Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const resolveSecret = vi.fn().mockResolvedValue('gh-token-xyz');
    const tool = buildTool({
      authorization: { kind: 'bearer', secretRef: { envName: 'production', name: 'github-token' } },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx({ resolveSecret }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gh-token-xyz');
    expect(resolveSecret).toHaveBeenCalledWith({ envName: 'production', name: 'github-token' });
  });

  test('header auth writes the resolved secret to the named header verbatim', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const resolveSecret = vi.fn().mockResolvedValue('sk-abc');
    const tool = buildTool({
      authorization: {
        kind: 'header',
        headerName: 'X-API-Key',
        secretRef: { envName: 'production', name: 'openai-api-key' },
      },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx({ resolveSecret }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('sk-abc');
    expect(headers.Authorization).toBeUndefined();
  });

  test('tool with authorization but no resolveSecret on ctx → handler-error', async () => {
    const tool = buildTool({
      authorization: { kind: 'bearer', secretRef: { envName: 'production', name: 'x' } },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(
      tool.value,
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx(), // no resolveSecret
    );
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.code).toBe('handler-error');
      expect(invoked.error.message).toContain('resolveSecret is not wired');
    }
  });

  test('tools without authorization never call resolveSecret', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const resolveSecret = vi.fn().mockResolvedValue('unused');
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx({ resolveSecret }));
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});

describe('defineTool({spec: http}) — a connection authorization', () => {
  const connection: ToolConnection = {
    connectionId: '00000000-0000-0000-0000-0000000000c1',
    app: 'github',
    appName: 'GitHub',
    accessToken: 'ghs-installation-token',
    account: { id: '42', label: 'acme' },
  };

  function buildConnectionTool(name = 'repo'): ReturnType<typeof defineTool> {
    return defineTool({
      id: 'github.get-issue' as ToolId,
      description: 'Fetch a GitHub issue by owner + repo + number.',
      version: '1.0.0',
      input: ISSUE_INPUT_SCHEMA,
      output: ISSUE_OUTPUT_SCHEMA,
      needsSpec: {
        connections: { repo: { app: 'github', permissions: ['issues.read'], as: 'company' } },
      },
      spec: baseSpec({ authorization: { kind: 'connection', connection: name } }),
    });
  }

  test("sends the connection's access token as a bearer token, and no secret", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const resolveSecret = vi.fn();
    const tool = buildConnectionTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(
      tool.value,
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx({ resolveSecret, connections: { repo: connection } }),
    );
    expect(invoked.kind).toBe('ok');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghs-installation-token',
    );
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  test('a 401 fails the call with ConnectionRejectedError, naming the connection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { message: 'Bad credentials' }, { statusText: 'Unauthorized' }),
    );
    const handler = getToolSpecSynthesizer('http')?.(
      baseSpec({ authorization: { kind: 'connection', connection: 'repo' } }),
      'github.get-issue',
    );
    if (handler === undefined) throw new Error('no http synthesizer');
    const thrown = await handler(
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx({ connections: { repo: connection } }),
    ).catch((e: unknown) => e);
    expect(isConnectionRejectedError(thrown)).toBe(true);
    expect((thrown as ConnectionRejectedError).connection).toBe('repo');
    expect((thrown as Error).message).toContain('got status 401');
    expect((thrown as Error).message).not.toContain('ghs-installation-token');
  });

  test('another failing status stays a plain error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: 'Forbidden' }));
    const handler = getToolSpecSynthesizer('http')?.(
      baseSpec({ authorization: { kind: 'connection', connection: 'repo' } }),
      'github.get-issue',
    );
    if (handler === undefined) throw new Error('no http synthesizer');
    const thrown = await handler(
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx({ connections: { repo: connection } }),
    ).catch((e: unknown) => e);
    expect(isConnectionRejectedError(thrown)).toBe(false);
    expect((thrown as Error).message).toContain('got status 403');
  });

  test('a 401 to a secret authorization is not a connection refusal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Bad credentials' }));
    const spec = baseSpec({
      authorization: { kind: 'bearer', secretRef: { envName: 'production', name: 'gh' } },
    });
    const handler = getToolSpecSynthesizer('http')?.(spec, 'github.get-issue');
    if (handler === undefined) throw new Error('no http synthesizer');
    const thrown = await handler(
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx({ resolveSecret: vi.fn().mockResolvedValue('t') }),
    ).catch((e: unknown) => e);
    expect(isConnectionRejectedError(thrown)).toBe(false);
  });

  test('a call without the connection fails before fetch, naming it', async () => {
    const tool = buildConnectionTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx());
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.code).toBe('handler-error');
      expect(invoked.error.message).toContain(
        'the connection "repo", which this call doesn\'t have',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a token with a line break fails before fetch, without quoting it', async () => {
    const tool = buildConnectionTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(
      tool.value,
      { owner: 'a', repo: 'b', number: 1 },
      makeCtx({ connections: { repo: { ...connection, accessToken: 'abc\r\ndef' } } }),
    );
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.message).toContain('the access token of its connection "repo"');
      expect(invoked.error.message).not.toContain('abc');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('defineTool refuses a connection the tool does not declare', () => {
    const tool = buildConnectionTool('mail');
    expect(tool.kind).toBe('err');
    if (tool.kind === 'err') {
      expect(tool.error.code).toBe('invalid-tool-definition');
      expect(tool.error.message).toContain(
        'sends the connection "mail", which needsSpec.connections doesn\'t declare',
      );
    }
  });
});

describe("defineTool({spec: http}) — a header value fetch can't send", () => {
  /** Pasted with its second line: fetch's own error would quote it. */
  const CANARY = 'canary-SECRET-one\nline-two';
  /** Nothing listens here, and nothing is meant to reach it: the header is refused first. */
  const NOWHERE = 'http://127.0.0.1:9/repos/{owner}/{repo}/issues/{number}';
  const input = { owner: 'a', repo: 'b', number: 1 };
  /** Everything an invocation's failure carries, as a log or a run would. */
  const everything = (invoked: unknown) => {
    const cause = (invoked as { error?: { cause?: unknown } }).error?.cause;
    return `${JSON.stringify(invoked)} ${cause instanceof Error ? `${cause.message} ${cause.stack}` : ''}`;
  };

  test.each([
    ['header', { kind: 'header', headerName: 'X-API-Key' }, 'X-API-Key'],
    ['bearer', { kind: 'bearer' }, 'Authorization'],
  ] as const)(
    "%s auth: a secret with a line break inside fails by the header's name, never quoted, with real fetch",
    async (_kind, auth, header) => {
      vi.unstubAllGlobals(); // the real fetch, whose own error quotes the value
      const tool = buildTool({
        urlTemplate: NOWHERE,
        authorization: { ...auth, secretRef: { envName: 'production', name: 'acme-key' } },
      });
      if (tool.kind !== 'ok') throw new Error('build failed');
      const invoked = await invokeTool(
        tool.value,
        input,
        makeCtx({ resolveSecret: async () => CANARY }),
      );
      expect(invoked.kind === 'err' && invoked.error.code).toBe('handler-error');
      expect(invoked.kind === 'err' && invoked.error.message).toBe(
        `Tool "github.get-issue" handler threw: http-tool "github.get-issue": its secret production/acme-key for the header "${header}" has a line break, which a header can't carry: store the secret without it`,
      );
      expect(everything(invoked)).not.toContain('canary');
    },
  );

  test.each(['\ncanary-SECRET-lead', '\r\ncanary-SECRET-lead'])(
    'bearer auth: a secret that starts with a line break (%j) is refused as sent, after `Bearer `',
    async (secret) => {
      vi.unstubAllGlobals();
      const tool = buildTool({
        urlTemplate: NOWHERE,
        authorization: { kind: 'bearer', secretRef: { envName: 'production', name: 'acme-key' } },
      });
      if (tool.kind !== 'ok') throw new Error('build failed');
      const invoked = await invokeTool(
        tool.value,
        input,
        makeCtx({ resolveSecret: async () => secret }),
      );
      expect(invoked.kind === 'err' && invoked.error.message).toBe(
        'Tool "github.get-issue" handler threw: http-tool "github.get-issue": its secret production/acme-key for the header "Authorization" has a line break, which a header can\'t carry: store the secret without it',
      );
      expect(everything(invoked)).not.toContain('canary');
    },
  );

  test('header auth: a secret that starts with a line break goes out, trimmed by fetch, never quoted', async () => {
    vi.unstubAllGlobals();
    const tool = buildTool({
      urlTemplate: NOWHERE,
      authorization: {
        kind: 'header',
        headerName: 'X-API-Key',
        secretRef: { envName: 'production', name: 'k' },
      },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(
      tool.value,
      input,
      makeCtx({ resolveSecret: async () => '\ncanary-SECRET-lead' }),
    );
    // Sent (nothing listens on port 9, so the call fails to connect), not refused.
    expect(invoked.kind === 'err' && invoked.error.message).not.toContain(
      "which a header can't carry",
    );
    expect(everything(invoked)).not.toContain('canary');
  });

  test("a header filled from the input that fetch can't send fails by its name, never quoted", async () => {
    vi.unstubAllGlobals();
    const tool = buildTool({
      urlTemplate: NOWHERE,
      headers: [{ name: 'X-Trace', value: 'trace-{repo}' }],
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { ...input, repo: 'b\u0000canary' }, makeCtx());
    expect(invoked.kind === 'err' && invoked.error.message).toBe(
      'Tool "github.get-issue" handler threw: http-tool "github.get-issue": the header "X-Trace", filled from its input, has a control character, which a header can\'t carry',
    );
    expect(everything(invoked)).not.toContain('canary');
  });

  test('a secret with only a trailing newline is sent as before: fetch trims it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const tool = buildTool({
      authorization: {
        kind: 'header',
        headerName: 'X-API-Key',
        secretRef: { envName: 'production', name: 'k' },
      },
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(
      tool.value,
      input,
      makeCtx({ resolveSecret: async () => 'sk-abc\n' }),
    );
    expect(invoked.kind).toBe('ok');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('X-API-Key')).toBe('sk-abc');
  });
});

// -----------------------------------------------------------------------------
// Request body
// -----------------------------------------------------------------------------

describe('defineTool({spec: http}) — request body strategies', () => {
  test('POST with default json-input body: strips URL-consumed keys and JSON-serializes remaining input', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { number: 42, title: 't' }));
    const spec: HttpToolSpec = {
      kind: 'http',
      method: 'POST',
      urlTemplate: 'https://api.example.com/repos/{owner}/{repo}/issues',
    };
    const tool = defineTool({
      id: 'github.post-issue' as ToolId,
      description: 'Open an issue.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'title'],
        additionalProperties: false,
      } as const,
      output: ISSUE_OUTPUT_SCHEMA,
      spec: spec,
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b', title: 'hi', body: 'first!' }, makeCtx());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ title: 'hi', body: 'first!' }));
  });

  test('input-passthrough sends the entire input including URL-consumed keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const spec: HttpToolSpec = {
      kind: 'http',
      method: 'POST',
      urlTemplate: 'https://api.example.com/{owner}/{repo}',
      requestBody: { kind: 'input-passthrough' },
    };
    const tool = defineTool({
      id: 'demo.passthrough' as ToolId,
      description: 'Passthrough.',
      version: '1.0.0',
      input: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        required: ['owner', 'repo'],
        additionalProperties: false,
      } as const,
      output: { type: 'object', additionalProperties: true } as const,
      spec: spec,
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b' }, makeCtx());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ owner: 'a', repo: 'b' }));
  });

  test('GET does not send a body by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 1, title: 't' }));
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Response handling
// -----------------------------------------------------------------------------

describe('defineTool({spec: http}) — response handling', () => {
  test('parses JSON by default; returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { number: 42, title: 'ok', extra: true }));
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 42 }, makeCtx());
    expect(invoked.kind).toBe('ok');
    if (invoked.kind === 'ok') {
      expect(invoked.value).toEqual({ number: 42, title: 'ok', extra: true });
    }
  });

  test('non-2xx status surfaces as handler-error with body in message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('rate limit exceeded', { status: 429, statusText: 'Too Many Requests' }),
    );
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx());
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') {
      expect(invoked.error.code).toBe('handler-error');
      expect(invoked.error.message).toContain('429');
      expect(invoked.error.message).toContain('rate limit exceeded');
    }
  });

  test('successStatus override widens the accepted range', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(302, { number: 1, title: 'redirected' }));
    const tool = buildTool({ successStatus: { min: 200, max: 399 } });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx());
    expect(invoked.kind).toBe('ok');
  });

  test('parseJson: false returns response body as text', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain text body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const spec: HttpToolSpec = {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://api.example.com/plain',
      parseJson: false,
    };
    const tool = defineTool({
      id: 'demo.text' as ToolId,
      description: 'Text endpoint.',
      version: '1.0.0',
      input: { type: 'object', additionalProperties: false } as const,
      output: { type: 'string' } as const,
      spec: spec,
    });
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, {}, makeCtx(), { skipOutputValidation: true });
    expect(invoked.kind).toBe('ok');
    if (invoked.kind === 'ok') expect(invoked.value).toBe('plain text body');
  });

  test('malformed JSON response surfaces as handler-error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json {{', { status: 200 }));
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    const invoked = await invokeTool(tool.value, { owner: 'a', repo: 'b', number: 1 }, makeCtx());
    expect(invoked.kind).toBe('err');
    if (invoked.kind === 'err') expect(invoked.error.message).toContain('not valid JSON');
  });
});

// -----------------------------------------------------------------------------
// The response body: under the deadline, the caller's signal and a size cap
// -----------------------------------------------------------------------------

// Captured before `beforeEach` stubs it, for the tests against a real server.
const realFetch = globalThis.fetch;

function httpHandler(
  over: HttpSpecOverrides = {},
  options: { readonly fetch?: typeof fetch; readonly maxResponseBytes?: number } = {},
): (input: unknown, ctx: ToolContext) => Promise<unknown> {
  const synthesize = getToolSpecSynthesizer('http');
  if (synthesize === undefined) throw new Error('no http synthesizer');
  return synthesize(
    { kind: 'http', method: 'GET', urlTemplate: 'https://api.example.com/items/{id}', ...over },
    'acme.lookup',
    { fetch: fetchMock as unknown as typeof fetch, ...options },
  );
}

/**
 * A body that hands over the next of `chunks` on each read, waiting
 * `everyMs` first; past the last it sends the last again, forever.
 * `seen` counts the reads and whether the reader cancelled it.
 */
function streamedBody(chunks: readonly string[], everyMs = 0) {
  const seen = { reads: 0, cancelled: false };
  const bytes = chunks.map((c) => new TextEncoder().encode(c));
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (everyMs > 0) await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (seen.cancelled) return;
      const next = bytes[Math.min(seen.reads, bytes.length - 1)] as Uint8Array;
      seen.reads += 1;
      controller.enqueue(next);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

/** A body that ends after `chunks`. */
function finiteBody(chunks: readonly string[]) {
  const seen = { reads: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[seen.reads];
      if (next === undefined) {
        controller.close();
        return;
      }
      seen.reads += 1;
      controller.enqueue(new TextEncoder().encode(next));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe('defineTool({spec: http}) — the response body', () => {
  test('a body that trickles past the deadline fails the call as timed out', async () => {
    const { stream, seen } = streamedBody(['{"a":', ' '], 10);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const started = Date.now();
    await expect(httpHandler({ timeoutMs: 150 })({ id: '1' }, makeCtx())).rejects.toThrow(
      'http-tool "acme.lookup" timed out after 150ms',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen.cancelled).toBe(true);
  });

  test("a failed call's body that never ends fails the call as timed out", async () => {
    const { stream, seen } = streamedBody(['busy '], 10);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 503 }));
    await expect(httpHandler({ timeoutMs: 150 })({ id: '1' }, makeCtx())).rejects.toThrow(
      'timed out after 150ms',
    );
    expect(seen.cancelled).toBe(true);
  });

  test("the caller's cancel mid-body fails the call with the caller's reason", async () => {
    const caller = new AbortController();
    const seen = { reads: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.reads += 1;
        if (seen.reads === 1) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
          return;
        }
        // The rest never comes; the run is cancelled while it waits.
        caller.abort(new Error('the run was cancelled'));
        return new Promise<void>(() => undefined);
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    await expect(
      httpHandler()({ id: '1' }, makeCtx({ abortSignal: caller.signal })),
    ).rejects.toThrow('the run was cancelled');
    expect(seen.cancelled).toBe(true);
  });

  test('a body past maxResponseBytes fails the call, naming the cap; one at the cap is read', async () => {
    const atCap = `"${'a'.repeat(1022)}"`;
    fetchMock.mockResolvedValueOnce(new Response(atCap, { status: 200 }));
    expect(await httpHandler({}, { maxResponseBytes: 1024 })({ id: '1' }, makeCtx())).toBe(
      'a'.repeat(1022),
    );

    fetchMock.mockResolvedValueOnce(new Response(`"${'a'.repeat(1023)}"`, { status: 200 }));
    await expect(
      httpHandler({}, { maxResponseBytes: 1024 })({ id: '1' }, makeCtx()),
    ).rejects.toThrow(
      'http-tool "acme.lookup": the response body is longer than 1024 bytes, the most this tool reads',
    );
  });

  test('without maxResponseBytes the cap is 10 MiB, and reading stops there', async () => {
    const mib = 'a'.repeat(1024 * 1024);
    const { stream, seen } = finiteBody(['"', ...Array.from({ length: 20 }, () => mib), '"']);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    await expect(httpHandler()({ id: '1' }, makeCtx())).rejects.toThrow(
      'longer than 10485760 bytes',
    );
    // The 11th MiB crosses the cap; the stream may have pulled one more ahead.
    expect(seen.reads).toBeLessThanOrEqual(12);
    expect(seen.cancelled).toBe(true);
  });

  test('parseJson: false text is capped the same way', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(2048), { status: 200 }));
    await expect(
      httpHandler({ parseJson: false }, { maxResponseBytes: 1024 })({ id: '1' }, makeCtx()),
    ).rejects.toThrow('longer than 1024 bytes');
  });

  test("a failed call's message reads only the start of a long body", async () => {
    const { stream, seen } = finiteBody(Array.from({ length: 64 }, () => 'e'.repeat(1024)));
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 500 }));
    await expect(httpHandler()({ id: '1' }, makeCtx())).rejects.toThrow(
      `got status 500  — ${'e'.repeat(512)}`,
    );
    // 2 KiB is read for the message; the stream may have pulled one more ahead.
    expect(seen.reads).toBeLessThanOrEqual(4);
    expect(seen.cancelled).toBe(true);
  });

  test('a maxResponseBytes that is not a positive whole number is refused when the tool is built', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => httpHandler({}, { maxResponseBytes: bad })).toThrow(
        'maxResponseBytes must be a positive whole number of bytes',
      );
    }
  });
});

describe('defineTool({spec: http}) — the response body, from a real server', () => {
  async function serve(
    respond: RequestListener,
  ): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
    const server = createServer(respond);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/items/{id}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  test('a server that answers at once and trickles its body is cut off at the deadline', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let closedByClient = false;
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      timer = setInterval(() => res.write(' '), 10);
      res.on('close', () => {
        closedByClient = true;
        clearInterval(timer);
      });
    });
    try {
      // The headers must come before the deadline, so it's the body read it cuts.
      let headersAt: number | undefined;
      const timedFetch = (async (...args: Parameters<typeof fetch>) => {
        const response = await realFetch(...args);
        headersAt = Date.now();
        return response;
      }) as typeof fetch;
      const handler = httpHandler(
        { urlTemplate: server.url, timeoutMs: 1_000 },
        { fetch: timedFetch },
      );
      const started = Date.now();
      await expect(handler({ id: '1' }, makeCtx())).rejects.toThrow('timed out after 1000ms');
      expect(headersAt).toBeDefined();
      expect((headersAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(1_000);
      await vi.waitFor(() => expect(closedByClient).toBe(true));
    } finally {
      clearInterval(timer);
      await server.close();
    }
  });

  test('a gzip body is counted as it decodes: a small download past the cap fails', async () => {
    // 4 MiB of zeros, under 5 KiB on the wire.
    const zipped = gzipSync(Buffer.from(`"${'0'.repeat(4 * 1024 * 1024)}"`));
    expect(zipped.byteLength).toBeLessThan(1024 * 1024);
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zipped);
    });
    try {
      const handler = httpHandler(
        { urlTemplate: server.url },
        { fetch: realFetch, maxResponseBytes: 1024 * 1024 },
      );
      await expect(handler({ id: '1' }, makeCtx())).rejects.toThrow('longer than 1048576 bytes');
    } finally {
      await server.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Manifest preservation
// -----------------------------------------------------------------------------

describe('defineTool({spec}) — manifest', () => {
  test('runtime Tool preserves the declarative spec field with kind discriminant', () => {
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    expect(tool.value.spec).toBeDefined();
    expect(tool.value.spec?.kind).toBe('http');
    expect((tool.value.spec as { readonly method: string }).method).toBe('GET');
    expect((tool.value.spec as { readonly urlTemplate: string }).urlTemplate).toBe(
      'https://api.example.com/repos/{owner}/{repo}/issues/{number}',
    );
  });

  test('tool.handler is synthesized (not null / undefined)', () => {
    const tool = buildTool();
    if (tool.kind !== 'ok') throw new Error('build failed');
    expect(typeof tool.value.handler).toBe('function');
  });
});
