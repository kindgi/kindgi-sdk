// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One JSON-RPC request to `/mcp`, as a chat app sends it: the 2025
 * revisions' shape, or 2026-07-28's with its method and name headers and
 * the `_meta` envelope's required keys (the protocol version and the
 * client's capabilities). Reads a JSON answer or the first SSE event.
 * `mcpListen` sends 2026-07-28's `subscriptions/listen` and reads its stream
 * for a short while, so a stream held open fails a test instead of hanging it.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

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
          ? {
              ...params,
              _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_CAPABILITIES_META_KEY]: {} },
            }
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

/** How long `mcpListen` waits for the stream to end. */
const LISTEN_MS = 1_000;

export function mcpListen(app: Requests) {
  return async (token: string, notifications: Record<string, unknown>) => {
    const method = 'subscriptions/listen';
    const version = '2026-07-28';
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': method,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          notifications,
          _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_CAPABILITIES_META_KEY]: {} },
        },
      }),
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + LISTEN_MS;
    let text = '';
    let ended = false;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now()));
      });
      const next = await Promise.race([reader.read(), late]);
      clearTimeout(timer);
      if (next === 'late') {
        // Still open: cancel it, which ends the server's side too.
        await reader.cancel();
        break;
      }
      if (next.done) {
        ended = true;
        break;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, any>);
    return { res, frames, ended };
  };
}
