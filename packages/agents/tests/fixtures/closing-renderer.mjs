// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Renders once with the built renderer (its module URL is the argument),
// then `await`s close() and prints DONE. An idle worker is unref'd, so
// close() must still settle here — otherwise this top-level `await` hangs,
// the process exits before DONE is written, and the exit code is non-zero.

const [entry] = process.argv.slice(2);
const { createWorkerTemplateRenderer } = await import(entry);
const renderer = createWorkerTemplateRenderer({ workers: 2 });
await renderer.render({ tenantId: 't', template: '{{ a | upcase }}', scope: { a: 'done' } });
await renderer.close();
process.stdout.write('DONE\n');
