// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The pack imports nothing, so its failure is an error with `ToolFailure`'s
// brand, code and details, which counts as a `ToolFailure` does; with
// `bad: true`, its code is one the class refuses.
export default {
  id: 'conformance.fails-on-purpose',
  description: 'Fails the call on purpose: no order Z-9.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  handler: async (input) => {
    throw Object.assign(new Error('No order Z-9'), {
      [Symbol.for('kindgi.tools.tool-failure')]: true,
      code: input.bad === true ? 'Order Not Found' : 'order-not-found',
      details: { orderId: 'Z-9' },
    });
  },
};
