// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { RunId, TenantId, Timestamp, ToolId } from '@kindgi/types';

import {
  BUILT_IN_CHECK_IDS,
  DEFAULT_CHECK_POINTS,
  GUARDRAIL_POINTS,
  checkPoints,
  createCheckRegistry,
  defineCheck,
  guardrailCheckPointProblems,
  guardrailCoversTool,
  guardrailPoint,
  guardrailPointIssues,
  isGuardrailPoint,
  validateGuardrail,
  validateGuardrailSpec,
} from '../src/index.js';
import type { Guardrail, GuardrailPoint, RunTrace, TraceCall } from '../src/index.js';

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const AT = '2026-10-27T00:00:00.000Z' as Timestamp;

function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: '00000000-0000-4000-8000-000000000003' as RunId,
    tenantId: TENANT,
    output: '',
    toolCalls: [],
    toolResults: [],
    modelCalls: [],
    mode: 'runtime',
    ...over,
  };
}

function call(toolName: string, args: Record<string, unknown> = {}): TraceCall {
  return { callId: 'call_1', toolId: `acme.${toolName}` as ToolId, toolName, arguments: args };
}

function earlierCall(toolName: string) {
  return { toolId: `acme.${toolName}` as ToolId, toolName, arguments: {}, at: AT };
}

const registry = createCheckRegistry();

async function run(check: string, config: Record<string, unknown>, t: RunTrace) {
  const registered = registry.get(check);
  if (registered === undefined) throw new Error(`no ${check}`);
  return registered.evaluate(config, t);
}

function declaration(over: Partial<Guardrail> = {}): Record<string, unknown> {
  return {
    id: 'acme.guardrails.t',
    kind: 'zero-llm',
    check: 'never-call-tool',
    config: { tools: ['refund'] },
    action: { 'on-violation': 'halt' },
    ...over,
  };
}

describe('points', () => {
  test('a guardrail runs at the final answer unless it names a point', () => {
    expect(guardrailPoint({})).toBe('final-answer');
    expect(guardrailPoint({ at: 'before-tool' })).toBe('before-tool');
  });

  test('a check runs at the final answer only unless it names its points', () => {
    expect(checkPoints({})).toEqual(DEFAULT_CHECK_POINTS);
    expect(DEFAULT_CHECK_POINTS).toEqual(['final-answer']);
    expect(checkPoints({ points: ['model-step'] })).toEqual(['model-step']);
  });

  test('isGuardrailPoint knows the four points and nothing else', () => {
    for (const point of GUARDRAIL_POINTS) expect(isGuardrailPoint(point)).toBe(true);
    expect(GUARDRAIL_POINTS).toHaveLength(4);
    expect(isGuardrailPoint('before-handoff')).toBe(false);
    expect(isGuardrailPoint(undefined)).toBe(false);
  });

  test('the built-ins run where the shape puts them', () => {
    const want: Record<string, readonly GuardrailPoint[]> = {
      'must-cite': ['final-answer'],
      'required-substring': ['final-answer'],
      'never-call-tool': ['before-tool', 'final-answer'],
      'max-tool-calls': ['before-tool', 'final-answer'],
      'tool-order': ['before-tool', 'final-answer'],
      'output-matches': ['model-step', 'after-tool', 'final-answer'],
      'forbidden-substring': ['model-step', 'after-tool', 'final-answer'],
    };
    expect(Object.keys(want).sort()).toEqual([...BUILT_IN_CHECK_IDS].sort());
    for (const [id, points] of Object.entries(want)) {
      const check = registry.get(id);
      expect(check === undefined ? undefined : checkPoints(check), id).toEqual(points);
    }
  });
});

describe('guardrailPointIssues', () => {
  test('escalate and compensate are recorded at the final answer only', () => {
    for (const action of ['escalate', 'compensate'] as const) {
      for (const at of ['before-tool', 'after-tool', 'model-step'] as const) {
        expect(
          guardrailPointIssues({ at, action: { 'on-violation': action, escalateTo: 'senior' } }),
        ).toEqual([
          {
            path: '/action/on-violation',
            message: `"${action}" is recorded at the final answer only, not at "${at}"`,
          },
        ]);
      }
      expect(guardrailPointIssues({ action: { 'on-violation': action } })).toEqual([]);
      expect(guardrailPointIssues({ at: 'final-answer', action: { 'on-violation': action } })).toEqual(
        [],
      );
    }
  });

  test('scope.tools is for the tool points', () => {
    const scope = { tools: ['acme.woo.*'] };
    expect(
      guardrailPointIssues({ at: 'model-step', action: { 'on-violation': 'halt' }, scope }),
    ).toEqual([
      { path: '/scope/tools', message: 'scope.tools is for "before-tool" and "after-tool", not "model-step"' },
    ]);
    expect(guardrailPointIssues({ action: { 'on-violation': 'halt' }, scope })).toHaveLength(1);
    for (const at of ['before-tool', 'after-tool'] as const) {
      expect(guardrailPointIssues({ at, action: { 'on-violation': 'halt' }, scope })).toEqual([]);
    }
  });

  test('a custom action is taken as at the final answer', () => {
    expect(
      guardrailPointIssues({ at: 'model-step', action: { 'on-violation': 'acme.page-oncall' } }),
    ).toEqual([]);
  });
});

describe('guardrailCheckPointProblems', () => {
  test('a point the check runs at is no problem', () => {
    expect(guardrailCheckPointProblems({ at: 'before-tool' }, ['before-tool', 'final-answer'])).toEqual(
      [],
    );
    expect(guardrailCheckPointProblems({}, DEFAULT_CHECK_POINTS)).toEqual([]);
  });

  test('a point it doesn\'t run at is a problem at /at', () => {
    expect(guardrailCheckPointProblems({ at: 'model-step' }, ['final-answer'])).toEqual([
      { path: '/at', message: 'at "model-step" isn\'t one of the check\'s points (final-answer).' },
    ]);
    expect(guardrailCheckPointProblems({}, ['before-tool'])).toEqual([
      { path: '/at', message: 'at "final-answer" isn\'t one of the check\'s points (before-tool).' },
    ]);
  });
});

describe('guardrailCoversTool', () => {
  test('every tool without scope.tools', () => {
    expect(guardrailCoversTool(undefined, 'acme.woo.refund')).toBe(true);
    expect(guardrailCoversTool({}, 'acme.woo.refund')).toBe(true);
  });

  test('an exact id, or a prefix before a trailing *', () => {
    const scope = { tools: ['acme.mail.send', 'acme.woo.*'] };
    expect(guardrailCoversTool(scope, 'acme.mail.send')).toBe(true);
    expect(guardrailCoversTool(scope, 'acme.mail.read')).toBe(false);
    expect(guardrailCoversTool(scope, 'acme.woo.refund')).toBe(true);
    expect(guardrailCoversTool(scope, 'acme.wood')).toBe(false);
    expect(guardrailCoversTool({ tools: [] }, 'acme.mail.send')).toBe(false);
  });
});

describe('built-in checks at their points', () => {
  test('never-call-tool before a call judges that call alone', async () => {
    const config = { tools: ['refund'] };
    expect(
      (await run('never-call-tool', config, trace({ at: 'before-tool', call: call('refund') }))).passed,
    ).toBe(false);
    // An earlier forbidden call was judged before it ran; this call isn't one.
    expect(
      (
        await run(
          'never-call-tool',
          config,
          trace({ at: 'before-tool', call: call('lookup'), toolCalls: [earlierCall('refund')] }),
        )
      ).passed,
    ).toBe(true);
    // At the final answer, the turn's calls as before.
    expect(
      (await run('never-call-tool', config, trace({ toolCalls: [earlierCall('refund')] }))).passed,
    ).toBe(false);
  });

  test('max-tool-calls before a call counts it with the earlier ones', async () => {
    const config = { max: 2 };
    const two = [earlierCall('lookup'), earlierCall('lookup')];
    const before = await run(
      'max-tool-calls',
      config,
      trace({ at: 'before-tool', call: call('lookup'), toolCalls: two }),
    );
    expect(before).toEqual({
      passed: false,
      reason: 'expected <= 2 tool calls, saw 3',
      attributes: { toolCallCount: 3 },
    });
    expect((await run('max-tool-calls', config, trace({ toolCalls: two }))).passed).toBe(true);
  });

  test('tool-order before a call needs the tools before it in sequence first', async () => {
    const config = { sequence: ['lookup', 'verify', 'refund'] };
    const early = await run('tool-order', config, trace({ at: 'before-tool', call: call('refund') }));
    expect(early.passed).toBe(false);
    expect(early.reason).toBe('"refund" called before [lookup, verify]');

    const half = await run(
      'tool-order',
      config,
      trace({ at: 'before-tool', call: call('refund'), toolCalls: [earlierCall('lookup')] }),
    );
    expect(half.reason).toBe('"refund" called before [verify]');

    const inOrder = trace({
      at: 'before-tool',
      call: call('refund'),
      toolCalls: [earlierCall('lookup'), earlierCall('verify')],
    });
    expect((await run('tool-order', config, inOrder)).passed).toBe(true);
    // A tool not in the sequence, and one already passed, run anywhere.
    expect(
      (await run('tool-order', config, trace({ at: 'before-tool', call: call('search') }))).passed,
    ).toBe(true);
    expect(
      (
        await run(
          'tool-order',
          config,
          trace({ at: 'before-tool', call: call('lookup'), toolCalls: [earlierCall('lookup')] }),
        )
      ).passed,
    ).toBe(true);
  });

  test('output-matches reads the reply at model-step and the result after a tool', async () => {
    const config = { pattern: 'ORDER-\\d+' };
    const step = await run(
      'output-matches',
      config,
      trace({ at: 'model-step', step: { text: 'no order here', toolCalls: [] }, output: 'ORDER-1' }),
    );
    expect(step).toMatchObject({ passed: false, reason: 'reply did not match /ORDER-\\d+/' });
    const result = await run(
      'output-matches',
      config,
      trace({ at: 'after-tool', call: call('lookup'), result: { output: { id: 'ORDER-7' } } }),
    );
    expect(result.passed).toBe(true);
  });

  test('output-matches passes a reply with no text, one that only asks for calls', async () => {
    const callsOnly = trace({
      at: 'model-step',
      step: { text: '', toolCalls: [call('lookup')] },
    });
    expect(await run('output-matches', { pattern: 'ORDER-\\d+' }, callsOnly)).toEqual({
      passed: true,
    });
    expect((await run('output-matches', { pattern: '^$', negate: true }, callsOnly)).passed).toBe(
      true,
    );
    // An empty answer is judged as before.
    expect((await run('output-matches', { pattern: 'ORDER-\\d+' }, trace())).passed).toBe(false);
  });

  test('forbidden-substring reads a result: a string as is, JSON, or an error message', async () => {
    const config = { patterns: ['secret'] };
    const at = (result: RunTrace['result']) =>
      trace({ at: 'after-tool', call: call('lookup'), result });
    expect(await run('forbidden-substring', config, at({ output: 'a secret' }))).toMatchObject({
      passed: false,
      reason: 'result contains forbidden pattern(s): secret',
    });
    expect((await run('forbidden-substring', config, at({ output: { note: 'secret' } }))).passed).toBe(
      false,
    );
    expect(
      (await run('forbidden-substring', config, at({ error: { message: 'secret store down' } })))
        .passed,
    ).toBe(false);
    expect((await run('forbidden-substring', config, at({ output: 'fine' }))).passed).toBe(true);
    // The final answer reads the output as before.
    expect(
      (await run('forbidden-substring', config, trace({ output: 'my secret' }))).reason,
    ).toBe('output contains forbidden pattern(s): secret');
  });
});

describe('defineCheck points', () => {
  const evaluate = async () => ({ passed: true });

  test('a check keeps the points it names, and names none by default', () => {
    const check = defineCheck({
      id: 'acme.checks.calls',
      kind: 'zero-llm',
      points: ['before-tool'],
      evaluate,
    });
    expect(check.points).toEqual(['before-tool']);
    const plain = defineCheck({ id: 'acme.checks.plain', kind: 'zero-llm', evaluate });
    expect(plain.points).toBeUndefined();
    expect(checkPoints(plain)).toEqual(['final-answer']);
  });

  test('points that are empty, unknown or repeated are refused', () => {
    const cases: [unknown[], string][] = [
      [[], 'Check "acme.checks.x" points must name at least one point'],
      [['before-handoff'], 'Check "acme.checks.x" points names "before-handoff", which isn\'t a point'],
      [['model-step', 'model-step'], 'Check "acme.checks.x" points names a point twice'],
    ];
    for (const [points, message] of cases) {
      expect(() =>
        defineCheck({
          id: 'acme.checks.x',
          kind: 'zero-llm',
          points: points as GuardrailPoint[],
          evaluate,
        }),
      ).toThrow(message);
    }
  });
});

describe('validateGuardrail at a point', () => {
  test('a point its check runs at validates', () => {
    const r = validateGuardrail(
      declaration({ at: 'before-tool', scope: { tools: ['acme.woo.*'] } }),
      registry,
    );
    expect(r.kind).toBe('ok');
  });

  test("a point its check doesn't run at is refused at /at", () => {
    const r = validateGuardrail(
      declaration({ check: 'must-cite', config: { minCitations: 1 }, at: 'model-step' }),
      registry,
    );
    expect(r.kind === 'err' && r.error).toMatchObject({
      code: 'invalid-guardrail',
      message:
        'Guardrail "acme.guardrails.t" runs where check "must-cite" doesn\'t: at "model-step" isn\'t one of the check\'s points (final-answer).',
      issues: [{ path: '/at' }],
    });
  });

  test("a pack check's points, from defineCheck", () => {
    const checks = createCheckRegistry([
      defineCheck({
        id: 'acme.checks.args',
        kind: 'zero-llm',
        points: ['before-tool'],
        evaluate: async () => ({ passed: true }),
      }),
    ]);
    const at = (point?: GuardrailPoint) =>
      validateGuardrail(
        declaration({ check: 'acme.checks.args', config: {}, ...(point && { at: point }) }),
        checks,
      ).kind;
    expect(at('before-tool')).toBe('ok');
    expect(at()).toBe('err');
  });

  test('what a point can\'t do is refused by both validators', () => {
    const spec = declaration({ at: 'after-tool', action: { 'on-violation': 'escalate' } });
    for (const r of [validateGuardrail(spec, registry), validateGuardrailSpec(spec)]) {
      expect(r.kind === 'err' && r.error).toMatchObject({
        code: 'invalid-guardrail',
        message:
          'Guardrail "acme.guardrails.t": "escalate" is recorded at the final answer only, not at "after-tool"',
        issues: [{ path: '/action/on-violation' }],
      });
    }
  });

  test('the schema refuses a point or a view it doesn\'t know', () => {
    expect(validateGuardrailSpec(declaration({ at: 'before-handoff' as never })).kind).toBe('err');
    expect(validateGuardrailSpec(declaration({ sees: 'everything' as never })).kind).toBe('err');
    expect(validateGuardrailSpec(declaration({ sees: 'conversation' })).kind).toBe('ok');
  });

  test('the schema refuses a scope.tools that would match no call', () => {
    const scoped = (tools: string[]) =>
      validateGuardrailSpec(declaration({ at: 'before-tool', scope: { tools } })).kind;
    expect(scoped([])).toBe('err');
    expect(scoped(['acme.*.refund'])).toBe('err');
    expect(scoped(['acme.woo.**'])).toBe('err');
    expect(scoped([''])).toBe('err');
    expect(scoped(['acme.woo.*', 'acme.mail.send'])).toBe('ok');
  });
});
