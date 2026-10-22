// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A stand-in render worker for the pool's tests that won't stop on SIGTERM:
// it traps the signal and keeps running, so only SIGKILL can end it. The
// pool's close() must escalate to SIGKILL after its grace, or it would wait
// on an 'exit' that never comes. (The real worker installs no SIGTERM
// handler and exits at once; this one stands in for a worker wedged past
// stopping.) Its liveness is the IPC channel alone, so if the parent goes
// the channel closes and this exits too, rather than leaking.

const send = process.send.bind(process);

// Installed at load, before the worker says it's ready: by the time a render
// resolves, the trap is in place, so close()'s SIGTERM is reliably ignored.
process.on('SIGTERM', () => {
  /* nothing: refuse to stop on SIGTERM, so the pool must escalate to SIGKILL. */
});

let configured = false;
process.on('message', (message) => {
  if (!configured) {
    configured = true;
    send({ ready: true });
    return;
  }
  const { id, template, scope } = message;
  send({ id, rendered: `${template}${scope.suffix ?? ''}` });
});
