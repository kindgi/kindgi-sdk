// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type {
  BackoffShape,
  ConvergenceMode,
  EdgePolicy,
  Expr,
  FanoutBranch,
  FanoutNode,
  ForeachLoopNode,
  Flow,
  FlowEdge,
  FlowNode,
  FlowOutputSpec,
  LeafNode,
  LiteralOperand,
  LoopBody,
  LoopEdge,
  LoopNode,
  LoopOutputSchema,
  Mapping,
  Operand,
  OperatorName,
  Path,
  PathOperand,
  PathRoot,
  RetryPolicy,
  SubflowConvergence,
  SubflowNode,
  SubflowRef,
  WhileLoopNode,
} from './types.js';
export {
  CONVERGENCE_MODES,
  EDGE_POLICY_PRIORITY_DEFAULT,
  EDGE_POLICY_PRIORITY_MAX,
  EDGE_POLICY_PRIORITY_MIN,
  END_NODE,
  LOOP_END_NODE,
  LOOP_START_NODE,
  OPERATORS,
  SENTINEL_IDS,
  START_NODE,
  SUBGRAPH_CONVERGENCE_MODES,
  isFanoutNode,
  isLeafNode,
  isLoopNode,
  isSubflowNode,
} from './types.js';

export type {
  CycleError,
  DuplicateEdgeError,
  DuplicateNodeError,
  FlowError,
  InvalidEdgePolicyError,
  InvalidFanoutNodeError,
  InvalidFlowOutputError,
  InvalidMappingError,
  InvalidPredicateError,
  InvalidSubflowNodeError,
  LoopBodyCycleError,
  LoopBodyEdgeReferenceError,
  LoopBodyMissingStartError,
  LoopConcurrencyError,
  LoopMaxIterationsError,
  LoopOutputSchemaError,
  LoopVariantMismatchError,
  MissingStartEdgeError,
  ReservedIdError,
  SchemaValidationError,
  UnknownNodeReferenceError,
} from './errors.js';

export { GRAPH_SCHEMA_URI, loadFlow } from './loader.js';

export { defineFlow } from './define.js';
export type { FlowSpec } from './define.js';

export { evaluateExpr, MISSING_PATH, resolveMapping, resolvePath } from './evaluator.js';
export type { EvalEnv } from './evaluator.js';

export { getEffectivePriority, schedulerTick } from './scheduler.js';
export type { PendingEdgeEval, SchedulerState, SchedulerTick } from './scheduler.js';
