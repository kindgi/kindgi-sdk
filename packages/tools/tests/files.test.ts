// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tool that stores the files it fetches: what it declares, what its
 * handler gets, and what defineTool refuses.
 */

import { describe, expect, expectTypeOf, test } from 'vitest';
import * as z from 'zod';

import type { ToolId } from '@kindgi/types';

import { MAX_STORED_FILES_PER_CALL, changedToolFields, defineTool } from '../src/index.js';
import type { FileStore, FileStoreAnswer, ToolContext, ToolManifest } from '../src/index.js';

const Fetch = z.object({ attachmentId: z.string() });
const Fetched = z.object({ files: z.array(z.unknown()).optional() });

describe('defineTool with storesFiles', () => {
  test('the handler may get a file store; the manifest says the tool stores files', () => {
    const r = defineTool({
      id: 'acme.mail.attachment-get' as ToolId,
      description: "Fetches a mail's attachment.",
      version: '1.0.0',
      input: Fetch,
      output: Fetched,
      storesFiles: true,
      handler: async (_input, c) => {
        expectTypeOf(c.files).toEqualTypeOf<FileStore | undefined>();
        if (c.files?.store === undefined) return {};
        const answer = await c.files.store({
          name: 'invoice.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array(),
        });
        expectTypeOf(answer).toEqualTypeOf<FileStoreAnswer>();
        return 'file' in answer ? { files: [answer.file] } : {};
      },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.storesFiles).toBe(true);
  });

  test.each([
    ['an MCP transport', { transport: 'mcp' as const, handler: async () => ({}) }],
    [
      'a declarative spec',
      {
        spec: {
          kind: 'http' as const,
          method: 'GET' as const,
          urlTemplate: 'https://mail.acme.example/attachments/{attachmentId}',
        },
      },
    ],
  ])("a tool with %s can't store files", (_label, extra) => {
    const r = defineTool({
      id: 'acme.mail.remote' as ToolId,
      description: 'A tool the pack does not run.',
      version: '1.0.0',
      input: Fetch,
      output: Fetched,
      storesFiles: true,
      ...extra,
    } as unknown as Parameters<typeof defineTool>[0]);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') {
      expect(r.error.code).toBe('invalid-tool-definition');
      expect(r.error.message).toContain("can't store files");
    }
  });

  test('a call stores at most 10 files', () => {
    expect(MAX_STORED_FILES_PER_CALL).toBe(10);
  });

  test("storesFiles is part of the tool's definition: a change takes a new version", () => {
    const manifest = {
      id: 'acme.mail.attachment-get',
      description: "Fetches a mail's attachment.",
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
    } as unknown as ToolManifest;
    expect(changedToolFields(manifest, { ...manifest, storesFiles: true })).toEqual([
      'storesFiles',
    ]);
  });

  test('a context without a store is a valid context', () => {
    expectTypeOf<ToolContext['files']>().toEqualTypeOf<FileStore | undefined>();
  });
});
