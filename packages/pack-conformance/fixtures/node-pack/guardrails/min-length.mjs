// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Like `kindgi init`'s sample: the check is a named export too, which is where the
// pack service finds `evaluate`.
export const check = {
  id: 'conformance.checks.min-length',
  evaluate: async (config, trace) => {
    const length = (trace.output ?? '').trim().length;
    const min = config.minLength ?? 1;
    return length >= min ? { passed: true } : { passed: false, reason: 'too short' };
  },
};

export default {
  id: 'conformance.min-length',
  name: 'Output is long enough',
  kind: 'zero-llm',
  check,
  configSchema: {
    type: 'object',
    properties: { minLength: { type: 'integer', minimum: 0, default: 1 } },
  },
  action: { 'on-violation': 'halt' },
  severity: 'error',
};
