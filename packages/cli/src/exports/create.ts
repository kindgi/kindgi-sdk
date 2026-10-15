// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi exports create`: everything the workspace holds, read through
 * the API, written as files in one folder.
 *
 * - Each kind in `EXPORT_PLAN` becomes `<kind>.jsonl`, written to
 *   `<kind>.jsonl.partial` and renamed when its last record is in, so a
 *   file that's there is whole.
 * - `manifest.json` says, after every kind, what was exported, from where,
 *   and each kind's outcome: `ok` (its file and record count), `skipped`
 *   (and why) or `failed` (the error). A kind that fails doesn't stop the
 *   others. `--resume` reads it and skips the kinds already `ok`.
 * - Then the signed exports, under `signed/`: each decided approval's audit
 *   bundle, each run's provenance, and the compliance evidence, each a
 *   `POST` the server records as an `export-signed` audit event.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

import { EXPORT_PLAN } from './plan.js';
import type { ExportKind, ParentRef } from './plan.js';
import { ReadError, fillRoute } from './reader.js';
import type { Query, Reader } from './reader.js';

export const MANIFEST_FILE = 'manifest.json';

/** What an export never holds, in the manifest's words. */
export const NEVER_EXPORTED: readonly string[] = [
  "Secret values: the API never answers them. secrets.jsonl and secret-versions.jsonl hold each secret's name, scope and versions.",
  'Pack images: build them again from the packs’ sources.',
  "Pack and run logs: the server's logging keeps them, not the workspace's API.",
];

/** The signed exports, by the name the manifest gives them. */
export const SIGNED = {
  approvals: 'signed/approvals',
  provenance: 'signed/provenance',
  evidence: 'signed/compliance-evidence',
} as const;

/** The approval statuses an audit bundle is made for: a decided approval's. */
const DECIDED = new Set(['approved', 'rejected', 'escalated', 'expired', 'withdrawn']);

export type KindOutcome =
  | {
      readonly status: 'ok';
      /** The file or folder, under the export's folder. */
      readonly file: string;
      readonly records: number;
      /** When its last record was read. */
      readonly at: string;
      /** Records listed, then gone (`404`) before they could be read. */
      readonly gone?: number;
      /** Signed without their messages: the server refused the size with them. */
      readonly withoutMessages?: number;
    }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string };

export interface Manifest {
  readonly cliVersion: string;
  readonly server: string;
  readonly tenant: { readonly id: string; readonly state?: string };
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly consistency: string;
  readonly kinds: Readonly<Record<string, KindOutcome>>;
  readonly neverExported: readonly string[];
}

/** The output, clock and pauses `kindgi exports create` uses: tests inject them; production leaves them out. */
export interface ExportsSeam {
  /** Where each kind's line goes, as it ends. Default: stderr. */
  readonly progress?: (line: string) => void;
  readonly now?: () => Date;
  /** The pause before a `5xx` is sent again. Default: a timer. */
  readonly pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CreateExportInput {
  /** The folder the export is written to. */
  readonly out: string;
  /** Finish the export in `out`, skipping the kinds its manifest marks `ok`. */
  readonly resume: boolean;
  /** Make the signed exports too. */
  readonly signed: boolean;
  /** Whether the caller is a tenant admin; the kinds marked `admin` are skipped otherwise. */
  readonly admin: boolean;
  readonly tenantId: string;
  readonly reader: Reader;
  readonly server: string;
  readonly cliVersion: string;
  readonly now?: () => Date;
  /** One line per kind, as it ends. */
  readonly progress?: (line: string) => void;
  readonly stopSignal?: AbortSignal;
}

/** Export the workspace; the manifest, as written last. */
export async function createExport(input: CreateExportInput): Promise<Manifest> {
  const now = input.now ?? (() => new Date());
  const progress = input.progress ?? (() => undefined);
  const earlier = await prepareFolder(input);
  const started = now().toISOString();
  const state = await tenantState(input.reader);
  const kinds: Record<string, KindOutcome> = { ...(earlier?.kinds ?? {}) };
  const manifest = (finishedAt?: string): Manifest => ({
    cliVersion: input.cliVersion,
    server: input.server,
    tenant: { id: input.tenantId, ...(state !== undefined && { state }) },
    startedAt: earlier?.startedAt ?? started,
    ...(finishedAt !== undefined && { finishedAt }),
    consistency: consistencyOf(state),
    kinds,
    neverExported: NEVER_EXPORTED,
  });
  const save = (finishedAt?: string): Promise<void> =>
    writeAtomically(
      join(input.out, MANIFEST_FILE),
      `${JSON.stringify(manifest(finishedAt), null, 2)}\n`,
    );

  const ctx: KindContext = { ...input, now, kinds };
  const steps: readonly (readonly [string, () => Promise<KindOutcome>])[] = [
    ...EXPORT_PLAN.map((kind) => [kind.name, () => exportKind(ctx, kind)] as const),
    [SIGNED.approvals, () => signApprovals(ctx)],
    [SIGNED.provenance, () => signProvenance(ctx)],
    [SIGNED.evidence, () => signEvidence(ctx)],
  ];
  const stopped = (): boolean => input.stopSignal?.aborted === true;
  await save();
  // A kind is `ok` only when what it's read from was, so keeping the `ok`
  // ones never leaves a kind read from data this run read again.
  for (const [name, run] of steps) {
    if (stopped()) break;
    if (kinds[name]?.status === 'ok') continue;
    const outcome = await run();
    // Stopped part way: the kind is left for --resume, not marked failed.
    if (stopped() && outcome.status === 'failed') break;
    kinds[name] = outcome;
    progress(progressLine(name, outcome));
    await save();
  }
  const finished = stopped() ? undefined : now().toISOString();
  await save(finished);
  return manifest(finished);
}

/** The kinds a kind is read from: its parent, or, read at each env and scope, what lists them. */
function needsOf(kind: ExportKind): string[] {
  if (kind.parent !== undefined) return [kind.parent.kind];
  if (kind.envScoped === true) return ['environments', 'orgs', 'projects'];
  return [];
}

interface KindContext extends CreateExportInput {
  readonly now: () => Date;
  readonly kinds: Readonly<Record<string, KindOutcome>>;
}

/** Check `out`: new or empty, or, with `--resume`, an export of this tenant on this server. Its manifest, when resuming. */
async function prepareFolder(input: CreateExportInput): Promise<Manifest | undefined> {
  let entries: string[];
  try {
    entries = await readdir(input.out);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    entries = [];
  }
  if (!input.resume) {
    if (entries.length > 0) {
      throw new Error(
        `${input.out} isn't empty. Name a new or empty folder with --out, or pass --resume to finish the export that's there.`,
      );
    }
    await mkdir(input.out, { recursive: true });
    return undefined;
  }
  let earlier: Manifest;
  try {
    earlier = JSON.parse(await readFile(join(input.out, MANIFEST_FILE), 'utf8')) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${input.out} has no ${MANIFEST_FILE}, so there's no export there to resume. Leave out --resume to start one in a new or empty folder.`,
      );
    }
    throw new Error(
      `${join(input.out, MANIFEST_FILE)} isn't an export's manifest: ${(err as Error).message}`,
    );
  }
  if (earlier.server !== input.server || earlier.tenant?.id !== input.tenantId) {
    throw new Error(
      `${input.out} holds an export of tenant ${earlier.tenant?.id} from ${earlier.server}, not of tenant ${input.tenantId} from ${input.server}. Resume it against that server and tenant, or start a new export in a new or empty folder.`,
    );
  }
  return earlier;
}

async function tenantState(reader: Reader): Promise<string | undefined> {
  try {
    const tenant = (await reader.one('/v1/tenant')) as { state?: unknown };
    return typeof tenant.state === 'string' ? tenant.state : undefined;
  } catch {
    // The tenant kind says what went wrong.
    return undefined;
  }
}

function consistencyOf(state: string | undefined): string {
  if (state === 'closing' || state === 'suspended') {
    return `The tenant is ${state}: nothing in it changes but deletes and erasures, so the files agree with each other.`;
  }
  return "Records can change while the export reads them, so the files are each kind as it stood when it was read (its `at`), not one moment's snapshot.";
}

function progressLine(name: string, outcome: KindOutcome): string {
  switch (outcome.status) {
    case 'ok': {
      const gone =
        outcome.gone === undefined ? '' : `, ${outcome.gone} gone before they could be read`;
      return `${name}: ${outcome.records} ${outcome.records === 1 ? 'record' : 'records'}${gone}\n`;
    }
    case 'skipped':
      return `${name}: skipped, ${outcome.reason}\n`;
    case 'failed':
      return `${name}: failed, ${outcome.error}\n`;
  }
}

/** One kind: its file written whole, or what stopped it. */
async function exportKind(ctx: KindContext, kind: ExportKind): Promise<KindOutcome> {
  const unmet = unmetNeed(ctx, kind);
  if (unmet !== undefined) return { status: 'skipped', reason: unmet };
  const file = `${kind.name}.jsonl`;
  const partial = join(ctx.out, `${file}.partial`);
  const tally = { records: 0, gone: 0 };
  const sink = await openLines(partial);
  try {
    for await (const line of linesOf(ctx, kind, tally)) {
      await sink.write(line);
      tally.records++;
    }
    await sink.close();
    if (kind.bytes !== undefined) await writeBytes(ctx, kind, partial, tally);
    await rename(partial, join(ctx.out, file));
  } catch (err) {
    await sink.close().catch(() => undefined);
    await rm(partial, { force: true });
    const notServed =
      err instanceof ReadError &&
      kind.parent === undefined &&
      tally.records === 0 &&
      (err.status === 404 || err.status === 501);
    if (notServed)
      return {
        status: 'skipped',
        reason: `this server doesn't serve ${kind.route} (${err.status})`,
      };
    return { status: 'failed', error: (err as Error).message };
  }
  return ok(ctx, file, tally);
}

function ok(
  ctx: KindContext,
  file: string,
  tally: { records: number; gone: number; withoutMessages?: number },
): KindOutcome {
  return {
    status: 'ok',
    file,
    records: tally.records,
    at: ctx.now().toISOString(),
    ...(tally.gone > 0 && { gone: tally.gone }),
    ...((tally.withoutMessages ?? 0) > 0 && { withoutMessages: tally.withoutMessages }),
  };
}

/** Why a kind can't be read now, if it can't. */
function unmetNeed(ctx: KindContext, kind: ExportKind): string | undefined {
  if (kind.admin === true && !ctx.admin) return 'it needs a tenant admin';
  const missing = needsOf(kind).filter((name) => ctx.kinds[name]?.status !== 'ok');
  if (missing.length === 0) return undefined;
  return `it's read for each record of ${missing.join(', ')}, which ${missing.length === 1 ? "wasn't" : "weren't"} exported`;
}

/** Each line of a kind's file, as JSON text. */
function linesOf(
  ctx: KindContext,
  kind: ExportKind,
  tally: { gone: number },
): AsyncGenerator<string> {
  return kind.parent === undefined
    ? topLines(ctx, kind, tally)
    : childLines(ctx, kind, kind.parent, tally);
}

/** A child kind's lines: for each parent record, its children, each with its parent. */
async function* childLines(
  ctx: KindContext,
  kind: ExportKind,
  parent: ParentRef,
  tally: { gone: number },
): AsyncGenerator<string> {
  for await (const record of recordsOf(ctx, parent.kind)) {
    const params = fieldsOf(record, parent.params, parent.kind);
    const query = {
      ...kind.query,
      ...(kind.envScoped === true ? envScopeOf(record, parent.kind) : {}),
    };
    try {
      for await (const item of read(ctx.reader, kind, fillRoute(kind.route, params), query)) {
        yield `${JSON.stringify({ parent: params, item })}\n`;
      }
    } catch (err) {
      if (!isGone(err)) throw err;
      tally.gone++;
    }
  }
}

/** A top-level kind's lines: each record listed, at each env and scope if it has them, or each item's own record. */
async function* topLines(
  ctx: KindContext,
  kind: ExportKind,
  tally: { gone: number },
): AsyncGenerator<string> {
  const query = kind.query ?? {};
  const queries = kind.envScoped === true ? await envScopes(ctx, query) : [query];
  for (const q of queries) {
    for await (const listed of read(ctx.reader, kind, kind.route, q)) {
      const record =
        kind.item === undefined ? listed : await fullRecord(ctx, kind, kind.item, listed);
      if (record === GONE) {
        tally.gone++;
        continue;
      }
      yield `${JSON.stringify(record)}\n`;
    }
  }
}

const GONE = Symbol('gone');

/** A listed record's own route's answer, or `GONE` when it was deleted since it was listed. */
async function fullRecord(
  ctx: KindContext,
  kind: ExportKind,
  item: NonNullable<ExportKind['item']>,
  listed: unknown,
): Promise<unknown> {
  const params = fieldsOf(listed as Record<string, unknown>, item.params, kind.name);
  try {
    return await ctx.reader.one(fillRoute(item.route, params));
  } catch (err) {
    if (!isGone(err)) throw err;
    return GONE;
  }
}

/** A `404` for a record that was listed: deleted between the two reads. */
function isGone(err: unknown): boolean {
  return err instanceof ReadError && err.status === 404;
}

/** A route's records, as its paging reads them. */
async function* read(
  reader: Reader,
  kind: ExportKind,
  path: string,
  query: Query,
): AsyncGenerator<unknown> {
  switch (kind.paging) {
    case 'cursor':
      yield* reader.pages(path, query);
      return;
    case 'whole':
      yield* await reader.whole(path, query);
      return;
    case 'one':
      yield await reader.one(path, query);
      return;
  }
}

/** The records in an exported kind's file: each line, or its `item` for a child kind. */
async function* recordsOf(ctx: KindContext, name: string): AsyncGenerator<Record<string, unknown>> {
  const wrapped = EXPORT_PLAN.find((k) => k.name === name)?.parent !== undefined;
  const lines = createInterface({
    input: createReadStream(join(ctx.out, `${name}.jsonl`)),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line === '') continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    yield wrapped ? (value.item as Record<string, unknown>) : value;
  }
}

/** The values a route's path takes, from a record's fields. */
function fieldsOf(
  record: Record<string, unknown>,
  params: Readonly<Record<string, string>>,
  from: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [param, field] of Object.entries(params)) {
    const value = record[field];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`A record in ${from}.jsonl has no ${field}, which ${param} takes.`);
    }
    out[param] = String(value);
  }
  return out;
}

/** Each env name at each scope: the tenant, each org, each project. */
async function envScopes(ctx: KindContext, query: Query): Promise<Query[]> {
  const scopes: Query[] = [{ scopeKind: 'tenant' }];
  for await (const org of recordsOf(ctx, 'orgs'))
    scopes.push({ scopeKind: 'org', scopeId: String(org.id) });
  for await (const project of recordsOf(ctx, 'projects'))
    scopes.push({ scopeKind: 'project', scopeId: String(project.id) });
  const out: Query[] = [];
  for await (const env of recordsOf(ctx, 'environments')) {
    for (const scope of scopes) out.push({ ...query, envName: String(env.envName), ...scope });
  }
  return out;
}

/** The env and scope a record was read at, for reading its children there. */
function envScopeOf(record: Record<string, unknown>, from: string): Query {
  const scope = record.scope as
    | { kind?: unknown; orgId?: unknown; projectId?: unknown }
    | undefined;
  const envName = record.envName;
  if (typeof envName !== 'string' || typeof scope?.kind !== 'string') {
    throw new Error(`A record in ${from}.jsonl has no envName or scope to read its children at.`);
  }
  const id =
    scope.kind === 'org' ? scope.orgId : scope.kind === 'project' ? scope.projectId : undefined;
  return { envName, scopeKind: scope.kind, ...(typeof id === 'string' && { scopeId: id }) };
}

/** A name the server gave, safe as a file name in the export's folder. */
function safeName(id: string, what: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      `${what} ${JSON.stringify(id)} isn't a safe file name, so it can't be written.`,
    );
  }
  return id;
}

/** Each listed record's bytes, to `<dir>/<id>`. */
async function writeBytes(
  ctx: KindContext,
  kind: ExportKind,
  listed: string,
  tally: { gone: number },
): Promise<void> {
  const bytes = kind.bytes as NonNullable<ExportKind['bytes']>;
  const dir = join(ctx.out, bytes.dir);
  await mkdir(dir, { recursive: true });
  const lines = createInterface({
    input: createReadStream(listed),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line === '') continue;
    const params = fieldsOf(JSON.parse(line) as Record<string, unknown>, bytes.params, kind.name);
    const name = safeName(Object.values(params)[0] as string, `An ${kind.name} id`);
    const target = join(dir, name);
    try {
      await pipeline(
        await ctx.reader.bytes(fillRoute(bytes.route, params)),
        createWriteStream(`${target}.partial`),
      );
    } catch (err) {
      await rm(`${target}.partial`, { force: true });
      if (!isGone(err)) throw err;
      tally.gone++;
      continue;
    }
    await rename(`${target}.partial`, target);
  }
}

/** Why the signed exports can't be made, if they can't. */
function signedUnmet(ctx: KindContext, from: string): string | undefined {
  if (!ctx.signed) return '--no-signed';
  const keys = ctx.kinds['export-signing-keys'];
  if (keys?.status !== 'ok')
    return "export-signing-keys wasn't exported, so it isn't known whether this server signs exports";
  if (keys.records === 0)
    return "this server doesn't sign exports (it lists no export signing keys)";
  if (ctx.kinds[from]?.status !== 'ok')
    return `it's made for each record of ${from}, which wasn't exported`;
  return undefined;
}

async function signApprovals(ctx: KindContext): Promise<KindOutcome> {
  return signEach(ctx, 'approvals', SIGNED.approvals, (record) =>
    typeof record.status === 'string' && DECIDED.has(record.status) && typeof record.id === 'string'
      ? { id: record.id, path: `/v1/approvals/${encodeURIComponent(record.id)}/audit-bundle` }
      : undefined,
  );
}

async function signProvenance(ctx: KindContext): Promise<KindOutcome> {
  return signEach(ctx, 'provenance', SIGNED.provenance, (record) =>
    typeof record.runId === 'string'
      ? { id: record.runId, path: `/v1/provenance/${encodeURIComponent(record.runId)}/export` }
      : undefined,
  );
}

/** One signed export for each record of `from` that `target` picks, to `<dir>/<id>.json`. */
async function signEach(
  ctx: KindContext,
  from: string,
  dir: string,
  target: (
    record: Record<string, unknown>,
  ) => { readonly id: string; readonly path: string } | undefined,
): Promise<KindOutcome> {
  const unmet = signedUnmet(ctx, from);
  if (unmet !== undefined) return { status: 'skipped', reason: unmet };
  const tally = { records: 0, gone: 0, withoutMessages: 0 };
  try {
    await mkdir(join(ctx.out, dir), { recursive: true });
    for await (const record of recordsOf(ctx, from)) {
      const to = target(record);
      if (to === undefined) continue;
      const file = join(ctx.out, dir, `${safeName(to.id, `A ${from} id`)}.json`);
      let signed: unknown;
      try {
        signed = await ctx.reader.post(to.path, { includeMessages: true }, randomUUID());
      } catch (err) {
        if (isGone(err)) {
          tally.gone++;
          continue;
        }
        if (!(err instanceof ReadError && err.status === 413)) throw err;
        signed = await ctx.reader.post(to.path, { includeMessages: false }, randomUUID());
        tally.withoutMessages++;
      }
      await writeAtomically(file, `${JSON.stringify(signed, null, 2)}\n`);
      tally.records++;
    }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
  return ok(ctx, dir, tally);
}

async function signEvidence(ctx: KindContext): Promise<KindOutcome> {
  const unmet = signedUnmet(ctx, 'compliance-evidence');
  if (unmet !== undefined) return { status: 'skipped', reason: unmet };
  const file = `${SIGNED.evidence}.json`;
  try {
    const signed = await ctx.reader.post('/v1/compliance/evidence/export', {}, randomUUID());
    await mkdir(join(ctx.out, 'signed'), { recursive: true });
    await writeAtomically(join(ctx.out, file), `${JSON.stringify(signed, null, 2)}\n`);
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
  return ok(ctx, file, { records: 1, gone: 0 });
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await writeFile(`${file}.partial`, text);
  await rename(`${file}.partial`, file);
}

/** A file written line by line, waiting when the disk is behind. */
async function openLines(
  file: string,
): Promise<{ write(line: string): Promise<void>; close(): Promise<void> }> {
  const stream: WriteStream = createWriteStream(file);
  await new Promise<void>((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', reject);
  });
  let closed = false;
  return {
    write: (line) =>
      new Promise((resolve, reject) => {
        stream.write(line, (err) => (err ? reject(err) : resolve()));
      }),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}
