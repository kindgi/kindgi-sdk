// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An agent candidate's `overrides`, checked when the comparison starts:
 * each settings block must be one the version pins, its values satisfying
 * the schema of the version it pins (model settings, for the
 * model-settings block); a prompt template must be for the prompt block
 * the version pins, and pass `checkDraftedTemplate` (it reads and names
 * only what the agent has). Checked once, here, before any run exists:
 * the replays use them as given, on resume too.
 */

import {
  type AgentId,
  MODEL_SETTINGS_SCHEMA,
  checkDraftedTemplate,
  settingsSchemaIssues,
} from '@kindgi/agents';
import type { Semver, TenantId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import type { EvalOverrides } from '../eval-run-binding.js';

/** Where the check reads the agent version and its blocks. */
export interface SettingsOverridesCheck {
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
}

export interface OverridesIssue {
  readonly path: string;
  readonly message: string;
}

/** A JSON Pointer token: `~` and `/` escaped. */
const token = (id: string): string => id.replaceAll('~', '~0').replaceAll('/', '~1');

export async function checkSettingsOverrides(
  check: SettingsOverridesCheck,
  tenantId: TenantId,
  candidate: { readonly agentId: string; readonly version: string },
  overrides: EvalOverrides,
): Promise<OverridesIssue[]> {
  const settings = overrides.settings ?? {};
  const label = `${candidate.agentId} ${candidate.version}`;
  const found = await check.agents.getVersion({
    tenantId,
    agentId: candidate.agentId as AgentId,
    version: candidate.version as Semver,
  });
  if (found === null) {
    return [{ path: '/agentRef/version', message: `agent ${label} isn't registered` }];
  }
  if (found.pins === undefined) {
    return [
      {
        path: '/overrides/settings',
        message: `${label} was published before pins: it has no pinned settings to replace`,
      },
    ];
  }
  const issues: OverridesIssue[] = [];
  for (const [id, values] of Object.entries(settings)) {
    const path = `/overrides/settings/${token(id)}`;
    const version = found.pins.settings[id];
    if (version === undefined) {
      issues.push({ path, message: `${label} doesn't pin settings block "${id}"` });
      continue;
    }
    const block = await check.blocks.getVersion({ tenantId, blockId: id, version });
    if (block === null || block.kind !== 'settings') {
      issues.push({ path, message: `settings block "${id}" version ${version} isn't published` });
      continue;
    }
    const schema = found.modelSettings?.id === id ? MODEL_SETTINGS_SCHEMA : block.content.schema;
    if (schema === undefined) continue;
    for (const issue of settingsSchemaIssues(values, schema)) {
      issues.push({ path: `${path}${issue.path}`, message: issue.message });
    }
  }
  for (const [id, { template }] of Object.entries(overrides.prompts ?? {})) {
    const path = `/overrides/prompts/${token(id)}`;
    const version = found.pins.prompts[id];
    if (version === undefined) {
      issues.push({ path, message: `${label} doesn't pin prompt block "${id}"` });
      continue;
    }
    const block = await check.blocks.getVersion({ tenantId, blockId: id, version });
    if (block === null || block.kind !== 'prompt') {
      issues.push({ path, message: `prompt block "${id}" version ${version} isn't published` });
      continue;
    }
    const drafted = checkDraftedTemplate(template, {
      current: block.content,
      settingsBlocks: Object.keys(found.pins.settings),
      knownIds: [
        candidate.agentId,
        ...Object.keys(found.pins.tools),
        ...Object.keys(found.pins.prompts),
        ...Object.keys(found.pins.settings),
      ],
    });
    for (const issue of drafted) issues.push({ path, message: issue.message });
  }
  return issues;
}
