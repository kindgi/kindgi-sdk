// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A corrections export's body and its two audit events: CSV fields, page
 * after page, rows the caller can't read left out, and how a stream that
 * breaks off or loses its client is recorded.
 */

import { describe, expect, test, vi } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { Logger } from '@kindgi/log';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type {
  Correction,
  CorrectionListInput,
  CorrectionRegistryBinding,
} from '../src/correction-binding.js';
import {
  CORRECTIONS_EXPORTED_EVENT_KIND,
  CORRECTIONS_EXPORT_STARTED_EVENT_KIND,
  type CorrectionsExportInput,
  correctionsExportStream,
  csvHeader,
  csvRow,
  startCorrectionsExport,
} from '../src/corrections-export.js';

const tenantId = 'tenant-1' as TenantId;
const projectId = 'proj-1' as ProjectId;

function correction(id: string, overrides: Partial<Correction> = {}): Correction {
  return {
    id,
    tenantId,
    projectId,
    runId: `run-${id}`,
    subject: { kind: 'agent', id: 'acme.matcher', version: '1.2.0' },
    status: 'open',
    madeBy: { kind: 'user', id: 'user-1' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as Correction;
}

/** A registry whose `list` serves these pages in order, each after the cursor the last one gave. */
function pagedRegistry(
  pages: readonly (readonly Correction[])[],
  fail?: { readonly onPage: number; readonly error: Error },
): { readonly binding: CorrectionRegistryBinding; readonly asked: CorrectionListInput[] } {
  const asked: CorrectionListInput[] = [];
  const list = async (input: CorrectionListInput) => {
    asked.push(input);
    const at = input.cursor === undefined ? 0 : Number(input.cursor);
    if (fail !== undefined && at === fail.onPage) throw fail.error;
    const more = at + 1 < pages.length;
    return {
      data: pages[at] ?? [],
      hasMore: more,
      ...(more && { nextCursor: String(at + 1) as unknown as Cursor }),
    };
  };
  return { binding: { list } as unknown as CorrectionRegistryBinding, asked };
}

function logger(): Logger & { readonly errors: unknown[][] } {
  const errors: unknown[][] = [];
  const log = {
    errors,
    error: (...args: unknown[]) => errors.push(args),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    child: () => log,
  };
  return log as unknown as Logger & { readonly errors: unknown[][] };
}

function exportInput(
  binding: CorrectionRegistryBinding,
  overrides: Partial<CorrectionsExportInput> = {},
): CorrectionsExportInput {
  return {
    binding,
    tenantId,
    filters: { agentId: 'acme.matcher', statuses: ['open'] },
    format: 'csv',
    visible: async (rows) => rows,
    serialize: (j) => ({ id: j.id, status: j.status }),
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function events(audit: AuditEventBinding): Promise<readonly AuditEvent[]> {
  const page = await audit.query({ tenantId, limit: 100 });
  if (page.kind !== 'ok') throw new Error('query failed');
  return page.value.data;
}

describe('csvRow', () => {
  test('writes the columns in order, a flow subject with no agent version', () => {
    expect(csvHeader()).toBe(
      'id,projectId,runId,agentVersion,madeBy,participantId,expert,decisions,shouldCall,mustNotCall,answer,shouldSay,why,sortedTo,status,fixedIn,createdAt\r\n',
    );
    const row = csvRow(
      correction('c1', {
        participantId: 'app-user-7',
        decisions: 'wrong',
        shouldCall: [{ tool: 'lookup' }] as never,
        mustNotCall: ['refund'],
        answer: 'wrong',
        shouldSay: 'Plain words',
        why: 'It said no',
        sortedTo: 'improve',
        status: 'fixed',
        fixedIn: { version: '1.3.0', how: 'improve-run', at: '2026-10-02T00:00:00.000Z' } as never,
      }),
    );
    expect(row).toBe(
      'c1,proj-1,run-c1,1.2.0,user:user-1,app-user-7,false,wrong,"[{""tool"":""lookup""}]","[""refund""]",wrong,Plain words,It said no,improve,fixed,1.3.0,2026-10-01T00:00:00.000Z\r\n',
    );
    const flow = csvRow(correction('c2', { subject: { kind: 'flow', id: 'f', version: '2.0.0' } }));
    expect(flow.split(',')[3]).toBe('');
  });

  test('quotes commas, quotes and line breaks, and makes a formula inert', () => {
    const row = csvRow(
      correction('c1', {
        expert: true,
        shouldSay: 'Say "yes", then\nstop',
        why: '=HYPERLINK("http://example.com")',
      }),
    );
    expect(row).toContain(',true,');
    expect(row).toContain(',"Say ""yes"", then\nstop",');
    expect(row).toContain(`,"'=HYPERLINK(""http://example.com"")",`);
    for (const lead of ['+1', '-1', '@x', '\tx']) {
      expect(csvRow(correction('c1', { why: lead }))).toContain(`,'${lead},`);
    }
  });
});

describe('correctionsExportStream', () => {
  test('sends every page after the header, without the rows the caller cannot read, and records both events', async () => {
    const pages = [
      [correction('c1'), correction('c2')],
      [correction('hidden-1')],
      [correction('c3')],
    ];
    const { binding, asked } = pagedRegistry(pages);
    const audit = createInMemoryAuditEventBinding();
    const input = exportInput(binding, {
      visible: async (rows) => rows.filter((j) => !j.id.startsWith('hidden')),
      audit: { auditEvents: audit, actor: 'user:user-1', projectId },
    });

    const started = await startCorrectionsExport(input);
    expect(started.kind).toBe('ok');
    if (started.kind !== 'ok') return;
    const text = await readAll(correctionsExportStream(input, started.exportId));

    const lines = text.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe(csvHeader().trimEnd());
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['c1', 'c2', 'c3']);
    expect(asked.map((a) => a.cursor)).toEqual([undefined, '1', '2']);
    expect(asked.every((a) => a.agentId === 'acme.matcher' && a.tenantId === tenantId)).toBe(true);

    // Both can share a millisecond, so they're found by kind, not by order.
    const recorded = await events(audit);
    expect(recorded).toHaveLength(2);
    const first = recorded.find((e) => e.kind === CORRECTIONS_EXPORT_STARTED_EVENT_KIND);
    const last = recorded.find((e) => e.kind === CORRECTIONS_EXPORTED_EVENT_KIND);
    if (first === undefined || last === undefined) throw new Error('an event is missing');
    expect(first.actor).toBe('user:user-1');
    expect(first.projectId).toBe(projectId);
    expect(first.outcome).toBeUndefined();
    expect(first.payload).toEqual({
      v: 1,
      doc: {
        exportId: started.exportId,
        format: 'csv',
        filters: { agentId: 'acme.matcher', statuses: ['open'] },
      },
    });
    expect(last.outcome).toBe('succeeded');
    expect(last.payload).toEqual({
      v: 1,
      doc: {
        exportId: started.exportId,
        format: 'csv',
        filters: { agentId: 'acme.matcher', statuses: ['open'] },
        rows: 3,
      },
    });
  });

  test('JSON lines: one correction per line, as the list sends it, and no header', async () => {
    const { binding } = pagedRegistry([[correction('c1')], [correction('c2')]]);
    const text = await readAll(
      correctionsExportStream(exportInput(binding, { format: 'jsonl' }), 'export-1'),
    );
    expect(text).toBe('{"id":"c1","status":"open"}\n{"id":"c2","status":"open"}\n');
  });

  test('nothing to export: the CSV is its header, and the export succeeded with no rows', async () => {
    const { binding } = pagedRegistry([[]]);
    const audit = createInMemoryAuditEventBinding();
    const input = exportInput(binding, { audit: { auditEvents: audit, actor: 'user:user-1' } });
    expect(await readAll(correctionsExportStream(input, 'export-1'))).toBe(csvHeader());
    const [ended] = await events(audit);
    expect(ended?.outcome).toBe('succeeded');
    expect(ended?.projectId).toBeUndefined();
    expect((ended?.payload.doc as { rows: number }).rows).toBe(0);
  });

  test('a page read that fails breaks the stream off and records it failed, with the rows sent', async () => {
    const { binding } = pagedRegistry([[correction('c1')], [correction('c2')]], {
      onPage: 1,
      error: new Error('database went away'),
    });
    const audit = createInMemoryAuditEventBinding();
    const log = logger();
    const input = exportInput(binding, {
      audit: { auditEvents: audit, actor: 'user:user-1' },
      log,
      requestId: 'req-1',
    });
    await expect(readAll(correctionsExportStream(input, 'export-1'))).rejects.toThrow(
      'database went away',
    );
    const [ended] = await events(audit);
    expect(ended?.kind).toBe(CORRECTIONS_EXPORTED_EVENT_KIND);
    expect(ended?.outcome).toBe('failed');
    expect((ended?.payload.doc as { rows: number }).rows).toBe(1);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.[1]).toMatchObject({ requestId: 'req-1', exportId: 'export-1', rows: 1 });
  });

  test('a client that leaves before the end is recorded failed, once', async () => {
    const { binding } = pagedRegistry([[correction('c1')], [correction('c2')], [correction('c3')]]);
    const audit = createInMemoryAuditEventBinding();
    const input = exportInput(binding, { audit: { auditEvents: audit, actor: 'user:user-1' } });
    const reader = correctionsExportStream(input, 'export-1').getReader();
    await reader.read();
    await reader.cancel();
    const recorded = await events(audit);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe('failed');
    expect((recorded[0]?.payload.doc as { rows: number }).rows).toBe(1);
  });

  test("a closing event that can't be written is logged with the request id, and the rows still go out", async () => {
    const { binding } = pagedRegistry([[correction('c1')]]);
    const auditEvents = {
      append: vi.fn(async () => ({ kind: 'err', error: { message: 'audit store full' } })),
    } as unknown as AuditEventBinding;
    const log = logger();
    const input = exportInput(binding, {
      audit: { auditEvents, actor: 'user:user-1' },
      log,
      requestId: 'req-2',
    });
    const text = await readAll(correctionsExportStream(input, 'export-2'));
    expect(text.split('\r\n')[1]?.startsWith('c1,')).toBe(true);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.[1]).toMatchObject({
      requestId: 'req-2',
      exportId: 'export-2',
      rows: 1,
      outcome: 'succeeded',
      reason: 'audit store full',
    });
  });

  test('without an audit binding, nothing is recorded and the rows still go out', async () => {
    const { binding } = pagedRegistry([[correction('c1')]]);
    const input = exportInput(binding);
    const started = await startCorrectionsExport(input);
    expect(started.kind).toBe('ok');
    const text = await readAll(correctionsExportStream(input, 'export-3'));
    expect(text.split('\r\n')[1]?.startsWith('c1,')).toBe(true);
  });
});

describe('startCorrectionsExport', () => {
  test("a start event that can't be written is an error, whether the append refuses or throws", async () => {
    const { binding } = pagedRegistry([[correction('c1')]]);
    const refusing = {
      append: async () => ({ kind: 'err', error: { message: 'audit store full' } }),
    } as unknown as AuditEventBinding;
    const throwing = {
      append: async () => {
        throw new Error('connection reset');
      },
    } as unknown as AuditEventBinding;
    expect(
      await startCorrectionsExport(
        exportInput(binding, { audit: { auditEvents: refusing, actor: 'user:user-1' } }),
      ),
    ).toEqual({ kind: 'err', message: 'audit store full' });
    expect(
      await startCorrectionsExport(
        exportInput(binding, { audit: { auditEvents: throwing, actor: 'user:user-1' } }),
      ),
    ).toEqual({ kind: 'err', message: 'connection reset' });
  });
});
