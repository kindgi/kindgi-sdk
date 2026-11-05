// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model's built-in file tools: `kindgi_update_file` adds a version to
 * a text file the turn was given, and `kindgi_create_file` makes a new
 * text file the run owns, each through the turn's file binding under the
 * call's key, offered only as the agent declares and the binding can.
 */

import type { FileUpdateAnswer } from '@kindgi/tools';
import type { ConversationId, FileValue, ProjectId, RunId, TenantId } from '@kindgi/types';
import { isTextFileType } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import { CREATE_FILE_TOOL_ID, FILE_TOOLS_VERSION, UPDATE_FILE_TOOL_ID } from '../src/file-tools.js';
import type { TurnContext } from '../src/handlers/context.js';
import { buildDispatchToolsHandler } from '../src/handlers/dispatch-tools.js';
import { type FileBinding, type FileCreateAnswer, asMessageFile } from '../src/handlers/files.js';
import {
  type CreateFileToolOutput,
  type UpdateFileToolOutput,
  withFileTools,
} from '../src/handlers/model-file-tools.js';
import type { ToolCallAuthorization } from '../src/handlers/public-types.js';
import { isReadOnlyTool } from '../src/handlers/replay.js';
import { resolveEffectiveHitlPolicy } from '../src/hitl-policy.js';
import type { Agent, AgentFilesPolicy, ConversationMessage } from '../src/types.js';
import { testNodeContext } from './node-context.js';

const tenantId = 't-1' as TenantId;
const projectId = 'p-1' as ProjectId;
const conversationId = 'conv-1' as ConversationId;

const sha = (n: number) => n.toString(16).padStart(64, '0');

/** Version `version` of the file `f_1`, `notes.md`. */
function notes(version: number, extra: Partial<FileValue> = {}): FileValue {
  return {
    type: 'kindgi.file',
    artifactId: `art-${version}`,
    fileId: 'f_1',
    version,
    name: 'notes.md',
    contentType: 'text/markdown',
    size: 5,
    sha256: sha(version),
    ...extra,
  };
}

const NEW_FILE: FileValue = {
  type: 'kindgi.file',
  artifactId: 'art-new',
  fileId: 'f_9',
  version: 1,
  name: 'summary.md',
  contentType: 'text/markdown',
  size: 4,
  sha256: sha(9),
};

interface Turn {
  readonly updates: { readonly call: unknown; readonly file: unknown }[];
  readonly creates: { readonly call: unknown; readonly file: unknown }[];
  readonly asked: readonly { readonly toolId: string; readonly toolVersion?: string }[];
  readonly stored: ConversationMessage[];
  readonly definitions: readonly { readonly name: string; readonly description?: string }[];
}

/** One model step that calls `name` with `args`, through dispatch-tools. */
async function fileTurn(options: {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly policy?: AgentFilesPolicy;
  /** The binding's answers; `false` for a turn with no file store. */
  readonly binding?:
    | false
    | { readonly update?: FileUpdateAnswer | false; readonly create?: FileCreateAnswer | false };
  /** The turn's own message's files. */
  readonly given?: readonly FileValue[];
  /** Files on earlier messages, as the history reads them. */
  readonly history?: readonly FileValue[];
  /** Files on a tool result earlier in this turn. */
  readonly appended?: readonly FileValue[];
  readonly stepScope?: string | false;
  readonly authorize?: () => Promise<ToolCallAuthorization>;
}): Promise<Turn> {
  const updates: Turn['updates'] = [];
  const creates: Turn['creates'] = [];
  const asked: { toolId: string; toolVersion?: string }[] = [];
  const stored: ConversationMessage[] = [];
  const agent = {
    id: 'acme.desk',
    version: '1.2.0',
    tools: [],
    files: options.policy ?? { update: true, create: true },
  } as unknown as Agent;
  const answers = options.binding === false ? undefined : (options.binding ?? {});
  const binding: FileBinding | undefined =
    answers === undefined
      ? undefined
      : {
          admit: async (values) => values.map((v) => asMessageFile(v)),
          read: async () => undefined,
          readSource: async () => ({ notRead: 'rule' }),
          store: async () => ({ notStored: 'storage' }),
          shown: async () => {},
          refuse: async () => {},
          ...(answers.update !== false && {
            update: async (call, file) => {
              updates.push({ call, file });
              return answers.update ?? { file: notes(3) };
            },
          }),
          ...(answers.create !== false && {
            create: async (call, file) => {
              creates.push({ call, file });
              return answers.create ?? { file: NEW_FILE };
            },
          }),
        };
  const message = (files: readonly FileValue[], sequence: number) =>
    ({
      id: `msg-${sequence}`,
      sequence,
      role: 'user',
      content: 'Here.',
      files,
    }) as unknown as ConversationMessage;
  const ctx = {
    input: { tenantId, projectId, conversationId, agent },
    bindings: {
      conversationBinding: {
        readMessages: async () => ({
          kind: 'ok',
          value: options.history === undefined ? [] : [message(options.history, 1)],
        }),
        appendMessage: async (m: Record<string, unknown>) => {
          const kept = {
            id: `msg-${stored.length + 10}`,
            sequence: stored.length + 10,
            createdAt: '2026-11-05T10:00:00.000Z',
            ...m,
          } as unknown as ConversationMessage;
          stored.push(kept);
          return { kind: 'ok', value: kept };
        },
      },
      ...(options.authorize !== undefined && {
        authorizeToolCall: async (input: {
          readonly toolId: string;
          readonly toolVersion?: string;
        }) => {
          asked.push({
            toolId: input.toolId,
            ...(input.toolVersion !== undefined && { toolVersion: input.toolVersion }),
          });
          return (options.authorize as () => Promise<ToolCallAuthorization>)();
        },
      }),
    },
    userMessage: message(options.given ?? [], 5),
    turnAbort: new AbortController(),
    appended: options.appended === undefined ? [] : [message(options.appended, 6)],
    usage: { steps: 1, promptTokens: 0, completionTokens: 0, totalCostUsd: 0 },
    hitlPolicy: resolveEffectiveHitlPolicy({ tenant: undefined, agent }),
    initialMessageCount: 0,
    ...(binding !== undefined && { files: binding }),
  } as unknown as TurnContext;
  ctx.tools = withFileTools(ctx, { definitions: [], byName: new Map() });

  await buildDispatchToolsHandler(ctx)(
    {
      step: 1,
      finishReason: 'tool-use',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-7', name: options.name, arguments: options.args }],
      },
      iterationUsage: { promptTokens: 0, completionTokens: 0 },
      provider: { id: 'p', model: 'm' },
      nextMessages: [],
    },
    testNodeContext({
      runId: 'run-42' as RunId,
      ...(options.stepScope !== false && { stepScope: options.stepScope ?? 'step-1' }),
    }),
  );
  return { updates, creates, asked, stored, definitions: ctx.tools.definitions };
}

const toolMessage = (turn: Turn) => turn.stored.find((m) => m.role === 'tool');
const outputOf = (turn: Turn) =>
  toolMessage(turn)?.content as unknown as UpdateFileToolOutput & CreateFileToolOutput;

const TEXT = '# Notes\nmore';
const BYTES = new TextEncoder().encode(TEXT);

describe('which file tools a turn offers', () => {
  test('each as the agent declares, when the binding can, named in its own description', async () => {
    const turn = await fileTurn({ name: 'none', args: {} });
    expect(turn.definitions.map((d) => d.name)).toEqual([UPDATE_FILE_TOOL_ID, CREATE_FILE_TOOL_ID]);
    expect(turn.definitions[0]?.description).toMatch(
      /^Use kindgi_update_file to change a text file/,
    );
    expect(turn.definitions[1]?.description).toMatch(
      /^Use kindgi_create_file to make a new text file/,
    );
    const names = async (options: Parameters<typeof fileTurn>[0]) =>
      (await fileTurn(options)).definitions.map((d) => d.name);
    expect(await names({ name: 'none', args: {}, policy: { update: true } })).toEqual([
      UPDATE_FILE_TOOL_ID,
    ]);
    expect(
      await names({ name: 'none', args: {}, policy: { create: true, update: false } }),
    ).toEqual([CREATE_FILE_TOOL_ID]);
    expect(await names({ name: 'none', args: {}, policy: {} })).toEqual([]);
    // A binding that adds no versions, or no file store at all.
    expect(await names({ name: 'none', args: {}, binding: { update: false } })).toEqual([
      CREATE_FILE_TOOL_ID,
    ]);
    expect(await names({ name: 'none', args: {}, binding: false })).toEqual([]);
  });

  test("a model that calls one it isn't offered writes nothing", async () => {
    const turn = await fileTurn({
      name: UPDATE_FILE_TOOL_ID,
      args: { fileId: 'f_1', expectedVersion: 2, content: TEXT },
      given: [notes(2)],
      policy: { create: true },
    });
    expect(turn.updates).toEqual([]);
  });

  test('both change files: mutating, writing files, so never run live on a replay', async () => {
    const ctx = {
      input: {
        agent: { id: 'acme.desk', version: '1.0.0', files: { update: true, create: true } },
      },
      files: {
        update: async () => ({ notUpdated: 'rule' }),
        create: async () => ({ notCreated: 'denied' }),
      },
    } as unknown as TurnContext;
    const tools = withFileTools(ctx, { definitions: [], byName: new Map() });
    for (const id of [UPDATE_FILE_TOOL_ID, CREATE_FILE_TOOL_ID]) {
      const entry = tools.byName.get(id);
      expect(entry).toMatchObject({ resolvedVersion: FILE_TOOLS_VERSION, requestedRange: '1.0.0' });
      expect(entry?.tool).toMatchObject({
        mutating: true,
        effects: [{ kind: 'writes', resource: 'files' }],
      });
      expect(isReadOnlyTool(entry?.tool as never)).toBe(false);
    }
  });
});

describe('kindgi_update_file', () => {
  const update = (more: Partial<Parameters<typeof fileTurn>[0]> = {}) =>
    fileTurn({
      name: UPDATE_FILE_TOOL_ID,
      args: { fileId: 'f_1', expectedVersion: 2, content: TEXT },
      given: [notes(2)],
      ...more,
    });

  test("adds a version under the call's key, keeping the given version's type; the new one is the result's file", async () => {
    const turn = await update();
    expect(turn.updates).toEqual([
      {
        call: { callKey: expect.any(String), toolId: UPDATE_FILE_TOOL_ID },
        file: { fileId: 'f_1', expectedVersion: 2, contentType: 'text/markdown', bytes: BYTES },
      },
    ]);
    expect(outputOf(turn)).toEqual({ status: 'updated' });
    // The new version is admitted as the result's file, so the next call shows it.
    expect(toolMessage(turn)?.files).toEqual([notes(3)]);
    // The same call again is keyed the same: a re-run answers its first version.
    const again = await update();
    expect((again.updates[0]?.call as { callKey: string }).callKey).toBe(
      (turn.updates[0]?.call as { callKey: string }).callKey,
    );
  });

  test("a version given in this turn's results or the history counts; one never given is not-in-run", async () => {
    expect((await update({ given: [], appended: [notes(2)] })).updates).toHaveLength(1);
    expect((await update({ given: [], history: [notes(2)] })).updates).toHaveLength(1);
    // Another version of the same file, or none at all: nothing is sent.
    for (const more of [{ given: [notes(1)] }, { given: [] }]) {
      const turn = await update(more);
      expect(turn.updates).toEqual([]);
      expect(outputOf(turn)).toEqual({
        status: 'not-in-run',
        reason:
          'That is not a version of a file you were given in this conversation. Use the id and version from its line.',
      });
    }
  });

  test('only a text file, and at most 1 MiB of text; nothing is sent for either', async () => {
    const pdf = await update({ given: [notes(2, { contentType: 'application/pdf' })] });
    expect([pdf.updates, outputOf(pdf).status]).toEqual([[], 'not-text']);
    const big = await update({
      args: { fileId: 'f_1', expectedVersion: 2, content: 'é'.repeat(524_289) },
    });
    expect([big.updates, outputOf(big).status]).toEqual([[], 'too-large']);
    expect(outputOf(big).reason).toBe('The text is over 1048576 bytes.');
  });

  test('same and conflict answer Latest as the file, with why', async () => {
    const same = await update({ binding: { update: { same: notes(2) } } });
    expect(outputOf(same)).toEqual({
      status: 'same',
      reason: 'The text is the latest version already, so nothing changed.',
    });
    expect(toolMessage(same)?.files).toEqual([notes(2)]);
    const conflict = await update({ binding: { update: { conflict: notes(4) } } });
    expect(outputOf(conflict).status).toBe('conflict');
    expect(outputOf(conflict).reason).toMatch(
      /^The file has a later version than the one you read/,
    );
    expect(toolMessage(conflict)?.files).toEqual([notes(4)]);
  });

  test.each([
    ['rule', 'not-in-run'],
    ['denied', 'not-allowed'],
    ['gone', 'gone'],
    ['type', 'not-text'],
    ['size', 'too-large'],
    ['storage', 'not-stored'],
  ] as const)("the binding's %s is %s", async (notUpdated, status) => {
    const turn = await update({ binding: { update: { notUpdated } } });
    expect(outputOf(turn).status).toBe(status);
    expect(typeof outputOf(turn).reason).toBe('string');
    expect(toolMessage(turn)?.files).toBeUndefined();
  });

  test("authorizeToolCall is asked under the built-in's id and version; a denied call writes nothing", async () => {
    const allowed = await update({ authorize: async () => ({ allowed: true }) });
    expect(allowed.asked).toEqual([
      { toolId: UPDATE_FILE_TOOL_ID, toolVersion: FILE_TOOLS_VERSION },
    ]);
    expect(allowed.updates).toHaveLength(1);
    const denied = await update({
      authorize: async () => ({ allowed: false, reason: 'Not for you.' }),
    });
    expect(denied.updates).toEqual([]);
    expect(outputOf(denied)).toEqual({ status: 'denied', reason: 'Not for you.' });
  });

  test("a call with no key fails as a tool's throw does, before it writes", async () => {
    await expect(update({ stepScope: false })).rejects.toThrow(
      'kindgi_update_file has no key for its call, so it writes nothing',
    );
  });
});

describe('kindgi_create_file', () => {
  const create = (
    args: Record<string, unknown>,
    more: Partial<Parameters<typeof fileTurn>[0]> = {},
  ) => fileTurn({ name: CREATE_FILE_TOOL_ID, args, ...more });

  test("makes version 1 under the call's key, text/plain unless a text type is given", async () => {
    const plain = await create({ name: 'summary.md', content: TEXT });
    expect(plain.creates).toEqual([
      {
        call: { callKey: expect.any(String), toolId: CREATE_FILE_TOOL_ID },
        file: { name: 'summary.md', contentType: 'text/plain', bytes: BYTES },
      },
    ]);
    expect(outputOf(plain)).toEqual({ status: 'created' });
    expect(toolMessage(plain)?.files).toEqual([NEW_FILE]);
    const csv = await create({ name: 'rows.csv', content: 'a,b', contentType: 'text/csv' });
    expect((csv.creates[0]?.file as { contentType: string }).contentType).toBe('text/csv');
  });

  test('a type that is not text, or more than 1 MiB of text, makes nothing and sends nothing', async () => {
    const png = await create({ name: 'a.png', content: 'x', contentType: 'image/png' });
    expect([png.creates, outputOf(png).status]).toEqual([[], 'not-text']);
    const big = await create({ name: 'big.txt', content: 'x'.repeat(1_048_577) });
    expect([big.creates, outputOf(big).status]).toEqual([[], 'too-large']);
  });

  test.each([
    ['denied', 'not-allowed'],
    ['type', 'not-text'],
    ['size', 'too-large'],
    ['storage', 'not-stored'],
  ] as const)("the binding's %s is %s", async (notCreated, status) => {
    const turn = await create(
      { name: 'a.txt', content: 'x' },
      { binding: { create: { notCreated } } },
    );
    expect(outputOf(turn).status).toBe(status);
    expect(toolMessage(turn)?.files).toBeUndefined();
  });
});

describe('isTextFileType', () => {
  test('text/*, JSON, XML, YAML and their suffixes, in any case, parameters aside', () => {
    for (const type of [
      'text/plain',
      'text/markdown',
      'text/csv',
      'TEXT/HTML; charset=utf-8',
      'application/json',
      'application/xml',
      'application/yaml',
      'application/ld+json',
      'image/svg+xml',
      'application/vnd.acme+yaml',
    ]) {
      expect([type, isTextFileType(type)]).toEqual([type, true]);
    }
    for (const type of [
      'application/pdf',
      'image/png',
      'application/octet-stream',
      'text',
      '',
      'text/',
    ]) {
      expect([type, isTextFileType(type)]).toEqual([type, false]);
    }
  });
});
