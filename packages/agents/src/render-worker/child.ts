// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A render worker: a child process that renders each template it's sent
 * with the same engine, the same charging and the same bounds as a render
 * on the server's own thread, and answers with the output or the failure
 * `renderInstructions` would report. Its renders are charged to no tenant's
 * budget here: the pool charges them, on the server's thread.
 */

import { configureTenantInputBounds } from '@kindgi/bounds';

import { renderTenantTemplate } from '../liquid.js';
import { renderFailure } from '../prompt.js';

import type {
  ParentMessage,
  RenderInit,
  RenderReply,
  RenderRequest,
  WorkerReady,
} from './messages.js';

const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error('The render worker runs as a child process with an IPC channel.');
}

// The pool's first message is the bounds (`RenderInit`); every one after is a render.
let configured = false;
process.on('message', (message: ParentMessage) => {
  if (!configured) {
    configureTenantInputBounds((message as RenderInit).bounds);
    configured = true;
    // Started: the pool sends renders from now on, and times them from when it does.
    send({ ready: true } satisfies WorkerReady);
    return;
  }
  send(render(message as RenderRequest));
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
