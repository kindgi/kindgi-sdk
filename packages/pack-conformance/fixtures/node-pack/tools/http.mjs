// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// A declarative HTTP tool. The indexer classifies a module as a tool by its
// `handler`, and copies `spec` onto the manifest verbatim. The suite only
// asserts the indexed `spec` — it never invokes this tool — so the handler is
// a stub, standing in for the one every SDK's `.http()` synthesizes.
export default {
  id: 'conformance.http',
  description: 'Reads a path from the example API.',
  version: '1.0.0',
  input: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  effects: [],
  spec: {
    kind: 'http',
    method: 'GET',
    urlTemplate: 'https://api.example.com/{path}',
    headers: [{ name: 'Accept', value: 'application/json' }],
    authorization: {
      kind: 'bearer',
      secretRef: { envName: 'local', name: 'API_TOKEN' },
    },
    successStatus: { min: 200, max: 299 },
  },
  handler: async () => {
    throw new Error(
      'conformance.http is declarative: the Kindgi runtime makes its request, not the SDK.',
    );
  },
};
