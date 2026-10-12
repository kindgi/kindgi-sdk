// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A render worker: renders each template it's sent with the same engine,
 * the same charging and the same bounds as a render on the server's own
 * thread, and answers with the output or the failure `renderInstructions`
 * would report. Its renders are charged to no tenant's budget here: the
 * pool charges them, on the server's thread.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { configureTenantInputBounds } from '@kindgi/bounds';

import { renderTenantTemplate } from '../liquid.js';
import { renderFailure } from '../prompt.js';

import type { RenderReply, RenderRequest, RenderWorkerData } from './messages.js';

const port = parentPort;
if (port === null) throw new Error('The render worker runs in a worker thread.');

configureTenantInputBounds((workerData as RenderWorkerData).bounds);

port.on('message', (request: RenderRequest) => {
  port.postMessage(render(request));
});

function render({ id, template, scope }: RenderRequest): RenderReply {
  try {
    return { id, rendered: renderTenantTemplate(template, scope) };
  } catch (cause) {
    const failure = renderFailure(cause);
    return {
      id,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.code === 'missing-parameter' &&
          failure.parameterName !== undefined && { parameterName: failure.parameterName }),
      },
    };
  }
}
