// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A corrections export (`GET /v1/corrections/export`): every correction
 * the list's filters match, page after page, as CSV or as JSON lines.
 *
 * Two audit events bracket it, with the same `exportId`:
 *
 * - `corrections-export-started`, before the first row: who, the filters
 *   and the format. When it can't be written, nothing is sent.
 * - `corrections-exported`, when the stream ends: the rows sent, and the
 *   outcome. `succeeded` when every page went out; `failed` when a page
 *   read broke or the client left. When it can't be written, the rows are
 *   already out, so the error is logged with the request id.
 *
 * Without an audit-event binding, an export isn't recorded.
 */

import { randomUUID } from 'node:crypto';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Logger } from '@kindgi/log';
import type { Cursor, ProjectId, TenantId, Timestamp } from '@kindgi/types';

import type {
  Correction,
  CorrectionListInput,
  CorrectionRegistryBinding,
} from './correction-binding.js';
import { loggable } from './middleware/error-mapper.js';

export type CorrectionsExportFormat = 'csv' | 'jsonl';

export const CORRECTIONS_EXPORT_FORMATS: readonly CorrectionsExportFormat[] = ['csv', 'jsonl'];

/** Appended before an export's first row. */
export const CORRECTIONS_EXPORT_STARTED_EVENT_KIND = 'corrections-export-started';

/** Appended when an export's stream ends. */
export const CORRECTIONS_EXPORTED_EVENT_KIND = 'corrections-exported';

/** The CSV's columns, in order. The header row names them. */
export const CORRECTIONS_CSV_COLUMNS = [
  'id',
  'projectId',
  'runId',
  'agentVersion',
  'madeBy',
  'participantId',
  'expert',
  'decisions',
  'shouldCall',
  'mustNotCall',
  'answer',
  'shouldSay',
  'why',
  'sortedTo',
  'status',
  'fixedIn',
  'createdAt',
] as const;

/** How many corrections one page read asks for. */
const PAGE_SIZE = 100;

/** The list's filters an export takes: everything but the tenant, the page size and the cursor. */
export type CorrectionsExportFilters = Omit<CorrectionListInput, 'tenantId' | 'limit' | 'cursor'>;

export interface CorrectionsExportAudit {
  readonly auditEvents: AuditEventBinding;
  /** The caller, as `exportActor` names it. */
  readonly actor: string;
  /** The project scope, when the export has one. */
  readonly projectId?: ProjectId;
}

export interface CorrectionsExportInput {
  readonly binding: CorrectionRegistryBinding;
  readonly tenantId: TenantId;
  readonly filters: CorrectionsExportFilters;
  readonly format: CorrectionsExportFormat;
  /** Keeps the rows the caller may read, as the list does. */
  readonly visible: (rows: readonly Correction[]) => Promise<readonly Correction[]>;
  /** A correction as the list sends it: one JSON line. */
  readonly serialize: (correction: Correction) => Record<string, unknown>;
  readonly audit?: CorrectionsExportAudit;
  readonly log?: Logger;
  readonly requestId?: string;
}

/** One RFC 4180 line of the CSV, ending in CRLF. */
export function csvLine(fields: readonly string[]): string {
  return `${fields.map(csvField).join(',')}\r\n`;
}

/** The CSV's header line. */
export function csvHeader(): string {
  return csvLine(CORRECTIONS_CSV_COLUMNS);
}

/** A correction as one CSV line, in `CORRECTIONS_CSV_COLUMNS` order. */
export function csvRow(correction: Correction): string {
  const j = correction;
  return csvLine([
    j.id,
    j.projectId as unknown as string,
    j.runId,
    j.subject.kind === 'agent' ? j.subject.version : '',
    `${j.madeBy.kind}:${j.madeBy.id}`,
    j.participantId ?? '',
    j.expert === true ? 'true' : 'false',
    j.decisions ?? '',
    j.shouldCall === undefined ? '' : JSON.stringify(j.shouldCall),
    j.mustNotCall === undefined ? '' : JSON.stringify(j.mustNotCall),
    j.answer ?? '',
    j.shouldSay ?? '',
    j.why ?? '',
    j.sortedTo ?? '',
    j.status,
    j.fixedIn?.version ?? '',
    j.createdAt,
  ]);
}

/**
 * One field: quoted when it holds a quote, a comma or a line break, with
 * its quotes doubled. A field a spreadsheet would run as a formula (it
 * starts with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a
 * leading `'`, since an end user's words can land in `why`.
 */
function csvField(value: string): string {
  const inert = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert;
}

/**
 * Appends `corrections-export-started`. The export id names both events.
 * An `err` means nothing may be sent.
 */
export async function startCorrectionsExport(
  input: Pick<CorrectionsExportInput, 'tenantId' | 'filters' | 'format' | 'audit'>,
): Promise<
  | { readonly kind: 'ok'; readonly exportId: string }
  | { readonly kind: 'err'; readonly message: string }
> {
  const exportId = randomUUID();
  if (input.audit === undefined) return { kind: 'ok', exportId };
  const event = exportEvent(input, CORRECTIONS_EXPORT_STARTED_EVENT_KIND, exportId, {});
  const appended = await appendEvent(input.audit.auditEvents, event);
  return appended === undefined ? { kind: 'ok', exportId } : { kind: 'err', message: appended };
}

/**
 * The export's body: the CSV header (for CSV), then a page of rows per
 * read, until the list has no more. It ends by appending
 * `corrections-exported`.
 */
export function correctionsExportStream(
  input: CorrectionsExportInput,
  exportId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor: Cursor | undefined;
  let headerSent = false;
  let rows = 0;
  let ended = false;

  const end = async (outcome: 'succeeded' | 'failed'): Promise<void> => {
    if (ended) return;
    ended = true;
    if (input.audit === undefined) return;
    const event = exportEvent(input, CORRECTIONS_EXPORTED_EVENT_KIND, exportId, { rows }, outcome);
    const failed = await appendEvent(input.audit.auditEvents, event);
    if (failed !== undefined) {
      input.log?.error('a corrections export ended, but recording it failed', {
        requestId: input.requestId,
        exportId,
        rows,
        outcome,
        reason: failed,
      });
    }
  };

  const line = (j: Correction): string =>
    input.format === 'csv' ? csvRow(j) : `${JSON.stringify(input.serialize(j))}\n`;

  // A page can hold nothing the caller may read: read on until there's
  // something to send after `text`, or nothing left.
  const readOn = async (
    text: string,
  ): Promise<{ readonly text: string; readonly done: boolean }> => {
    let out = text;
    for (;;) {
      const page = await input.binding.list({
        ...input.filters,
        tenantId: input.tenantId,
        limit: PAGE_SIZE,
        ...(cursor !== undefined && { cursor }),
      });
      const shown = await input.visible(page.data);
      for (const j of shown) out += line(j);
      rows += shown.length;
      cursor = page.nextCursor;
      const done = !page.hasMore || cursor === undefined;
      if (done || out !== '') return { text: out, done };
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const header = !headerSent && input.format === 'csv' ? csvHeader() : '';
        headerSent = true;
        try {
          const next = await readOn(header);
          if (next.text !== '') controller.enqueue(encoder.encode(next.text));
          if (next.done) {
            controller.close();
            await end('succeeded');
          }
        } catch (err) {
          input.log?.error('a corrections export broke off: a page read failed', {
            requestId: input.requestId,
            exportId,
            rows,
            err: loggable(err),
          });
          await end('failed');
          controller.error(err);
        }
      },
      async cancel() {
        // The client left before the end.
        await end('failed');
      },
    },
    // A page is read only when the client asks for more, never ahead of it.
    { highWaterMark: 0 },
  );
}

function exportEvent(
  input: Pick<CorrectionsExportInput, 'tenantId' | 'filters' | 'format' | 'audit'>,
  kind: string,
  exportId: string,
  extra: Readonly<Record<string, unknown>>,
  outcome?: 'succeeded' | 'failed',
): AuditEvent {
  const audit = input.audit as CorrectionsExportAudit;
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    ...(audit.projectId !== undefined && { projectId: audit.projectId }),
    kind,
    timestamp: new Date().toISOString() as unknown as Timestamp,
    actor: audit.actor,
    ...(outcome !== undefined && { outcome }),
    payload: {
      v: 1,
      doc: { exportId, format: input.format, filters: input.filters, ...extra },
    },
  };
}

/** `undefined` once the event is written, else why it wasn't. */
async function appendEvent(
  auditEvents: AuditEventBinding,
  event: AuditEvent,
): Promise<string | undefined> {
  try {
    const appended = await auditEvents.append([event]);
    return appended.kind === 'ok' ? undefined : appended.error.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
