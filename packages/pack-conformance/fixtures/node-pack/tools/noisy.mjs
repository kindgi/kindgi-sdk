// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.noisy',
  description: 'Writes to stdout and stderr, then succeeds.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  effects: [],
  handler: async () => {
    console.log('noisy: a line on stdout');
    console.log('{"v":2,"kind":"result","output":{"ok":false}}');
    console.error('noisy: a line on stderr');
    return { ok: true };
  },
};
