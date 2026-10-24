// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A stand-in render worker for the pool's tests: a child process that
// renders nothing, and does what each template's name asks, so a test can
// make a worker that never answers, runs out of heap, crashes or stops.

const send = process.send.bind(process);

// The pool's first message is the bounds; every one after is a render. This
// stand-in renders by name, so it needs no bounds — it just says it's ready.
let configured = false;
process.on('message', (message) => {
  if (!configured) {
    configured = true;
    send({ ready: true });
    return;
  }
  const { id, template, scope } = message;
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
    send({
      id,
      error: { code: 'render-failure', message: 'Template render failed: as asked' },
    });
    return;
  }
  if (template.startsWith('busy:')) {
    const until = Date.now() + Number(template.slice('busy:'.length));
    while (Date.now() < until) {}
  }
  send({ id, rendered: `${template}${scope.suffix ?? ''}` });
});
