// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PrepareEvent } from '@kindgi/capabilities';

import { DEFAULT_LOCAL_MODEL, type LocalModel, MODEL_SPECS } from './models.js';

/**
 * `prepareInProcessModel` — the in-process adapter's download / warmup
 * step, in the shape of `AdapterFactoryEntry.prepare()` from
 * `@kindgi/capabilities`. Streams download / warmup progress as
 * framework `PrepareEvent`s so an HTTP SSE endpoint (such as
 * `POST /v1/adapters/:adapterId/prepare` in `@kindgi/api`) can stream
 * them to a client.
 *
 * What happens under the hood:
 *   0. Yield a first `progress` event naming the model and its
 *      approximate download size, before any callback fires.
 *   1. Dynamically import `@huggingface/transformers` (kept
 *      dynamic so shape tests don't touch the ONNX runtime).
 *   2. Call `pipeline('text-generation', hfName, {dtype,
 *      progress_callback})`. First run: transformers.js downloads
 *      the model into its cache (`cacheDir` when set, passed as
 *      `cache_dir`; otherwise transformers.js's default, see
 *      `models.ts`). Subsequent runs hit the cache — the callback
 *      still fires but reports zero-byte "downloads."
 *   3. The pipeline's progress_callback fires with events like
 *      `{status: 'initiate' | 'download' | 'progress' | 'done',
 *      name, file, progress?, loaded?, total?}`. We translate each
 *      into a `PrepareEvent` and enqueue it for the async iterator
 *      to yield.
 *   4. When the pipeline promise resolves → emit `{kind: 'ready'}`
 *      and end the stream. On rejection → emit
 *      `{kind: 'error', message}` and end.
 *
 * Consumer pattern (e.g. inside an SSE route):
 * ```ts
 * for await (const event of prepareInProcessModel({model: 'smollm2-360m'})) {
 *   sendSse(event);
 * }
 * ```
 */
export interface PrepareInProcessParams {
  readonly model?: LocalModel;
  /** Directory for downloaded model files, passed to transformers.js as `cache_dir`. */
  readonly cacheDir?: string;
}

interface RawProgressEvent {
  readonly status?: string;
  readonly name?: string;
  readonly file?: string;
  readonly progress?: number;
  readonly loaded?: number;
  readonly total?: number;
}

export async function* prepareInProcessModel(
  params: PrepareInProcessParams = {},
): AsyncIterable<PrepareEvent> {
  const modelKey = params.model ?? DEFAULT_LOCAL_MODEL;
  const spec = MODEL_SPECS[modelKey];

  const queue: PrepareEvent[] = [];
  let resolveWait: (() => void) | undefined;
  let ended = false;

  const enqueue = (event: PrepareEvent): void => {
    queue.push(event);
    const w = resolveWait;
    resolveWait = undefined;
    w?.();
  };
  const finish = (event: PrepareEvent): void => {
    queue.push(event);
    ended = true;
    const w = resolveWait;
    resolveWait = undefined;
    w?.();
  };

  const progressCallback = (raw: unknown): void => {
    if (raw === null || typeof raw !== 'object') return;
    const r = raw as RawProgressEvent;
    switch (r.status) {
      case 'initiate':
        enqueue({
          kind: 'progress',
          message: `Fetching ${r.file ?? r.name ?? spec.hfName}`,
          ...(r.file !== undefined && { file: r.file }),
        });
        return;
      case 'download':
        enqueue({
          kind: 'progress',
          message: `Downloading ${r.file ?? r.name ?? spec.hfName}`,
          ...(r.file !== undefined && { file: r.file }),
        });
        return;
      case 'progress':
        if (typeof r.progress === 'number') {
          enqueue({
            kind: 'progress',
            message: `Downloading ${r.file ?? r.name ?? spec.hfName}`,
            ratio: Math.max(0, Math.min(1, r.progress / 100)),
            ...(typeof r.loaded === 'number' && { loadedBytes: r.loaded }),
            ...(typeof r.total === 'number' && { totalBytes: r.total }),
            ...(r.file !== undefined && { file: r.file }),
          });
        }
        return;
      case 'done':
        enqueue({
          kind: 'progress',
          message: `Completed ${r.file ?? r.name ?? spec.hfName}`,
          ratio: 1,
          ...(r.file !== undefined && { file: r.file }),
        });
        return;
      default:
        // 'ready' + any unknown status — ignore; the load-promise
        // resolution is the authoritative "done" signal.
        return;
    }
  };

  // Kick off the load in parallel with the yield loop.
  const loadPromise = (async () => {
    const mod = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
    };
    return mod.pipeline('text-generation', spec.hfName, {
      dtype: spec.dtype,
      progress_callback: progressCallback,
      ...(params.cacheDir !== undefined && { cache_dir: params.cacheDir }),
    });
  })();

  loadPromise.then(
    () => finish({ kind: 'ready', message: `${spec.hfName} ready` }),
    (err) =>
      finish({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      }),
  );

  // Prologue — tell the consumer what's about to happen even before
  // the callback fires (transformers.js can silently sit on a cache
  // check for a second or two before emitting anything).
  yield {
    kind: 'progress',
    message: `Preparing ${spec.hfName} (~${spec.approxDownloadMb} MB, ${spec.tier} tier)`,
  };

  while (!ended || queue.length > 0) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
  }
}
