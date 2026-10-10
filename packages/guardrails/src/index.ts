// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  GUARDRAIL_SCHEMA_URI,
  GUARDRAIL_SPEC_KEYS,
  defineGuardrail,
  validateGuardrailSpec,
} from './define.js';
export { defineCheck } from './define-check.js';
export { describeGuardrailConfigProblems, guardrailConfigProblems } from './config-problems.js';
export type { GuardrailConfigProblem, GuardrailConfigProblemsInput } from './config-problems.js';
export type { DefineCheckSpec, DefinedCheck, InferCheckConfig } from './define-check.js';
export { BUILT_IN_CHECK_IDS, createCheckRegistry } from './checks.js';
export {
  BUILT_IN_ACTION_HANDLERS,
  compensateHandler,
  createActionHandlerRegistry,
  escalateHandler,
  haltHandler,
  logOnlyHandler,
  noopHandler,
  retryHandler,
} from './action-handler.js';
export type {
  ActionContext,
  ActionHandler,
  ActionHandlerRegistry,
  ActionResult,
} from './action-handler.js';
export { builtInStrategies, evaluateAll, evaluateGuardrail, violations } from './engine.js';
export type { EvaluationOutcome } from './engine.js';
export {
  createExecutionStrategyRegistry,
  externalStrategy,
  makeLlmJudgeStrategy,
  zeroLlmStrategy,
} from './execution-strategy.js';
export type {
  ExecutionStrategy,
  ExecutionStrategyRegistry,
  StrategyError,
  StrategyResult,
} from './execution-strategy.js';
export { JUDGE_THINKING_TOKENS, JUDGE_VERDICT_TOKENS, invokeJudge } from './judge.js';
export type { LlmJudgeConfig } from './judge.js';
export type {
  Action,
  Budget,
  BuiltInGuardrailKind,
  BuiltInOnViolation,
  CheckFunction,
  CheckRegistry,
  CheckResult,
  CodeArtifactRef,
  EvaluationBindings,
  EvaluationResult,
  Guardrail,
  GuardrailKind,
  GuardrailSeverity,
  JsonSchema,
  ModelCallRecord,
  NetworkPolicy,
  OnViolation,
  RegisteredCheck,
  RunTrace,
  RuntimeLimits,
  SandboxMode,
  Scope,
  ScopeWhen,
  ToolCallRecord,
  ToolResultRecord,
  TypedNeeds,
} from './types.js';
export { BUILT_IN_GUARDRAIL_KINDS, BUILT_IN_ON_VIOLATIONS } from './types.js';
export type {
  CheckFailedError,
  InvalidCheckConfigError,
  InvalidCheckDefinitionError,
  InvalidGuardrailError,
  GuardrailError,
  JudgeMissingError,
  JudgeRoutingError,
  JudgeUsageError,
  ScopeMismatchError,
  UnknownActionError,
  UnknownCheckError,
} from './errors.js';
