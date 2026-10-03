// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.echo-agent',
  version: '1.0.0',
  name: 'Echo agent',
  instructions: 'Call conformance.echo with the message.',
  capabilities: [{ needs: [{ feature: 'tool-use' }] }],
  tools: [{ id: 'conformance.echo', version: '1.0.0' }],
  retrieval: [],
  guardrails: ['conformance.min-length'],
};
