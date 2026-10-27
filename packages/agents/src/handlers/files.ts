// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  DOCUMENT_FILE_TYPES,
  type FileForm,
  type FilePlanOptions,
  IMAGE_FILE_TYPES,
  type MessageFile,
  type ModelInfo,
  type ModelMessage,
  filesForCall,
  isReadable,
} from '@kindgi/capabilities';
import { type FileValue, isFileValue } from '@kindgi/types';

import type { Agent } from '../types.js';

import type { TurnContext } from './context.js';

/**
 * Where a turn gets its stored files: one binding for the turn's run, asked
 * for once the run has its id, beside the provenance builder. A run is
 * often made only when its turn starts, so the runtime can't bind it
 * earlier.
 */
export interface FileBindings {
  /** The run's files. The runtime finds the run's root and conversation from its id. */
  forRun(run: { readonly tenantId: string; readonly runId: string }): FileBinding;
}

/**
 * One run's stored files: which file values its model may be shown, and
 * their bytes. Absent: a tool result's file values stay plain JSON, and a
 * history message's files are `store` lines.
 */
export interface FileBinding {
  /**
   * The run's rule for each value, in order: the file to carry, with its
   * name, type, size, sha256 and pages from the runtime's own record of it,
   * never from the value. `notShown: 'gone'` when the file is deleted, or
   * `'changed'` when the value's sha256 isn't the record's. `undefined` when
   * the rule doesn't let the turn show it: the value stays plain JSON.
   *
   * Without `call`, that's all: the answer is kept, as the turn's input, a
   * tool's result or a message's files. With `call`, it's one model call's
   * copy, never kept (`withFileForms`): each file also carries what the
   * runtime made of it for that call, sent in its place (`rendition`,
   * `extracted`), found or made and waited for; or it's `notShown:
   * 'reading'` while that's made, or why it isn't shown. `seesFiles`: the
   * call's model is shown images and PDFs.
   */
  admit(
    values: readonly FileValue[],
    call?: { readonly seesFiles: boolean },
  ): Promise<readonly (MessageFile | undefined)[]>;
  /**
   * A file's bytes, or a form made of it (`form`), read for one model call
   * (`ModelCallInput.readFile`), after the same rule is asked again.
   * `undefined` when it's gone, its form isn't made, or the rule refuses it.
   */
  read(artifactId: string, form?: FileForm): Promise<Uint8Array | undefined>;
  /**
   * A call that carried these files answered: its model was shown them.
   * That only decides which files a later `refuse` marks. Marking one
   * already marked changes nothing.
   */
  shown(artifactIds: readonly string[]): Promise<void>;
  /**
   * A call that carried these images and PDFs was refused as an invalid
   * request, and the same call without them answered. The runtime marks
   * the ones no answered call has shown, or all of them when each one was
   * shown before (another model refused what an earlier one read). Later
   * turns are given a marked file as `notShown: 'refused'`, so it isn't
   * sent again. Marking one already marked changes nothing.
   */
  refuse(artifactIds: readonly string[]): Promise<void>;
  /**
   * Room for one model call's files while they're in flight: each one's
   * bytes, their base64 and the request body, in the runtime's memory for
   * files. A call holds it before it reads any of them, waiting its turn
   * when there's none, and releases it once it answers or fails.
   * `undefined` when there's no room in time, or the signal aborts the
   * wait: the call is sent with a `limit` line for each of them, and a
   * later call shows them again. Absent: a call holds nothing.
   */
  hold?(files: readonly MessageFile[], signal: AbortSignal): Promise<FileHold | undefined>;
}

/** A model call's room for its files (`FileBinding.hold`). Released once. */
export interface FileHold {
  release(): void;
}

/**
 * Bind the turn's run's files (`bindings.files.forRun`), by the run's id:
 * setup does it beside the provenance builder, and a resumed turn's
 * rebuild does it again.
 */
export function bindRunFiles(ctx: TurnContext, runId: string): void {
  if (ctx.bindings.files !== undefined) {
    ctx.files = ctx.bindings.files.forRun({ runId, tenantId: ctx.input.tenantId });
  }
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
 * The messages with each file's form for one call to the turn's model
 * (`FileBinding.admit` with the call), in the call's copy only: the journal
 * and the conversation keep the plain references, so each call finds its
 * own, and a text made since an earlier call is sent. A file the rule no
 * longer admits is `gone`. Without a binding, or a file to show, the
 * messages are as they are.
 */
export async function withFileForms(
  ctx: TurnContext,
  messages: readonly ModelMessage[],
  seesFiles: boolean,
): Promise<readonly ModelMessage[]> {
  const binding = ctx.files;
  const shown = messages.flatMap((message) => message.files ?? []).filter(isShown);
  if (binding === undefined || shown.length === 0) return messages;
  const admitted = (await binding.admit(shown.map(asFileValue), { seesFiles })).values();
  return messages.map((message) =>
    message.files === undefined || !message.files.some(isShown)
      ? message
      : {
          ...message,
          files: message.files.map((file): MessageFile => {
            if (!isShown(file)) return file;
            return admitted.next().value ?? { ...file, notShown: 'gone' };
          }),
        },
  );
}

const isShown = (file: MessageFile) => file.notShown === undefined;

/**
 * The messages as one model call gets them. For an agent that doesn't need
 * `vision`, each image and PDF sent as itself, not already marked, is
 * `notShown: 'model'`, so the model reads a line naming it, as an agent did
 * before files; one with its text in its place is sent that. Only the
 * call's copy is marked: the journal and the conversation keep the plain
 * reference, and a later version of the agent that needs `vision` is shown
 * the file. Each image and PDF in `refused` (the turn's model couldn't read
 * a call carrying it) is `notShown: 'refused'` the same way, for the rest
 * of the turn. Each file in `leftOut` (one the first of a retried call's
 * two left out, `filesLeftOut`) is `notShown: 'limit'`, so the second
 * leaves it out too.
 */
export function messagesForCall(
  messages: readonly ModelMessage[],
  seesFiles: boolean,
  refused: ReadonlySet<string> = new Set(),
  leftOut: ReadonlySet<string> = new Set(),
): readonly ModelMessage[] {
  if (seesFiles && refused.size === 0 && leftOut.size === 0) return messages;
  const reasonOf = (file: MessageFile): 'model' | 'refused' | 'limit' | undefined => {
    if (file.notShown !== undefined) return undefined;
    if (sentAsImageOrPdf(file)) {
      if (!seesFiles) return 'model';
      if (refused.has(file.artifactId)) return 'refused';
    }
    return leftOut.has(file.artifactId) ? 'limit' : undefined;
  };
  return messages.map((message) =>
    message.files === undefined || !message.files.some((file) => reasonOf(file) !== undefined)
      ? message
      : {
          ...message,
          files: message.files.map((file) => {
            const notShown = reasonOf(file);
            return notShown === undefined ? file : { ...file, notShown };
          }),
        },
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
  return filesForCall(messages, planOptions(model));
}

/**
 * The files a call to `model` left out for its limits: each one it reads
 * when it fits (`isReadable`), but whose bytes it never asked for
 * (`asked`, every id its `readFile` was given). A file over its provider's
 * own lower size limit is one too, as the call can't tell it apart; it
 * isn't sent either way.
 */
export function filesLeftOut(
  messages: readonly ModelMessage[],
  model: Pick<ModelInfo, 'features' | 'contextWindow'>,
  asked: ReadonlySet<string>,
): ReadonlySet<string> {
  const options = planOptions(model);
  const leftOut = messages
    .flatMap((message) => message.files ?? [])
    .filter((file) => !asked.has(file.artifactId) && isReadable(file, options));
  return new Set(leftOut.map((file) => file.artifactId));
}

/** A call to `model`'s plan: `FILE_LIMITS`, with images and PDFs for a model that declares `vision`. */
function planOptions(model: Pick<ModelInfo, 'features' | 'contextWindow'>): FilePlanOptions {
  const vision = model.features.includes('vision');
  return { images: vision, documents: vision, contextWindow: model.contextWindow };
}

/** An image or a PDF: a file a call sends as itself, unless its text is sent in its place. */
export function isImageOrPdf(file: Pick<MessageFile, 'contentType'>): boolean {
  return (
    (IMAGE_FILE_TYPES as readonly string[]).includes(file.contentType) ||
    (DOCUMENT_FILE_TYPES as readonly string[]).includes(file.contentType)
  );
}

/**
 * A file a call sends as an image or a PDF: its `rendition`, or itself with
 * no `extracted` text in its place.
 */
export function sentAsImageOrPdf(file: MessageFile): boolean {
  if (file.extracted !== undefined) return false;
  return file.rendition !== undefined || isImageOrPdf(file);
}

/** A file the turn admitted, as the value a conversation keeps: a file's fields only, no form. */
export function asFileValue(file: MessageFile): FileValue {
  return { type: 'kindgi.file', ...asMessageFile(file) };
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
  const binding = ctx.files;
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
 * No form is kept here, whatever the binding answers: a call's forms are its
 * own copy's (`withFileForms`).
 */
export async function admitHistoryFiles(
  ctx: TurnContext,
  byMessage: readonly (readonly FileValue[] | undefined)[],
): Promise<readonly (readonly MessageFile[])[]> {
  const values = byMessage.flatMap((files) => files ?? []);
  if (values.length === 0) return byMessage.map(() => []);
  const binding = ctx.files;
  const admitted =
    binding === undefined ? values.map(() => undefined) : await binding.admit(values);
  const files = values.map((value, i): MessageFile => {
    const file = admitted[i];
    if (file !== undefined) return asMessageFile(file);
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
  const binding = ctx.files;
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
export function asMessageFile(value: Omit<FileValue, 'type'>): MessageFile {
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
