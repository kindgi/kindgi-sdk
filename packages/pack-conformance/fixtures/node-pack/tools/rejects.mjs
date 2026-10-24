// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The pack imports nothing, so the refusal is an error with the refusal's
// code and the connection's name, which counts as `ConnectionRejectedError`
// does.
export default {
  id: 'conformance.rejects',
  description: 'Says the app refused the connection mail, or wraps that refusal.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  needsSpec: {
    connections: { mail: { app: 'google', permissions: ['gmail.send'], as: 'person' } },
  },
  handler: async (input) => {
    const refused = Object.assign(new Error('refused'), {
      code: 'connection-rejected',
      connection: 'mail',
    });
    if (input.wrapped === true) throw new Error('send failed', { cause: refused });
    throw refused;
  },
};
