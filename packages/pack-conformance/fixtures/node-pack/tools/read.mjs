// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.read',
  description: 'Reads a file as text, and answers what the read answered.',
  version: '1.0.0',
  readsFiles: true,
  input: {
    type: 'object',
    properties: { artifactId: { type: 'string' } },
    required: ['artifactId'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { read: { type: 'boolean' }, answer: { type: 'object' } },
    required: ['read'],
  },
  effects: [],
  handler: async (input, ctx) => {
    // No read: the call came from a runtime before pack protocol 2.10.0.
    if (ctx.files?.read === undefined) return { read: false };
    const answer = await ctx.files.read(input.artifactId);
    if ('notRead' in answer) return { read: true, answer };
    return { read: true, answer: { text: new TextDecoder().decode(answer.bytes) } };
  },
};
