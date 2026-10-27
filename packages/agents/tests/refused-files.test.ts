// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A file the provider refuses. A call carrying images or PDFs that the
 * provider refuses as an invalid request is sent once more, in the same
 * step, with a line in each one's place. When that call answers, the turn
 * goes on without them and the files binding is told to mark them; when it
 * fails too, nothing is marked and the turn fails with the first call's
 * error. Every other failure keeps the files. A call that answers tells the
 * binding what its model was shown.
 */

import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  FILE_LIMITS,
  type MessageFile,
  type ModelCallInput,
  type ModelCallResult,
  type ModelInfo,
  type ModelMessage,
  type ModelProvider,
  type ModelUsageRecord,
  type ProviderMetadata,
  fileParts,
} from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import type { NodeId, ProjectId, RunId, TenantId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { buildBudgetCheckHandler } from '../src/handlers/budget-check.js';
import type { TurnContext } from '../src/handlers/context.js';
import { AgentTurnFailure } from '../src/handlers/errors.js';
import type { FileBinding } from '../src/handlers/files.js';
import { buildModelCallHandler } from '../src/handlers/model-call.js';
import type { InvokeAgentBindings } from '../src/handlers/public-types.js';
import type { TurnEvent } from '../src/streaming.js';
import type { Agent, ConversationId, TurnBudget } from '../src/types.js';

/** An adapter's typed failure (`@kindgi/adapter-model-shared`): agents knows it by its shape. */
class ModelProviderError extends Error {
  constructor(
    readonly kind: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

const refusedAsInvalid = () =>
  new ModelProviderError(
    'invalid-request',
    400,
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}',
  );

const answer = (costUsd = 0.002): ModelCallResult => ({
  message: { role: 'assistant', content: 'It is cracked.' },
  finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 5 },
  costUsd,
  durationMs: 5,
  provider: { id: 'anthropic', model: 'claude-haiku-4-5' },
});

const sha = (n: number) => n.toString(16).padStart(64, '0');
const photo = (n: number): MessageFile => ({
  artifactId: `art-${n}`,
  name: `photo-${n}.jpg`,
  contentType: 'image/jpeg',
  size: 1000 + n,
  sha256: sha(n),
});
const pdf = (n: number): MessageFile => ({
  artifactId: `doc-${n}`,
  name: 'receipt.pdf',
  contentType: 'application/pdf',
  size: 2000,
  sha256: sha(n),
  pages: 1,
});
const notes: MessageFile = {
  artifactId: 'txt-9',
  name: 'notes.txt',
  contentType: 'text/plain',
  size: 3,
  sha256: sha(9),
};

const withFiles = (...files: MessageFile[]): readonly ModelMessage[] => [
  { role: 'system', content: 'Look at the photo.' },
  { role: 'user', content: 'Is it broken?', files },
];

function agent(budget?: TurnBudget): Agent {
  const r = defineAgent({
    id: 'acme.refund-desk',
    version: '1.0.0',
    name: 'Refund desk',
    instructions: 'Look at the photo.',
    capabilities: [{ needs: [{ feature: 'vision' }, { feature: 'tool-use' }] }],
    tools: [],
    retrieval: [],
    guardrails: [],
    ...(budget !== undefined && { budget }),
  });
  if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
  return r.value;
}

/** `count` stored photos, oldest first, each with the bytes its checks found. */
function storedPhotos(count: number) {
  const bytes = new Map<string, Uint8Array>();
  const photos = Array.from({ length: count }, (_, n): MessageFile => {
    const data = new Uint8Array(100).fill(n);
    bytes.set(`art-${n}`, data);
    return {
      artifactId: `art-${n}`,
      name: `photo-${n}.jpg`,
      contentType: 'image/jpeg',
      size: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
  return { photos, bytes };
}

/** The run's files: each id is stored (as `bytes`, or three bytes), and every mark is logged. */
function filesOf(
  options: {
    readonly refuse?: FileBinding['refuse'];
    readonly bytes?: ReadonlyMap<string, Uint8Array>;
  } = {},
) {
  const shown: string[][] = [];
  const refused: string[][] = [];
  const read: string[] = [];
  const binding: FileBinding = {
    admit: async () => [],
    read: async (artifactId) => {
      read.push(artifactId);
      return options.bytes?.get(artifactId) ?? new Uint8Array([1, 2, 3]);
    },
    shown: async (ids) => {
      shown.push([...ids]);
    },
    refuse:
      options.refuse ??
      (async (ids) => {
        refused.push([...ids]);
      }),
  };
  return { binding, shown, refused, read };
}

/**
 * A turn whose provider reads each file a call shows, then answers or
 * throws as `outcomes` say, one per call. With `unreadable`, it fits the
 * files to the call's limits as an adapter does (`fileParts`), and refuses
 * as an invalid request a call that sends one of these; it answers any
 * other.
 */
function turn(options: {
  readonly outcomes: (ModelCallResult | Error)[];
  readonly unreadable?: ReadonlySet<string>;
  readonly files: FileBinding;
  readonly budget?: TurnBudget;
  readonly spentUsd?: number;
  readonly abortOnCall?: number;
}) {
  const sent: ModelCallInput[] = [];
  const recorded: ModelUsageRecord[] = [];
  const events: TurnEvent[] = [];
  const turnAbort = new AbortController();
  const invoke: ModelProvider['invoke'] = async (input) => {
    sent.push(input);
    if (options.unreadable !== undefined) return await fitting(input, options.unreadable);
    for (const file of input.messages.flatMap((m) => m.files ?? [])) {
      if (file.notShown === undefined) await input.readFile?.(file.artifactId);
    }
    if (options.abortOnCall === sent.length) turnAbort.abort(new Error('timed out'));
    const next = options.outcomes.shift();
    if (next === undefined) throw new Error('no outcome left');
    if (next instanceof Error) throw next;
    return next;
  };
  const ctx = {
    input: {
      tenantId: 'acme' as TenantId,
      projectId: '00000000-0000-0000-0000-0000000000aa' as ProjectId,
      agent: agent(options.budget),
      conversationId: '00000000-0000-0000-0000-0000000000cc' as ConversationId,
      userMessage: 'Is it broken?',
    },
    bindings: {
      usage: { record: async (call: ModelUsageRecord) => void recorded.push(call) },
      onEvent: async (event: TurnEvent) => void events.push(event),
    } as unknown as InvokeAgentBindings,
    turnAbort,
    startedAt: Date.now(),
    appended: [],
    usage: { steps: 0, promptTokens: 0, completionTokens: 0, totalCostUsd: options.spentUsd ?? 0 },
    abortReason: undefined,
    provider: { metadata: { id: 'anthropic' } as ProviderMetadata, invoke },
    model: {
      name: 'claude-haiku-4-5',
      features: ['vision', 'tool-use'],
      contextWindow: 200_000,
    } as unknown as ModelInfo,
    tools: { definitions: [], byName: new Map() },
    userMessage: { sequence: 1 },
    files: options.files,
  } as unknown as TurnContext;
  const step = async (nextMessages: readonly ModelMessage[]) =>
    (await buildModelCallHandler(ctx)({ nextMessages }, kctx)) as {
      readonly step: number;
      readonly callId: string;
      readonly message: ModelMessage;
      readonly warnings?: readonly { readonly code: string; readonly message: string }[];
      readonly refused?: readonly string[];
    };
  return { ctx, step, sent, recorded, events };
}

/** A provider that fits a call's files to its limits, as an adapter does, and can't read `unreadable`. */
async function fitting(
  input: ModelCallInput,
  unreadable: ReadonlySet<string>,
): Promise<ModelCallResult> {
  const sentFiles: string[] = [];
  await fileParts(input.messages, {
    images: true,
    documents: true,
    contextWindow: 200_000,
    readFile: async (artifactId) => {
      const bytes = await input.readFile?.(artifactId);
      if (bytes !== undefined) sentFiles.push(artifactId);
      return bytes;
    },
  });
  if (sentFiles.some((id) => unreadable.has(id))) throw refusedAsInvalid();
  return answer();
}

const kctx = { runId: 'run-1' as RunId, nodeId: 'n' as NodeId, dryRun: false } as NodeContext;

async function failureOf(p: Promise<unknown>): Promise<AgentTurnFailure> {
  const thrown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(AgentTurnFailure);
  return thrown as AgentTurnFailure;
}

/** The files a call was sent, each with the reason it wasn't shown, if any. */
const filesSent = (input: ModelCallInput | undefined) =>
  (input?.messages ?? [])
    .flatMap((m) => m.files ?? [])
    .map((f) => (f.notShown === undefined ? f.artifactId : `${f.artifactId}:${f.notShown}`));

describe('a call that answers', () => {
  test('tells the binding the images and PDFs it carried, once a turn; a text file is never one', async () => {
    const files = filesOf();
    const t = turn({ outcomes: [answer(), answer()], files: files.binding });
    await t.step(withFiles(photo(1), pdf(2), notes));
    await t.step(withFiles(photo(1), pdf(2), notes, photo(3)));
    expect(files.shown).toEqual([['art-1', 'doc-2'], ['art-3']]);
    expect(files.refused).toEqual([]);
  });
});

describe('every failure other than an invalid request keeps the files (point 1)', () => {
  const NOT_RETRIED: readonly [string, Error][] = [
    ['rate-limited (429)', new ModelProviderError('rate-limited', 429, '429 slow down')],
    ['unavailable (529)', new ModelProviderError('unavailable', 529, '529 overloaded')],
    ['unavailable (408)', new ModelProviderError('unavailable', 408, '408 took too long')],
    ['network', new ModelProviderError('network', undefined, 'fetch failed')],
    ['auth (401)', new ModelProviderError('auth', 401, '401 invalid x-api-key')],
    ['auth (403)', new ModelProviderError('auth', 403, '403 forbidden')],
    ['context-too-long', new ModelProviderError('context-too-long', 400, '400 prompt is too long')],
    ['content-filter', new ModelProviderError('content-filter', 400, '400 blocked by safety')],
    ['an error with no kind', new Error('socket hang up')],
  ];

  test.each(NOT_RETRIED)(
    '%s: one call, nothing marked, and the next turn sends the photo again',
    async (_, error) => {
      const files = filesOf();
      const t = turn({ outcomes: [error], files: files.binding });
      const failed = await failureOf(t.step(withFiles(photo(1))));
      expect(failed.payload).toMatchObject({ code: 'model-invocation-failed' });
      expect(t.sent).toHaveLength(1);
      expect(files.refused).toEqual([]);
      expect(files.shown).toEqual([]);

      const next = turn({ outcomes: [answer()], files: files.binding });
      await next.step(withFiles(photo(1)));
      expect(filesSent(next.sent[0])).toEqual(['art-1']);
      expect(files.shown).toEqual([['art-1']]);
    },
  );

  test('a turn aborted while its call ran: no retry, and the abort is the failure', async () => {
    const files = filesOf();
    const t = turn({ outcomes: [refusedAsInvalid()], files: files.binding, abortOnCall: 1 });
    const failed = await failureOf(t.step(withFiles(photo(1))));
    expect(failed.payload).toMatchObject({ code: 'agent-turn-aborted' });
    expect(t.sent).toHaveLength(1);
    expect(files.refused).toEqual([]);
  });

  test("a call that carried no image or PDF isn't retried", async () => {
    const files = filesOf();
    const t = turn({ outcomes: [refusedAsInvalid()], files: files.binding });
    await failureOf(t.step(withFiles(notes)));
    expect(t.sent).toHaveLength(1);
  });
});

describe('an invalid request with a photo, whose retry answers', () => {
  test('the photo is marked, the step answers with the note, and both calls are recorded', async () => {
    const files = filesOf();
    const t = turn({ outcomes: [refusedAsInvalid(), answer(0.003)], files: files.binding });
    const out = await t.step(withFiles(photo(1), notes));

    expect(t.sent.map(filesSent)).toEqual([
      ['art-1', 'txt-9'],
      ['art-1:refused', 'txt-9'],
    ]);
    expect(files.refused).toEqual([['art-1']]);
    expect(files.shown).toEqual([]);
    expect(out.message.content).toBe('It is cracked.');
    expect(out.refused).toEqual(['art-1']);
    expect(out.warnings).toEqual([
      {
        code: 'file-refused',
        message:
          'The model\'s provider refused the call with "photo-1.jpg" attached as an invalid request. The same call without it answered, and the turn went on without it.',
      },
    ]);

    // Two calls, each with its own id; the answer is the second's.
    expect(t.recorded.map((r) => [r.status, r.step])).toEqual([
      ['failed', 1],
      ['ok', 1],
    ]);
    expect(t.recorded[0]?.error?.message).toContain('Could not process image');
    expect(new Set(t.recorded.map((r) => r.callId)).size).toBe(2);
    expect(out.callId).toBe(t.recorded[1]?.callId);
    expect(t.ctx.usage.totalCostUsd).toBeCloseTo(0.003);
    expect(t.events.map((e) => e.kind)).toEqual([
      'model.call.started',
      'model.call.started',
      'model.call.completed',
    ]);
    expect(t.events.map((e) => ('step' in e ? e.step : undefined))).toEqual([1, 1, 1]);
  });

  test('the rest of the turn sends the note in its place, and a new photo is still sent', async () => {
    const files = filesOf();
    const t = turn({ outcomes: [refusedAsInvalid(), answer(), answer()], files: files.binding });
    await t.step(withFiles(photo(1)));
    await t.step(withFiles(photo(1), photo(2)));
    expect(filesSent(t.sent[2])).toEqual(['art-1:refused', 'art-2']);
    expect(files.shown).toEqual([['art-2']]);
  });

  test('an agent with `maxSteps: 1` still answers: the retry is the same step', async () => {
    const files = filesOf();
    const t = turn({
      outcomes: [refusedAsInvalid(), answer()],
      files: files.binding,
      budget: { maxSteps: 1 },
    });
    const out = await t.step(withFiles(photo(1)));
    expect(out.step).toBe(1);
    expect(t.ctx.usage.steps).toBe(1);
    const checked = await buildBudgetCheckHandler(t.ctx)(
      { ...out, iterationAppended: [], hasToolCalls: false, nextMessages: [] },
      kctx,
    );
    expect(checked).toMatchObject({ finishedTurn: true });
  });

  test('every image and PDF the call carried goes to the binding, which chooses what it marks', async () => {
    // An earlier turn showed the PDF; this one adds a photo, or follows a
    // model switch. The binding is given both, and marks by its records.
    const files = filesOf();
    const t = turn({ outcomes: [refusedAsInvalid(), answer()], files: files.binding });
    await t.step(withFiles(pdf(2), photo(1)));
    expect(files.refused).toEqual([['doc-2', 'art-1']]);
    expect(filesSent(t.sent[1])).toEqual(['doc-2:refused', 'art-1:refused']);
  });

  test('a `refuse` that throws: the turn answers, with a warning that a later turn sends it again', async () => {
    const files = filesOf({
      refuse: () => Promise.reject(new Error('database unavailable')),
    });
    const t = turn({ outcomes: [refusedAsInvalid(), answer()], files: files.binding });
    const out = await t.step(withFiles(photo(1)));
    expect(out.message.content).toBe('It is cracked.');
    expect(out.warnings?.map((w) => w.code)).toEqual(['file-refused', 'file-record-failed']);
    expect(out.warnings?.[1]?.message).toBe(
      'Recording that the model couldn\'t read "photo-1.jpg" failed: database unavailable. A later turn sends it again.',
    );
  });
});

describe('the retry fails too', () => {
  test.each([
    [
      'a retired model (404)',
      new ModelProviderError('invalid-request', 404, '404 model: not found'),
    ],
    [
      'a bad max_tokens (400)',
      new ModelProviderError('invalid-request', 400, '400 max_tokens: 999999 > 64000'),
    ],
  ])(
    '%s: nothing is marked, the error is the first call’s, and both calls are recorded',
    async (_, error) => {
      const files = filesOf();
      const t = turn({ outcomes: [error, error], files: files.binding });
      const failed = await failureOf(t.step(withFiles(photo(1))));
      expect(failed.payload).toEqual({
        code: 'model-invocation-failed',
        message: `Model call to anthropic (claude-haiku-4-5) failed: ${error.message}`,
        cause: error,
      });
      expect(t.sent).toHaveLength(2);
      expect(files.refused).toEqual([]);
      expect(files.shown).toEqual([]);
      expect(t.recorded.map((r) => r.status)).toEqual(['failed', 'failed']);
    },
  );

  test('a retry that fails some other way: the error is still the first call’s', async () => {
    const files = filesOf();
    const first = refusedAsInvalid();
    const t = turn({
      outcomes: [first, new ModelProviderError('unavailable', 503, '503 down')],
      files: files.binding,
    });
    const failed = await failureOf(t.step(withFiles(photo(1))));
    expect(failed.payload).toMatchObject({ cause: first });
    expect(files.refused).toEqual([]);
  });
});

describe('once a turn', () => {
  test('a second invalid request in the turn fails it, and marks nothing more', async () => {
    const files = filesOf();
    const t = turn({
      outcomes: [refusedAsInvalid(), answer(), refusedAsInvalid()],
      files: files.binding,
    });
    await t.step(withFiles(photo(1)));
    const failed = await failureOf(t.step(withFiles(photo(1), photo(2))));
    expect(failed.payload).toMatchObject({ code: 'model-invocation-failed' });
    expect(t.sent).toHaveLength(3);
    expect(files.refused).toEqual([['art-1']]);
  });
});

describe('the cost budget', () => {
  test('a turn at its cost budget makes no second call; the error names the photo', async () => {
    const files = filesOf();
    const t = turn({
      outcomes: [refusedAsInvalid(), answer()],
      files: files.binding,
      budget: { maxCostUsd: 0.01 },
      spentUsd: 0.01,
    });
    const failed = await failureOf(t.step(withFiles(photo(1))));
    expect(t.sent).toHaveLength(1);
    expect(files.refused).toEqual([]);
    expect(failed.payload).toMatchObject({
      code: 'model-invocation-failed',
      message: expect.stringMatching(
        /failed: 400 .*Could not process image.* \(not retried without the attached file "photo-1\.jpg": the turn has spent its cost budget\)$/,
      ),
    });
    expect(t.recorded.map((r) => r.status)).toEqual(['failed']);
  });

  test('a turn under it retries', async () => {
    const files = filesOf();
    const t = turn({
      outcomes: [refusedAsInvalid(), answer()],
      files: files.binding,
      budget: { maxCostUsd: 0.01 },
      spentUsd: 0.009,
    });
    await t.step(withFiles(photo(1)));
    expect(t.sent).toHaveLength(2);
  });
});

describe('the retry leaves out what the first call left out for its limits', () => {
  test('a thread with an unreadable photo on each side of the limit: each turn answers, and marks one side', async () => {
    // A call sends the ten newest photos, so the oldest is a `limit` line.
    const { photos, bytes } = storedPhotos(FILE_LIMITS.filesPerCall + 1);
    const ids = photos.map((p) => p.artifactId);
    const [oldest, ...newer] = ids;
    const unreadable = new Set([ids[0], ids.at(-1)] as string[]);
    const files = filesOf({ bytes });

    const t = turn({ outcomes: [], unreadable, files: files.binding });
    const answered = await t.step(withFiles(...photos));
    expect(answered.message.content).toBe('It is cracked.');
    expect(filesSent(t.sent[0])).toEqual(ids);
    expect(filesSent(t.sent[1])).toEqual([
      `${oldest}:limit`,
      ...newer.map((id) => `${id}:refused`),
    ]);
    expect(files.refused).toEqual([newer]);

    // The next turn: the binding admits the newer ten as `refused`, so the
    // oldest fits; its call is refused in turn, and the retry answers.
    const next = turn({ outcomes: [], unreadable, files: files.binding });
    const marked = photos.map((p, n) => (n === 0 ? p : { ...p, notShown: 'refused' as const }));
    await next.step(withFiles(...marked));
    expect(filesSent(next.sent[1])).toEqual([
      `${oldest}:refused`,
      ...newer.map((id) => `${id}:refused`),
    ]);
    expect(files.refused).toEqual([newer, [oldest]]);
  });
});

describe('a file already marked', () => {
  test('a history file the binding admitted as `refused` is a line, and its bytes are never read', async () => {
    const files = filesOf();
    const t = turn({ outcomes: [answer()], files: files.binding });
    await t.step(withFiles({ ...photo(1), notShown: 'refused' }, photo(2)));
    expect(files.read).toEqual(['art-2']);
    expect(filesSent(t.sent[0])).toEqual(['art-1:refused', 'art-2']);
    expect(files.shown).toEqual([['art-2']]);
  });
});
