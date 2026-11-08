// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { BlockRegistryBinding } from './block-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { GuardrailRegistryBinding } from './guardrail-binding.js';
import type { ReferenceOutOfScopeError } from './reference-scope.js';
import type { ToolRegistryBinding } from './tool-binding.js';

type PublishedPrimitive = 'tool' | 'guardrail' | 'agent' | 'flow' | 'block';

/**
 * A registry's answer to a deploy's publish, other than `ok`,
 * `already-registered` or `held-version-gone` (which `refusedPublish`,
 * in `deploy-versions.ts`, answers).
 */
type RefusedOutcome = Exclude<
  | Awaited<ReturnType<ToolRegistryBinding['publish']>>
  | Awaited<ReturnType<GuardrailRegistryBinding['register']>>
  | Awaited<ReturnType<AgentRegistryBinding['publish']>>
  | Awaited<ReturnType<FlowRegistryBinding['publish']>>
  | Awaited<ReturnType<BlockRegistryBinding['publish']>>,
  { readonly kind: 'ok' | 'already-registered' | 'held-version-gone' }
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
 * for the log. The answer names it only when it's a test project the
 * caller may know of (`liveInTestProject`).
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
  /** With `…-project-mismatch`: the project the primitive belongs to, for the log, and named in the answer only as `liveInTestProject` says. */
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

/**
 * A deploy's agent or flow refused as reach refuses a reference: the
 * deploy stops, what it published is rolled back, and the route answers
 * `400 reference-out-of-scope` (`refusal`).
 */
export class ReferencesRefused extends Error {
  constructor(readonly refusal: ReferenceOutOfScopeError) {
    super(refusal.message);
    this.name = 'ReferencesRefused';
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
 *
 * A test project (`Project.testFor`) joins no environment order, so where
 * the items are live in one (`testProject: 'holder'`), or the deploy goes
 * into one (`'target'`), the order fix can't be done, and the words say
 * why instead.
 */
export function projectMismatchFix(
  runtime: {
    readonly perDeploymentPacks: boolean;
    readonly environmentOrders: boolean;
  },
  testProject?: 'holder' | 'target',
): string | undefined {
  if (runtime.perDeploymentPacks) {
    return 'one pack per client: `kindgi init` a copy of the pack for this client, with its own pack id';
  }
  if (runtime.environmentOrders) {
    if (testProject === 'holder') {
      return "this runtime runs one pack service, so a copy of the pack wouldn't run, and a test project joins no environment order, so its builds can't be promoted to another project";
    }
    if (testProject === 'target') {
      return "this runtime runs one pack service, so a copy of the pack wouldn't run, and a test project joins no environment order: it takes only ids no other project holds";
    }
    return "this runtime runs one pack service, so a copy of the pack wouldn't run: if both projects are in the same org, or neither is in an org, put them in one environment order (`kindgi environments set`), this one right after the one it belongs to, and `kindgi promote` the build to this one instead of deploying it; otherwise they can't share an order until both are in the same org, or neither is in an org (a project not in an order can move)";
  }
  return undefined;
}

/**
 * Where a deploy's `<primitive>-project-mismatch` is live, when that's a
 * test project, as far as the caller may know it: their own, or one they
 * can read, by name and id; another person's, by its kind alone. Any other
 * project is never named, as `PublishRefused` says.
 */
export type TestProjectHolder =
  | { readonly kind: 'own'; readonly name: string; readonly projectId: ProjectId }
  | { readonly kind: 'readable'; readonly name: string; readonly projectId: ProjectId }
  | { readonly kind: 'another-persons' };

/** A test project holder (`TestProjectHolder`), as `: it's live in …` for the answer. */
export function liveInTestProject(holder: TestProjectHolder): string {
  if (holder.kind === 'own') {
    return `: it's live in your test project "${holder.name}" (${holder.projectId})`;
  }
  if (holder.kind === 'readable') {
    return `: it's live in the test project "${holder.name}" (${holder.projectId})`;
  }
  return ": it's live in another person's test project";
}
