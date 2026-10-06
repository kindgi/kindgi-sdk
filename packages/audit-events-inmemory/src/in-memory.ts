// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AuditEvent,
  AuditEventBinding,
  AuditEventFilter,
  AuditEventPage,
  AuditEventPurgeInput,
  AuditEventPurgeResult,
  AuditEventQueryInput,
  AuditEventValidationError,
  InvalidCursorError,
  PersistenceError,
} from '@kindgi/audit-events';
import type { Result, TenantId } from '@kindgi/types';

/**
 * In-memory reference adapter. Tests + dev deployments use this;
 * production deployments plug a durable `AuditEventBinding`. The cursor
 * shape (base64url `{ timestamp, id }`) and the `(timestamp, id)`
 * ordering are the reference semantics a durable adapter matches, so
 * consumers swap adapters without touching their code.
 */
export function createInMemoryAuditEventBinding(): AuditEventBinding {
  const store = new Map<TenantId, Map<string, AuditEvent>>();

  return {
    async append(events): Promise<Result<void, PersistenceError | AuditEventValidationError>> {
      for (const e of events) {
        if (typeof e.id !== 'string' || e.id.length === 0) {
          const err: AuditEventValidationError = {
            code: 'invalid-event',
            message: 'Event id must be a non-empty string',
            issues: [{ path: '/id', message: 'must be non-empty string' }],
          };
          return { kind: 'err', error: err };
        }
        let bucket = store.get(e.tenantId);
        if (bucket === undefined) {
          bucket = new Map<string, AuditEvent>();
          store.set(e.tenantId, bucket);
        }
        // Idempotent — silent no-op on duplicate id within tenant.
        if (!bucket.has(e.id)) bucket.set(e.id, e);
      }
      return { kind: 'ok', value: undefined };
    },

    async query(
      input: AuditEventQueryInput,
    ): Promise<Result<AuditEventPage, PersistenceError | InvalidCursorError>> {
      const cursor = decodeCursor(input.cursor);
      if (cursor.kind === 'err') return cursor;
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
      const bucket = store.get(input.tenantId) ?? new Map<string, AuditEvent>();
      const filter = input.filter ?? {};
      const filtered = Array.from(bucket.values())
        .filter((e) => matchesFilter(e, filter))
        .sort(compareByTimestampThenId);
      const startIndex =
        cursor.value === null ? 0 : findStart(filtered, cursor.value.timestamp, cursor.value.id);
      const slice = filtered.slice(startIndex, startIndex + limit + 1);
      const hasMore = slice.length > limit;
      const page = hasMore ? slice.slice(0, limit) : slice;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? encodeCursor({ timestamp: last.timestamp as unknown as string, id: last.id })
          : undefined;
      return {
        kind: 'ok',
        value: nextCursor === undefined ? { data: page } : { data: page, nextCursor },
      };
    },

    async purge(
      input: AuditEventPurgeInput,
    ): Promise<Result<AuditEventPurgeResult, PersistenceError>> {
      const cutoff = new Date(input.olderThan).getTime();
      const bucket = store.get(input.tenantId);
      if (bucket === undefined) return { kind: 'ok', value: { deleted: 0 } };
      let deleted = 0;
      for (const [id, event] of bucket) {
        if (event.kind !== input.kind) continue;
        if (input.outcome !== undefined && event.outcome !== input.outcome) continue;
        if (input.exceptOutcome !== undefined && event.outcome === input.exceptOutcome) continue;
        const ts = new Date(event.timestamp as unknown as string).getTime();
        if (ts < cutoff) {
          bucket.delete(id);
          deleted += 1;
        }
      }
      return { kind: 'ok', value: { deleted } };
    },

    describe() {
      return { name: '@kindgi/audit-events-inmemory', version: '0.1.0' };
    },
  };
}

function matchesFilter(e: AuditEvent, filter: AuditEventFilter): boolean {
  if (filter.id !== undefined && e.id !== filter.id) return false;
  if (filter.kind !== undefined && e.kind !== filter.kind) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(e.kind)) return false;
  if (filter.actor !== undefined && e.actor !== filter.actor) return false;
  if (filter.onBehalfOf !== undefined && e.onBehalfOf !== filter.onBehalfOf) return false;
  if (filter.runId !== undefined && e.runId !== filter.runId) return false;
  if (filter.agentId !== undefined && e.agentId !== filter.agentId) return false;
  if (filter.flowId !== undefined && e.flowId !== filter.flowId) return false;
  if (filter.correlationId !== undefined && e.correlationId !== filter.correlationId) return false;
  if (filter.outcome !== undefined && e.outcome !== filter.outcome) return false;
  if (filter.from !== undefined && (e.timestamp as unknown as string) < filter.from) return false;
  if (filter.to !== undefined && (e.timestamp as unknown as string) > filter.to) return false;
  if (filter.payloadDoc !== undefined && !matchesPayloadDoc(e, filter.payloadDoc)) return false;
  return true;
}

function matchesPayloadDoc(e: AuditEvent, fields: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(fields);
  if (entries.length === 0) return true;
  const doc = e.payload.doc;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const record = doc as Readonly<Record<string, unknown>>;
  return entries.every(([key, value]) => record[key] === value);
}

function compareByTimestampThenId(a: AuditEvent, b: AuditEvent): number {
  const at = a.timestamp as unknown as string;
  const bt = b.timestamp as unknown as string;
  if (at < bt) return -1;
  if (at > bt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function findStart(sorted: readonly AuditEvent[], ts: string, id: string): number {
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i];
    if (e === undefined) continue;
    const et = e.timestamp as unknown as string;
    if (et > ts || (et === ts && e.id > id)) return i;
  }
  return sorted.length;
}

interface CursorPayload {
  readonly timestamp: string;
  readonly id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): Result<CursorPayload | null, InvalidCursorError> {
  if (cursor === undefined || cursor === '') return { kind: 'ok', value: null };
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as CursorPayload;
    if (typeof parsed.timestamp !== 'string' || typeof parsed.id !== 'string') {
      return {
        kind: 'err',
        error: { code: 'invalid-cursor', message: 'Cursor missing (timestamp, id)' },
      };
    }
    return { kind: 'ok', value: parsed };
  } catch {
    return {
      kind: 'err',
      error: { code: 'invalid-cursor', message: 'Cursor is not decodable base64url JSON' },
    };
  }
}
