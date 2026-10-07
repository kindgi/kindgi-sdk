// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * W3C Trace Context (`traceparent`), the ids every record written inside a
 * request or a run carries: honour a caller's trace, or start one, and give
 * each request its own span. Pure functions on Web Crypto, so they run in
 * Node and in workers alike. No spans are recorded or exported here.
 */

export interface TraceContext {
  /** 32 lowercase hex characters, not all zero. */
  readonly traceId: string;
  /** 16 lowercase hex characters, not all zero: this span. */
  readonly spanId: string;
  /** The span this one is a child of, when there is one. */
  readonly parentSpanId?: string;
  /** Trace flags, two hex characters; `01` is sampled. */
  readonly flags: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/**
 * An incoming `traceparent`'s trace id and parent span, or `undefined`
 * when the header is absent or malformed: then the caller starts a fresh
 * trace (a bad header is replaced, never trusted). Version `ff` is
 * invalid; a future version is read by its first four fields, as the
 * spec says. All-zero ids are invalid.
 */
export function parseTraceparent(
  header: string | null | undefined,
): { readonly traceId: string; readonly parentSpanId: string; readonly flags: string } | undefined {
  if (typeof header !== 'string') return undefined;
  // Hex must be lowercase (the spec): an uppercase header is malformed.
  const m = TRACEPARENT.exec(header.trim());
  if (m === null) return undefined;
  const [, version, traceId, parentSpanId, flags] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === 'ff') return undefined;
  if (version === '00' && header.trim().length !== 55) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return undefined;
  return { traceId, parentSpanId, flags };
}

function randomHex(bytes: number): string {
  for (;;) {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!/^0+$/.test(hex)) return hex;
  }
}

/** A fresh trace: a new trace id and a first span, sampled. */
export function newTraceContext(): TraceContext {
  return { traceId: randomHex(16), spanId: randomHex(8), flags: '01' };
}

/** A new span in the same trace, whose parent is `parent`'s span. */
export function childSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomHex(8),
    parentSpanId: parent.spanId,
    flags: parent.flags,
  };
}

/**
 * The context for a request: a child span of the caller's trace when its
 * `traceparent` is valid, else a fresh trace.
 */
export function traceFromHeader(header: string | null | undefined): TraceContext {
  const incoming = parseTraceparent(header);
  if (incoming === undefined) return newTraceContext();
  return {
    traceId: incoming.traceId,
    spanId: randomHex(8),
    parentSpanId: incoming.parentSpanId,
    flags: incoming.flags,
  };
}

/** The `traceparent` (and `traceresponse`) value for a context: `00-<trace>-<span>-<flags>`. */
export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}
