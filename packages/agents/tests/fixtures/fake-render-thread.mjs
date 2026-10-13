// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A stand-in render worker for the pool's tests: it renders nothing, and
// does what each template's name asks, so a test can make a worker that
// never answers, runs out of heap, crashes or stops.

import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, template, scope }) => {
  if (template === 'spin') {
    for (;;) {}
  }
  if (template === 'grow') {
    const kept = [];
    for (;;) kept.push(new Array(100_000).fill(kept.length));
  }
  if (template === 'crash') throw new Error('the worker crashed');
  if (template === 'exit') process.exit(3);
  if (template === 'fail') {
    parentPort.postMessage({
      id,
      error: { code: 'render-failure', message: 'Template render failed: as asked' },
    });
    return;
  }
  if (template.startsWith('busy:')) {
    const until = Date.now() + Number(template.slice('busy:'.length));
    while (Date.now() < until) {}
  }
  parentPort.postMessage({ id, rendered: `${template}${scope.suffix ?? ''}` });
});
parentPort.postMessage({ ready: true });
