// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Test support for rights on an environment order's items: an in-memory
 * `ItemProjectsBinding` over a fixed table, and an authorization binding
 * that grants exactly what each caller is given and records every check.
 */

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { ProjectId } from '@kindgi/types';

import type { ItemProjectsBinding, OrderItemKind } from '../../src/index.js';

/** One version of an item: the projects it can run in, the one it was made in first. */
export interface ItemVersionRow {
  readonly version: string;
  readonly projects: readonly ProjectId[];
  /** `false`: unregistered. Default `true`. */
  readonly active?: boolean;
}

/** An item: its projects (the one it was first published in first) and its versions, oldest first. */
export interface ItemRow {
  readonly kind: OrderItemKind;
  readonly id: string;
  readonly projects: readonly ProjectId[];
  readonly versions?: readonly ItemVersionRow[];
}

/**
 * The binding over `rows`. `asked` names each call (`projectsOfMany agent`,
 * …), so a test can count what a request asked. `rows` is read at every
 * call, so a test can change it between requests.
 */
export function itemProjects(rows: ItemRow[]): ItemProjectsBinding & { readonly asked: string[] } {
  const asked: string[] = [];
  const find = (kind: OrderItemKind, id: string) =>
    rows.find((row) => row.kind === kind && row.id === id);
  return {
    asked,
    async projectsOf({ kind, id }) {
      asked.push(`projectsOf ${kind} ${id}`);
      return find(kind, id)?.projects;
    },
    async projectsOfMany({ kind, ids }) {
      asked.push(`projectsOfMany ${kind}`);
      const out = new Map<string, readonly ProjectId[]>();
      for (const id of ids) {
        const row = find(kind, id);
        if (row !== undefined) out.set(id, row.projects);
      }
      return out;
    },
    async servesIn({ kind, id, projectId }) {
      asked.push(`servesIn ${kind} ${id} ${projectId}`);
      const projects = find(kind, id)?.projects;
      const own = projects?.[0];
      return own === undefined
        ? undefined
        : { own, serves: projects?.includes(projectId) === true };
    },
    async servedElsewhere({ kind, id }) {
      asked.push(`servedElsewhere ${kind} ${id}`);
      const projects = find(kind, id)?.projects;
      const own = projects?.[0];
      return own === undefined ? undefined : { own, elsewhere: (projects?.length ?? 0) > 1 };
    },
    async versionProjectsOf({ kind, id, version }) {
      asked.push(`versionProjectsOf ${kind} ${id} ${version}`);
      return find(kind, id)?.versions?.find((v) => v.version === version)?.projects;
    },
    async versionProjectsOfMany({ kind, id, versions }) {
      asked.push(`versionProjectsOfMany ${kind} ${id}`);
      const out = new Map<string, readonly ProjectId[]>();
      for (const v of find(kind, id)?.versions ?? []) {
        if (versions.includes(v.version)) out.set(v.version, v.projects);
      }
      return out;
    },
    async newestVisibleOfMany({ kind, readable, retired }) {
      asked.push(`newestVisibleOfMany ${kind}`);
      const out = new Map<string, string>();
      for (const [id, seen] of readable) {
        const versions = find(kind, id)?.versions ?? [];
        const counted =
          retired?.has(id) === true ? versions : versions.filter((v) => v.active !== false);
        const newest = [...counted].reverse().find((v) => v.projects.some((p) => seen.includes(p)));
        if (newest !== undefined) out.set(id, newest.version);
      }
      return out;
    },
  };
}

/** A grant: `"<action> <type>:<id>"`, as `decide` reads it. */
export type Grant = `${string} ${string}:${string}`;

/**
 * An authorization binding granting each caller (by user id) exactly its
 * `grants`. `asked` records every check (`"<user> <action> <type>:<id>"`)
 * and `batches` every batch, in order. `parents` is what `inProject`
 * reads: the project each resource (`"<type>:<id>"`) has as its parent.
 */
export function grantsAuthz(
  grants: Readonly<Record<string, readonly Grant[]>>,
  parents: Readonly<Record<string, string>> = {},
) {
  const asked: string[] = [];
  const batches: string[] = [];
  const decide = (principal: Principal, action: Action, r: ResourceRef): Decision => {
    const who = principal.actor.id;
    asked.push(`${who} ${action} ${r.type}:${r.id}`);
    const allowed = (grants[who] ?? []).includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const binding: AuthzCheckBinding = {
    check: async (p, action, r) => decide(p, action, r),
    checkBatch: async (p, action, rs) => {
      batches.push(`${action} ${rs.map((r) => `${r.type}:${r.id}`).join(',')}`);
      return rs.map((r) => decide(p, action, r));
    },
    inProject: async (_p, r, projectId) => parents[`${r.type}:${r.id}`] === projectId,
  };
  return {
    asked,
    batches,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: binding },
  };
}
