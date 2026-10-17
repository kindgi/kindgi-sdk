// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A stand-in render worker that reports how it was forked instead of
// rendering: the environment it can see and its Node flags. The pool's fork
// must give it only the server's timezone and locale — never the rest of the
// server's environment (its database URLs, KMS settings and tokens) nor the
// server's flags; this is what the isolation test reads back.

const send = process.send.bind(process);

let configured = false;
process.on('message', (message) => {
  if (!configured) {
    configured = true;
    send({ ready: true });
    return;
  }
  send({
    id: message.id,
    rendered: JSON.stringify({
      envKeys: Object.keys(process.env),
      marker: process.env.KINDGI_RENDER_WORKER_MARKER ?? null,
      execArgv: process.execArgv,
    }),
  });
});
