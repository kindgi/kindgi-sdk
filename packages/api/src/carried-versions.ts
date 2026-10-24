// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The versions a promotion carries with a deployment. A version made by an
 * edit (an expert's, or an improvement proposal's candidate) is made in
 * the first environment of an order, and no deployment lists it: when the
 * deployment it was made from moves to the next environment, the edit
 * moves with it, so it can go live there.
 *
 * An edit moves with a deployment when a run in the deployment's project
 * reaches it, the deployment doesn't ship it already, and its chain of
 * edits (`derivedFrom`, reason `edited`, within the one agent or flow)
 * leads to a version the deployment ships. A version a deploy registered
 * (any other reason) is that deploy's build, and moves with its own
 * deployment. An edit whose chain leads elsewhere is left behind: it was
 * made from a version this deployment doesn't ship.
 */

import type { AgentId, FlowId, ProjectId, TenantId, VersionDerivation } from '@kindgi/types';

import type { AgentRegistryBinding } from './agent-binding.js';
import type { CarriedVersion, DeploymentContents } from './deployment-binding.js';
import type { FlowRegistryBinding } from './flow-binding.js';
import type { ReferenceScopeBinding } from './reference-scope.js';

export type { CarriedVersion };

/** An edit of an agent or flow a deployment ships, made from a version it doesn't ship. */
export interface LeftBehindVersion extends CarriedVersion {
  /** The version its chain of edits starts from. */
  readonly from: string;
}

export interface CarriedVersionsDeps {
  readonly agents?: Pick<AgentRegistryBinding, 'listVersions'>;
  readonly flows?: Pick<FlowRegistryBinding, 'listVersions'>;
  /** Whether a run in the deployment's project reaches a version. Absent: it reaches every one. */
  readonly reach?: ReferenceScopeBinding;
}

export interface CarriedVersionsInput {
  readonly tenantId: TenantId;
  /** The project the deployment serves: the edits reached there move with it. */
  readonly fromProjectId: ProjectId;
  readonly contents: DeploymentContents;
}

export interface CarriedVersions {
  readonly carried: readonly CarriedVersion[];
  readonly leftBehind: readonly LeftBehindVersion[];
}

/** One version as the chain walk reads it. */
interface ListedVersion {
  readonly version: string;
  readonly derivedFrom?: VersionDerivation;
  readonly unregisteredAt?: string;
}

const PAGE = 100;

/**
 * The edits that move with a deployment from `fromProjectId`, and the
 * edits of the same agents and flows that don't (see the module comment).
 * Each list is by kind, then id, then the registry's version order.
 */
export async function carriedVersions(
  deps: CarriedVersionsDeps,
  input: CarriedVersionsInput,
): Promise<CarriedVersions> {
  const out = { carried: [] as CarriedVersion[], leftBehind: [] as LeftBehindVersion[] };
  const items = [
    { kind: 'agent' as const, shipped: shippedVersions(input.contents.agents) },
    { kind: 'flow' as const, shipped: shippedVersions(input.contents.flows) },
  ];
  for (const { kind, shipped } of items) {
    for (const id of [...shipped.keys()].sort()) {
      await sortItem(deps, input, { kind, id, shipped: shipped.get(id) ?? new Set() }, out);
    }
  }
  return out;
}

/** One agent's or flow's edits, each into `out.carried` or `out.leftBehind`, or neither. */
async function sortItem(
  deps: CarriedVersionsDeps,
  input: CarriedVersionsInput,
  item: {
    readonly kind: 'agent' | 'flow';
    readonly id: string;
    readonly shipped: ReadonlySet<string>;
  },
  out: { readonly carried: CarriedVersion[]; readonly leftBehind: LeftBehindVersion[] },
): Promise<void> {
  const { kind, id, shipped } = item;
  const listed = await listAll(deps, input.tenantId, kind, id);
  if (listed === undefined) return;
  const byVersion = new Map(listed.map((v) => [v.version, v]));
  for (const v of listed) {
    const edit = v.derivedFrom?.reason === 'edited';
    if (!edit || v.unregisteredAt !== undefined || shipped.has(v.version)) continue;
    const ref = { kind, id, version: v.version };
    if (!(await reached(deps, input, ref))) continue;
    const chain = editChain(byVersion, v.version, shipped);
    if (chain.ships) out.carried.push(ref);
    else out.leftBehind.push({ ...ref, from: chain.from });
  }
}

/** The versions each id ships, by id. A shipped item with no version names none to carry from. */
function shippedVersions(
  shipped: readonly { readonly id: string; readonly version?: string }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { id, version } of shipped) {
    if (version === undefined) continue;
    const versions = out.get(id) ?? new Set<string>();
    versions.add(version);
    out.set(id, versions);
  }
  return out;
}

/**
 * Where `version`'s chain of edits leads: to a shipped version (`ships`),
 * or else the version it starts from. Only `edited` links are followed: a
 * version a deploy registered starts a chain, it doesn't continue one.
 */
function editChain(
  byVersion: ReadonlyMap<string, ListedVersion>,
  version: string,
  shipped: ReadonlySet<string>,
): { readonly ships: boolean; readonly from: string } {
  const seen = new Set<string>([version]);
  let at = version;
  for (;;) {
    const derived = byVersion.get(at)?.derivedFrom;
    if (derived === undefined || derived.reason !== 'edited') return { ships: false, from: at };
    if (shipped.has(derived.version)) return { ships: true, from: derived.version };
    if (seen.has(derived.version)) return { ships: false, from: derived.version };
    seen.add(derived.version);
    at = derived.version;
  }
}

/** Every version of one agent or flow, unregistered ones included (a chain can pass through one). */
async function listAll(
  deps: CarriedVersionsDeps,
  tenantId: TenantId,
  kind: 'agent' | 'flow',
  id: string,
): Promise<ListedVersion[] | undefined> {
  const out: ListedVersion[] = [];
  let cursor: Parameters<AgentRegistryBinding['listVersions']>[0]['cursor'];
  for (;;) {
    const page =
      kind === 'agent'
        ? await deps.agents?.listVersions({
            tenantId,
            agentId: id as AgentId,
            limit: PAGE,
            includeTombstoned: true,
            ...(cursor !== undefined && { cursor }),
          })
        : await deps.flows?.listVersions({
            tenantId,
            flowId: id as FlowId,
            limit: PAGE,
            includeTombstoned: true,
            ...(cursor !== undefined && { cursor }),
          });
    if (page === undefined) return undefined;
    for (const v of page.data) {
      out.push({
        version: v.version as unknown as string,
        ...(v.derivedFrom !== undefined && { derivedFrom: v.derivedFrom }),
        ...(v.unregisteredAt !== undefined && { unregisteredAt: v.unregisteredAt }),
      });
    }
    if (page.nextCursor === undefined) return out;
    cursor = page.nextCursor;
  }
}

async function reached(
  deps: CarriedVersionsDeps,
  input: CarriedVersionsInput,
  ref: CarriedVersion,
): Promise<boolean> {
  if (deps.reach === undefined) return true;
  return deps.reach.reachable({
    tenantId: input.tenantId,
    fromProjectId: input.fromProjectId,
    ref: { kind: ref.kind, id: ref.id, version: ref.version },
  });
}
