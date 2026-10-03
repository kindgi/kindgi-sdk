// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type ActionHandler,
  BUILT_IN_ACTION_HANDLERS,
  createActionHandlerRegistry,
  createCheckRegistry,
  defineGuardrail,
  evaluateGuardrail,
} from '../src/index.js';
import type { Guardrail, RunTrace } from '../src/types.js';

const TRACE_FAIL: RunTrace = {
  runId: '00000000-0000-4000-8000-000000000001' as never,
  tenantId: '00000000-0000-4000-8000-000000000002' as never,
  mode: 'runtime',
  output: '',
  toolCalls: [],
  toolResults: [],
  modelCalls: [],
};

function makeMustCite(): Guardrail {
  const checkRegistry = createCheckRegistry();
  const r = defineGuardrail(
    {
      id: 'must-cite-t' as never,
      kind: 'zero-llm',
      check: 'must-cite',
      config: { minCitations: 1, sourcePattern: '\\[[^\\]]+\\]' },
      action: { 'on-violation': 'halt' },
    },
    checkRegistry,
  );
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

describe('registered action handlers', () => {
  test('built-in registry seeds halt / log-only / noop / retry / escalate / compensate', () => {
    const reg = createActionHandlerRegistry(BUILT_IN_ACTION_HANDLERS);
    expect(reg.get('halt')).toBeDefined();
    expect(reg.get('log-only')).toBeDefined();
    expect(reg.get('noop')).toBeDefined();
    expect(reg.get('retry')).toBeDefined();
    expect(reg.get('escalate')).toBeDefined();
    expect(reg.get('compensate')).toBeDefined();
  });

  test('caller-registered custom action fires on violation', async () => {
    const invocations: { readonly guardrailId: string }[] = [];
    const hitlHandler: ActionHandler = {
      action: 'hitl-review',
      async apply(ctx) {
        invocations.push({ guardrailId: ctx.guardrail.id });
        return { kind: 'ok' };
      },
    };
    const guardrail: Guardrail = {
      id: 'requires-review' as never,
      kind: 'zero-llm',
      check: 'must-cite',
      config: { minCitations: 1, sourcePattern: '\\[[^\\]]+\\]' },
      action: { 'on-violation': 'hitl-review' },
    };
    const actions = createActionHandlerRegistry([hitlHandler]);
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE_FAIL, {
      actions,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.value.action).toBe('hitl-review');
    expect(invocations).toEqual([{ guardrailId: 'requires-review' }]);
  });

  test('handler error surfaces in evaluation.result.attributes.actionHandlerError', async () => {
    const brokenHandler: ActionHandler = {
      action: 'halt',
      async apply() {
        return { kind: 'err', error: { code: 'sink-unreachable', message: 'network down' } };
      },
    };
    const guardrail = makeMustCite();
    const actions = createActionHandlerRegistry([brokenHandler]);
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE_FAIL, {
      actions,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      const err = outcome.value.result.attributes?.actionHandlerError as {
        readonly code: string;
      };
      expect(err.code).toBe('sink-unreachable');
    }
  });

  test('no action handler registry → engine records action but does not invoke', async () => {
    const guardrail = makeMustCite();
    const outcome = await evaluateGuardrail(guardrail, createCheckRegistry(), TRACE_FAIL, {});
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.value.action).toBe('halt');
  });

  test('an action with no registered handler fails with unknown-action naming it', async () => {
    // Accepted at define time — `on-violation` is an open string.
    const defined = defineGuardrail(
      { ...makeMustCite(), action: { 'on-violation': 'obliterate' } },
      createCheckRegistry(),
    );
    if (defined.kind === 'err') throw new Error(defined.error.message);
    const outcome = await evaluateGuardrail(defined.value, createCheckRegistry(), TRACE_FAIL, {
      actions: createActionHandlerRegistry(BUILT_IN_ACTION_HANDLERS),
    });
    expect(outcome.kind).toBe('err');
    if (outcome.kind === 'err') {
      expect(outcome.error).toMatchObject({
        code: 'unknown-action',
        action: 'obliterate',
        guardrailId: 'must-cite-t',
      });
      expect(outcome.error.message).toContain('"obliterate"');
    }
  });
});
