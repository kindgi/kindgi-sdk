// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  DOCUMENT_FILE_TYPES,
  type FileValue,
  IMAGE_FILE_TYPES,
  type MessageFile,
  type ModelInfo,
  type ModelMessage,
  filesForCall,
  isFileValue,
} from '@kindgi/capabilities';

import type { Agent } from '../types.js';

import type { TurnContext } from './context.js';

/**
 * The turn's stored files: which file values its model may be shown, and
 * their bytes. The runtime binds one per turn, so it knows the turn's run,
 * the run's root and its conversation. Absent: a tool result's file values
 * stay plain JSON, and a history message's files are `store` lines.
 */
export interface FileBinding {
  /**
   * The run's rule for each value, in order: the file to carry, with its
   * name, type, size, sha256 and pages from the runtime's own record of it,
   * never from the value. `notShown: 'gone'` when the file is deleted, or
   * `'changed'` when the value's sha256 isn't the record's. `undefined` when
   * the rule doesn't let the turn show it: the value stays plain JSON.
   */
  admit(values: readonly FileValue[]): Promise<readonly (MessageFile | undefined)[]>;
  /**
   * A file's bytes, read for one model call (`ModelCallInput.readFile`),
   * after the same rule is asked again. `undefined` when it's gone or the
   * rule refuses it.
   */
  read(artifactId: string): Promise<Uint8Array | undefined>;
}

/**
 * Whether the agent's model is shown images and PDFs: the capability its
 * turn routes (the first) needs `vision`. Text files are read in for any
 * agent.
 */
export function agentSeesFiles(agent: Pick<Agent, 'capabilities'>): boolean {
  return (
    agent.capabilities[0]?.needs.some((need) => 'feature' in need && need.feature === 'vision') ??
    false
  );
}

/**
 * The messages as one model call gets them. For an agent that doesn't need
 * `vision`, each image and PDF not already marked is `notShown: 'model'`, so
 * the model reads a line naming it, as an agent did before files. Only the
 * call's copy is marked: the journal and the conversation keep the plain
 * reference, and a later version of the agent that needs `vision` is shown
 * the file.
 */
export function messagesForCall(
  messages: readonly ModelMessage[],
  seesFiles: boolean,
): readonly ModelMessage[] {
  if (seesFiles) return messages;
  return messages.map((message) =>
    message.files === undefined || !message.files.some(isUnseen)
      ? message
      : { ...message, files: message.files.map((file) => (isUnseen(file) ? unseen(file) : file)) },
  );
}

/**
 * The stored files a call to `model` reads from its messages: the images
 * and PDFs that fit the call's limits, for a model that declares `vision`,
 * and the text files. The adapter decides the same way, with its
 * provider's own limits too, so it may read fewer.
 */
export function callFiles(
  messages: readonly ModelMessage[],
  model: Pick<ModelInfo, 'features' | 'contextWindow'>,
): readonly MessageFile[] {
  const vision = model.features.includes('vision');
  return filesForCall(messages, {
    images: vision,
    documents: vision,
    contextWindow: model.contextWindow,
  });
}

/** An image or a PDF with no reason yet not to be shown. */
function isUnseen(file: MessageFile): boolean {
  return (
    file.notShown === undefined &&
    ((IMAGE_FILE_TYPES as readonly string[]).includes(file.contentType) ||
      (DOCUMENT_FILE_TYPES as readonly string[]).includes(file.contentType))
  );
}

function unseen(file: MessageFile): MessageFile {
  return { ...file, notShown: 'model' };
}

/** A file the turn admitted, as the value a conversation keeps. */
export function asFileValue(file: MessageFile): FileValue {
  return { type: 'kindgi.file', ...file };
}

/**
 * The turn's input files as the user message keeps them: each one the run's
 * rule admits, with the runtime's own fields. A value the rule refuses is
 * left out. Without a binding, each value of a file value's shape is a
 * `store` line, with only a file value's fields.
 */
export async function admitInputFiles(
  ctx: TurnContext,
  values: readonly FileValue[] | undefined,
): Promise<readonly FileValue[]> {
  if (values === undefined || values.length === 0) return [];
  const binding = ctx.bindings.files;
  if (binding === undefined) {
    return values
      .filter(isFileValue)
      .map((value) => asFileValue({ ...asMessageFile(value), notShown: 'store' }));
  }
  const admitted = await binding.admit(values);
  return admitted.flatMap((file) => (file === undefined ? [] : [asFileValue(file)]));
}

/**
 * The files of earlier messages, as the turn's model may be shown them, by
 * message: the run's rule asked again, once for the whole history. A value
 * it refuses has lost the record it was admitted by (the file is deleted or
 * going), so it's a `gone` line. Without a binding, each is a `store` line.
 */
export async function admitHistoryFiles(
  ctx: TurnContext,
  byMessage: readonly (readonly FileValue[] | undefined)[],
): Promise<readonly (readonly MessageFile[])[]> {
  const values = byMessage.flatMap((files) => files ?? []);
  if (values.length === 0) return byMessage.map(() => []);
  const binding = ctx.bindings.files;
  const admitted =
    binding === undefined ? values.map(() => undefined) : await binding.admit(values);
  const files = values.map((value, i): MessageFile => {
    const file = admitted[i];
    if (file !== undefined) return file;
    return { ...asMessageFile(value), notShown: binding === undefined ? 'store' : 'gone' };
  });
  let next = 0;
  return byMessage.map((list) => {
    const taken = files.slice(next, next + (list?.length ?? 0));
    next += list?.length ?? 0;
    return taken;
  });
}

/** At most this many of a tool result's file values are admitted; the rest stay plain JSON. */
export const TOOL_RESULT_FILES = 10;

/**
 * A tool's result, split: the file values in its top-level `files` that
 * the run's rule admits (the first `TOOL_RESULT_FILES` of them), and the
 * rest of the result, as it's turned into text. A value the rule refuses,
 * one past the first ten, and anything that isn't a file value stay in the
 * result's `files`, as plain JSON. Without a binding, none is admitted.
 */
export async function admitToolResultFiles(
  ctx: TurnContext,
  result: unknown,
): Promise<{ readonly result: unknown; readonly files: readonly FileValue[] }> {
  const binding = ctx.bindings.files;
  if (binding === undefined || !hasFilesField(result)) return { result, files: [] };
  const { files: listed, ...rest } = result;
  const candidates = listed
    .map((value, at) => ({ value, at }))
    .filter((c): c is { value: FileValue; at: number } => isFileValue(c.value))
    .slice(0, TOOL_RESULT_FILES);
  if (candidates.length === 0) return { result, files: [] };
  const admitted = await binding.admit(candidates.map((c) => c.value));
  const taken = new Set(candidates.filter((_, i) => admitted[i] !== undefined).map((c) => c.at));
  const files = admitted.flatMap((file) => (file === undefined ? [] : [asFileValue(file)]));
  const left = listed.filter((_, at) => !taken.has(at));
  return { result: left.length > 0 ? { ...rest, files: left } : rest, files };
}

function hasFilesField(
  result: unknown,
): result is Readonly<Record<string, unknown>> & { readonly files: readonly unknown[] } {
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    Array.isArray((result as { readonly files?: unknown }).files)
  );
}

/** A kept file value as the file a model message carries: a file's fields only. */
export function asMessageFile(value: FileValue): MessageFile {
  const { artifactId, name, contentType, size, sha256, pages, notShown } = value;
  return {
    artifactId,
    ...(name !== undefined && { name }),
    contentType,
    size,
    sha256,
    ...(pages !== undefined && { pages }),
    ...(notShown !== undefined && { notShown }),
  };
}
