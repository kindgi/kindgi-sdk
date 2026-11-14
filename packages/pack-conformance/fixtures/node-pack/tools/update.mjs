// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.update',
  description: 'Adds a text as a version of a file, and answers what the update answered.',
  version: '1.0.0',
  updatesFiles: true,
  input: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      expectedVersion: { type: 'integer', minimum: 1 },
      name: { type: 'string' },
      contentType: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['fileId', 'expectedVersion', 'contentType', 'text'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { updated: { type: 'boolean' }, answer: { type: 'object' } },
    required: ['updated'],
  },
  effects: [],
  handler: async (input, ctx) => {
    // No update: the call came from a runtime before pack protocol 2.13.0, or has no
    // idempotency key.
    if (ctx.files?.update === undefined) return { updated: false };
    const answer = await ctx.files.update({
      fileId: input.fileId,
      expectedVersion: input.expectedVersion,
      ...(input.name !== undefined && { name: input.name }),
      contentType: input.contentType,
      bytes: new TextEncoder().encode(input.text),
    });
    return { updated: true, answer };
  },
};
