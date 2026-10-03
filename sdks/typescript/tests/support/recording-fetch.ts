// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test-only recording `fetch` shim. Every call captures the raw request
 * (URL, method, headers, body) so assertions can pin the wire contract
 * — URL path, query params, `Authorization: Bearer …`, idempotency-key
 * header, body payload — without any dependency on `msw` or friends.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: readonly RecordedRequest[];
}

export function jsonFetch(payload: unknown, init: { status?: number } = {}): FetchStub {
  return recordingFetch([{ status: init.status ?? 200, body: JSON.stringify(payload) }]);
}

export function errorFetch(
  status: number,
  wireError: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  },
): FetchStub {
  const body = JSON.stringify({ error: { requestId: 'req-test', ...wireError } });
  return recordingFetch([{ status, body }]);
}

export function recordingFetch(
  responses: readonly { status: number; body: string; headers?: Record<string, string> }[],
): FetchStub {
  const calls: RecordedRequest[] = [];
  let cursor = 0;
  const stub: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers = normalizeHeaders(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, headers, ...(body !== undefined && { body }) });

    if (cursor >= responses.length) {
      throw new Error(`No mock response queued for ${method} ${url}`);
    }
    const next = responses[cursor];
    if (next === undefined) {
      throw new Error(`No mock response queued for ${method} ${url}`);
    }
    cursor += 1;
    return new Response(next.body, {
      status: next.status,
      headers: {
        'content-type': 'application/json',
        ...(next.headers ?? {}),
      },
    });
  };
  return { fetch: stub, calls };
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (input === undefined) return {};
  const out: Record<string, string> = {};
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) out[key.toLowerCase()] = value;
    return out;
  }
  for (const key of Object.keys(input)) {
    out[key.toLowerCase()] = (input as Record<string, string>)[key] as string;
  }
  return out;
}
