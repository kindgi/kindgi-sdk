// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.process-env',
  description: 'Returns the names of the KINDGI_ variables in its process environment.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  handler: async () => ({
    names: Object.keys(process.env)
      .filter((name) => name.startsWith('KINDGI_'))
      .sort(),
  }),
};
