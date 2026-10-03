// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export const check = {
  id: 'conformance.checks.throws',
  evaluate: async () => {
    throw new Error('check boom');
  },
};

export default {
  id: 'conformance.check-throws',
  kind: 'zero-llm',
  check,
  action: { 'on-violation': 'log-only' },
};
