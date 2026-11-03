// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One JSON-RPC request to `/mcp`, as a chat app sends it: the 2025
 * revisions' shape, or 2026-07-28's with its method and name headers and
 * the `_meta` protocol key. Reads a JSON answer or the first SSE event.
 */

export type McpRevision = '2025-11-25' | '2026-07-28';

interface Requests {
  request(path: string, init: RequestInit): Response | Promise<Response>;
}

export function mcpRpc(app: Requests) {
  let id = 0;
  return async (
    token: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    version: McpRevision = '2025-11-25',
  ) => {
    const modern = version === '2026-07-28';
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        ...(modern && { 'mcp-method': method }),
        ...(modern && typeof params.name === 'string' && { 'mcp-name': params.name }),
        ...(token !== undefined && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: modern
          ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version } }
          : params,
      }),
    });
    const text = await res.text();
    const data = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5) ?? 'null');
    return { res, body: (JSON.parse(data) ?? {}) as Record<string, any> };
  };
}
