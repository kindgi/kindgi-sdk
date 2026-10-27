// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.store',
  description: 'Stores a text as a file, and answers what the store answered.',
  version: '1.0.0',
  storesFiles: true,
  input: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      contentType: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['name', 'contentType', 'text'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { stored: { type: 'boolean' }, answer: { type: 'object' } },
    required: ['stored'],
  },
  effects: [],
  handler: async (input, ctx) => {
    // No store: the call came from a runtime before pack protocol 2.10.0, or has no
    // idempotency key.
    if (ctx.files?.store === undefined) return { stored: false };
    const answer = await ctx.files.store({
      name: input.name,
      contentType: input.contentType,
      bytes: new TextEncoder().encode(input.text),
    });
    return { stored: true, answer };
  },
};
