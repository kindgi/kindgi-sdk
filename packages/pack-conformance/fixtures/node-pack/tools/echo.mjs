// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.echo',
  description: 'Returns its message.',
  version: '1.0.0',
  input: {
    type: 'object',
    properties: { message: { type: 'string', minLength: 1 } },
    required: ['message'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  effects: [],
  handler: async (input) => ({ message: input.message }),
};
