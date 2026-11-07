// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Its steps form a cycle: a -> b -> a.
export default {
  id: 'conformance.cycle-flow',
  version: '1.0.0',
  nodes: [
    { id: 'a', kind: 'tool', ref: 'conformance.echo' },
    { id: 'b', kind: 'tool', ref: 'conformance.echo' },
  ],
  edges: [
    { id: 'e-start', from: '$start', to: 'a' },
    { id: 'e-a-b', from: 'a', to: 'b' },
    { id: 'e-b-a', from: 'b', to: 'a' },
    { id: 'e-end', from: 'b', to: '$end' },
  ],
};
