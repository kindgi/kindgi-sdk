// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Run with the built renderer's module URL as the argument, under a timezone
// and locale set unlike the machine's. Renders a date template in-process
// and in a worker and prints both as JSON. They match only when the fork
// forwards the timezone and locale to the worker; otherwise the worker, with
// an otherwise-empty environment, formats the date in a different zone.

const [entry] = process.argv.slice(2);
const { defineAgent, renderInstructions } = await import(new URL('../index.js', entry).href);
const { renderInstructionsWith } = await import(new URL('../prompt.js', entry).href);
const { createWorkerTemplateRenderer } = await import(entry);

const made = defineAgent({
  id: 'acme.assistant',
  version: '1.0.0',
  name: 'Assistant',
  instructions: 'Hello',
  capabilities: [{ needs: [{ feature: 'tool-use' }] }],
  tools: [],
  retrieval: [],
  guardrails: [],
});
if (made.kind === 'err') throw new Error(made.error.message);

// A date filter formats in the local zone (%z) and the default locale (%A, %B).
const agent = {
  ...made.value,
  instructions: '{{ "2026-10-15T08:30:00Z" | date: "%Y-%m-%d %H:%M %z — %A %d %B %Y" }}',
  parameters: [],
};

const ctx = {
  parameters: {},
  conversation: { id: 'c-1', turn: 1 },
  input: {},
  settings: {},
  clock: () => new Date('2026-10-12T00:00:00Z'),
};

const out = (r) => (r.ok ? r.value.rendered : `ERR ${r.error.code}: ${r.error.message}`);

const here = out(renderInstructions(agent, ctx));
const renderer = createWorkerTemplateRenderer({ workers: 1 });
const there = out(await renderInstructionsWith(renderer, 't', agent, ctx));
await renderer.close();

process.stdout.write(`${JSON.stringify({ here, there })}\n`);
