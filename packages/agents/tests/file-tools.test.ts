// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in file tools: an agent that declares `files.update` gets
 * `kindgi_update_file`, and one that declares `files.create` gets
 * `kindgi_create_file`.
 */

import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import { CREATE_FILE_TOOL_ID, UPDATE_FILE_TOOL_ID } from '../src/file-tools.js';

describe('declaring files', () => {
  const base = {
    id: 'acme.desk',
    version: '1.0.0',
    name: 'Desk',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
  };
  const issues = (spec: Record<string, unknown>): string[] => {
    const r = defineAgent({ ...base, ...spec } as never);
    return r.kind === 'err' ? r.error.issues.map((i) => i.path) : [];
  };

  test('a valid declaration is kept as declared', () => {
    const r = defineAgent({ ...base, files: { update: true, create: false } } as never);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.files).toEqual({ update: true, create: false });
    expect(issues({ files: {} })).toEqual([]);
  });

  test('files is an object of update and create, each true or false', () => {
    expect(issues({ files: true })).toEqual(['/files']);
    expect(issues({ files: ['update'] })).toEqual(['/files']);
    expect(issues({ files: { update: 'yes' } })).toEqual(['/files/update']);
    expect(issues({ files: { create: 1 } })).toEqual(['/files/create']);
    expect(issues({ files: { updates: true } })).toEqual(['/files/updates']);
  });

  test('the built-in ids are reserved, and the refusal names the declaration', () => {
    for (const id of [UPDATE_FILE_TOOL_ID, CREATE_FILE_TOOL_ID]) {
      const r = defineAgent({
        ...base,
        tools: [{ id, version: '1.0.0' }],
        files: { update: true, create: true },
      } as never);
      expect(r.kind).toBe('err');
      if (r.kind === 'err') {
        expect(r.error.issues.map((i) => i.path)).toEqual(['/tools/0/id']);
        expect(r.error.issues[0]?.message).toContain(
          'files.update for kindgi_update_file, files.create for kindgi_create_file',
        );
      }
    }
  });
});
