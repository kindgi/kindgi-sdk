// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `makeInMemoryTeamBinding` — reference in-memory implementations of
 * `TeamBinding` + `TeamMembershipBinding`. Used by tests + dev-time
 * defaults.
 *
 * Storage: two maps — one keyed by `TeamId`, the other keyed by a
 * composite `(teamId, userId)` string for memberships. Every op
 * filters by `tenantId` at the row level. The membership map only
 * stores memberships whose parent team belongs to the tenant — the
 * `add` code path validates team existence before writing.
 *
 * Both factories are returned together so the two adapters share the
 * same team map (a membership add must fail cleanly for a
 * non-existent team; splitting into two disjoint factories would
 * require an extra cross-binding contract).
 */

import type { Filter, Page, TeamId, TenantId, UserId } from '@kindgi/types';

import type {
  TeamBinding,
  TeamListFilter,
  TeamMembershipAddInput,
  TeamMembershipBinding,
} from '../team-binding.js';
import type { Team, TeamMembership, TeamPatch, TeamRole, TeamSpec } from '../types.js';

import { nowTimestamp, paginate } from './util.js';

let teamIdCounter = 0;
function nextTeamId(): TeamId {
  teamIdCounter += 1;
  return `team-${teamIdCounter}` as TeamId;
}

function membershipKey(teamId: TeamId, userId: UserId): string {
  return `${teamId}::${userId}`;
}

/**
 * Combined factory — returns a `TeamBinding` + `TeamMembershipBinding`
 * pair that share underlying storage. The pair is the atomic unit
 * (memberships reference teams; the two must agree on tenant
 * membership at every op).
 */
export function makeInMemoryTeamBinding(): {
  readonly teams: TeamBinding;
  readonly memberships: TeamMembershipBinding;
} {
  const teamRows = new Map<TeamId, Team>();
  const membershipRows = new Map<string, TeamMembership>();

  function findTeamInTenant(tenantId: TenantId, teamId: TeamId): Team | undefined {
    const t = teamRows.get(teamId);
    if (t === undefined || t.tenantId !== tenantId) return undefined;
    return t;
  }

  const teams: TeamBinding = {
    async create(tenantId, spec: TeamSpec): Promise<TeamId> {
      const id = nextTeamId();
      const now = nowTimestamp();
      const row: Team = {
        id,
        tenantId,
        name: spec.name,
        slug: spec.slug,
        createdAt: now,
        updatedAt: now,
        ...(spec.orgId !== undefined ? { orgId: spec.orgId } : {}),
        ...(spec.description !== undefined ? { description: spec.description } : {}),
      };
      teamRows.set(id, row);
      return id;
    },

    async get(tenantId, teamId): Promise<Team | undefined> {
      return findTeamInTenant(tenantId, teamId);
    },

    async list(tenantId, filter: TeamListFilter): Promise<Page<Team>> {
      const all: Team[] = [];
      for (const row of teamRows.values()) {
        if (row.tenantId !== tenantId) continue;
        if (filter.orgId !== undefined && row.orgId !== filter.orgId) continue;
        if (filter.nameContains !== undefined && !row.name.includes(filter.nameContains)) {
          continue;
        }
        all.push(row);
      }
      all.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return paginate(all, filter.limit, filter.cursor);
    },

    async update(tenantId, teamId, patch: TeamPatch): Promise<void> {
      const row = findTeamInTenant(tenantId, teamId);
      if (row === undefined) {
        throw new Error(`team-not-found: ${teamId}`);
      }
      // orgId patch tri-state: undefined = untouched; null = clear;
      // OrgId value = set.
      let nextOrgId = row.orgId;
      if (patch.orgId !== undefined) {
        nextOrgId = patch.orgId === null ? undefined : patch.orgId;
      }
      const nextDescription = patch.description ?? row.description;
      const next: Team = {
        id: row.id,
        tenantId: row.tenantId,
        name: patch.name ?? row.name,
        slug: patch.slug ?? row.slug,
        createdAt: row.createdAt,
        updatedAt: nowTimestamp(),
        ...(nextOrgId !== undefined ? { orgId: nextOrgId } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
      };
      teamRows.set(teamId, next);
    },

    async delete(tenantId, teamId): Promise<void> {
      const row = findTeamInTenant(tenantId, teamId);
      if (row === undefined) return;
      teamRows.delete(teamId);
      // Cascade — every membership row for this team drops with it.
      for (const key of membershipRows.keys()) {
        if (key.startsWith(`${teamId}::`)) {
          membershipRows.delete(key);
        }
      }
    },
  };

  const memberships: TeamMembershipBinding = {
    async add(tenantId, input: TeamMembershipAddInput): Promise<void> {
      const team = findTeamInTenant(tenantId, input.teamId);
      if (team === undefined) {
        throw new Error(`team-not-found: ${input.teamId}`);
      }
      const key = membershipKey(input.teamId, input.userId);
      if (membershipRows.has(key)) {
        // Idempotent — role mutation goes through updateRole.
        return;
      }
      const row: TeamMembership = {
        teamId: input.teamId,
        userId: input.userId,
        role: input.role,
        joinedAt: nowTimestamp(),
      };
      membershipRows.set(key, row);
    },

    async remove(tenantId, teamId, userId): Promise<void> {
      const team = findTeamInTenant(tenantId, teamId);
      if (team === undefined) return;
      membershipRows.delete(membershipKey(teamId, userId));
    },

    async list(tenantId, teamId, filter: Filter): Promise<Page<TeamMembership>> {
      const team = findTeamInTenant(tenantId, teamId);
      if (team === undefined) return { items: [] };
      const all: TeamMembership[] = [];
      for (const row of membershipRows.values()) {
        if (row.teamId !== teamId) continue;
        all.push(row);
      }
      all.sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
      return paginate(all, filter.limit, filter.cursor);
    },

    async listForUser(tenantId, userId, filter: Filter): Promise<Page<TeamMembership>> {
      const all: TeamMembership[] = [];
      for (const row of membershipRows.values()) {
        if (row.userId !== userId) continue;
        // Confirm the parent team belongs to the tenant.
        const t = teamRows.get(row.teamId);
        if (t === undefined || t.tenantId !== tenantId) continue;
        all.push(row);
      }
      all.sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
      return paginate(all, filter.limit, filter.cursor);
    },

    async updateRole(tenantId, teamId, userId, role: TeamRole): Promise<void> {
      const team = findTeamInTenant(tenantId, teamId);
      if (team === undefined) {
        throw new Error(`team-not-found: ${teamId}`);
      }
      const key = membershipKey(teamId, userId);
      const row = membershipRows.get(key);
      if (row === undefined) {
        throw new Error(`team-membership-not-found: ${teamId}/${userId}`);
      }
      membershipRows.set(key, { ...row, role });
    },
  };

  return { teams, memberships };
}
