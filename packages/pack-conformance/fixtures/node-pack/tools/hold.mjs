// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { existsSync } from 'node:fs';

export default {
  id: 'conformance.hold',
  description:
    'Prints `hold: <release>` on stdout, then waits until the file `release` exists, or until the call is cancelled.',
  version: '1.0.0',
  input: {
    type: 'object',
    properties: { release: { type: 'string', minLength: 1 } },
    required: ['release'],
  },
  output: {
    type: 'object',
    properties: { released: { type: 'boolean' } },
    required: ['released'],
  },
  effects: [],
  handler: (input, ctx) =>
    new Promise((resolve, reject) => {
      console.log(`hold: ${input.release}`);
      const timer = setInterval(() => {
        if (!existsSync(input.release)) return;
        clearInterval(timer);
        resolve({ released: true });
      }, 10);
      ctx.abortSignal.addEventListener('abort', () => {
        clearInterval(timer);
        reject(new Error('cancelled'));
      });
    }),
};
