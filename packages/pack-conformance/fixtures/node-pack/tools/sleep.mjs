// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.sleep',
  description: 'Waits `ms` milliseconds, or until the call is cancelled.',
  version: '1.0.0',
  input: {
    type: 'object',
    properties: { ms: { type: 'integer', minimum: 0 } },
    required: ['ms'],
  },
  output: { type: 'object', properties: { slept: { type: 'integer' } }, required: ['slept'] },
  effects: [],
  handler: (input, ctx) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ slept: input.ms }), input.ms);
      ctx.abortSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      });
    }),
};
