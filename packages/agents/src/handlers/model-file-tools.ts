// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The built-in file tools, built for each turn of an agent that declares
 * `files`: `kindgi_update_file` (`files.update`) adds a version to a text
 * file the turn was given, and `kindgi_create_file` (`files.create`) makes
 * a new text file the run owns. They dispatch like any tool (the agent's
 * `hitl.tools` policy, `authorizeToolCall`, guardrails by tool id, replay
 * and the tool error policy apply), and they're `mutating`, so an agent that
 * opts in with `hitl.tools` asks on first use, as for any mutating tool.
 * They aren't in the tool registry:
 * each writes through the turn's file binding, under the call's key, so a
 * re-run of the call answers what its first run made.
 */

import type { ModelToolDefinition } from '@kindgi/capabilities';
import { type Tool, type ToolContext, type ToolError, defineTool } from '@kindgi/tools';
import { type FileValue, type Result, type ToolId, isTextFileType } from '@kindgi/types';

import {
  CREATE_FILE_TOOL_ID,
  FILE_TOOLS_VERSION,
  MAX_MODEL_FILE_TEXT_BYTES,
  MAX_MODEL_UPDATED_FILE_BYTES,
  UPDATE_FILE_TOOL_ID,
} from '../file-tools.js';

import type { TurnContext } from './context.js';
import type { FileBinding } from './files.js';
import { readHistory } from './history.js';

/** What the model reads back from `kindgi_update_file`. */
export interface UpdateFileToolOutput {
  /**
   * `updated`: the new version, in `files`. `same`: the text is Latest's,
   * so nothing was added; Latest is in `files`. `conflict`: the file has a
   * version after the one given; Latest is in `files`, to read and update
   * instead. Otherwise nothing was added, and `reason` says why:
   * `not-text`, `too-large` (the new text is over a text file's limit, or
   * the version is longer than a model reads whole), `gone` (deleted),
   * `not-in-run` (not that version of a file the turn was given),
   * `not-allowed` (the run may not change it) or `not-stored` (no room
   * left in storage).
   */
  readonly status:
    | 'updated'
    | 'same'
    | 'conflict'
    | 'not-text'
    | 'too-large'
    | 'gone'
    | 'not-in-run'
    | 'not-allowed'
    | 'not-stored';
  readonly files?: readonly FileValue[];
  readonly reason?: string;
}

/** What the model reads back from `kindgi_create_file`. */
export interface CreateFileToolOutput {
  /**
   * `created`: the new file, version 1, in `files`. Otherwise nothing was
   * made, and `reason` says why: `not-text`, `too-large`, `not-allowed`
   * (the run may not add files where it would go) or `not-stored` (no room
   * left in storage).
   */
  readonly status: 'created' | 'not-text' | 'too-large' | 'not-allowed' | 'not-stored';
  readonly files?: readonly FileValue[];
  readonly reason?: string;
}

/** What the model sends to `kindgi_update_file`. */
interface UpdateFileArgs {
  readonly fileId: string;
  readonly expectedVersion: number;
  readonly content: string;
}

/** What the model sends to `kindgi_create_file`. */
interface CreateFileArgs {
  readonly name: string;
  readonly content: string;
  readonly contentType?: string;
}

type TurnTools = NonNullable<TurnContext['tools']>;
type Update = NonNullable<FileBinding['update']>;
type Create = NonNullable<FileBinding['create']>;

/**
 * The turn's tools, with `kindgi_update_file` and `kindgi_create_file`
 * added as the agent declares them, each only when the turn's file binding
 * can do it: a runtime with no file store offers neither.
 */
export function withFileTools(ctx: TurnContext, tools: TurnTools): TurnTools {
  const policy = ctx.input.agent.files;
  const binding = ctx.files;
  if (policy === undefined || binding === undefined) return tools;
  const update = policy.update === true ? binding.update?.bind(binding) : undefined;
  const create = policy.create === true ? binding.create?.bind(binding) : undefined;
  const added = [
    ...(update === undefined ? [] : [updateFileTool(ctx, update)]),
    ...(create === undefined ? [] : [createFileTool(create)]),
  ];
  if (added.length === 0) return tools;
  const byName = new Map(tools.byName);
  for (const tool of added) {
    byName.set(tool.id, {
      tool,
      resolvedVersion: FILE_TOOLS_VERSION,
      requestedRange: FILE_TOOLS_VERSION,
    });
  }
  const definitions = added.map(
    (tool): ModelToolDefinition => ({
      name: tool.id,
      description: tool.description,
      inputSchema: tool.input as Readonly<Record<string, unknown>>,
    }),
  );
  return { definitions: [...tools.definitions, ...definitions], byName };
}

function updateFileTool(ctx: TurnContext, update: Update): Tool {
  return built(
    defineTool<UpdateFileArgs, UpdateFileToolOutput>({
      id: UPDATE_FILE_TOOL_ID as ToolId,
      version: FILE_TOOLS_VERSION,
      description: `Use ${UPDATE_FILE_TOOL_ID} to change a text file you were given: send its id and the version you read, from the line "file <fileId> v<version>" before it, and its whole new text. It adds a version; the ones before are kept. It changes only a file of at most ${MAX_MODEL_UPDATED_FILE_BYTES} bytes, one you were shown whole.`,
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['fileId', 'expectedVersion', 'content'],
        properties: {
          fileId: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'The file\'s id, from its line "file <fileId> v<version>".',
          },
          expectedVersion: {
            type: 'integer',
            minimum: 1,
            description:
              'The version you read, from the same line. If the file has a later one, nothing changes, and you get the later one to read.',
          },
          content: {
            type: 'string',
            description: 'The whole new text of the file, not only what changes.',
          },
        },
      },
      output: outputSchema(UPDATE_STATUSES),
      mutating: true,
      effects: [{ kind: 'writes', resource: 'files' }],
      handler: (args, toolCtx) => updateFile(ctx, update, args, toolCtx),
    }),
  );
}

function createFileTool(create: Create): Tool {
  return built(
    defineTool<CreateFileArgs, CreateFileToolOutput>({
      id: CREATE_FILE_TOOL_ID as ToolId,
      version: FILE_TOOLS_VERSION,
      description: `Use ${CREATE_FILE_TOOL_ID} to make a new text file for this run: send its name and its whole text, and its type when it isn't plain text (text/markdown, text/csv, application/json and the like).`,
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'content'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'The file\'s name, with its extension (e.g. "summary.md").',
          },
          content: { type: 'string', description: 'The whole text of the file.' },
          contentType: {
            type: 'string',
            minLength: 1,
            maxLength: 127,
            description: 'A text type. Absent: text/plain.',
          },
        },
      },
      output: outputSchema(CREATE_STATUSES),
      mutating: true,
      effects: [{ kind: 'writes', resource: 'files' }],
      handler: (args, toolCtx) => createFile(create, args, toolCtx),
    }),
  );
}

const UPDATE_STATUSES = [
  'updated',
  'same',
  'conflict',
  'not-text',
  'too-large',
  'gone',
  'not-in-run',
  'not-allowed',
  'not-stored',
] as const satisfies readonly UpdateFileToolOutput['status'][];

const CREATE_STATUSES = [
  'created',
  'not-text',
  'too-large',
  'not-allowed',
  'not-stored',
] as const satisfies readonly CreateFileToolOutput['status'][];

function outputSchema(statuses: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: [...statuses] },
      files: { type: 'array', items: { type: 'object' } },
      reason: { type: 'string' },
    },
  };
}

/** The schemas are fixed here: a failure is a bug, not an input problem. */
function built<TInput, TOutput>(defined: Result<Tool<TInput, TOutput>, ToolError>): Tool {
  if (defined.kind === 'err') {
    throw new Error(`a built-in file tool failed to build: ${defined.error.message}`);
  }
  return defined.value as Tool;
}

type UpdateRefusal = Exclude<UpdateFileToolOutput['status'], 'updated' | 'same' | 'conflict'>;
type CreateRefusal = Exclude<CreateFileToolOutput['status'], 'created'>;

const TEXT_TOO_LARGE = `The text is over ${MAX_MODEL_FILE_TEXT_BYTES} bytes.`;
const NO_ROOM = 'There is no room left in storage.';

const SAME = 'The text is the latest version already, so nothing changed.';
const CONFLICT =
  "The file has a later version than the one you read; it's shown with this result. Read it, and update that version if the change still applies.";
// A version over the cut a model reads at: writing back what it read would drop the rest.
const FILE_TOO_LONG = `The file is over ${MAX_MODEL_UPDATED_FILE_BYTES} bytes, more than you may have read whole, so it can't be changed this way.`;

const UPDATE_REASONS: Readonly<Record<UpdateRefusal, string>> = {
  'not-text': 'Only a text file can be changed this way.',
  'too-large': TEXT_TOO_LARGE,
  gone: 'The file is deleted.',
  'not-in-run':
    'That is not a version of a file you were given in this conversation. Use the id and version from its line.',
  'not-allowed': 'This run may not change this file.',
  'not-stored': NO_ROOM,
};

const CREATE_REASONS: Readonly<Record<CreateRefusal, string>> = {
  'not-text': 'Only a text file can be made this way.',
  'too-large': TEXT_TOO_LARGE,
  'not-allowed': 'This run may not make files.',
  'not-stored': NO_ROOM,
};

const UPDATE_REFUSED = {
  rule: 'not-in-run',
  denied: 'not-allowed',
  gone: 'gone',
  type: 'not-text',
  size: 'too-large',
  storage: 'not-stored',
} as const;

const CREATE_REFUSED = {
  denied: 'not-allowed',
  type: 'not-text',
  size: 'too-large',
  storage: 'not-stored',
} as const;

async function updateFile(
  ctx: TurnContext,
  update: Update,
  args: UpdateFileArgs,
  toolCtx: ToolContext,
): Promise<UpdateFileToolOutput> {
  const bytes = new TextEncoder().encode(args.content);
  if (bytes.byteLength > MAX_MODEL_FILE_TEXT_BYTES) return notUpdated('too-large');
  // The version the model was given, which says the type the new one keeps.
  const given = await givenFile(ctx, args.fileId, args.expectedVersion);
  if (given === undefined) return notUpdated('not-in-run');
  if (!isTextFileType(given.contentType)) return notUpdated('not-text');
  if (given.size > MAX_MODEL_UPDATED_FILE_BYTES) return notUpdated('too-large', FILE_TOO_LONG);
  const answer = await update(callOf(toolCtx, UPDATE_FILE_TOOL_ID), {
    fileId: args.fileId,
    expectedVersion: args.expectedVersion,
    contentType: given.contentType,
    bytes,
  });
  if ('file' in answer) return { status: 'updated', files: [answer.file] };
  if ('same' in answer) return { status: 'same', files: [answer.same], reason: SAME };
  if ('conflict' in answer) {
    return { status: 'conflict', files: [answer.conflict], reason: CONFLICT };
  }
  return notUpdated(UPDATE_REFUSED[answer.notUpdated]);
}

async function createFile(
  create: Create,
  args: CreateFileArgs,
  toolCtx: ToolContext,
): Promise<CreateFileToolOutput> {
  const contentType = args.contentType ?? 'text/plain';
  if (!isTextFileType(contentType)) return notCreated('not-text');
  const bytes = new TextEncoder().encode(args.content);
  if (bytes.byteLength > MAX_MODEL_FILE_TEXT_BYTES) return notCreated('too-large');
  const answer = await create(callOf(toolCtx, CREATE_FILE_TOOL_ID), {
    name: args.name,
    contentType,
    bytes,
  });
  if ('file' in answer) return { status: 'created', files: [answer.file] };
  return notCreated(CREATE_REFUSED[answer.notCreated]);
}

function notUpdated(
  status: UpdateRefusal,
  reason: string = UPDATE_REASONS[status],
): UpdateFileToolOutput {
  return { status, reason };
}

function notCreated(status: CreateRefusal): CreateFileToolOutput {
  return { status, reason: CREATE_REASONS[status] };
}

/**
 * The call the binding keys the write by. Dispatch gives every call of a
 * step its key; without one, a re-run couldn't answer its first write, so
 * the call fails as a tool's throw does.
 */
function callOf(
  toolCtx: ToolContext,
  toolId: string,
): { readonly callKey: string; readonly toolId: string } {
  if (toolCtx.idempotencyKey === undefined) {
    throw new Error(`${toolId} has no key for its call, so it writes nothing`);
  }
  return { callKey: toolCtx.idempotencyKey, toolId };
}

/**
 * The file value of `fileId` at `version` that the turn was given, newest
 * first: in this turn's messages (a tool's result, this tool's own
 * included), then its user message, then the history its model reads.
 * `undefined` when there's none: the model may change only a version it
 * was given.
 */
async function givenFile(
  ctx: TurnContext,
  fileId: string,
  version: number,
): Promise<FileValue | undefined> {
  const named = (files: readonly FileValue[] | undefined) =>
    files?.find((file) => file.fileId === fileId && file.version === version);
  for (const message of [...ctx.appended].reverse()) {
    const found = named(message.files);
    if (found !== undefined) return found;
  }
  const own = named(ctx.userMessage?.files);
  if (own !== undefined) return own;
  for (const message of [...(await readHistory(ctx))].reverse()) {
    const found = named(message.files);
    if (found !== undefined) return found;
  }
  return undefined;
}
