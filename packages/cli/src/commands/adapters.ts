// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi adapters` — user-facing surface for the adapter lifecycle.
 *
 * Today: `prepare` only. Adapters are also queryable via the wire
 * (`GET /v1/adapters`) but that surface stays on `providers` for now
 * since users think in provider ids. `prepare` is separate because it
 * acts on the adapter (which knows how to warm itself), not on the
 * provider config.
 *
 * Production pattern: `kindgi providers register` → `kindgi adapters
 * prepare <adapter-id>` → agent runs are hot. Skipping prepare works
 * (first `generate()` will lazy-download) but stalls a request path on
 * a multi-hundred-MB fetch and gives users no progress signal, so the
 * skill teaches prepare as mandatory.
 */

import type { PrepareEvent } from '@kindgi/client';

import { commandResultFromThrown, requiredPositional, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const prepareCmd: LeafCommand = {
  kind: 'leaf',
  name: 'prepare',
  description:
    'Pre-warm an adapter (download weights, initialize sessions). Streams SSE progress. Call after `providers register`, before `runs start`.',
  usage: 'kindgi adapters prepare <adapter-id> [--model=<key>] [--params=<json-or-@file>]',
  optionSpec: {
    model: { type: 'string' as const },
    params: { type: 'string' as const },
  },
  run: async (ctx): Promise<CommandResult> => {
    let adapterId: string;
    try {
      adapterId = requiredPositional(ctx, 0, 'adapter-id');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }

    // Compose adapter params. `--model=<key>` is a shorthand for the
    // in-process ONNX adapter (its only meaningful param); `--params`
    // accepts an arbitrary JSON blob for any adapter.
    const paramsFlag = stringFlag(ctx, 'params');
    const modelFlag = stringFlag(ctx, 'model');
    let params: Readonly<Record<string, unknown>> | undefined;
    if (paramsFlag !== undefined) {
      try {
        params = JSON.parse(paramsFlag) as Readonly<Record<string, unknown>>;
      } catch (err) {
        return {
          kind: 'error',
          stderr: `Malformed --params JSON: ${(err as Error).message}\n`,
          exitCode: 2,
        };
      }
    }
    if (modelFlag !== undefined) {
      params = { ...(params ?? {}), model: modelFlag };
    }

    // Wire SIGINT / stopSignal to the SSE stream so Ctrl-C aborts
    // mid-download cleanly instead of leaving a dangling connection.
    const controller = new AbortController();
    const upstream = ctx.stopSignal;
    if (upstream !== undefined) {
      if (upstream.aborted) controller.abort();
      else upstream.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const iterable = ctx.client().adapters.prepare({
      adapterId,
      ...(params !== undefined && { params }),
      signal: controller.signal,
    });

    const jsonMode = ctx.globals.format === 'json';
    const events: PrepareEvent[] = [];
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    stderrChunks.push(
      `\n  Preparing ${adapterId}${params !== undefined ? ` (${JSON.stringify(params)})` : ''}…\n`,
    );

    try {
      for await (const event of iterable) {
        events.push(event);
        if (jsonMode) {
          stdoutChunks.push(`${JSON.stringify(event)}\n`);
        } else {
          stderrChunks.push(renderProgressLine(event));
        }
        if (event.kind === 'ready' || event.kind === 'error') break;
      }
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'kindgi adapters prepare');
    }

    const terminal = events[events.length - 1];
    if (terminal?.kind === 'error') {
      return {
        kind: 'error',
        stderr: [...stderrChunks, `\n  Failed: ${terminal.message}\n\n`].join(''),
        exitCode: 1,
      };
    }

    if (jsonMode) {
      return {
        kind: 'ok',
        rendered: {
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        },
      };
    }
    const summary =
      terminal?.kind === 'ready'
        ? (terminal.message ?? 'ready')
        : 'stream ended without terminal event';
    stderrChunks.push(`\n  Ready: ${summary}\n\n`);
    return {
      kind: 'ok',
      rendered: {
        stdout: '',
        stderr: stderrChunks.join(''),
      },
    };
  },
};

function renderProgressLine(event: PrepareEvent): string {
  if (event.kind === 'ready') {
    return `  ✓ ${event.message ?? 'ready'}\n`;
  }
  if (event.kind === 'error') {
    return `  ✗ ${event.message}\n`;
  }
  // progress
  const parts: string[] = [];
  if (event.message !== undefined) parts.push(event.message);
  if (typeof event.ratio === 'number') {
    parts.push(`${Math.round(event.ratio * 100)}%`);
  }
  if (typeof event.loadedBytes === 'number' && typeof event.totalBytes === 'number') {
    parts.push(`(${formatBytes(event.loadedBytes)} / ${formatBytes(event.totalBytes)})`);
  }
  return `  ${parts.join('  ')}\n`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const adaptersCommand: Command = {
  kind: 'group',
  name: 'adapters',
  description:
    'Manage adapter lifecycle (prepare / warmup). Read-side lives on `kindgi providers`.',
  subcommands: [prepareCmd],
};
