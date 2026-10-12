// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What the render pool and its worker threads send each other. */

import type { TenantInputBounds } from '@kindgi/bounds';

import type { TemplateRenderErrorInit } from '../template-renderer.js';

/** What a worker starts with: the bounds it renders under, the server's own. */
export interface RenderWorkerData {
  readonly bounds: TenantInputBounds;
}

/** One render, sent to a worker. */
export interface RenderRequest {
  readonly id: number;
  readonly template: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

/** A worker's answer to a render: the output, or the template's failure. */
export type RenderReply =
  | { readonly id: number; readonly rendered: string }
  | { readonly id: number; readonly error: TemplateRenderErrorInit };
