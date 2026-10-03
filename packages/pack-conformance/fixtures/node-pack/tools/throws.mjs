// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.throws',
  description: 'Always fails.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  handler: async () => {
    throw new Error('boom');
  },
};
