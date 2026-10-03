// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.defaults',
  description: 'Returns its input as the handler received it, defaults filled in.',
  version: '1.0.0',
  input: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      greeting: { type: 'string', default: 'Hello' },
      options: {
        type: 'object',
        properties: { loud: { type: 'boolean', default: false } },
        default: {},
      },
    },
    required: ['name'],
  },
  output: { type: 'object' },
  effects: [],
  handler: async (input) => input,
};
