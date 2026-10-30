// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Rights on an item that more than one project serves.
//
// An item's rights are inherited from its parent: the project it was first
// published in. Once an environment order carries an item into further
// projects, that one project would govern what they all serve. So for an
// item with more than one project (`ItemProjectsBinding`), rights are
// rights on the projects instead, and the item's own grants give reads
// only:
//
//   1. Reading the item: read on it, or read on any of its projects.
//   2. Reading a version (or a pinned version, or a pin change): only one that
//      can run in a project the caller reads. A caller who reads the item
//      itself reads as its first project's readers do. Any other version
//      answers the route's own 404, as a missing one does.
//   3. A change in one project: the right on that project, never the
//      item's, and nothing added from the item's first project.
//   4. A change that reaches several projects: the right on each of them.
//
// A key limited to a project reaches such an item when that project is
// one of the item's, and acts in that project only (rules 2 to 4 ask the
// projects themselves, which the key's limit holds).
//
// An item with one project keeps today's checks, unchanged: without the
// binding, or without environment orders, every item has one.
//
// With the binding and no authorizer there are no rights to ask: every
// caller in the tenant reads everything. Which projects serve an item is
// still the binding's, so `?projectId=` answers the version that project
// runs (`itemServingOf`, `shownLatest`).
//

import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import { type Action, type Decision, type ResourceRef, denyPayload, ref } from '@kindgi/authz';
import type { AgentPinScope, PinScope, PinnedItemKind, ProjectId, TenantId } from '@kindgi/types';

import { firstEnvironmentOf, orderSpanning } from './environment-entry.js';
import type {
  EnvironmentOrderBinding,
  EnvironmentOrderLocation,
} from './environment-orders-binding.js';
import { toWireError } from './errors.js';
import type {
  ItemProjectsBinding,
  ItemServedElsewhere,
  ItemServesIn,
  OrderItemKind,
} from './item-projects-binding.js';
import type { Authorizer } from './middleware/authorize.js';
import type { AppEnv } from './types.js';

type Ctx = Context<AppEnv>;

const tenantOf = (c: Ctx) => c.get('tenantId') as TenantId;

/** What was refused: the action, on what, and the decision. */
export interface ItemRefusal {
  readonly action: Action;
  readonly resource: ResourceRef;
  readonly decision: Decision;
}

/** What a route under an item asks, for an item more than one project serves. */
export type ItemCheck =
  /** Rule 1: reading the item. */
  | { readonly rule: 'read' }
  /** Rules 1 and 2: reading one of its versions. */
  | { readonly rule: 'version'; readonly version: string }
  /** Rule 3: a change in one project. */
  | { readonly rule: 'on'; readonly action: Action; readonly projectId: string }
  /** Rule 4: a change to the whole item, on each of its projects. */
  | { readonly rule: 'every'; readonly action: Action }
  /** Rule 4: a change to one version, on each project it can run in. */
  | { readonly rule: 'every-version'; readonly action: Action; readonly version: string };

/** How a list route reads its rows, for `filterItems`. */
export interface ItemRows<T> {
  readonly idOf: (row: T) => string;
  /** What today's check reads a row by: the item, or (blocks) its project. */
  readonly todayRef: (row: T) => ResourceRef;
  /**
   * The row's version, and another version of its item: each row is shown
   * at its item's newest version the caller can see. Absent for items
   * without versions (guardrails): rule 1 alone.
   */
  readonly versions?: {
    readonly versionOf: (row: T) => string;
    readonly getVersion: (id: string, version: string) => Promise<T | null>;
  };
  /** A row of a retired item (a list including them): its unregistered versions count. */
  readonly retired?: (row: T) => boolean;
}

export interface ItemRights {
  /** The item's projects, its first one first; `undefined`: no such item. Asked once per request. */
  projects(c: Ctx, kind: OrderItemKind, id: string): Promise<readonly ProjectId[] | undefined>;
  /**
   * The item's projects when more than one serves it, so the rules here
   * apply; `undefined` when it has one (or there's no such item), so the
   * route's checks are today's. Asked of the binding once per request.
   */
  multi(c: Ctx, kind: OrderItemKind, id: string): Promise<readonly ProjectId[] | undefined>;
  /**
   * The environment order any of the item's projects belongs to — the first
   * such project's, by the item's project order — or `undefined` when none is
   * in an order (or there's no order binding). A pin change wider than one
   * project for such an item would span that order's environments, whether one
   * project serves the item or several. Asked of the binding once per request.
   */
  spannedOrder(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
  ): Promise<EnvironmentOrderLocation | undefined>;
  /** `multi` for a page's items, in one ask: the ids more than one project serves. */
  multiOfMany(
    c: Ctx,
    kind: OrderItemKind,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ProjectId[]>>;
  /**
   * Whether `projectId` is one of the item's projects, and its first one,
   * without reading every project it's in. `undefined`: no such item.
   */
  servesIn(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projectId: string,
  ): Promise<ItemServesIn | undefined>;
  /**
   * Whether more than one project serves the item, and its first one,
   * without reading every project it's in. `undefined`: no such item.
   */
  servedElsewhere(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
  ): Promise<ItemServedElsewhere | undefined>;
  /** Rule 1. `undefined` when allowed; else the item's own refusal, as today's. */
  read(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
  ): Promise<ItemRefusal | undefined>;
  /** Rule 2: the rows whose version can run in a project the caller reads. */
  visibleVersions<T>(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    rows: readonly T[],
    versionOf: (row: T) => string,
  ): Promise<T[]>;
  /** Rule 2, for one version: `false` for one that doesn't exist. */
  versionVisible(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    version: string,
  ): Promise<boolean>;
  /**
   * The item's newest active version the caller can see (rule 2), or with
   * `inProject`, the newest that can run in that project, which the caller
   * must read; `undefined`: none.
   */
  newestVisible(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    inProject?: string,
  ): Promise<string | undefined>;
  /**
   * Rules 1 and 2 for a list page: the rows the caller may read, each an
   * item more than one project serves shown at its newest version the
   * caller can see. A page of one-project items is today's one check.
   */
  filterItems<T>(c: Ctx, kind: OrderItemKind, rows: readonly T[], how: ItemRows<T>): Promise<T[]>;
  /**
   * Where an item's new versions are made: the first environment of its
   * first project's order, else that project (`deriveAgentVersion`).
   */
  madeIn(c: Ctx, projects: readonly ProjectId[]): Promise<ProjectId | undefined>;
  /** Rule 3: `action` on `projectId`. */
  on(c: Ctx, projectId: string, action: Action): Promise<ItemRefusal | undefined>;
  /** Rule 4: `action` on each of `projects`; the refusal names the first one refused. */
  onEvery(c: Ctx, projects: readonly string[], action: Action): Promise<ItemRefusal | undefined>;
  /**
   * What `check` asks, answered: `undefined` when allowed; else the 403, or
   * (a version the caller can't see) the route's own 404.
   */
  enforce(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    check: ItemCheck,
    versionNotFound: (c: Ctx, version: string) => Response,
  ): Promise<Response | undefined>;
}

/** The authorization type an item kind is checked as; blocks are checked by project. */
const ITEM_TYPE: Readonly<Record<OrderItemKind, ResourceRef['type'] | undefined>> = {
  agent: 'agent',
  flow: 'flow',
  test_set: 'test_set',
  tool: 'tool',
  guardrail: 'guardrail',
  block: undefined,
};

/** What a kind is called in a refusal. */
const KIND_NAME: Readonly<Record<OrderItemKind, string>> = {
  agent: 'agent',
  flow: 'flow',
  test_set: 'test set',
  tool: 'tool',
  guardrail: 'guardrail',
  block: 'block',
};

/** The rights, when there's both an authorizer and an item-projects binding. */
export function itemRightsOf(
  authorizer: Authorizer | undefined,
  binding: ItemProjectsBinding | undefined,
  orders?: Pick<EnvironmentOrderBinding, 'orderOf'>,
): ItemRights | undefined {
  return authorizer === undefined || binding === undefined
    ? undefined
    : createItemRights(authorizer, binding, orders);
}

export function createItemRights(
  authorizer: Authorizer,
  binding: ItemProjectsBinding,
  /** The tenant's environment orders, for `madeIn`. Absent: an item's versions are made in its first project. */
  orders?: Pick<EnvironmentOrderBinding, 'orderOf'>,
): ItemRights {
  // What one request has asked already: an item's projects are asked once,
  // though its middleware and its handler both need them.
  const asked = new WeakMap<Request, Map<string, Promise<unknown>>>();
  function once<T>(c: Ctx, key: string, ask: () => Promise<T>): Promise<T> {
    let seen = asked.get(c.req.raw);
    if (seen === undefined) {
      seen = new Map();
      asked.set(c.req.raw, seen);
    }
    const found = seen.get(key);
    if (found !== undefined) return found as Promise<T>;
    const answer = ask();
    seen.set(key, answer);
    return answer;
  }
  function projects(c: Ctx, kind: OrderItemKind, id: string) {
    return once(c, `projects ${kind} ${id}`, () =>
      binding.projectsOf({ tenantId: tenantOf(c), kind, id }),
    );
  }

  async function multi(c: Ctx, kind: OrderItemKind, id: string) {
    const all = await projects(c, kind, id);
    return all !== undefined && all.length > 1 ? all : undefined;
  }

  function servesIn(c: Ctx, kind: OrderItemKind, id: string, projectId: string) {
    return binding.servesIn({ tenantId: tenantOf(c), kind, id, projectId: projectId as ProjectId });
  }

  function servedElsewhere(c: Ctx, kind: OrderItemKind, id: string) {
    return binding.servedElsewhere({ tenantId: tenantOf(c), kind, id });
  }

  function spannedOrder(c: Ctx, kind: OrderItemKind, id: string) {
    return once(c, `spannedOrder ${kind} ${id}`, async () => {
      const all = await projects(c, kind, id);
      return all === undefined ? undefined : orderSpanning(orders, tenantOf(c), all);
    });
  }

  async function multiOfMany(c: Ctx, kind: OrderItemKind, ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, readonly ProjectId[]>();
    const of = await binding.projectsOfMany({
      tenantId: tenantOf(c),
      kind,
      ids: [...new Set(ids)],
    });
    return new Map([...of].filter(([, projects]) => projects.length > 1));
  }

  /**
   * What the caller reads of an item more than one project serves: the
   * item itself (its own decision), and the projects among its own it
   * reads. Reading the item reads as its first project's readers do.
   */
  function reach(c: Ctx, kind: OrderItemKind, id: string, projects: readonly ProjectId[]) {
    return once(c, `reach ${kind} ${id}`, async () => {
      const type = ITEM_TYPE[kind];
      const item =
        type === undefined
          ? undefined
          : await (authorizer.checkServedBy?.(c, 'read', ref(type, id), projects) ??
              authorizer.check(c, 'read', ref(type, id)));
      const read = await authorizer.filterByCan(c, 'read', projects, (p) => ref('project', p));
      const head = projects[0];
      const readable =
        item?.allowed === true && head !== undefined && !read.includes(head)
          ? [head, ...read]
          : read;
      return { item, readable };
    });
  }

  async function read(c: Ctx, kind: OrderItemKind, id: string, projects: readonly ProjectId[]) {
    const { item, readable } = await reach(c, kind, id, projects);
    if (readable.length > 0) return undefined;
    const type = ITEM_TYPE[kind];
    const resource = ref(type ?? 'project', type === undefined ? (projects[0] ?? id) : id);
    const decision: Decision = item ?? {
      allowed: false,
      reason: `no read on any project that serves ${KIND_NAME[kind]} "${id}"`,
      evidence: {
        action: 'read',
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
    return { action: 'read' as const, resource, decision };
  }

  async function visibleVersions<T>(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    rows: readonly T[],
    versionOf: (row: T) => string,
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    const { readable } = await reach(c, kind, id, projects);
    if (readable.length === 0) return [];
    const where = await binding.versionProjectsOfMany({
      tenantId: tenantOf(c),
      kind,
      id,
      versions: [...new Set(rows.map(versionOf))],
    });
    return rows.filter((row) => where.get(versionOf(row))?.some((p) => readable.includes(p)));
  }

  async function versionVisible(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    version: string,
  ) {
    const { readable } = await reach(c, kind, id, projects);
    if (readable.length === 0) return false;
    const where = await versionProjects(c, kind, id, version);
    return where?.some((p) => readable.includes(p)) === true;
  }

  function versionProjects(c: Ctx, kind: OrderItemKind, id: string, version: string) {
    return once(c, `version ${kind} ${id} ${version}`, () =>
      binding.versionProjectsOf({ tenantId: tenantOf(c), kind, id, version }),
    );
  }

  async function newestVisible(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    inProject?: string,
  ) {
    const { readable } = await reach(c, kind, id, projects);
    return newestIn(c, binding, kind, id, readable, inProject);
  }

  async function filterItems<T>(
    c: Ctx,
    kind: OrderItemKind,
    rows: readonly T[],
    how: ItemRows<T>,
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    const of = await binding.projectsOfMany({
      tenantId: tenantOf(c),
      kind,
      ids: [...new Set(rows.map(how.idOf))],
    });
    const projectsOf = (row: T) => {
      const projects = of.get(how.idOf(row));
      return projects !== undefined && projects.length > 1 ? projects : undefined;
    };
    const many = new Set(rows.filter((row) => projectsOf(row) !== undefined));
    // A page of one-project items: today's one check.
    if (many.size === 0) return authorizer.filterByCan(c, 'read', rows, how.todayRef);
    const { allowed, readProjects } = await pageReads(c, kind, rows, many, projectsOf, how);
    // The projects the caller reads a row's item through: as for one item (`reach`).
    const readableOf = (row: T): readonly ProjectId[] => {
      const projects = projectsOf(row) ?? [];
      const head = projects[0];
      const read = projects.filter((p) => readProjects.has(p));
      return allowed.has(row) && head !== undefined && !read.includes(head)
        ? [head, ...read]
        : read;
    };
    const { versions } = how;
    if (versions === undefined) {
      // No versions: rule 1, the item's own read or read on one of its projects.
      return rows.filter((row) => (many.has(row) ? readableOf(row).length > 0 : allowed.has(row)));
    }
    const newest = await newestOnPage(c, kind, many, readableOf, how);
    // One version read at a time, as the page is shown.
    return keptInOrder(rows, (row) =>
      many.has(row)
        ? shownAt(row, newest.get(how.idOf(row)), how.idOf, versions)
        : allowed.has(row)
          ? row
          : null,
    );
  }

  /**
   * A page's two checks: today's, and for an item more than one project
   * serves, the item's own read (blocks have none); then read on the
   * page's projects.
   */
  async function pageReads<T>(
    c: Ctx,
    kind: OrderItemKind,
    rows: readonly T[],
    many: ReadonlySet<T>,
    projectsOf: (row: T) => readonly ProjectId[] | undefined,
    how: ItemRows<T>,
  ) {
    const itemChecked = ITEM_TYPE[kind] === undefined ? rows.filter((r) => !many.has(r)) : rows;
    const allowed = new Set(
      await authorizer.filterByCan(c, 'read', itemChecked, how.todayRef, projectsOf),
    );
    const pageProjects = [...new Set([...many].flatMap((row) => projectsOf(row) ?? []))];
    const readProjects = new Set(
      await authorizer.filterByCan(c, 'read', pageProjects, (p) => ref('project', p)),
    );
    return { allowed, readProjects };
  }

  /** For a page's items more than one project serves, each one's newest version the caller can see, in one ask. */
  async function newestOnPage<T>(
    c: Ctx,
    kind: OrderItemKind,
    many: ReadonlySet<T>,
    readableOf: (row: T) => readonly ProjectId[],
    how: ItemRows<T>,
  ): Promise<ReadonlyMap<string, string>> {
    const seen = new Map<string, readonly ProjectId[]>();
    for (const row of many) {
      const readable = readableOf(row);
      if (readable.length > 0) seen.set(how.idOf(row), readable);
    }
    if (seen.size === 0) return new Map();
    const retired = new Set([...many].filter((row) => how.retired?.(row) === true).map(how.idOf));
    return binding.newestVisibleOfMany({
      tenantId: tenantOf(c),
      kind,
      readable: seen,
      ...(retired.size > 0 && { retired }),
    });
  }

  async function madeIn(c: Ctx, projects: readonly ProjectId[]) {
    const home = projects[0];
    if (home === undefined) return undefined;
    return (await firstEnvironmentOf(orders, tenantOf(c), home)) ?? home;
  }

  async function on(c: Ctx, projectId: string, action: Action) {
    const resource = ref('project', projectId);
    const decision = await authorizer.check(c, action, resource);
    return decision.allowed ? undefined : { action, resource, decision };
  }

  async function onEvery(c: Ctx, projects: readonly string[], action: Action) {
    const resources = projects.map((p) => ref('project', p));
    const decisions =
      authorizer.checkMany === undefined
        ? await Promise.all(resources.map((r) => authorizer.check(c, action, r)))
        : await authorizer.checkMany(c, action, resources);
    const at = decisions.findIndex((d) => !d.allowed);
    const resource = resources[at];
    const decision = decisions[at];
    return resource === undefined || decision === undefined
      ? undefined
      : { action, resource, decision };
  }

  async function enforce(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    check: ItemCheck,
    versionNotFound: (c: Ctx, version: string) => Response,
  ): Promise<Response | undefined> {
    const refusal = await refusalOf(c, kind, id, projects, check);
    if (refusal === undefined) return undefined;
    return 'hidden' in refusal
      ? versionNotFound(c, refusal.hidden)
      : forbidden(c, refusal.refused, refusal.message);
  }

  /** What `check` refuses: a refusal (with the message of a change's), or a version the caller can't see. */
  async function refusalOf(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    check: ItemCheck,
  ): Promise<{ refused: ItemRefusal; message?: string } | { hidden: string } | undefined> {
    const changing = (refused: ItemRefusal | undefined, version?: string) =>
      refused === undefined ? undefined : { refused, message: served(kind, id, refused, version) };
    switch (check.rule) {
      case 'read': {
        const refused = await read(c, kind, id, projects);
        return refused === undefined ? undefined : { refused };
      }
      case 'version': {
        const refused = await read(c, kind, id, projects);
        if (refused !== undefined) return { refused };
        return (await versionVisible(c, kind, id, projects, check.version))
          ? undefined
          : { hidden: check.version };
      }
      case 'on':
        return changing(await on(c, check.projectId, check.action));
      case 'every':
        return changing(await onEvery(c, projects, check.action));
      case 'every-version': {
        const where = await changedWhere(c, kind, id, projects, check.version);
        return changing(await onEvery(c, where, check.action), check.version);
      }
    }
  }

  /**
   * The projects a change to one version is asked of: each project it can
   * run in. A version the caller can't see (rule 2) is asked as one that
   * doesn't exist: of the item's projects, then the route's own 404.
   * Never an empty set.
   */
  async function changedWhere(
    c: Ctx,
    kind: OrderItemKind,
    id: string,
    projects: readonly ProjectId[],
    version: string,
  ): Promise<readonly ProjectId[]> {
    const where = (await versionVisible(c, kind, id, projects, version))
      ? await versionProjects(c, kind, id, version)
      : undefined;
    return where !== undefined && where.length > 0 ? where : projects;
  }

  return {
    projects,
    multi,
    spannedOrder,
    multiOfMany,
    servesIn,
    servedElsewhere,
    read,
    visibleVersions,
    versionVisible,
    newestVisible,
    filterItems,
    madeIn,
    on,
    onEvery,
    enforce,
  };
}

/**
 * The newest active version of `id` that can run in one of `projects`,
 * or with `inProject`, in that one; `undefined`: none.
 */
async function newestIn(
  c: Ctx,
  binding: ItemProjectsBinding,
  kind: OrderItemKind,
  id: string,
  projects: readonly ProjectId[],
  inProject: string | undefined,
): Promise<string | undefined> {
  const seen = inProject === undefined ? projects : projects.filter((p) => p === inProject);
  if (seen.length === 0) return undefined;
  const newest = await binding.newestVisibleOfMany({
    tenantId: tenantOf(c),
    kind,
    readable: new Map([[id, seen]]),
  });
  return newest.get(id);
}

/**
 * What `shownLatest` reads of an item: which projects serve it, and its
 * newest version that can run in them. `ItemRights` answers under rules 1
 * and 2; `itemServingOf`, from the binding alone.
 */
export type ItemServing = Pick<ItemRights, 'projects' | 'newestVisible'>;

/**
 * The binding's answers with no rights asked, for a deployment with no
 * authorizer, where every caller in the tenant reads every project.
 */
export function itemServingOf(binding: ItemProjectsBinding): ItemServing {
  return {
    projects: (c, kind, id) => binding.projectsOf({ tenantId: tenantOf(c), kind, id }),
    newestVisible: (c, kind, id, projects, inProject) =>
      newestIn(c, binding, kind, id, projects, inProject),
  };
}

/** `rows` through `keep`, one at a time and in order, without the nulls. */
async function keptInOrder<T>(
  rows: readonly T[],
  keep: (row: T) => T | null | Promise<T | null>,
): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) {
    const kept = await keep(row);
    if (kept !== null) out.push(kept);
  }
  return out;
}

/** A row shown at `version` of its item: itself, when it's that version; else that version, if it's there. */
async function shownAt<T>(
  row: T,
  version: string | undefined,
  idOf: (row: T) => string,
  versions: NonNullable<ItemRows<T>['versions']>,
): Promise<T | null> {
  if (version === undefined) return null;
  if (version === versions.versionOf(row)) return row;
  return versions.getVersion(idOf(row), version);
}

/** A refusal's message for a change asked of the projects that serve an item. */
function served(kind: OrderItemKind, id: string, refused: ItemRefusal, version?: string): string {
  const what = `${KIND_NAME[kind]} "${id}"${version === undefined ? '' : ` at ${version}`}`;
  return `Permission denied: ${what} is served by more than one project, so this needs ${refused.action} on each project it changes; refused on project ${refused.resource.id} (${refused.decision.reason})`;
}

/**
 * The project a row of an item's (a test run, a schedule) is checked on:
 * for an item more than one project serves, the row's own project, so a
 * project's members see and act on what happens there and not elsewhere.
 * `undefined`: an item with one project (or a row without one), checked
 * as before.
 */
export async function ownProject(
  c: Ctx,
  rights: ItemRights | undefined,
  kind: OrderItemKind,
  id: string,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (rights === undefined || projectId === undefined) return undefined;
  return (await rights.multi(c, kind, id)) === undefined ? undefined : projectId;
}

/**
 * `ownProject` for a list page, in one ask of the binding: each row of an
 * item more than one project serves is read on its own project (given the
 * item's projects, for a row that has none of its own), every other row
 * as `todayRef` says, in one check of the page.
 */
export async function filterOwned<T>(
  c: Ctx,
  authorizer: Authorizer,
  rights: ItemRights | undefined,
  kind: OrderItemKind,
  rows: readonly T[],
  how: {
    readonly idOf: (row: T) => string;
    readonly projectOf: (row: T, projects: readonly ProjectId[]) => string | undefined;
    readonly todayRef: (row: T) => ResourceRef;
  },
): Promise<T[]> {
  const many = await rights?.multiOfMany(c, kind, rows.map(how.idOf));
  return authorizer.filterByCan(c, 'read', rows, (row) => {
    const projects = many?.get(how.idOf(row));
    const own = projects === undefined ? undefined : how.projectOf(row, projects);
    return own !== undefined ? ref('project', own) : how.todayRef(row);
  });
}

/**
 * Running an agent, flow or test set in one of the projects that serve
 * it: that project's `call` (agents) or `execute` (flows and test sets)
 * alone, the item's own `execute` not asked. `undefined` when allowed;
 * else the 403, naming the right it needs there. `what`: what the caller
 * does, when not running the item (opening a conversation with it).
 */
export async function runIn(
  c: Ctx,
  rights: ItemRights,
  item: { readonly kind: 'agent' | 'flow' | 'test_set'; readonly id: string },
  projectId: string,
  what?: string,
): Promise<Response | undefined> {
  const refused = await rights.on(c, projectId, item.kind === 'agent' ? 'call' : 'execute');
  if (refused === undefined) return undefined;
  const doing = what ?? `running ${KIND_NAME[item.kind]} "${item.id}"`;
  const relation = item.kind === 'agent' ? 'caller' : 'executor';
  return forbidden(
    c,
    refused,
    `Permission denied: ${doing} in project ${projectId} needs ${relation} or editor on ${projectId} (${refused.decision.reason})`,
  );
}

/**
 * A change that makes a new version of an item more than one project
 * serves (an Improve run, a suggested change): `write` where its new
 * versions are made (`madeIn`), the item's own right not asked.
 * `undefined` when allowed; else the 403, naming that project.
 */
export async function writeWhereMade(
  c: Ctx,
  rights: ItemRights,
  item: { readonly kind: OrderItemKind; readonly id: string },
  projects: readonly ProjectId[],
  doing: string,
): Promise<Response | undefined> {
  const where = await rights.madeIn(c, projects);
  const refused =
    where === undefined ? undefined : await rights.on(c, where as unknown as string, 'write');
  if (refused === undefined) return undefined;
  return forbidden(
    c,
    refused,
    `Permission denied: ${doing} needs write on project ${refused.resource.id}, where ${KIND_NAME[item.kind]} "${item.id}" gets its new versions (${refused.decision.reason})`,
  );
}

/** The 403 a refusal answers, in the envelope the authorizer's own 403 uses. */
export function forbidden(c: Ctx, refused: ItemRefusal, message?: string): Response {
  const { action, resource, decision } = refused;
  const deny = denyPayload(action, resource.type, resource.id, decision.reason);
  const requestId = c.get('requestId');
  c.status(403);
  return c.json(
    toWireError(
      {
        code: deny.code,
        message: message ?? `Permission denied: ${deny.reason}`,
        action: deny.action,
        resource: deny.resource,
        reason: deny.reason,
      },
      typeof requestId === 'string' ? requestId : '',
    ),
  );
}

/**
 * The path under an item's id, in a middleware mounted at `/:id/*`:
 * `['versions', '1.0.0', 'unregister']` for `…/:id/versions/1.0.0/unregister`.
 */
export function underItem(c: Ctx): readonly string[] {
  return c.req.path
    .split('/')
    .slice(routePath(c).split('/').length - 1)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * What a GET under an item reads: one of its versions (rule 2) when the
 * path names one (`versions/:version[/…]`), else the item (rule 1).
 */
export function readCheck(under: readonly string[]): ItemCheck {
  const [first, version] = under;
  return first === 'versions' && version !== undefined && version.length > 0
    ? { rule: 'version', version }
    : { rule: 'read' };
}

/**
 * What a pin change asks (a pin, an unpin):
 * a project's, or a segment's within it, is that project's (rule 3); the
 * tenant's, or an org's, reaches every project of the item (rule 4).
 */
export function agentPinScopeCheck(scope: AgentPinScope | undefined): ItemCheck {
  return scope?.kind === 'project' || scope?.kind === 'segment'
    ? { rule: 'on', action: 'admin', projectId: scope.projectId as unknown as string }
    : { rule: 'every', action: 'admin' };
}

/**
 * Whether a pin change for an agent at `scope` is refused,
 * whoever asks: the pin routes (a pin, an unpin), and
 * a deployment's promotion that pins what it moved. Authorization
 * first: for an agent more than one project serves, what `agentPinScopeCheck`
 * names; else today's check, `pin` on the agent, as the route's
 * middleware asks it. Then the width refusal: for an agent any of whose
 * projects is in an order — one project or several — `setsPin` (a pin,
 * not an unpin) at a scope wider than one project is refused,
 * since a tenant- or org-wide pin would act in every environment of that
 * order at once (`widthRefusal`). The authorization is first, so an
 * unauthorized wide pin is the 403, not the 409. `undefined` when allowed;
 * else the response to answer. It reads no body and answers nothing itself.
 */
export async function agentPinChangeRefusal(
  c: Ctx,
  how: {
    readonly authorizer: Authorizer;
    readonly rights: ItemRights | undefined;
    readonly agentId: string;
    readonly scope: AgentPinScope | undefined;
    /** A pin, not an unpin: only a pin spans an order's environments. */
    readonly setsPin?: boolean;
  },
): Promise<Response | undefined> {
  // Authorization first, so an unauthorized wide change is the 403, not the 409.
  const projects = await how.rights?.multi(c, 'agent', how.agentId);
  if (how.rights !== undefined && projects !== undefined) {
    // More than one project serves the agent: what `agentPinScopeCheck` names.
    const check = agentPinScopeCheck(how.scope);
    const refused = await how.rights.enforce(
      c,
      'agent',
      how.agentId,
      projects,
      check,
      namesNoVersion,
    );
    if (refused !== undefined) return refused;
  } else {
    // One project (or no item-rights binding): today's check, `pin` on the agent.
    const refused = await authorizedOn(c, how.authorizer, 'pin', ref('agent', how.agentId));
    if (refused !== undefined) return refused;
  }
  // Then the width refusal — only a pin spans an order; an unpin
  // doesn't. Keyed on order membership, so one project or several, it fires
  // only for an agent whose projects reach an order.
  return how.setsPin === true
    ? widthRefusal(c, { rights: how.rights, agentId: how.agentId, scope: how.scope })
    : undefined;
}

/** `action` on `resource`, asked of the authorizer as a route's middleware asks it: `undefined` when allowed, else its refusal. */
async function authorizedOn(
  c: Ctx,
  authorizer: Authorizer,
  action: Action,
  resource: ResourceRef,
): Promise<Response | undefined> {
  let allowed = false;
  const refused = await authorizer.authorize(action, () => resource)(c, async () => {
    allowed = true;
  });
  if (allowed) return undefined;
  if (refused instanceof Response) return refused;
  throw new Error('The authorizer neither allowed the change nor refused it');
}

/** `enforce`'s answer for a version the caller can't see: a pin scope's check names no version, so it's never asked. */
function namesNoVersion(): never {
  throw new Error("A pin change's check names no version");
}

/** A pin scope that reaches more than one project: the tenant's, an org's, or none given (tenant-wide). A project or one of its segments stays within one. */
function spansEnvironmentsScope(scope: AgentPinScope | undefined): boolean {
  return scope?.kind !== 'project' && scope?.kind !== 'segment';
}

/**
 * The 409 a pin wider than one project answers for an agent in
 * an order, in the envelope and message shape a flow's or a tool's uses
 * (`pinWidthRefusal`). It names the scope asked for, the agent and the
 * order (by its parent), and says to pin the agent one environment at a
 * time.
 */
function spansEnvironments(
  c: Ctx,
  agentId: string,
  scope: AgentPinScope | undefined,
  order: EnvironmentOrderLocation,
): Response {
  const requestId = c.get('requestId');
  c.status(409);
  const scopeAsked =
    scope?.kind === 'org'
      ? `An org-wide pin (org ${scope.orgId as unknown as string})`
      : 'A tenant-wide pin';
  const orderName =
    order.parent.kind === 'org'
      ? `org ${order.parent.orgId as unknown as string}'s environment order`
      : "the tenant's environment order";
  return c.json(
    toWireError(
      {
        code: 'pin-scope-spans-environments',
        message: `${scopeAsked} of agent "${agentId}" would act across every environment of ${orderName} at once. Pin the agent one environment at a time, in each environment's project or a segment of it. Nothing was pinned.`,
      },
      typeof requestId === 'string' ? requestId : '',
    ),
  );
}

/**
 * Whether a pin for an agent in an order is refused for spanning
 * the order's environments: a tenant- or org-wide `scope` (one wider than a
 * project), for an agent any of whose projects is in an order — one project
 * or several. The 409 to answer, else `undefined`. For an agent in no order,
 * with a project scope, or with no rights to ask, `undefined` — today's
 * checks hold. It reads no body and answers nothing but the refusal. The
 * suggested change's pin calls it after its own `deny`, as the
 * pin routes and a deployment's make-live call it through
 * `agentPinChangeRefusal`.
 */
export async function widthRefusal(
  c: Ctx,
  how: {
    readonly rights: ItemRights | undefined;
    readonly agentId: string;
    readonly scope: AgentPinScope | undefined;
  },
): Promise<Response | undefined> {
  if (how.rights === undefined || !spansEnvironmentsScope(how.scope)) return undefined;
  const order = await how.rights.spannedOrder(c, 'agent', how.agentId);
  return order === undefined ? undefined : spansEnvironments(c, how.agentId, how.scope, order);
}

/**
 * What a change to a flow's or tool's pins asks (a pin, an unpin): a
 * project's is that project's (rule 3); the tenant's, an org's, or a scope
 * that isn't one (read leniently, so the 403 comes before the route's 400)
 * reaches every project of the item (rule 4).
 */
export function pinScopeCheck(scope: PinScope | undefined): ItemCheck {
  return scope?.kind === 'project'
    ? { rule: 'on', action: 'admin', projectId: scope.projectId as unknown as string }
    : { rule: 'every', action: 'admin' };
}

/**
 * Whether a change to a flow's or tool's pins at `scope` is refused for
 * its rights, whoever asks: for an item more than one project serves, what
 * `pinScopeCheck` names; else `pin` on the item. `undefined` when allowed;
 * else the response to answer. The width refusal comes after the route's
 * own checks (`pinWidthRefusal`).
 */
export async function pinChangeRefusal(
  c: Ctx,
  how: {
    readonly authorizer: Authorizer;
    readonly rights: ItemRights | undefined;
    readonly kind: PinnedItemKind;
    readonly itemId: string;
    readonly scope: PinScope | undefined;
  },
): Promise<Response | undefined> {
  const projects = await how.rights?.multi(c, how.kind, how.itemId);
  if (how.rights !== undefined && projects !== undefined) {
    return how.rights.enforce(
      c,
      how.kind,
      how.itemId,
      projects,
      pinScopeCheck(how.scope),
      namesNoVersion,
    );
  }
  return authorizedOn(c, how.authorizer, 'pin', ref(how.kind, how.itemId));
}

/**
 * The 409 a pin wider than one project answers for a flow or tool any of
 * whose projects is in an environment order (`pin-scope-spans-environments`):
 * such a pin would act in every environment of that order at once. An
 * unpin is never refused for its width. `undefined` for an item in no
 * order, a project scope, or with no rights to ask.
 */
export async function pinWidthRefusal(
  c: Ctx,
  how: {
    readonly rights: ItemRights | undefined;
    readonly kind: PinnedItemKind;
    readonly itemId: string;
    readonly scope: PinScope;
  },
): Promise<Response | undefined> {
  if (how.rights === undefined || how.scope.kind === 'project') return undefined;
  const order = await how.rights.spannedOrder(c, how.kind, how.itemId);
  if (order === undefined) return undefined;
  const requestId = c.get('requestId');
  const scopeAsked =
    how.scope.kind === 'org'
      ? `An org-wide pin (org ${how.scope.orgId as unknown as string})`
      : 'A tenant-wide pin';
  const orderName =
    order.parent.kind === 'org'
      ? `org ${order.parent.orgId as unknown as string}'s environment order`
      : "the tenant's environment order";
  const instead =
    how.kind === 'tool'
      ? "Pin the tool in the order's first environment, where agent and flow versions are made."
      : "Pin the flow one environment at a time, in each environment's project.";
  c.status(409);
  return c.json(
    toWireError(
      {
        code: 'pin-scope-spans-environments',
        message: `${scopeAsked} of ${how.kind} "${how.itemId}" would act across every environment of ${orderName} at once. ${instead} Nothing was pinned.`,
      },
      typeof requestId === 'string' ? requestId : '',
    ),
  );
}

/**
 * The authorization middleware under one item (`/:id` and `/:id/*`): for
 * an item more than one project serves, what `check` names (`enforce`);
 * else `today`, the item's own check, as before. `today` returning
 * `undefined` leaves the route to check for itself.
 */
export function itemMiddleware(how: {
  readonly authorizer: Authorizer;
  readonly rights: ItemRights | undefined;
  readonly kind: OrderItemKind;
  readonly id: (c: Ctx) => string;
  readonly today: (c: Ctx) => Action | undefined | Promise<Action | undefined>;
  readonly check: (c: Ctx, projects: readonly ProjectId[]) => ItemCheck | Promise<ItemCheck>;
  readonly versionNotFound: (c: Ctx, version: string) => Response;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const today = await how.today(c);
    if (today === undefined) return next();
    const id = how.id(c);
    const projects = await how.rights?.multi(c, how.kind, id);
    if (how.rights !== undefined && projects !== undefined) {
      const check = await how.check(c, projects);
      return (
        (await how.rights.enforce(c, how.kind, id, projects, check, how.versionNotFound)) ?? next()
      );
    }
    const type = ITEM_TYPE[how.kind];
    if (type === undefined) return next();
    return how.authorizer.authorize(today, () => ref(type, id))(c, next);
  };
}

/** What `shownLatest` answers. */
export type ShownLatest<T> =
  | { readonly kind: 'ok'; readonly row: T }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'bad-input'; readonly message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which version `GET /:id` answers, given the item's newest active one.
 * An item more than one project serves answers the newest the caller can
 * see (rule 2), or with `?projectId=P`, the newest that can run in P, a
 * project the caller reads (every one, with no authorizer: `serving` is
 * then `itemServingOf`'s). An item with one project answers `latest`,
 * when `?projectId=` names no project or names its own; a row that names
 * no project (`kindgi dev` reads a pack's agents, flows and tools from
 * disk) is every project's. Anything else is the route's 404, as a
 * hidden item is.
 */
export async function shownLatest<T>(
  c: Ctx,
  serving: ItemServing | undefined,
  kind: OrderItemKind,
  id: string,
  latest: T,
  how: {
    readonly versionOf: (row: T) => string;
    readonly projectOf: (row: T) => string | undefined;
    readonly getVersion: (version: string) => Promise<T | null>;
  },
): Promise<ShownLatest<T>> {
  const inProject = c.req.query('projectId');
  if (inProject !== undefined && !UUID_RE.test(inProject)) {
    return { kind: 'bad-input', message: '`projectId` must be a project id (a UUID)' };
  }
  const all = await serving?.projects(c, kind, id);
  if (serving === undefined || all === undefined || all.length <= 1) {
    const own = all?.[0] ?? how.projectOf(latest);
    return inProject === undefined || own === undefined || inProject === own
      ? { kind: 'ok', row: latest }
      : { kind: 'not-found' };
  }
  const newest = await serving.newestVisible(c, kind, id, all, inProject);
  if (newest === undefined) return { kind: 'not-found' };
  if (newest === how.versionOf(latest)) return { kind: 'ok', row: latest };
  const row = await how.getVersion(newest);
  return row === null ? { kind: 'not-found' } : { kind: 'ok', row };
}

/**
 * What a route under an item asks, by its path: a read is rules 1 and 2;
 * unregistering or reinstating a version is `admin` on each project it
 * can run in; any other change, `admin` on each of the item's projects.
 */
export function itemPathCheck(c: Ctx): ItemCheck {
  const under = underItem(c);
  if (c.req.method === 'GET') return readCheck(under);
  const [first, version, verb] = under;
  if (
    under.length === 3 &&
    first === 'versions' &&
    version !== undefined &&
    (verb === 'unregister' || verb === 'reinstate')
  ) {
    return { rule: 'every-version', action: 'admin', version };
  }
  return { rule: 'every', action: 'admin' };
}
