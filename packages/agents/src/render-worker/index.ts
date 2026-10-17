// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/agents/render-worker`: a `TemplateRenderer` that renders turns'
 * instructions in child processes, for a server that runs many tenants'
 * agents. A subpath of its own, kept out of the main entry: it's for Node
 * only, and it starts its workers from a file next to its module, which an
 * app's bundler can't follow.
 */

import {
  WorkerPool,
  type WorkerTemplateRenderer,
  type WorkerTemplateRendererOptions,
} from './pool.js';

export { RENDERER_CLOSED, STOP_MARGIN_MS } from './pool.js';
export type { WorkerTemplateRenderer, WorkerTemplateRendererOptions } from './pool.js';

/**
 * A renderer for `InvokeAgentBindings`' `templateRenderer`, with
 * `options.workers` child processes that start now. Make it once the
 * server's bounds are set (`configureTenantInputBounds`): its workers
 * render under them. Each render runs as `renderInstructions` would
 * in-process (the same output, the same failures), and:
 * - a render past `renderLimitMs` (plus `STOP_MARGIN_MS`) has its worker
 *   stopped and fails with the limit's message, wherever liquidjs is in
 *   it, so no template holds up the server's own thread;
 * - a render past `options.maxOldSpaceMb` fails with the memory limit's
 *   message;
 * - a stopped worker is replaced when a render next needs one;
 * - renders wait their turn by tenant: the waiting tenants take turns;
 * - each counts toward the tenant's render budget from when a worker takes
 *   it.
 *
 * `close()` it at shutdown: idle workers don't keep the process running,
 * but a render in flight does.
 */
export function createWorkerTemplateRenderer(
  options: WorkerTemplateRendererOptions,
): WorkerTemplateRenderer {
  return new WorkerPool(new URL('./child.js', import.meta.url), options);
}
