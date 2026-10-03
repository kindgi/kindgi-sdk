// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { JournalEntry, JournalKind } from '@kindgi/runtime';
import type { RunId, TenantId } from '@kindgi/types';

/**
 * Wire-side RunEvent kind — the enum surfaced over SSE.
 *
 * Source of truth: `@kindgi/specs/run-event.schema.json`. Names are dotted
 * `run.<xxx>-<yyy>` (e.g. `run.step-completed`) — matches the
 * conventions doc §6 example. Internal-only kernel journal kinds
 * (e.g. `clock.read`) and kinds absent from the wire enum
 * (`edge.evaluated`) are dropped by the mapper — the journal endpoint
 * still exposes them.
 */
export type RunEventKind =
  | 'run.started'
  | 'run.step-started'
  | 'run.step-completed'
  | 'run.step-failed'
  | 'run.step-retry-scheduled'
  | 'run.iteration-started'
  | 'run.iteration-completed'
  | 'run.wait-suspended'
  | 'run.wait-resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

const KERNEL_TO_WIRE: Readonly<Partial<Record<JournalKind, RunEventKind>>> = {
  'run.started': 'run.started',
  'step.started': 'run.step-started',
  'step.completed': 'run.step-completed',
  'step.failed': 'run.step-failed',
  'step.retry-scheduled': 'run.step-retry-scheduled',
  'iteration.started': 'run.iteration-started',
  'iteration.completed': 'run.iteration-completed',
  'wait.suspended': 'run.wait-suspended',
  'wait.resumed': 'run.wait-resumed',
  'run.completed': 'run.completed',
  'run.failed': 'run.failed',
  'run.cancelled': 'run.cancelled',
};

const TERMINAL_KINDS: ReadonlySet<RunEventKind> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/**
 * Project a kernel `JournalEntry` into the wire `RunEvent` shape
 * consumed over SSE. Returns `null` for kernel kinds not exposed on
 * the wire (`edge.evaluated`, `clock.read`).
 */
export function projectJournalEntry(
  entry: JournalEntry,
  runId: RunId,
  tenantId: TenantId,
): {
  wireKind: RunEventKind;
  event: {
    eventId: string;
    runId: RunId;
    tenantId: TenantId;
    timestamp: string;
    kind: RunEventKind;
    sequence: number;
    nodeId?: string;
    payload?: unknown;
  };
} | null {
  const wireKind = KERNEL_TO_WIRE[entry.kind];
  if (wireKind === undefined) return null;
  const ts = entry.timestamp as unknown;
  const timestampIso =
    ts instanceof Date ? ts.toISOString() : new Date(ts as string | number).toISOString();
  return {
    wireKind,
    event: {
      eventId: `${runId}:${entry.sequence}`,
      runId,
      tenantId,
      timestamp: timestampIso,
      kind: wireKind,
      sequence: entry.sequence,
      ...(entry.nodeId !== undefined && { nodeId: entry.nodeId as string }),
      ...(entry.payload !== undefined && { payload: entry.payload }),
    },
  };
}

/** A run event as the progress stream sends it: no payload, no tenant. */
export function toRunProgressEvent(event: {
  readonly eventId: string;
  readonly runId: RunId;
  readonly timestamp: string;
  readonly kind: RunEventKind;
  readonly sequence: number;
  readonly nodeId?: string;
}): Record<string, unknown> {
  return {
    eventId: event.eventId,
    runId: event.runId,
    timestamp: event.timestamp,
    kind: event.kind,
    sequence: event.sequence,
    ...(event.nodeId !== undefined && { nodeId: event.nodeId }),
  };
}

export function isTerminalWireKind(kind: RunEventKind): boolean {
  return TERMINAL_KINDS.has(kind);
}

/**
 * Parse `Last-Event-Id` header (format: `<runId>:<sequence>`). Returns
 * `undefined` on malformed input — caller replays from 0.
 */
export function parseLastEventId(header: string | undefined): number | undefined {
  if (header === undefined || header.length === 0) return undefined;
  const colonIdx = header.lastIndexOf(':');
  const seqStr = colonIdx === -1 ? header : header.slice(colonIdx + 1);
  const n = Number.parseInt(seqStr, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Format one SSE event frame as raw bytes per the spec. Multi-line
 * data payloads are prefixed on every line.
 */
export function formatSseFrame(input: { id: string; event: string; data: unknown }): string {
  const dataJson = JSON.stringify(input.data);
  const dataLines = dataJson
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n');
  return `id: ${input.id}\nevent: ${input.event}\n${dataLines}\n\n`;
}

/** Small unique-id helper used by tests that want a deterministic event id shape. */
export function newSseCorrelationId(): string {
  return `sse-${randomUUID()}`;
}
