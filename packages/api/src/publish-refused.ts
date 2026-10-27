// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { BlockRegistryBinding } from './block-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { GuardrailRegistryBinding } from './guardrail-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';

type PublishedPrimitive = 'tool' | 'guardrail' | 'agent' | 'flow' | 'block';

/** A registry's answer to a deploy's publish, other than `ok` or `already-registered`. */
type RefusedOutcome = Exclude<
  | Awaited<ReturnType<ToolRegistryBinding['publish']>>
  | Awaited<ReturnType<GuardrailRegistryBinding['register']>>
  | Awaited<ReturnType<AgentRegistryBinding['publish']>>
  | Awaited<ReturnType<FlowRegistryBinding['publish']>>
  | Awaited<ReturnType<BlockRegistryBinding['publish']>>,
  { readonly kind: 'ok' | 'already-registered' }
>;

/**
 * A refusal the deploy decides itself, when its registry answered
 * `already-registered` for a live guardrail it can't keep: one in another
 * project (whose project the registry doesn't say), or one in its own
 * project with a different definition. Or a pack's data block whose
 * version the registry holds with other content, or unregistered
 * (`deploy-blocks.ts`). Or a pack's tool whose version the registry holds
 * with another definition (`deploy-tools.ts`), with the fields that
 * differ.
 */
interface DeployRefusal {
  readonly code:
    | 'guardrail-project-mismatch'
    | 'guardrail-already-registered'
    | 'block-already-registered'
    | 'tool-already-registered';
  readonly reason: string;
  /** With `tool-already-registered`: the fields of the tool's definition that differ. */
  readonly fields?: readonly string[];
}

/**
 * A deploy's primitive came back from its registry with an outcome other
 * than `ok` or `already-registered` (e.g. `project-not-found`): the deploy
 * stops, what it published is rolled back, and the route answers with
 * that outcome's own status and code (T205). Before, such an outcome was
 * skipped, and the deployment was recorded without that primitive.
 *
 * A primitive whose id belongs to another project answers
 * `<primitive>-project-mismatch`, as publishing it on its own does: a
 * deploy never moves it, and the route's answer names the fix the runtime
 * has (`projectMismatchFix`). The project it belongs to (`projectId`) is
 * for the log, never the answer.
 *
 * A tool whose id is of another kind (an MCP endpoint's tool, where the
 * pack's is published here, or the other way round) answers
 * `tool-kind-mismatch`, as publishing it on its own does, with the
 * endpoint (`endpointId`) when the id is an endpoint's.
 */
export class PublishRefused extends Error {
  /** The code the deploy answers with. */
  readonly code:
    | Exclude<RefusedOutcome['kind'], 'project-mismatch' | 'kind-mismatch'>
    | `${PublishedPrimitive}-project-mismatch`
    | 'tool-kind-mismatch'
    | DeployRefusal['code'];
  /** With `…-project-mismatch`: the project the primitive belongs to, for the log only. */
  readonly projectId?: ProjectId;
  /** With `tool-kind-mismatch`: the MCP endpoint whose tool the id is, when it's one's. */
  readonly endpointId?: string;
  /** With `tool-already-registered`: the fields of the tool's definition that differ. */
  readonly fields?: readonly string[];

  /** The primitive refused. */
  readonly primitive: PublishedPrimitive;
  /** Its id (with `@<version>` where it has one). */
  readonly id: string;

  constructor(primitive: PublishedPrimitive, id: string, outcome: RefusedOutcome | DeployRefusal) {
    // One `super` at the top: tsc assigns parameter properties only after
    // a top-level one, so a refusal built in a branch had no `primitive`
    // or `id` in the built package (esbuild, which the tests run, assigns
    // them after every `super`).
    super(`The ${primitive} ${id} wasn't published: ${refusedBecause(outcome)}`);
    this.name = 'PublishRefused';
    this.primitive = primitive;
    this.id = id;
    if ('code' in outcome) {
      this.code = outcome.code;
      if (outcome.fields !== undefined) this.fields = outcome.fields;
    } else if (outcome.kind === 'kind-mismatch') {
      this.code = 'tool-kind-mismatch';
      if (outcome.endpointId !== undefined) this.endpointId = outcome.endpointId;
    } else if (outcome.kind === 'project-mismatch') {
      this.code = `${primitive}-project-mismatch`;
      this.projectId = outcome.projectId;
    } else {
      this.code = outcome.kind;
    }
  }
}

/** Why a refused primitive wasn't published, for `PublishRefused`'s message. */
function refusedBecause(outcome: RefusedOutcome | DeployRefusal): string {
  if ('code' in outcome) return outcome.reason;
  if (outcome.kind === 'kind-mismatch') {
    return outcome.endpointId === undefined
      ? "its id is a tool published here, and this version is an MCP endpoint's"
      : `its id is MCP endpoint "${outcome.endpointId}"'s tool (give the pack's tool another name, or unregister the endpoint first)`;
  }
  if (outcome.kind === 'project-mismatch') return PROJECT_MISMATCH;
  return outcome.kind;
}

/** Why a deploy refuses a primitive whose id belongs to another project. */
export const PROJECT_MISMATCH = 'it belongs to another project';

/**
 * The fix a deploy's `<primitive>-project-mismatch` names: a pack's items
 * stay in the project they were first deployed to. Where each deployment
 * runs its own pack service, a copy of the pack with its own pack id runs
 * beside it. Where one pack service serves every deployment, a copy's
 * image never runs, and another project gets the items through an
 * environment order, which holds only projects with the same parent
 * (one org, or none), and promotes a build only to the environment right
 * after. With neither, there's no fix to name.
 */
export function projectMismatchFix(runtime: {
  readonly perDeploymentPacks: boolean;
  readonly environmentOrders: boolean;
}): string | undefined {
  if (runtime.perDeploymentPacks) {
    return 'one pack per client: `kindgi init` a copy of the pack for this client, with its own pack id';
  }
  if (runtime.environmentOrders) {
    return "this runtime runs one pack service, so a copy of the pack wouldn't run: if both projects are in the same org, or neither is in an org, put them in one environment order (`kindgi environments set`), this one right after the one it belongs to, and `kindgi promote` the build to this one instead of deploying it; otherwise they can't share an order until one moves into the other's org, or out of its org (a project not in an order can move)";
  }
  return undefined;
}
