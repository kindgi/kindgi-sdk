// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A flow candidate's `versions`, checked against the flow version when
 * the comparison starts: each id must be an agent or tool the flow or
 * one of its sub-flows uses, at a published version, since a run's
 * versions apply to every flow of the run. Checked once, here, before any
 * run exists: the runs apply them as given, on resume too.
 */

import type { AgentId } from '@kindgi/agents';
import { type FlowVersionOverrides, overridableTreeRefs } from '@kindgi/flow';
import type { FlowId, Semver, TenantId, ToolId } from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import type { ItemReference } from '../reference-scope.js';
import type { ToolRegistryBinding } from '../tool-binding.js';

/** Where the check reads the flow version and the agents' and tools' versions. */
export interface FlowVersionsCheck {
  readonly flows: FlowRegistryBinding;
  readonly agents?: AgentRegistryBinding;
  readonly tools?: ToolRegistryBinding;
}

export interface VersionsIssue {
  readonly path: string;
  readonly message: string;
}

/** A JSON Pointer token: `~` and `/` escaped. */
const token = (id: string): string => id.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * A flow candidate's `versions` as references its run's project must
 * reach, each at its own path: an agent at the version named, since each
 * case runs that version in the run's project; a tool by its id, as
 * reach reads no tool versions (`ItemReference.version`).
 */
export function versionsReferences(
  versions: FlowVersionOverrides | undefined,
): (ItemReference & { readonly path: string })[] {
  return [
    ...Object.entries(versions?.agents ?? {}).map(([id, version]) => ({
      path: `/versions/agents/${token(id)}`,
      kind: 'agent' as const,
      id,
      version,
    })),
    ...Object.keys(versions?.tools ?? {}).map((id) => ({
      path: `/versions/tools/${token(id)}`,
      kind: 'tool' as const,
      id,
    })),
  ];
}

async function agentIssues(
  check: FlowVersionsCheck,
  tenantId: TenantId,
  label: string,
  used: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
): Promise<VersionsIssue[]> {
  const issues: VersionsIssue[] = [];
  for (const [id, version] of Object.entries(overrides)) {
    const path = `/versions/agents/${token(id)}`;
    if (!used.has(id)) {
      issues.push({ path, message: `flow ${label} doesn't use agent ${id}` });
      continue;
    }
    const found = await check.agents?.getVersion({
      tenantId,
      agentId: id as AgentId,
      version: version as Semver,
    });
    if (found === null) issues.push({ path, message: `agent ${id} has no version ${version}` });
    else if (found?.unregisteredAt !== undefined) {
      issues.push({ path, message: `agent ${id} ${version} is unregistered` });
    }
  }
  return issues;
}

async function toolIssues(
  check: FlowVersionsCheck,
  tenantId: TenantId,
  label: string,
  used: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
): Promise<VersionsIssue[]> {
  const issues: VersionsIssue[] = [];
  for (const [id, version] of Object.entries(overrides)) {
    const path = `/versions/tools/${token(id)}`;
    if (!used.has(id)) {
      issues.push({ path, message: `flow ${label} doesn't use tool ${id}` });
      continue;
    }
    const found = await check.tools?.getVersion({
      tenantId,
      toolId: id as ToolId,
      version: version as Semver,
    });
    if (found === null) issues.push({ path, message: `tool ${id} has no version ${version}` });
  }
  return issues;
}

/**
 * What's wrong with a flow candidate's `versions`, one issue per id; none
 * when they fit. Without an agent or tool registry, those versions'
 * existence isn't checked (the runs refuse an unpublished one).
 */
export async function checkFlowVersions(
  check: FlowVersionsCheck,
  tenantId: TenantId,
  flowRef: { readonly flowId: string; readonly version: string },
  versions: FlowVersionOverrides,
): Promise<readonly VersionsIssue[]> {
  const label = `${flowRef.flowId} ${flowRef.version}`;
  const flow = await check.flows.getVersion({
    tenantId,
    flowId: flowRef.flowId as FlowId,
    version: flowRef.version,
  });
  if (flow === null) {
    return [{ path: '/flowRef/version', message: `flow ${label} isn't registered` }];
  }
  const refs = await overridableTreeRefs(flow, ({ flowId, version }) =>
    check.flows.getVersion({ tenantId, flowId: flowId as FlowId, version }),
  );
  return [
    ...(await agentIssues(check, tenantId, label, new Set(refs.agents), versions.agents ?? {})),
    ...(await toolIssues(check, tenantId, label, new Set(refs.tools), versions.tools ?? {})),
  ];
}
