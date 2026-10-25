// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.pause',
  description: "Pauses for another system's answer, or answers at once with its wait token's id.",
  version: '1.0.0',
  pauses: true,
  input: {
    type: 'object',
    properties: { timeoutMs: {}, name: {}, answer: { type: 'boolean' } },
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { tokenId: { type: 'string' } },
    required: ['tokenId'],
  },
  effects: [],
  handler: async (input, ctx) => {
    // Read first: with no wait token, the call fails here.
    const { id } = ctx.waitToken;
    if (input.answer === true) return { tokenId: id };
    return ctx.pause({
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      ...(input.name !== undefined && { name: input.name }),
    });
  },
};
