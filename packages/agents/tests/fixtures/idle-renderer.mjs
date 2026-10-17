// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Renders once with the built renderer (its module URL is the argument)
// and leaves it open: the process still exits once the render is done.

const [entry] = process.argv.slice(2);
const { createWorkerTemplateRenderer } = await import(entry);
const renderer = createWorkerTemplateRenderer({ workers: 2 });
const rendered = await renderer.render({
  tenantId: 't',
  template: '{{ a | upcase }}',
  scope: { a: 'done' },
});
process.stdout.write(`${rendered}\n`);
