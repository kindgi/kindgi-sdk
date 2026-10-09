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
 * A deploy's primitive came back from its registry with an outcome other
 * than `ok` or `already-registered` (e.g. `project-not-found`): the deploy
 * stops, what it published is rolled back, and the route answers with
 * that outcome's own status and code (T205). Before, such an outcome was
 * skipped, and the deployment was recorded without that primitive.
 *
 * A primitive whose id belongs to another project answers
 * `<primitive>-project-mismatch`, with the project it belongs to, as
 * publishing it on its own does: a deploy never moves it.
 */
export class PublishRefused extends Error {
  /** The code the deploy answers with. */
  readonly code:
    | Exclude<RefusedOutcome['kind'], 'project-mismatch'>
    | `${PublishedPrimitive}-project-mismatch`;
  /** With `…-project-mismatch`: the project the primitive belongs to. */
  readonly projectId?: ProjectId;

  constructor(
    readonly primitive: PublishedPrimitive,
    readonly id: string,
    outcome: RefusedOutcome,
  ) {
    const code =
      outcome.kind === 'project-mismatch'
        ? (`${primitive}-project-mismatch` as const)
        : outcome.kind;
    super(
      outcome.kind === 'project-mismatch'
        ? `The ${primitive} ${id} wasn't published: it belongs to project "${outcome.projectId as unknown as string}"`
        : `The ${primitive} ${id} wasn't published: ${code}`,
    );
    this.name = 'PublishRefused';
    this.code = code;
    if (outcome.kind === 'project-mismatch') this.projectId = outcome.projectId;
  }
}
