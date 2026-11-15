// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Names a built-in check: the runtime runs it, and the pack ships no check for it.
export default {
  id: 'conformance.no-guarantees',
  kind: 'zero-llm',
  check: 'forbidden-substring',
  config: { patterns: ['guaranteed', 'we promise'] },
  at: 'model-step',
  action: { 'on-violation': 'halt' },
};
