// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.bad-output',
  description: 'Returns output that breaks its own schema.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  effects: [],
  handler: async () => ({ message: 42 }),
};
