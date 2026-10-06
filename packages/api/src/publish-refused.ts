// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentRegistryBinding } from './agent-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { GuardrailRegistryBinding } from './guardrail-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';

/**
 * A deploy's primitive came back from its registry with an outcome other
 * than `ok` or `already-registered` (e.g. `project-not-found`): the deploy
 * stops, what it published is rolled back, and the route answers with
 * that outcome's own status and code (T205). Before, such an outcome was
 * skipped, and the deployment was recorded without that primitive.
 */
export class PublishRefused extends Error {
  constructor(
    readonly primitive: 'tool' | 'guardrail' | 'agent' | 'flow',
    readonly id: string,
    readonly code: Exclude<
      | Awaited<ReturnType<ToolRegistryBinding['publish']>>['kind']
      | Awaited<ReturnType<GuardrailRegistryBinding['register']>>['kind']
      | Awaited<ReturnType<AgentRegistryBinding['publish']>>['kind']
      | Awaited<ReturnType<FlowRegistryBinding['publish']>>['kind'],
      'ok' | 'already-registered'
    >,
  ) {
    super(`The ${primitive} ${id} wasn't published: ${code}`);
    this.name = 'PublishRefused';
  }
}
