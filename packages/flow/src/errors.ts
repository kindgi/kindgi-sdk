// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EdgeId, FlowId, NodeId } from '@kindgi/types';

/**
 * Every flow error carries a discriminating `code` so callers can pattern
 * match without inspecting messages. Messages are intended for logs and are
 * not part of the API contract.
 */
export type FlowError =
  | SchemaValidationError
  | DuplicateNodeError
  | DuplicateEdgeError
  | UnknownNodeReferenceError
  | ReservedIdError
  | CycleError
  | InvalidPredicateError
  | InvalidEdgePolicyError
  | MissingStartEdgeError
  | LoopBodyMissingStartError
  | LoopBodyCycleError
  | LoopBodyEdgeReferenceError
  | LoopMaxIterationsError
  | LoopOutputSchemaError
  | LoopVariantMismatchError
  | LoopConcurrencyError
  | InvalidFanoutNodeError
  | InvalidSubflowNodeError
  | InvalidMappingError
  | InvalidFlowOutputError;

export interface SchemaValidationError {
  readonly code: 'schema-validation-failed';
  readonly message: string;
  readonly flowId?: FlowId;
  /** Ajv-style path list — one per validation failure. */
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

export interface DuplicateNodeError {
  readonly code: 'duplicate-node-id';
  readonly message: string;
  readonly flowId: FlowId;
  readonly nodeId: NodeId;
}

export interface DuplicateEdgeError {
  readonly code: 'duplicate-edge-id';
  readonly message: string;
  readonly flowId: FlowId;
  readonly edgeId: EdgeId;
}

export interface UnknownNodeReferenceError {
  readonly code: 'unknown-node-reference';
  readonly message: string;
  readonly flowId: FlowId;
  readonly edgeId: EdgeId;
  readonly endpoint: 'from' | 'to';
  readonly referencedId: string;
}

export interface ReservedIdError {
  readonly code: 'reserved-id';
  readonly message: string;
  readonly flowId: FlowId;
  readonly nodeId: NodeId;
}

export interface CycleError {
  readonly code: 'cycle-detected';
  readonly message: string;
  readonly flowId: FlowId;
  /** Node ids in the cycle, in traversal order. */
  readonly cycle: readonly NodeId[];
}

export interface InvalidPredicateError {
  readonly code: 'invalid-predicate';
  readonly message: string;
  readonly flowId: FlowId;
  readonly edgeId: EdgeId;
  readonly reason: string;
}

/**
 * A `FlowEdge.policy` field is structurally valid JSON-schema-wise but
 * violates one of the semantic rules `loadFlow` enforces — e.g.
 * `retry.maxAttempts` out of the `[1, 10]` band, negative `delayMs`, or
 * `backoff: 'exponential'` without a `maxDelayMs` ceiling.
 *
 * The schema layer catches shape errors (wrong types, unknown fields);
 * this error surfaces the semantic ones the schema can't express.
 */
export interface InvalidEdgePolicyError {
  readonly code: 'invalid-edge-policy';
  readonly message: string;
  readonly flowId: FlowId;
  readonly edgeId: EdgeId;
  readonly field:
    | 'retry.maxAttempts'
    | 'retry.delayMs'
    | 'retry.backoff'
    | 'retry.maxDelayMs'
    | 'timeoutMs'
    | 'concurrencyKey'
    | 'priority';
  readonly reason: string;
}

export interface MissingStartEdgeError {
  readonly code: 'missing-start-edge';
  readonly message: string;
  readonly flowId: FlowId;
}

/**
 * A loop node's body has no edge originating at `$loop-start`. Analogous to
 * `MissingStartEdgeError` but scoped to a specific loop body.
 */
export interface LoopBodyMissingStartError {
  readonly code: 'loop-body-missing-start-edge';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
}

/** A cycle was detected inside a loop node's body sub-flow. */
export interface LoopBodyCycleError {
  readonly code: 'loop-body-cycle-detected';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  readonly cycle: readonly NodeId[];
}

/**
 * An edge inside a loop body references an endpoint that isn't a known
 * body node or a `$loop-start` / `$loop-end` sentinel.
 */
export interface LoopBodyEdgeReferenceError {
  readonly code: 'loop-body-unknown-node-reference';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  readonly edgeId: EdgeId;
  readonly endpoint: 'from' | 'to';
  readonly referencedId: string;
}

/**
 * A loop node's `maxIterations` is out of the allowed range. Checked by
 * `loadFlow` in addition to the schema-level bounds.
 */
export interface LoopMaxIterationsError {
  readonly code: 'loop-invalid-max-iterations';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  readonly value: number;
}

/**
 * A loop node's `outputSchema` is missing or is not a valid JSON Schema
 * (draft 2020-12). Every loop declares a typed escape contract; a
 * malformed schema is caught at load time so no execution-time surprise
 * ever surfaces to the caller.
 */
export interface LoopOutputSchemaError {
  readonly code: 'loop-invalid-output-schema';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  /** Meta-schema validation issues (Ajv-style path + message). */
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

/**
 * A loop node declares fields that belong to the wrong variant. Examples:
 *   - `loopKind: 'foreach'` with an `exitCondition` present.
 *   - `loopKind: 'while'` with an `iterateOver` present.
 *   - `loopKind: 'foreach'` missing `iterateOver`.
 *   - `loopKind: 'while'` missing `exitCondition`.
 *
 * Enforced at load time so the executor can trust the discriminated union.
 */
export interface LoopVariantMismatchError {
  readonly code: 'loop-variant-mismatch';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  readonly loopKind: 'while' | 'foreach';
  readonly problem:
    | 'while-missing-exit-condition'
    | 'while-has-iterate-over'
    | 'while-has-invalid-evaluation-timing'
    | 'while-has-concurrency'
    | 'foreach-missing-iterate-over'
    | 'foreach-has-exit-condition'
    | 'foreach-has-evaluation-timing';
}

/**
 * A foreach loop's `concurrency` field is out of the allowed band. Bounds:
 *   - Must be a positive integer.
 *   - `1 ≤ concurrency ≤ 32` — the upper cap is a safety limit.
 *   - `concurrency ≤ maxIterations` — otherwise pointless.
 *
 * The 32 cap prevents accidents (a stray `concurrency: 1000` spawning a
 * thousand simultaneous handlers). The cap is fixed; adaptive or
 * rate-aware concurrency is not part of this primitive.
 */
export interface LoopConcurrencyError {
  readonly code: 'loop-invalid-concurrency';
  readonly message: string;
  readonly flowId: FlowId;
  readonly loopNodeId: NodeId;
  readonly value: number;
  readonly reason: 'not-integer' | 'below-minimum' | 'exceeds-max-iterations' | 'exceeds-cap';
}

/**
 * A `subgraph` node is structurally valid JSON-schema-wise but violates
 * one of the semantic rules `loadFlow` enforces — e.g. malformed `flowRef`,
 * non-exact semver, an `inputMapping` value that isn't a valid Operand,
 * an `outputSchema` that fails to compile against the draft-2020-12
 * meta-schema, or an unknown `convergence` mode.
 *
 * `field` narrows the location of the failure so callers can attribute
 * without matching on the message.
 */
export interface InvalidSubflowNodeError {
  readonly code: 'invalid-subgraph-node';
  readonly message: string;
  readonly flowId: FlowId;
  readonly subgraphNodeId: NodeId;
  readonly field:
    | 'flowRef'
    | 'flowRef.flowId'
    | 'flowRef.version'
    | 'inputMapping'
    | 'output-schema'
    | 'convergence';
  readonly reason: string;
  /** Meta-schema issues, when `field === 'output-schema'`. */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

/**
 * A `fanout` node is structurally valid JSON-schema-wise but violates one
 * of the semantic rules `loadFlow` enforces — e.g. duplicate `branchId`,
 * concurrency out of `[1, branches.length]`, an unknown convergence mode,
 * or a per-branch `outputSchema` that fails to compile against the
 * draft-2020-12 meta-schema.
 *
 * `field` narrows the location of the failure so callers can attribute
 * without matching on the message.
 */
export interface InvalidFanoutNodeError {
  readonly code: 'invalid-fanout-node';
  readonly message: string;
  readonly flowId: FlowId;
  readonly fanoutNodeId: NodeId;
  readonly field:
    | 'branches'
    | 'branch-id'
    | 'branch-handler'
    | 'branch-output-schema'
    | 'concurrency'
    | 'convergence';
  readonly reason: string;
  /** Branch id at fault, when the failure attribution is per-branch. */
  readonly branchId?: string;
  /** Meta-schema issues, when `field === 'branch-output-schema'`. */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

/**
 * A leaf `inputMapping` or the flow `output.mapping` entry can't be
 * resolved as written (schema-version 1.8.0+): its path names a node the
 * flow doesn't have, maps the node's own output, or uses a loop-only root
 * (`iterationIndex` / `iterationOutput`). A path with an unknown root
 * fails the schema step instead (`schema-validation-failed`).
 */
export interface InvalidMappingError {
  readonly code: 'invalid-mapping';
  readonly message: string;
  readonly flowId: FlowId;
  /** The leaf node whose `inputMapping` is invalid; absent for the flow's `output`. */
  readonly nodeId?: NodeId;
  /** The mapping key whose operand is invalid. */
  readonly key: string;
  readonly reason: string;
}

/**
 * A flow's `output.schema` is not a valid JSON Schema (draft 2020-12).
 */
export interface InvalidFlowOutputError {
  readonly code: 'invalid-flow-output';
  readonly message: string;
  readonly flowId: FlowId;
  /** Meta-schema validation issues (Ajv-style path + message). */
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}
