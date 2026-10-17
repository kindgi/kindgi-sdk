// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/runs/:runId/stream` falls back to polling the journal when
 * the event bus is wired but subscribing fails, and stops its work when
 * the reader cancels or the request aborts.
 */

import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { JournalEntry, KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { EventBusBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-stream-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function entry(sequence: number, kind: string): JournalEntry {
  return {
    sequence,
    kind,
    timestamp: new Date(Date.UTC(2026, 8, 30, 12, 0, sequence)).toISOString() as Timestamp,
  } as unknown as JournalEntry;
}

describe('GET /v1/runs/:runId/stream — event bus subscribe fails', () => {
  test('falls back to polling and delivers the run to its terminal event', async () => {
    const runId = randomUUID() as RunId;
    const at = '2026-09-30T00:00:00.000Z' as Timestamp;
    const record: KernelRunRecord = {
      runId,
      tenantId,
      projectId: randomUUID() as ProjectId,
      flowId: 'pack.flow',
      flowVersion: '1.0.0',
      status: 'running',
      input: {},
      dryRun: false,
      createdAt: at,
      updatedAt: at,
    };
    // The run completes after the stream opened: the first journal read
    // (the backfill) sees it running, later reads see it completed.
    let reads = 0;
    const stubs = createStubAppBindings();
    const run = {
      ...stubs.kernelBinding.run,
      getRun: async () => record,
      readJournal: async () => {
        reads += 1;
        const journal = [entry(1, 'run.started')];
        if (reads > 1) journal.push(entry(2, 'run.completed'));
        return { kind: 'ok' as const, value: journal };
      },
    } as unknown as RunBinding;
    const eventBus: EventBusBinding = {
      publish: async () => ({ kind: 'ok', value: undefined }),
      subscribe: async () => ({
        kind: 'err',
        error: { code: 'subscribe-failed', message: 'bus unavailable' },
      }),
    };
    const app = createApp({
      ...stubs,
      kernelBinding: { ...stubs.kernelBinding, run },
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      eventBus,
    });

    const res = await app.request(`/v1/runs/${runId}/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: run.started');
    expect(text).toContain('event: run.completed');
  });
});

describe('GET /v1/runs/:runId/stream — a reader that cancels stops the work', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A run that never ends; counts journal reads, subscriptions and unsubscriptions. */
  function streamApp(
    bus: boolean,
    journal: () => Promise<JournalEntry[]> = async () => [entry(1, 'run.started')],
  ) {
    const runId = randomUUID() as RunId;
    const at = '2026-09-30T00:00:00.000Z' as Timestamp;
    const counts = { reads: 0, subscribed: 0, unsubscribed: 0, aborted: false };
    let hold: { entered: () => void; released: Promise<void> } | undefined;
    /** Holds the route's read of the run until `release`; `waiting` resolves once it waits. */
    const holdRunRead = () => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((entered) => {
        hold = { entered, released };
      });
      return { waiting, release };
    };
    const stubs = createStubAppBindings();
    const run = {
      ...stubs.kernelBinding.run,
      getRun: async (_tenant: TenantId, id: RunId) => {
        if (hold !== undefined) {
          hold.entered();
          await hold.released;
        }
        return id !== runId
          ? null
          : ({
              runId,
              tenantId,
              projectId: randomUUID() as ProjectId,
              flowId: 'pack.flow',
              flowVersion: '1.0.0',
              status: 'running',
              input: {},
              dryRun: false,
              createdAt: at,
              updatedAt: at,
            } satisfies KernelRunRecord);
      },
      readJournal: async () => {
        counts.reads += 1;
        return { kind: 'ok' as const, value: await journal() };
      },
    } as unknown as RunBinding;
    const eventBus: EventBusBinding = {
      publish: async () => ({ kind: 'ok', value: undefined }),
      subscribe: async (_tenant, _channel, _onEvent, signal) => {
        counts.subscribed += 1;
        signal.addEventListener('abort', () => {
          counts.aborted = true;
        });
        return {
          kind: 'ok',
          value: {
            unsubscribe: async () => {
              counts.unsubscribed += 1;
            },
          },
        };
      },
    };
    const app = createApp({
      ...stubs,
      kernelBinding: { ...stubs.kernelBinding, run },
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      ...(bus && { eventBus }),
    });
    const call = (
      path: 'stream' | 'progress/stream',
      method: 'GET' | 'HEAD',
      { id = runId, signal }: { id?: RunId; signal?: AbortSignal } = {},
    ) =>
      app.request(`/v1/runs/${id}/${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-stream' },
        ...(signal !== undefined && { signal }),
      });
    const request = async (path: 'stream' | 'progress/stream') => {
      const res = await call(path, 'GET');
      expect(res.status).toBe(200);
      return (res.body as ReadableStream<Uint8Array>).getReader();
    };
    /** The stream, its first frame read. */
    const open = async (path: 'stream' | 'progress/stream') => {
      const reader = await request(path);
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: run.started');
      return reader;
    };
    return { call, request, open, counts, holdRunRead };
  }

  test.each(['stream', 'progress/stream'] as const)(
    'polling (%s): no journal read and no timer after the cancel',
    async (path) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { open, counts } = streamApp(false);
      const reader = await open(path);
      await vi.advanceTimersByTimeAsync(1_000);
      const polled = counts.reads;
      // It polls while it's read: the first read, then one every 200 ms.
      expect(polled).toBeGreaterThan(1);
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(counts.reads).toBe(polled);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('subscribed: the cancel aborts and ends the subscription, and the five-minute wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { open, counts } = streamApp(true);
    const reader = await open('stream');
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual({ reads: 1, subscribed: 1, unsubscribed: 0, aborted: false });
    // The wait for a terminal event.
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual({ reads: 1, subscribed: 1, unsubscribed: 1, aborted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('cancelled while it reads the journal back: it never subscribes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let backfilled: () => void = () => undefined;
    const backfill = new Promise<void>((resolve) => {
      backfilled = resolve;
    });
    // Nothing in the journal yet, so the read back writes no frame.
    const { request, counts } = streamApp(true, async () => {
      await backfill;
      return [];
    });
    const reader = await request('stream');
    await reader.cancel();
    backfilled();
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual({ reads: 1, subscribed: 0, unsubscribed: 0, aborted: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    ['stream', 'polling'],
    ['progress/stream', 'polling'],
    ['stream', 'subscribed'],
    ['progress/stream', 'subscribed'],
  ] as const)(
    "a HEAD (%s, %s) answers the stream's status and headers and starts none of its work",
    async (path, mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { call, counts } = streamApp(mode === 'subscribed');
      const head = await call(path, 'HEAD');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // No journal read, no subscription and no timer: the stream never started.
      expect(counts).toEqual({ reads: 0, subscribed: 0, unsubscribed: 0, aborted: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(head.body).toBeNull();
      const get = await call(path, 'GET');
      await get.body?.cancel();
      expect([head.status, get.status]).toEqual([200, 200]);
      // Each request answers its own span; every other header is the same.
      const { traceresponse: headSpan, ...headHeaders } = Object.fromEntries(head.headers);
      const { traceresponse: getSpan, ...getHeaders } = Object.fromEntries(get.headers);
      expect([headSpan, getSpan]).toEqual([expect.any(String), expect.any(String)]);
      expect(headHeaders).toEqual(getHeaders);
      expect(headHeaders['content-type']).toBe('text/event-stream; charset=utf-8');
      // A run it can't read: the GET's 404.
      const absent = randomUUID() as RunId;
      const [headMissing, getMissing] = [
        await call(path, 'HEAD', { id: absent }),
        await call(path, 'GET', { id: absent }),
      ];
      expect([headMissing.status, getMissing.status, headMissing.body]).toEqual([404, 404, null]);
      expect(Object.fromEntries(headMissing.headers)).toEqual({
        ...Object.fromEntries(getMissing.headers),
        traceresponse: expect.any(String),
      });
    },
  );

  test.each(['polling', 'subscribed'] as const)(
    'a client that leaves during the read check (%s): the stream never starts',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { call, counts, holdRunRead } = streamApp(mode === 'subscribed');
      const { waiting, release } = holdRunRead();
      const client = new AbortController();
      const answered = call('stream', 'GET', { signal: client.signal });
      await waiting;
      client.abort();
      release();
      const res = await answered;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // No journal read, no subscription and no timer. The body is never touched.
      expect(counts).toEqual({ reads: 0, subscribed: 0, unsubscribed: 0, aborted: false });
      expect(vi.getTimerCount()).toBe(0);
      expect([res.status, res.body]).toEqual([200, null]);
    },
  );

  test.each(['polling', 'subscribed'] as const)(
    'a client that leaves after the answer (%s), its body never read: the work stops',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { call, counts } = streamApp(mode === 'subscribed');
      const client = new AbortController();
      const res = await call('stream', 'GET', { signal: client.signal });
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(1_000);
      const working = { ...counts };
      // It works while the client is there: it polls, or it's subscribed.
      if (mode === 'polling') expect(working.reads).toBeGreaterThan(1);
      else expect(working).toEqual({ reads: 1, subscribed: 1, unsubscribed: 0, aborted: false });
      client.abort();
      await vi.advanceTimersByTimeAsync(0);
      // It stops at once, inside the five-minute wait: no timer left, and the
      // subscription ended.
      const stopped = mode === 'polling' ? working : { ...working, unsubscribed: 1, aborted: true };
      expect([counts, vi.getTimerCount()]).toEqual([stopped, 0]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(counts).toEqual(stopped);
    },
  );
});
