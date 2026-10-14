// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What the render pool and its render workers (child processes) send each other. */

import type { TenantInputBounds } from '@kindgi/bounds';

import type { TemplateRenderErrorInit } from '../template-renderer.js';

/**
 * What a worker starts with, the pool's first message to it: the bounds it
 * renders under, the server's own. Sent over the IPC channel with
 * `serialization: 'advanced'` (not argv or env) so a limit left unset —
 * `Infinity` — reaches the worker as `Infinity`, which JSON can't carry.
 */
export interface RenderInit {
  readonly bounds: TenantInputBounds;
}

/** One render, sent to a worker. */
export interface RenderRequest {
  readonly id: number;
  readonly template: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

/** Whatever the pool sends a worker: the bounds (`RenderInit`) first, then renders. */
export type ParentMessage = RenderInit | RenderRequest;

/** A worker's answer to a render: the output, or the template's failure. */
export type RenderReply =
  | { readonly id: number; readonly rendered: string }
  | { readonly id: number; readonly error: TemplateRenderErrorInit };

/** What a worker sends once, when it has started and can take renders. */
export interface WorkerReady {
  readonly ready: true;
}

/** Whatever a worker sends. */
export type WorkerMessage = WorkerReady | RenderReply;
