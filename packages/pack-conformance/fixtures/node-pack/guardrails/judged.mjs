// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The runtime judges an llm-judge guardrail with a model, by its `config`; it never calls this check.
export const check = {
  id: 'conformance.checks.judged',
  evaluate: async () => ({ passed: true }),
};

export default {
  id: 'conformance.judged',
  kind: 'llm-judge',
  check,
  config: { rubric: 'The reply answers the message.', responseFormat: 'pass-fail' },
  judgeCapabilities: { needs: [{ feature: 'structured-output' }] },
  action: { 'on-violation': 'log-only' },
};
