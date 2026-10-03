// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeId, Result } from '@kindgi/types';

import { compileInlineSchema, createSpecRegistry } from '@kindgi/schema';
import type { SpecRegistry } from '@kindgi/schema';

import type {
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
import flowSchema from './flow.schema.json' with { type: 'json' };
import type {
  ConvergenceMode,
  EdgePolicy,
  Expr,
  FanoutNode,
  Flow,
  FlowEdge,
  FlowNode,
  LoopBody,
  LoopEdge,
  LoopNode,
  Mapping,
  Operand,
  RetryPolicy,
  SubflowConvergence,
  SubflowNode,
} from './types.js';
import {
  CONVERGENCE_MODES,
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

const GRAPH_SCHEMA_ID = 'https://kindgi.com/schemas/v1/flow.schema.json';

// Registry is lazy — first loadFlow() call builds it once, subsequent calls reuse.
let cachedRegistry: SpecRegistry | undefined;

function registry(): SpecRegistry {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const built = createSpecRegistry([flowSchema]);
  if (built.kind === 'err') {
    throw new Error(`@kindgi/flow: bundled schema failed to compile: ${built.error.message}`);
  }
  cachedRegistry = built.value;
  return cachedRegistry;
}

/**
 * The semantic passes after schema conformance, in order (fail-fast);
 * see `loadFlow` for what each covers.
 */
const SEMANTIC_CHECKS: readonly ((flow: Flow) => FlowError | undefined)[] = [
  checkReservedIds,
  checkGlobalDuplicateNodes,
  checkGlobalDuplicateEdges,
  checkOuterEdgeReferences,
  checkAllPredicates,
  checkAllEdgePolicies,
  checkAllLoopMaxIterations,
  checkAllLoopVariants,
  checkAllLoopOutputSchemas,
  checkAllLoopConcurrency,
  checkAllFanoutNodes,
  checkAllSubflowNodes,
  checkAllMappings,
  checkFlowOutputSchema,
  checkStartEdge,
  detectOuterCycle,
  validateAllLoopBodies,
];

/**
 * Validate a flow definition and return a strongly-typed `Flow` on success.
 *
 * Runs in this order (fail-fast; `SEMANTIC_CHECKS` after step 1):
 *   1. JSON-schema conformance against flow.schema.json.
 *   2. Reserved-id check — sentinels ($start/$end/$loop-start/$loop-end) may
 *      not be node ids, at any nesting level.
 *   3. GLOBAL uniqueness of node ids across outer flow AND every loop body
 *      at every nesting level.
 *   4. Duplicate edge ids across outer + all bodies.
 *   5. Outer-edge endpoint resolution (from/to must be a known outer-scope
 *      node or $start/$end).
 *   6. Predicate structural check on every `when` (outer + body edges) and
 *      every loop node's `exitCondition`.
 *   7. Edge-policy bounds (`retry`, `timeoutMs`, `concurrencyKey`,
 *      `priority`).
 *   8. `maxIterations` range check for every loop node.
 *   9. Loop variant integrity (`while` vs `foreach` fields).
 *   10. Every loop `outputSchema` compiles.
 *   11. Foreach `concurrency` bounds.
 *   12. Fanout node rules (branches, `concurrency`, `convergence`,
 *       per-branch `outputSchema`).
 *   13. Subgraph node rules (`flowRef`, `inputMapping`, `outputSchema`,
 *       `convergence`).
 *   14. Data-flow mappings (1.8.0): every leaf `inputMapping` and the
 *       flow's `output.mapping` names only nodes of the flow, never the
 *       node's own output, and no loop-only root.
 *   15. The flow's `output.schema` compiles.
 *   16. Outer flow must have at least one $start-rooted edge.
 *   17. Outer flow cycle detection (Kahn's algorithm on the outer DAG).
 *   18. Per loop-body: has a $loop-start-rooted edge; body-edge endpoints
 *       resolve to body nodes or $loop-start / $loop-end sentinels; body
 *       sub-DAG cycle detection.
 *
 * The loader is pure: no I/O, no side effects, safe to call from anywhere.
 */
export function loadFlow(input: unknown): Result<Flow, FlowError> {
  const schemaResult = registry().validate<Flow>(GRAPH_SCHEMA_ID, input);
  if (schemaResult.kind === 'err') {
    const err = schemaResult.error;
    if (err.code !== 'validation-error') {
      throw new Error(`@kindgi/flow: unexpected schema error ${err.code}: ${err.message}`);
    }
    return { kind: 'err', error: toSchemaValidationError(err) };
  }
  const flow = schemaResult.value;

  for (const check of SEMANTIC_CHECKS) {
    const error = check(flow);
    if (error !== undefined) return { kind: 'err', error };
  }
  return { kind: 'ok', value: flow };
}

function toSchemaValidationError(err: {
  readonly errors: readonly unknown[];
  readonly message: string;
}): SchemaValidationError {
  const issues = err.errors.map((e) => {
    const ajvErr = e as { instancePath?: unknown; message?: unknown };
    return {
      path: typeof ajvErr.instancePath === 'string' ? ajvErr.instancePath : '',
      message: typeof ajvErr.message === 'string' ? ajvErr.message : 'validation failed',
    };
  });
  return {
    code: 'schema-validation-failed',
    message: err.message,
    issues,
  };
}

// ============ reserved ids ============

function checkReservedIds(flow: Flow): ReservedIdError | undefined {
  const sentinels = new Set<string>(SENTINEL_IDS);
  for (const node of collectAllNodes(flow)) {
    if (sentinels.has(node.id)) {
      return {
        code: 'reserved-id',
        message: `Node id "${node.id}" is reserved as a flow sentinel and may not name a node`,
        flowId: flow.id,
        nodeId: node.id,
      };
    }
  }
  return undefined;
}

// ============ global duplicate detection (walks into loop bodies) ============

function checkGlobalDuplicateNodes(flow: Flow): DuplicateNodeError | undefined {
  const seen = new Set<string>();
  for (const node of collectAllNodes(flow)) {
    if (seen.has(node.id)) {
      return {
        code: 'duplicate-node-id',
        message: `Node id "${node.id}" is used more than once (across outer flow and loop bodies)`,
        flowId: flow.id,
        nodeId: node.id,
      };
    }
    seen.add(node.id);
  }
  return undefined;
}

function checkGlobalDuplicateEdges(flow: Flow): DuplicateEdgeError | undefined {
  const seen = new Set<string>();
  for (const edge of flow.edges) {
    if (seen.has(edge.id)) return dupEdge(flow, edge.id);
    seen.add(edge.id);
  }
  for (const loop of collectAllLoopNodes(flow)) {
    for (const edge of loop.body.edges) {
      if (seen.has(edge.id)) return dupEdge(flow, edge.id);
      seen.add(edge.id);
    }
  }
  return undefined;
}

function dupEdge(flow: Flow, edgeId: string): DuplicateEdgeError {
  return {
    code: 'duplicate-edge-id',
    message: `Edge id "${edgeId}" is used more than once (across outer flow and loop bodies)`,
    flowId: flow.id,
    edgeId: edgeId as never,
  };
}

/** Flatten every node in the flow (outer + all loop bodies at any nesting). */
function collectAllNodes(flow: Flow): readonly FlowNode[] {
  const acc: FlowNode[] = [];
  const walk = (nodes: readonly FlowNode[]): void => {
    for (const node of nodes) {
      acc.push(node);
      if (isLoopNode(node)) walk(node.body.nodes);
    }
  };
  walk(flow.nodes);
  return acc;
}

function collectAllLoopNodes(flow: Flow): readonly LoopNode[] {
  const acc: LoopNode[] = [];
  for (const node of collectAllNodes(flow)) {
    if (isLoopNode(node)) acc.push(node);
  }
  return acc;
}

// ============ outer-flow edge reference resolution ============

function checkOuterEdgeReferences(flow: Flow): UnknownNodeReferenceError | undefined {
  const outerNodeIds = new Set<string>(flow.nodes.map((n) => n.id));
  for (const edge of flow.edges) {
    if (edge.from !== START_NODE && !outerNodeIds.has(edge.from)) {
      return unknownEdgeRef(flow, edge, 'from', edge.from);
    }
    if (edge.to !== END_NODE && !outerNodeIds.has(edge.to)) {
      return unknownEdgeRef(flow, edge, 'to', edge.to);
    }
  }
  return undefined;
}

function unknownEdgeRef(
  flow: Flow,
  edge: FlowEdge,
  endpoint: 'from' | 'to',
  referencedId: string,
): UnknownNodeReferenceError {
  return {
    code: 'unknown-node-reference',
    message: `Edge "${edge.id}" ${endpoint} unknown node "${referencedId}"`,
    flowId: flow.id,
    edgeId: edge.id,
    endpoint,
    referencedId,
  };
}

// ============ start-edge check (outer flow) ============

function checkStartEdge(flow: Flow): MissingStartEdgeError | undefined {
  const hasStart = flow.edges.some((e) => e.from === START_NODE);
  if (hasStart) return undefined;
  return {
    code: 'missing-start-edge',
    message: `Flow "${flow.id}" has no edge originating at $start`,
    flowId: flow.id,
  };
}

// ============ predicate validation (outer edges + body edges + loop exit conditions) ============

function checkAllPredicates(flow: Flow): InvalidPredicateError | undefined {
  for (const edge of flow.edges) {
    if (edge.when === undefined) continue;
    const reason = validateExprStructure(edge.when);
    if (reason !== undefined) {
      return {
        code: 'invalid-predicate',
        message: `Edge "${edge.id}" has an invalid predicate: ${reason}`,
        flowId: flow.id,
        edgeId: edge.id,
        reason,
      };
    }
  }
  for (const loop of collectAllLoopNodes(flow)) {
    if (loop.loopKind === 'while') {
      const exitReason = validateExprStructure(loop.exitCondition);
      if (exitReason !== undefined) {
        return {
          code: 'invalid-predicate',
          message: `Loop node "${loop.id}" has an invalid exitCondition: ${exitReason}`,
          flowId: flow.id,
          edgeId: loop.id as never,
          reason: exitReason,
        };
      }
    }
    for (const edge of loop.body.edges) {
      if (edge.when === undefined) continue;
      const reason = validateExprStructure(edge.when);
      if (reason !== undefined) {
        return {
          code: 'invalid-predicate',
          message: `Loop "${loop.id}" body edge "${edge.id}" has an invalid predicate: ${reason}`,
          flowId: flow.id,
          edgeId: edge.id,
          reason,
        };
      }
    }
  }
  return undefined;
}

function validateExprStructure(expr: Expr): string | undefined {
  if (!(OPERATORS as readonly string[]).includes(expr.op)) {
    return `unknown operator "${expr.op}"`;
  }
  switch (expr.op) {
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return validateBinaryOperands(expr.left, expr.right);
    case 'in':
    case 'notIn':
      return validateMembership(expr.value, expr.set);
    case 'exists':
    case 'notExists':
    case 'truthy':
    case 'falsy':
      return validateOperand(expr.value);
    case 'and':
    case 'or':
      return validateChildren(expr.op, expr.children);
    case 'not':
      return validateExprStructure(expr.child);
  }
}

function validateBinaryOperands(left: Operand, right: Operand): string | undefined {
  const l = validateOperand(left);
  if (l) return `left: ${l}`;
  const r = validateOperand(right);
  if (r) return `right: ${r}`;
  return undefined;
}

function validateMembership(value: Operand, set: Operand): string | undefined {
  const v = validateOperand(value);
  if (v) return `value: ${v}`;
  const s = validateOperand(set);
  if (s) return `set: ${s}`;
  return undefined;
}

function validateChildren(op: 'and' | 'or', children: readonly Expr[]): string | undefined {
  if (children.length === 0) return `${op} requires at least one child`;
  for (const child of children) {
    const reason = validateExprStructure(child);
    if (reason) return reason;
  }
  return undefined;
}

function validateOperand(operand: Operand): string | undefined {
  if ('literal' in operand) return undefined;
  if ('path' in operand) {
    if (typeof operand.path !== 'string' || operand.path.length === 0) {
      return 'path must be a non-empty string';
    }
    return undefined;
  }
  return 'operand must be a {literal} or {path}';
}

// ============ edge policy validation (retry, timeoutMs, concurrencyKey, priority) ============

/**
 * Validate `FlowEdge.policy` on outer + loop-body edges. Schema catches the
 * shape (wrong types, unknown fields); this pass enforces the semantic
 * rules the schema can't express:
 *   - `retry.maxAttempts` in `[1, 10]`.
 *   - `retry.delayMs` non-negative (the schema also enforces integer ≥ 0;
 *     repeated so this check stands on its own).
 *   - `retry.backoff` in `{'fixed', 'linear', 'exponential'}`.
 *   - `retry.backoff = 'exponential'` requires `retry.maxDelayMs`.
 *   - `timeoutMs` in `[1, 3_600_000]` (1 hour cap).
 *   - `concurrencyKey` non-empty, ≤ 256 chars, printable ASCII only.
 *   - `priority` integer in `[-100, 100]` (default 0 when omitted).
 *
 * `EdgePolicy` is a closed surface — `retry`, `timeoutMs`,
 * `concurrencyKey`, and `priority` are the complete set. There is no
 * `suspend` field; declarative suspension uses `ctx.waitForToken` at
 * handler level. Unknown edge-policy keys are
 * rejected at the schema step (`additionalProperties: false`).
 */
function checkAllEdgePolicies(flow: Flow): InvalidEdgePolicyError | undefined {
  for (const edge of flow.edges) {
    const err = checkEdgePolicy(flow, edge.id, edge.policy);
    if (err) return err;
  }
  // Loop-body edges (LoopEdge) carry no `policy`: the JSON schema's
  // `LoopEdge` has `additionalProperties: false`, so a `policy` on a body
  // edge is rejected at the schema step.
  return undefined;
}

function checkEdgePolicy(
  flow: Flow,
  edgeId: string,
  policy: EdgePolicy | undefined,
): InvalidEdgePolicyError | undefined {
  if (policy === undefined) return undefined;
  if (policy.retry !== undefined) {
    const retryErr = checkRetryPolicy(flow, edgeId, policy.retry);
    if (retryErr) return retryErr;
  }
  if (policy.timeoutMs !== undefined) {
    const timeoutErr = checkTimeoutMs(flow, edgeId, policy.timeoutMs);
    if (timeoutErr) return timeoutErr;
  }
  if (policy.concurrencyKey !== undefined) {
    const keyErr = checkConcurrencyKey(flow, edgeId, policy.concurrencyKey);
    if (keyErr) return keyErr;
  }
  if (policy.priority !== undefined) {
    const priorityErr = checkPriority(flow, edgeId, policy.priority);
    if (priorityErr) return priorityErr;
  }
  return undefined;
}

const TIMEOUT_MS_MAX = 3_600_000;
const CONCURRENCY_KEY_MAX_LENGTH = 256;
const PRINTABLE_ASCII_REGEX = /^[\x20-\x7E]+$/;
const PRIORITY_MIN = -100;
const PRIORITY_MAX = 100;

function checkPriority(
  flow: Flow,
  edgeId: string,
  priority: unknown,
): InvalidEdgePolicyError | undefined {
  if (typeof priority !== 'number') {
    return policyErr(flow, edgeId, 'priority', `must be a number (got ${typeof priority})`);
  }
  if (!Number.isInteger(priority)) {
    return policyErr(flow, edgeId, 'priority', `must be an integer (got ${priority})`);
  }
  if (priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
    return policyErr(
      flow,
      edgeId,
      'priority',
      `must be within [${PRIORITY_MIN}, ${PRIORITY_MAX}] (got ${priority})`,
    );
  }
  return undefined;
}

function checkConcurrencyKey(
  flow: Flow,
  edgeId: string,
  key: unknown,
): InvalidEdgePolicyError | undefined {
  if (typeof key !== 'string') {
    return policyErr(flow, edgeId, 'concurrencyKey', 'must be a string');
  }
  if (key.length === 0) {
    return policyErr(flow, edgeId, 'concurrencyKey', 'must not be empty');
  }
  if (key.length > CONCURRENCY_KEY_MAX_LENGTH) {
    return policyErr(
      flow,
      edgeId,
      'concurrencyKey',
      `must be <= ${CONCURRENCY_KEY_MAX_LENGTH} chars (got ${key.length})`,
    );
  }
  if (!PRINTABLE_ASCII_REGEX.test(key)) {
    return policyErr(
      flow,
      edgeId,
      'concurrencyKey',
      'must contain only printable ASCII (0x20..0x7E)',
    );
  }
  return undefined;
}

function checkTimeoutMs(
  flow: Flow,
  edgeId: string,
  timeoutMs: number,
): InvalidEdgePolicyError | undefined {
  if (!Number.isInteger(timeoutMs)) {
    return policyErr(flow, edgeId, 'timeoutMs', `must be an integer (got ${timeoutMs})`);
  }
  if (timeoutMs < 1) {
    return policyErr(flow, edgeId, 'timeoutMs', `must be >= 1 (got ${timeoutMs})`);
  }
  if (timeoutMs > TIMEOUT_MS_MAX) {
    return policyErr(
      flow,
      edgeId,
      'timeoutMs',
      `must be <= ${TIMEOUT_MS_MAX} (1 hour cap; got ${timeoutMs})`,
    );
  }
  return undefined;
}

function checkRetryPolicy(
  flow: Flow,
  edgeId: string,
  retry: RetryPolicy,
): InvalidEdgePolicyError | undefined {
  if (!Number.isInteger(retry.maxAttempts)) {
    return policyErr(flow, edgeId, 'retry.maxAttempts', 'must be an integer');
  }
  if (retry.maxAttempts < 1 || retry.maxAttempts > 10) {
    return policyErr(
      flow,
      edgeId,
      'retry.maxAttempts',
      `must be within [1, 10] (got ${retry.maxAttempts})`,
    );
  }
  if (retry.delayMs !== undefined) {
    if (!Number.isInteger(retry.delayMs) || retry.delayMs < 0) {
      return policyErr(
        flow,
        edgeId,
        'retry.delayMs',
        `must be a non-negative integer (got ${retry.delayMs})`,
      );
    }
  }
  if (retry.backoff !== undefined) {
    if (
      retry.backoff !== 'fixed' &&
      retry.backoff !== 'linear' &&
      retry.backoff !== 'exponential'
    ) {
      return policyErr(
        flow,
        edgeId,
        'retry.backoff',
        `must be one of "fixed" | "linear" | "exponential" (got ${String(retry.backoff)})`,
      );
    }
  }
  if (retry.maxDelayMs !== undefined) {
    if (!Number.isInteger(retry.maxDelayMs) || retry.maxDelayMs < 0) {
      return policyErr(
        flow,
        edgeId,
        'retry.maxDelayMs',
        `must be a non-negative integer (got ${retry.maxDelayMs})`,
      );
    }
  }
  if (retry.backoff === 'exponential' && retry.maxDelayMs === undefined) {
    return policyErr(
      flow,
      edgeId,
      'retry.maxDelayMs',
      'is required when retry.backoff is "exponential" (unbounded growth otherwise)',
    );
  }
  return undefined;
}

function policyErr(
  flow: Flow,
  edgeId: string,
  field: InvalidEdgePolicyError['field'],
  reason: string,
): InvalidEdgePolicyError {
  return {
    code: 'invalid-edge-policy',
    message: `Edge "${edgeId}" has an invalid policy at ${field}: ${reason}`,
    flowId: flow.id,
    edgeId: edgeId as never,
    field,
    reason,
  };
}

// ============ loop-specific bounds check ============

function checkAllLoopMaxIterations(flow: Flow): LoopMaxIterationsError | undefined {
  for (const loop of collectAllLoopNodes(flow)) {
    if (!Number.isInteger(loop.maxIterations)) {
      return loopBoundsErr(flow, loop, 'maxIterations must be an integer');
    }
    if (loop.maxIterations < 1) {
      return loopBoundsErr(flow, loop, 'maxIterations must be >= 1');
    }
    if (loop.maxIterations > 10000) {
      return loopBoundsErr(flow, loop, 'maxIterations must be <= 10000');
    }
  }
  return undefined;
}

function loopBoundsErr(flow: Flow, loop: LoopNode, reason: string): LoopMaxIterationsError {
  return {
    code: 'loop-invalid-max-iterations',
    message: `Loop node "${loop.id}": ${reason} (got ${loop.maxIterations})`,
    flowId: flow.id,
    loopNodeId: loop.id,
    value: loop.maxIterations,
  };
}

// ============ loop variant integrity (direct check alongside the JSON-schema oneOf) ============

function checkAllLoopVariants(flow: Flow): LoopVariantMismatchError | undefined {
  for (const loop of collectAllLoopNodes(flow)) {
    const err = checkLoopVariant(flow, loop);
    if (err) return err;
  }
  return undefined;
}

function checkLoopVariant(flow: Flow, loop: LoopNode): LoopVariantMismatchError | undefined {
  const raw = loop as unknown as Record<string, unknown>;
  if (loop.loopKind === 'while') {
    if (raw.exitCondition === undefined) {
      return variantErr(flow, loop, 'while', 'while-missing-exit-condition');
    }
    if (raw.iterateOver !== undefined) {
      return variantErr(flow, loop, 'while', 'while-has-iterate-over');
    }
    if (raw.concurrency !== undefined) {
      // Parallel while loops are semantically undefined (each iteration
      // depends on the previous iteration's output). Only foreach loops
      // carry `concurrency`.
      return variantErr(flow, loop, 'while', 'while-has-concurrency');
    }
    if (
      loop.evaluationTiming !== undefined &&
      loop.evaluationTiming !== 'before' &&
      loop.evaluationTiming !== 'after'
    ) {
      return variantErr(flow, loop, 'while', 'while-has-invalid-evaluation-timing');
    }
    return undefined;
  }
  if (loop.loopKind === 'foreach') {
    if (raw.iterateOver === undefined) {
      return variantErr(flow, loop, 'foreach', 'foreach-missing-iterate-over');
    }
    if (raw.exitCondition !== undefined) {
      return variantErr(flow, loop, 'foreach', 'foreach-has-exit-condition');
    }
    if (raw.evaluationTiming !== undefined) {
      return variantErr(flow, loop, 'foreach', 'foreach-has-evaluation-timing');
    }
    return undefined;
  }
  return undefined;
}

function variantErr(
  flow: Flow,
  loop: LoopNode,
  loopKind: 'while' | 'foreach',
  problem: LoopVariantMismatchError['problem'],
): LoopVariantMismatchError {
  return {
    code: 'loop-variant-mismatch',
    message: `Loop node "${loop.id}" (loopKind=${loopKind}): ${problem}`,
    flowId: flow.id,
    loopNodeId: loop.id,
    loopKind,
    problem,
  };
}

// ============ foreach concurrency bounds check ============

const LOOP_CONCURRENCY_CAP = 32;

function checkAllLoopConcurrency(flow: Flow): LoopConcurrencyError | undefined {
  for (const loop of collectAllLoopNodes(flow)) {
    if (loop.loopKind !== 'foreach') continue;
    if (loop.concurrency === undefined) continue;
    const err = checkLoopConcurrency(flow, loop.id, loop.concurrency, loop.maxIterations);
    if (err) return err;
  }
  return undefined;
}

function checkLoopConcurrency(
  flow: Flow,
  loopNodeId: NodeId,
  value: number,
  maxIterations: number,
): LoopConcurrencyError | undefined {
  if (!Number.isInteger(value)) {
    return concurrencyErr(flow, loopNodeId, value, 'not-integer', 'must be an integer');
  }
  if (value < 1) {
    return concurrencyErr(flow, loopNodeId, value, 'below-minimum', 'must be >= 1');
  }
  if (value > LOOP_CONCURRENCY_CAP) {
    return concurrencyErr(
      flow,
      loopNodeId,
      value,
      'exceeds-cap',
      `must be <= ${LOOP_CONCURRENCY_CAP} (safety cap)`,
    );
  }
  if (value > maxIterations) {
    return concurrencyErr(
      flow,
      loopNodeId,
      value,
      'exceeds-max-iterations',
      `must be <= maxIterations (${maxIterations})`,
    );
  }
  return undefined;
}

function concurrencyErr(
  flow: Flow,
  loopNodeId: NodeId,
  value: number,
  reason: LoopConcurrencyError['reason'],
  detail: string,
): LoopConcurrencyError {
  return {
    code: 'loop-invalid-concurrency',
    message: `Loop node "${loopNodeId}": concurrency ${detail} (got ${value})`,
    flowId: flow.id,
    loopNodeId,
    value,
    reason,
  };
}

// ============ fanout node validation (1.6.0) ============

function collectAllFanoutNodes(flow: Flow): readonly FanoutNode[] {
  const acc: FanoutNode[] = [];
  for (const node of collectAllNodes(flow)) {
    if (isFanoutNode(node)) acc.push(node);
  }
  return acc;
}

function checkAllFanoutNodes(flow: Flow): InvalidFanoutNodeError | undefined {
  for (const fanout of collectAllFanoutNodes(flow)) {
    const err = checkFanoutNode(flow, fanout);
    if (err) return err;
  }
  return undefined;
}

function checkFanoutNode(flow: Flow, fanout: FanoutNode): InvalidFanoutNodeError | undefined {
  // JSON schema minItems: 2 already catches this at the schema step;
  // repeated so this check stands on its own.
  if (!Array.isArray(fanout.branches) || fanout.branches.length < 2) {
    return fanoutErr(flow, fanout.id, 'branches', 'must declare at least 2 branches');
  }
  const seenBranchIds = new Set<string>();
  for (const branch of fanout.branches) {
    if (typeof branch.branchId !== 'string' || branch.branchId.length === 0) {
      return fanoutErr(
        flow,
        fanout.id,
        'branch-id',
        'each branch must declare a non-empty string branchId',
      );
    }
    if (seenBranchIds.has(branch.branchId)) {
      return fanoutErr(
        flow,
        fanout.id,
        'branch-id',
        `duplicate branchId "${branch.branchId}" within fanout`,
        branch.branchId,
      );
    }
    seenBranchIds.add(branch.branchId);
    if (typeof branch.handler !== 'string' || branch.handler.length === 0) {
      return fanoutErr(
        flow,
        fanout.id,
        'branch-handler',
        `branch "${branch.branchId}" must declare a non-empty string handler`,
        branch.branchId,
      );
    }
    if (branch.outputSchema === undefined || branch.outputSchema === null) {
      return fanoutErr(
        flow,
        fanout.id,
        'branch-output-schema',
        `branch "${branch.branchId}" must declare an outputSchema (typed escape contract)`,
        branch.branchId,
      );
    }
    const compiled = compileInlineSchema(branch.outputSchema);
    if (compiled.kind === 'err') {
      const cause = compiled.error;
      const primary =
        cause.code === 'schema-compile-error'
          ? String((cause.cause as Error)?.message ?? cause.message)
          : cause.message;
      return {
        code: 'invalid-fanout-node',
        message: `Fanout node "${fanout.id}" branch "${branch.branchId}" outputSchema failed to compile: ${primary}`,
        flowId: flow.id,
        fanoutNodeId: fanout.id,
        field: 'branch-output-schema',
        reason: primary,
        branchId: branch.branchId,
        issues: [{ path: '', message: primary }],
      };
    }
  }

  if (
    typeof fanout.convergence !== 'string' ||
    !(CONVERGENCE_MODES as readonly string[]).includes(fanout.convergence)
  ) {
    return fanoutErr(
      flow,
      fanout.id,
      'convergence',
      `must be one of ${CONVERGENCE_MODES.join(' | ')} (got ${String(fanout.convergence)})`,
    );
  }

  if (fanout.concurrency !== undefined) {
    if (!Number.isInteger(fanout.concurrency)) {
      return fanoutErr(
        flow,
        fanout.id,
        'concurrency',
        `must be an integer (got ${String(fanout.concurrency)})`,
      );
    }
    if (fanout.concurrency < 1) {
      return fanoutErr(flow, fanout.id, 'concurrency', `must be >= 1 (got ${fanout.concurrency})`);
    }
    if (fanout.concurrency > fanout.branches.length) {
      return fanoutErr(
        flow,
        fanout.id,
        'concurrency',
        `must be <= branches.length (${fanout.branches.length}) — a fanout cannot request more concurrent workers than it has branches (got ${fanout.concurrency})`,
      );
    }
  }

  return undefined;
}

function fanoutErr(
  flow: Flow,
  fanoutNodeId: NodeId,
  field: InvalidFanoutNodeError['field'],
  reason: string,
  branchId?: string,
): InvalidFanoutNodeError {
  const scope =
    branchId === undefined
      ? `Fanout node "${fanoutNodeId}"`
      : `Fanout node "${fanoutNodeId}" branch "${branchId}"`;
  return {
    code: 'invalid-fanout-node',
    message: `${scope}: ${reason}`,
    flowId: flow.id,
    fanoutNodeId,
    field,
    reason,
    ...(branchId !== undefined && { branchId }),
  };
}

// Silence unused ConvergenceMode import warning (referenced only via schema literal check).
void 0 as unknown as ConvergenceMode;

// ============ subgraph node validation (1.7.0) ============

const SEMVER_EXACT_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function collectAllSubflowNodes(flow: Flow): readonly SubflowNode[] {
  const acc: SubflowNode[] = [];
  for (const node of collectAllNodes(flow)) {
    if (isSubflowNode(node)) acc.push(node);
  }
  return acc;
}

function checkAllSubflowNodes(flow: Flow): InvalidSubflowNodeError | undefined {
  for (const subgraph of collectAllSubflowNodes(flow)) {
    const err = checkSubflowNode(flow, subgraph);
    if (err) return err;
  }
  return undefined;
}

function checkSubflowNode(flow: Flow, subgraph: SubflowNode): InvalidSubflowNodeError | undefined {
  // flowRef shape (the JSON schema also enforces this; repeated so this
  // check stands on its own).
  const ref = subgraph.flowRef as unknown;
  if (ref === undefined || ref === null || typeof ref !== 'object') {
    return subgraphErr(flow, subgraph.id, 'flowRef', 'must be an object');
  }
  const flowRef = ref as Record<string, unknown>;
  if (typeof flowRef.flowId !== 'string' || flowRef.flowId.length === 0) {
    return subgraphErr(flow, subgraph.id, 'flowRef.flowId', 'must be a non-empty string');
  }
  if (typeof flowRef.version !== 'string' || flowRef.version.length === 0) {
    return subgraphErr(flow, subgraph.id, 'flowRef.version', 'must be a non-empty string');
  }
  if (!SEMVER_EXACT_REGEX.test(flowRef.version)) {
    return subgraphErr(
      flow,
      subgraph.id,
      'flowRef.version',
      `must be an exact semver (no ranges) — got "${flowRef.version}"`,
    );
  }

  // inputMapping — plain object whose every value is a valid Operand.
  const mapping = subgraph.inputMapping as unknown;
  if (
    mapping === null ||
    mapping === undefined ||
    typeof mapping !== 'object' ||
    Array.isArray(mapping)
  ) {
    return subgraphErr(
      flow,
      subgraph.id,
      'inputMapping',
      'must be an object mapping string keys to Operands',
    );
  }
  for (const [key, value] of Object.entries(mapping as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      return subgraphErr(
        flow,
        subgraph.id,
        'inputMapping',
        `entry "${key}" must be an Operand ({ path } or { literal })`,
      );
    }
    const operandReason = validateOperand(value as Operand);
    if (operandReason !== undefined) {
      return subgraphErr(
        flow,
        subgraph.id,
        'inputMapping',
        `entry "${key}" is not a valid Operand: ${operandReason}`,
      );
    }
  }

  // outputSchema — must compile against draft-2020-12 meta-schema. Same
  // gate as loop / fanout output schemas so the runtime can trust it.
  if (subgraph.outputSchema === undefined || subgraph.outputSchema === null) {
    return subgraphErr(
      flow,
      subgraph.id,
      'output-schema',
      'must be a JSON Schema (draft 2020-12) — the typed escape contract',
    );
  }
  const compiled = compileInlineSchema(subgraph.outputSchema);
  if (compiled.kind === 'err') {
    const cause = compiled.error;
    const primary =
      cause.code === 'schema-compile-error'
        ? String((cause.cause as Error)?.message ?? cause.message)
        : cause.message;
    return {
      code: 'invalid-subgraph-node',
      message: `Subgraph node "${subgraph.id}" outputSchema failed to compile: ${primary}`,
      flowId: flow.id,
      subgraphNodeId: subgraph.id,
      field: 'output-schema',
      reason: primary,
      issues: [{ path: '', message: primary }],
    };
  }

  // convergence — closed enum.
  const cv = subgraph.convergence as unknown;
  if (typeof cv !== 'string' || !(SUBGRAPH_CONVERGENCE_MODES as readonly string[]).includes(cv)) {
    return subgraphErr(
      flow,
      subgraph.id,
      'convergence',
      `must be one of ${SUBGRAPH_CONVERGENCE_MODES.join(' | ')} (got ${String(cv)})`,
    );
  }

  return undefined;
}

function subgraphErr(
  flow: Flow,
  subgraphNodeId: NodeId,
  field: InvalidSubflowNodeError['field'],
  reason: string,
): InvalidSubflowNodeError {
  return {
    code: 'invalid-subgraph-node',
    message: `Subgraph node "${subgraphNodeId}": ${reason}`,
    flowId: flow.id,
    subgraphNodeId,
    field,
    reason,
  };
}

// Silence unused SubflowConvergence import warning (referenced via SUBGRAPH_CONVERGENCE_MODES literal check).
void 0 as unknown as SubflowConvergence;

// ============ loop outputSchema well-formedness (draft 2020-12 meta-schema compile) ============

function checkAllLoopOutputSchemas(flow: Flow): LoopOutputSchemaError | undefined {
  for (const loop of collectAllLoopNodes(flow)) {
    const compiled = compileInlineSchema(loop.outputSchema);
    if (compiled.kind === 'ok') continue;
    const cause = compiled.error;
    const primaryMessage =
      cause.code === 'schema-compile-error'
        ? String((cause.cause as Error)?.message ?? cause.message)
        : cause.message;
    return {
      code: 'loop-invalid-output-schema',
      message: `Loop node "${loop.id}" outputSchema failed to compile: ${primaryMessage}`,
      flowId: flow.id,
      loopNodeId: loop.id,
      issues: [{ path: '', message: primaryMessage }],
    };
  }
  return undefined;
}

// ============ data-flow mappings (leaf inputMapping + flow output, schema-version 1.8.0) ============

/**
 * Stricter than edge predicates: a mapping feeds a handler or the run's
 * output, so a path that can never resolve is a mistake, not a
 * "false" — reject it at load time. The schema already limits path
 * roots; this pass checks what it can't: `nodeOutputs.<id>` names a node
 * of the flow (ids are globally unique, so every node counts), a node
 * doesn't map its own output, and no loop-only root is used.
 */
function checkAllMappings(flow: Flow): InvalidMappingError | undefined {
  const allNodes = collectAllNodes(flow);
  const nodeIds = new Set<string>(allNodes.map((n) => n.id as unknown as string));
  for (const node of allNodes) {
    if (!isLeafNode(node) || node.inputMapping === undefined) continue;
    const bad = firstInvalidEntry(node.inputMapping, nodeIds, node.id as unknown as string);
    if (bad !== undefined) return mappingErr(flow, bad, node.id);
  }
  if (flow.output !== undefined) {
    const bad = firstInvalidEntry(flow.output.mapping, nodeIds, undefined);
    if (bad !== undefined) return mappingErr(flow, bad, undefined);
  }
  return undefined;
}

function firstInvalidEntry(
  mapping: Mapping,
  nodeIds: ReadonlySet<string>,
  ownNodeId: string | undefined,
): { readonly key: string; readonly reason: string } | undefined {
  for (const [key, operand] of Object.entries(mapping)) {
    const reason = validateMappingOperand(operand, nodeIds, ownNodeId);
    if (reason !== undefined) return { key, reason };
  }
  return undefined;
}

function validateMappingOperand(
  operand: Operand,
  nodeIds: ReadonlySet<string>,
  ownNodeId: string | undefined,
): string | undefined {
  if (!('path' in operand)) return undefined;
  const [root, nodeId = ''] = operand.path.split('.');
  if (root === 'iterationIndex' || root === 'iterationOutput') {
    return `${root} is only available in a loop's exitCondition`;
  }
  if (root !== 'nodeOutputs') return undefined;
  if (!nodeIds.has(nodeId)) return `nodeOutputs.${nodeId} names no node in this flow`;
  if (nodeId === ownNodeId) return 'a node cannot map its own output';
  return undefined;
}

function mappingErr(
  flow: Flow,
  bad: { readonly key: string; readonly reason: string },
  nodeId: NodeId | undefined,
): InvalidMappingError {
  const where = nodeId === undefined ? 'The flow output' : `Node "${nodeId}" inputMapping`;
  return {
    code: 'invalid-mapping',
    message: `${where} key "${bad.key}": ${bad.reason}`,
    flowId: flow.id,
    ...(nodeId !== undefined && { nodeId }),
    key: bad.key,
    reason: bad.reason,
  };
}

function checkFlowOutputSchema(flow: Flow): InvalidFlowOutputError | undefined {
  const schema = flow.output?.schema;
  if (schema === undefined) return undefined;
  const compiled = compileInlineSchema(schema);
  if (compiled.kind === 'ok') return undefined;
  const cause = compiled.error;
  const primaryMessage =
    cause.code === 'schema-compile-error'
      ? String((cause.cause as Error)?.message ?? cause.message)
      : cause.message;
  return {
    code: 'invalid-flow-output',
    message: `Flow output schema failed to compile: ${primaryMessage}`,
    flowId: flow.id,
    issues: [{ path: '', message: primaryMessage }],
  };
}

// ============ per-loop-body validation ============

function validateAllLoopBodies(
  flow: Flow,
): LoopBodyMissingStartError | LoopBodyEdgeReferenceError | LoopBodyCycleError | undefined {
  for (const loop of collectAllLoopNodes(flow)) {
    const missingStart = checkLoopBodyStartEdge(flow, loop);
    if (missingStart) return missingStart;
    const badRef = checkLoopBodyEdgeReferences(flow, loop);
    if (badRef) return badRef;
    const cycle = detectLoopBodyCycle(flow, loop);
    if (cycle) return cycle;
  }
  return undefined;
}

function checkLoopBodyStartEdge(flow: Flow, loop: LoopNode): LoopBodyMissingStartError | undefined {
  const hasStart = loop.body.edges.some((e) => e.from === LOOP_START_NODE);
  if (hasStart) return undefined;
  return {
    code: 'loop-body-missing-start-edge',
    message: `Loop node "${loop.id}" body has no edge originating at $loop-start`,
    flowId: flow.id,
    loopNodeId: loop.id,
  };
}

function checkLoopBodyEdgeReferences(
  flow: Flow,
  loop: LoopNode,
): LoopBodyEdgeReferenceError | undefined {
  const bodyNodeIds = new Set<string>(loop.body.nodes.map((n) => n.id));
  for (const edge of loop.body.edges) {
    if (edge.from !== LOOP_START_NODE && !bodyNodeIds.has(edge.from)) {
      return loopBodyEdgeRef(flow, loop, edge, 'from', edge.from);
    }
    if (edge.to !== LOOP_END_NODE && !bodyNodeIds.has(edge.to)) {
      return loopBodyEdgeRef(flow, loop, edge, 'to', edge.to);
    }
  }
  return undefined;
}

function loopBodyEdgeRef(
  flow: Flow,
  loop: LoopNode,
  edge: LoopEdge,
  endpoint: 'from' | 'to',
  referencedId: string,
): LoopBodyEdgeReferenceError {
  return {
    code: 'loop-body-unknown-node-reference',
    message: `Loop "${loop.id}" body edge "${edge.id}" ${endpoint} unknown node "${referencedId}"`,
    flowId: flow.id,
    loopNodeId: loop.id,
    edgeId: edge.id,
    endpoint,
    referencedId,
  };
}

function detectLoopBodyCycle(flow: Flow, loop: LoopNode): LoopBodyCycleError | undefined {
  const { inDegree, adjacency } = buildLoopBodyAdjacency(loop.body);
  const processed = topoDrain(inDegree, adjacency);
  if (processed === inDegree.size) return undefined;

  const remaining = new Set<string>();
  for (const [id, deg] of inDegree) if (deg > 0) remaining.add(id);
  const cycle = extractCycleWitness(adjacency, remaining);
  return {
    code: 'loop-body-cycle-detected',
    message: `Loop node "${loop.id}" body contains a cycle: ${cycle.join(' → ')}`,
    flowId: flow.id,
    loopNodeId: loop.id,
    cycle: cycle as NodeId[],
  };
}

function buildLoopBodyAdjacency(body: LoopBody): {
  readonly inDegree: Map<string, number>;
  readonly adjacency: Map<string, string[]>;
} {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of body.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of body.edges) {
    if (edge.from === LOOP_START_NODE || edge.to === LOOP_END_NODE) continue;
    const successors = adjacency.get(edge.from);
    if (successors === undefined) continue;
    successors.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  return { inDegree, adjacency };
}

// ============ outer cycle detection ============

function detectOuterCycle(flow: Flow): CycleError | undefined {
  const { inDegree, adjacency } = buildOuterAdjacency(flow);
  const processed = topoDrain(inDegree, adjacency);
  if (processed === inDegree.size) return undefined;

  const remaining = new Set<string>();
  for (const [id, deg] of inDegree) if (deg > 0) remaining.add(id);
  const cycle = extractCycleWitness(adjacency, remaining);
  return {
    code: 'cycle-detected',
    message: `Flow "${flow.id}" contains a cycle: ${cycle.join(' → ')}`,
    flowId: flow.id,
    cycle: cycle as NodeId[],
  };
}

function buildOuterAdjacency(flow: Flow): {
  readonly inDegree: Map<string, number>;
  readonly adjacency: Map<string, string[]>;
} {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of flow.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of flow.edges) {
    if (edge.from === START_NODE || edge.to === END_NODE) continue;
    const successors = adjacency.get(edge.from);
    if (successors === undefined) continue;
    successors.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  return { inDegree, adjacency };
}

// ============ shared topo / cycle helpers ============

function topoDrain(
  inDegree: Map<string, number>,
  adjacency: ReadonlyMap<string, readonly string[]>,
): number {
  const ready: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) ready.push(id);
  let processed = 0;
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    processed += 1;
    for (const next of adjacency.get(current) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) ready.push(next);
    }
  }
  return processed;
}

function extractCycleWitness(
  adjacency: ReadonlyMap<string, readonly string[]>,
  remaining: ReadonlySet<string>,
): string[] {
  const start = remaining.values().next().value;
  if (start === undefined) return [];
  const path: string[] = [];
  const onPath = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const node = stack[stack.length - 1];
    if (node === undefined) break;
    if (!onPath.has(node)) {
      onPath.add(node);
      path.push(node);
    }
    const advance = tryAdvance(node, adjacency, remaining, onPath, path);
    if (advance.kind === 'cycle') return advance.witness;
    if (advance.kind === 'push') {
      stack.push(advance.next);
      continue;
    }
    stack.pop();
    onPath.delete(node);
    path.pop();
  }
  return path;
}

type AdvanceResult =
  | { readonly kind: 'push'; readonly next: string }
  | { readonly kind: 'cycle'; readonly witness: string[] }
  | { readonly kind: 'backtrack' };

function tryAdvance(
  node: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  remaining: ReadonlySet<string>,
  onPath: ReadonlySet<string>,
  path: readonly string[],
): AdvanceResult {
  for (const next of adjacency.get(node) ?? []) {
    if (!remaining.has(next)) continue;
    if (onPath.has(next)) {
      const cycleStart = path.indexOf(next);
      return { kind: 'cycle', witness: [...path.slice(cycleStart), next] };
    }
    return { kind: 'push', next };
  }
  return { kind: 'backtrack' };
}

/** The `$id` of the JSON Schema this loader validates against. */
export const GRAPH_SCHEMA_URI = GRAPH_SCHEMA_ID;
