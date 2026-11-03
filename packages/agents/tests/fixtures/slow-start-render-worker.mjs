// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The stand-in render worker, slow to start: it blocks for half a second
// before it loads, as a worker can on a busy machine.

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
await import('./fake-render-worker.mjs');
