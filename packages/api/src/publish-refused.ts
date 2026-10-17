// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { GuardrailRegistryBinding } from './guardrail-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';

type PublishedPrimitive = 'tool' | 'guardrail' | 'agent' | 'flow';

/** A registry's answer to a deploy's publish, other than `ok` or `already-registered`. */
type RefusedOutcome = Exclude<
  | Awaited<ReturnType<ToolRegistryBinding['publish']>>
  | Awaited<ReturnType<GuardrailRegistryBinding['register']>>
  | Awaited<ReturnType<AgentRegistryBinding['publish']>>
  | Awaited<ReturnType<FlowRegistryBinding['publish']>>,
  { readonly kind: 'ok' | 'already-registered' }
>;

/**
 * A refusal the deploy decides itself, when its registry answered
 * `already-registered` for a live guardrail it can't keep: one in another
 * project (whose project the registry doesn't say), or one in its own
 * project with a different definition.
 */
interface DeployRefusal {
  readonly code: 'guardrail-project-mismatch' | 'guardrail-already-registered';
  readonly reason: string;
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
 * deploy never moves it, and the message names the fix (a pack per client,
 * whose ids carry its own pack id). The project it belongs to (`projectId`)
 * is for the log, never the answer.
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

  constructor(
    readonly primitive: PublishedPrimitive,
    readonly id: string,
    outcome: RefusedOutcome | DeployRefusal,
  ) {
    if ('code' in outcome) {
      super(`The ${primitive} ${id} wasn't published: ${outcome.reason}`);
      this.name = 'PublishRefused';
      this.code = outcome.code;
      return;
    }
    if (outcome.kind === 'kind-mismatch') {
      super(
        outcome.endpointId === undefined
          ? `The ${primitive} ${id} wasn't published: its id is a tool published here, and this version is an MCP endpoint's`
          : `The ${primitive} ${id} wasn't published: its id is MCP endpoint "${outcome.endpointId}"'s tool (give the pack's tool another name, or unregister the endpoint first)`,
      );
      this.name = 'PublishRefused';
      this.code = 'tool-kind-mismatch';
      if (outcome.endpointId !== undefined) this.endpointId = outcome.endpointId;
      return;
    }
    const code =
      outcome.kind === 'project-mismatch'
        ? (`${primitive}-project-mismatch` as const)
        : outcome.kind;
    super(
      outcome.kind === 'project-mismatch'
        ? `The ${primitive} ${id} wasn't published: it belongs to another project (one pack per client: \`kindgi init\` a copy of the pack for this client, with its own pack id)`
        : `The ${primitive} ${id} wasn't published: ${code}`,
    );
    this.name = 'PublishRefused';
    this.code = code;
    if (outcome.kind === 'project-mismatch') this.projectId = outcome.projectId;
  }
}
