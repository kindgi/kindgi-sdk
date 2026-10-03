// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TenantId, ToolId } from '@kindgi/types';

import { defineTool, validateToolManifest } from '../src/define.js';
// Side-effect import so the 'http' synthesizer is registered.
import '../src/http.js';
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
