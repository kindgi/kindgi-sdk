// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { route } from '@kindgi/capabilities';
import type {
  Capability,
  ModelCallResult,
  ModelInfo,
  ModelProvider,
  ModelUsageRecord,
} from '@kindgi/capabilities';

import type { JudgeMissingError, JudgeRoutingError } from './errors.js';
import type { CheckResult, EvaluationBindings, RunTrace } from './types.js';

/**
 * Configuration for an llm-judge guardrail, read from the guardrail's
 * `config`. `invokeJudge` builds the prompt around `rubric`.
 */
export interface LlmJudgeConfig {
  /** The rubric prompt — what the judge model evaluates against. */
  readonly rubric: string;
  /**
   * How the judge should respond. `'pass-fail'` (default) expects a
   * response starting with PASS or FAIL and a reason. `'score'` expects
   * a numeric score in [0, 1] on the first line, compared to `threshold`.
   */
  readonly responseFormat?: 'pass-fail' | 'score';
  /** For `'score'` format — pass threshold (inclusive). Default `0.5`. */
  readonly threshold?: number;
  /** Optional override for the model's temperature. */
  readonly temperature?: number;
}

/**
 * Invoke an LLM judge to evaluate a guardrail. Resolves a model via
 * the capability router (or uses `bindings.judgeProvider` if set), sends
 * a structured judgment prompt including the run trace + rubric, parses
 * the response. The call is recorded in `bindings.usage` (the cost
 * ledger) before its judgment is used, a call that threw included;
 * `guardrailId` says which guardrail it judged.
 */
export async function invokeJudge(
  config: LlmJudgeConfig,
  capability: Capability,
  trace: RunTrace,
  bindings: EvaluationBindings,
  guardrailId?: string,
): Promise<CheckResult | { readonly error: JudgeMissingError | JudgeRoutingError }> {
  const provider = await resolveJudgeProvider(capability, trace, bindings);
  if ('error' in provider) return provider;

  const responseFormat = config.responseFormat ?? 'pass-fail';
  const rubric = config.rubric;
  const prompt = buildJudgePrompt(rubric, responseFormat, trace);

  const record = (call: JudgeCallOutcome): Promise<void> =>
    recordJudgeCall(bindings, trace, provider, guardrailId, call);
  const callId = randomUUID();
  const startedAt = Date.now();
  let result: ModelCallResult;
  try {
    result = await provider.provider.invoke({
      model: provider.model.name,
      messages: [
        {
          role: 'system',
          content:
            responseFormat === 'pass-fail'
              ? 'You are an evaluator. Respond starting with PASS or FAIL on the first line, then a brief reason on the next line. No preamble.'
              : 'You are an evaluator. Respond with a numeric score from 0 to 1 on the first line, then a brief reason on the next line. No preamble.',
        },
        { role: 'user', content: prompt },
      ],
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      maxOutputTokens: 256,
      ...(bindings.abortSignal !== undefined && { abortSignal: bindings.abortSignal }),
    });
  } catch (cause) {
    await record({
      callId,
      status: 'failed',
      error: { message: cause instanceof Error ? cause.message : String(cause) },
      durationMs: Date.now() - startedAt,
    });
    throw cause;
  }
  const { message: _answer, ...used } = result;
  await record({ callId, status: 'ok', result: used, durationMs: result.durationMs });

  const text = result.message.content.trim();
  return parseJudgeResponse(text, responseFormat, config.threshold);
}

/** What a judge call came to, for `recordJudgeCall`. */
type JudgeCallOutcome = Pick<
  ModelUsageRecord,
  'callId' | 'status' | 'result' | 'error' | 'durationMs'
>;

/** Record a judge call in the usage sink, with the run's identity from the trace. */
async function recordJudgeCall(
  bindings: EvaluationBindings,
  trace: RunTrace,
  provider: ResolvedProvider,
  guardrailId: string | undefined,
  call: JudgeCallOutcome,
): Promise<void> {
  if (bindings.usage === undefined) return;
  await bindings.usage.record({
    ...call,
    tenantId: trace.tenantId,
    ...(trace.projectId !== undefined && { projectId: trace.projectId }),
    runId: trace.runId,
    ...(trace.agentId !== undefined && { agentId: trace.agentId as unknown as string }),
    providerId: provider.provider.metadata.id,
    model: provider.model.name,
    ...(provider.provider.metadata.fallback === true && { fallback: true }),
    purpose: guardrailId !== undefined ? `guardrail-judge:${guardrailId}` : 'guardrail-judge',
    occurredAt: new Date().toISOString(),
  });
}

interface ResolvedProvider {
  readonly provider: ModelProvider;
  readonly model: ModelInfo;
  readonly reason: string;
}

async function resolveJudgeProvider(
  capability: Capability,
  trace: RunTrace,
  bindings: EvaluationBindings,
): Promise<ResolvedProvider | { readonly error: JudgeMissingError | JudgeRoutingError }> {
  if (bindings.judgeProvider !== undefined && bindings.tenantPolicy !== undefined) {
    // Override under a tenant policy: route over the override alone, so
    // the policy (and the judge capability) still apply.
    const decision = route({
      capability,
      providers: [bindings.judgeProvider],
      tenantPolicy: bindings.tenantPolicy,
    });
    if (decision.kind === 'err') {
      const err: JudgeRoutingError = {
        code: 'judge-routing-failed',
        message: `Explicit judgeProvider "${bindings.judgeProvider.metadata.id}" is not allowed for this tenant: ${decision.error.message}`,
        guardrailId: '<unknown>' as never,
        cause: decision.error,
      };
      return { error: err };
    }
    return {
      provider: decision.value.provider,
      model: decision.value.model,
      reason: `explicit judgeProvider override; ${decision.value.reason}`,
    };
  }
  if (bindings.judgeProvider !== undefined) {
    // Direct provider override without a tenant policy — no routing
    // decision, so pick the provider's first advertised model. Callers
    // who need a specific model within the override should go through
    // `providerRegistry` + the router.
    const provider = bindings.judgeProvider;
    const first = provider.metadata.models[0];
    if (first === undefined) {
      const err: JudgeRoutingError = {
        code: 'judge-routing-failed',
        message: `Explicit judgeProvider "${provider.metadata.id}" exposes zero models`,
        guardrailId: '<unknown>' as never,
        cause: {
          code: 'capability-unsatisfiable',
          message: 'judgeProvider has no models',
          reasons: [],
        },
      };
      return { error: err };
    }
    return { provider, model: first, reason: 'explicit judgeProvider override' };
  }
  if (bindings.providerRegistry === undefined) {
    const err: JudgeMissingError = {
      code: 'judge-missing',
      message:
        'llm-judge guardrail evaluated without providerRegistry or judgeProvider in bindings',
      guardrailId: '<unknown>' as never,
    };
    return { error: err };
  }
  const decision = route({
    capability,
    providers: bindings.providerRegistry.list(trace.tenantId),
    ...(bindings.tenantPolicy !== undefined && { tenantPolicy: bindings.tenantPolicy }),
  });
  if (decision.kind === 'err') {
    const err: JudgeRoutingError = {
      code: 'judge-routing-failed',
      message: `Judge routing failed: ${decision.error.message}`,
      guardrailId: '<unknown>' as never,
      cause: decision.error,
    };
    return { error: err };
  }
  return {
    provider: decision.value.provider,
    model: decision.value.model,
    reason: decision.value.reason,
  };
}

function buildJudgePrompt(rubric: string, format: 'pass-fail' | 'score', trace: RunTrace): string {
  const lines = [
    'Evaluate the following agent run against the rubric.',
    '',
    '=== Rubric ===',
    rubric,
    '',
    '=== Run output ===',
    trace.output ?? '<empty>',
    '',
    '=== Tool calls ===',
    trace.toolCalls.length === 0
      ? '<none>'
      : trace.toolCalls.map((c) => `- ${c.toolName}(${JSON.stringify(c.arguments)})`).join('\n'),
    '',
    format === 'pass-fail'
      ? 'Respond PASS or FAIL then reason.'
      : 'Respond with a score in [0, 1] then reason.',
  ];
  return lines.join('\n');
}

function parseJudgeResponse(
  raw: string,
  format: 'pass-fail' | 'score',
  threshold: number | undefined,
): CheckResult {
  if (format === 'pass-fail') {
    const upper = raw.toUpperCase();
    if (upper.startsWith('PASS')) {
      const reasonLine = raw.split(/\r?\n/)[1]?.trim() ?? '';
      const result: CheckResult = { passed: true, judgeResponse: raw };
      return reasonLine.length > 0 ? { ...result, reason: reasonLine } : result;
    }
    if (upper.startsWith('FAIL')) {
      const reasonLine = raw.split(/\r?\n/)[1]?.trim() ?? '';
      return {
        passed: false,
        reason: reasonLine.length > 0 ? reasonLine : 'judge returned FAIL',
        judgeResponse: raw,
      };
    }
    return {
      passed: false,
      reason: `judge response did not start with PASS/FAIL: ${raw.slice(0, 80)}`,
      judgeResponse: raw,
    };
  }
  // score format
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
  const score = Number.parseFloat(firstLine);
  if (!Number.isFinite(score)) {
    return {
      passed: false,
      reason: `judge did not return a numeric score: ${firstLine}`,
      judgeResponse: raw,
    };
  }
  const cutoff = threshold ?? 0.5;
  const reasonLine = raw.split(/\r?\n/)[1]?.trim() ?? '';
  return {
    passed: score >= cutoff,
    reason: reasonLine.length > 0 ? reasonLine : `score=${score}, threshold=${cutoff}`,
    judgeResponse: raw,
    attributes: { score, threshold: cutoff },
  };
}
