// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/deployments` wire adapter. Two exports:
 *
 *   - `buildPostBody(envelope)` — strips `tenantId` + `$schema` +
 *     `buildLogsUrl` from the envelope; the server derives `tenantId`
 *     from the bearer token and returns 400 signature-invalid if the
 *     signed envelope's tenantId doesn't match. `buildLogsUrl` is CLI-
 *     local metadata, not part of the wire contract.
 *
 *   - `deriveIdempotencyKey(body)` — `sha256:<hex>` over the
 *     canonicalised POST body; matches every other hash shape in the
 *     codebase. Callers can override via
 *     `--idempotency-key <str>` for CI re-runs that manage keys
 *     externally.
 *
 *   - `postDeploymentReal(opts)` — the production runner: does the
 *     actual HTTP POST via the caller-supplied `fetchImpl`, parses the
 *     server's response, discriminates 201 / 200 / 4xx / 5xx. A refusal
 *     carries its `Retry-After` and the limit a `429` names, for the
 *     command to wait out (`rate-limit-wait.ts`), and the position a
 *     `409 environment-takes-promotions` names, for its hint.
 *
 *   - `listProjectsReal` / `findProjectsReal` / `listEnvironmentOrdersReal`
 *     — the reads `--project <slug>` and that hint make, every page.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../build/envelope.js';
import type { DeployEnvelope } from '../build/envelope.js';
import type { ServedEnv } from '../value-target.js';
import type {
  DeploymentRecord,
  EnvironmentOrderRow,
  FindProjectsOptions,
  FindProjectsResult,
  GetDeploymentOptions,
  GetDeploymentResult,
  GetPackEnvResult,
  ListEnvironmentOrdersResult,
  ListOptions,
  ListProjectsResult,
  PackEnvRecord,
  PostDeploymentBody,
  PostDeploymentOptions,
  PostDeploymentResult,
  ProjectRow,
  ServedEnvOptions,
  SyncSecretsBody,
  SyncSecretsOptions,
  SyncSecretsResult,
  SyncSecretsSuccess,
} from './runners.js';

/**
 * Build the exact wire body per
 * `packages/api/src/openapi/schemas.ts:3141` — the
 * `DeploymentRegistrationBodySchema`. `tenantId` is deliberately
 * absent (server-derived from the token); the envelope's signature
 * covers it via re-canonicalisation on the server.
 *
 * `$schema` (envelope-side namespace pin) and `buildLogsUrl` (build-
 * server URL, only useful for humans debugging failed builds) are
 * client-side metadata — not part of the deployment wire contract.
 */
export function buildPostBody(envelope: DeployEnvelope): PostDeploymentBody {
  if (
    envelope.signerKeyId === undefined ||
    envelope.signerPublicKey === undefined ||
    envelope.signature === undefined
  ) {
    // Should not happen — the caller pre-validates via `isEnvelopeSigned`.
    // We throw here (as opposed to returning Result) because it's a
    // programmer error, not user error.
    throw new Error(
      'buildPostBody() called on an unsigned envelope. Check with `isEnvelopeSigned` first.',
    );
  }
  // publishedAt stays last, the order a released CLI sends: the server's
  // idempotency check fingerprints the body's bytes, so the same envelope
  // deployed again under the same key by another CLI version, its keys
  // reordered, would be refused as a different body.
  const { publishedAt, ...fields } = unsignedPostBody(envelope);
  return {
    ...fields,
    signerKeyId: envelope.signerKeyId,
    signerPublicKey: envelope.signerPublicKey,
    signature: envelope.signature,
    publishedAt,
  };
}

/** The wire body without the signature's three fields: all an unsigned envelope has. */
export type UnsignedPostBody = Omit<
  PostDeploymentBody,
  'signerKeyId' | 'signerPublicKey' | 'signature'
>;

/**
 * The body less the signature's fields: what `--dry-run` shows for an
 * unsigned envelope, and what `buildPostBody` adds the signature to, so
 * a field the wire gains is in both. The server refuses it as it is, so
 * nothing sends it.
 */
export function unsignedPostBody(envelope: DeployEnvelope): UnsignedPostBody {
  return {
    imageRef: envelope.imageRef,
    artifactVersion: envelope.artifactVersion,
    index: envelope.index,
    indexHash: envelope.indexHash,
    publishedAt: envelope.publishedAt,
  };
}

/**
 * `sha256:<hex>` over the canonical (sorted-key, no-whitespace) JSON
 * representation of the wire body. Matches the sha256 shape every other hash in the framework uses.
 *
 * The idempotency middleware on `packages/api` caches the full HTTP
 * response by `(tenantId, Idempotency-Key)`. Same body → same key →
 * same cached response (201 or 200-replay). Different body + same
 * key → server returns `idempotency-key-conflict`.
 */
export function deriveIdempotencyKey(body: PostDeploymentBody): string {
  const canonical = stableStringify(body);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Production `postDeployment` runner. Executes the HTTP POST, parses
 * the response, discriminates the outcome. Tests substitute this whole
 * function via `DeployRunners.postDeployment` to keep the wire
 * synthetic.
 */
export async function postDeploymentReal(
  opts: PostDeploymentOptions,
): Promise<PostDeploymentResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': opts.idempotencyKey,
      },
      body: JSON.stringify(opts.body),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return {
      kind: 'transport-error',
      message: `POST ${url} failed: ${(err as Error).message}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — treat as transport-level failure.
    return {
      kind: 'transport-error',
      message: `POST ${url} returned HTTP ${res.status} with non-JSON body`,
    };
  }

  const replay = res.headers.get('x-idempotent-replay') === 'true' && { idempotentReplay: true };
  if (res.status === 201) {
    return {
      kind: 'created',
      status: 201,
      record: body as DeploymentRecord,
      ...replay,
    };
  }
  if (res.status === 200) {
    return {
      kind: 'replayed',
      status: 200,
      record: body as DeploymentRecord,
      ...replay,
    };
  }

  // 4xx / 5xx — the api-server wraps errors in `{ error: { code,
  // message, details? } }` via `toWireError` in
  // `packages/api/src/errors.ts`.
  const wire = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
  const code = wire?.error?.code ?? `http-${res.status}`;
  const message = wire?.error?.message ?? `HTTP ${res.status}`;
  const wireDetails = wire?.error?.details as
    | {
        readonly issues?: unknown;
        readonly limit?: unknown;
        readonly cause?: unknown;
        readonly position?: unknown;
        readonly firstProjectId?: unknown;
      }
    | undefined;
  const details = Array.isArray(wireDetails?.issues)
    ? (wireDetails.issues as readonly Record<string, unknown>[])
    : undefined;
  const limit = wireDetails?.limit;
  const cause = wireDetails?.cause;
  const position = wireDetails?.position;
  const firstProjectId = wireDetails?.firstProjectId;
  const retryAfter = res.headers.get('retry-after')?.trim();
  return {
    kind: 'wire-error',
    status: res.status,
    ...replay,
    // The server sends whole seconds.
    ...(retryAfter !== undefined &&
      /^\d+$/.test(retryAfter) && { retryAfterSeconds: Number(retryAfter) }),
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
      ...(typeof limit === 'string' && { limit }),
      ...(typeof cause === 'string' && { cause }),
      ...(Number.isSafeInteger(position) &&
        (position as number) >= 0 && { position: position as number }),
      ...(typeof firstProjectId === 'string' && firstProjectId !== '' && { firstProjectId }),
    },
  };
}

/**
 * Derive the Idempotency-Key for a sync-secrets POST. Same shape as
 * `deriveIdempotencyKey` for deployments (sha256 of canonical body) —
 * so a re-run of the same deploy with the same `.env.<envName>` sends
 * the same key and the server middleware caches the response.
 */
export function deriveSyncSecretsIdempotencyKey(
  deploymentId: string,
  body: SyncSecretsBody,
): string {
  const canonical = stableStringify({ deploymentId, ...body });
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Production `syncSecrets` runner. Executes
 * `POST /v1/deployments/:deploymentId/secrets` — the wire body carries
 * plaintext `value` entries at the developer boundary; the server
 * responds with references only. Errors surface as `wire-error` (with
 * the server's error code preserved for the CLI banner) or
 * `transport-error`.
 */
export async function syncSecretsReal(opts: SyncSecretsOptions): Promise<SyncSecretsResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments/${encodeURIComponent(opts.deploymentId)}/secrets`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': opts.idempotencyKey,
      },
      body: JSON.stringify(opts.body),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return {
      kind: 'transport-error',
      message: `POST ${url} failed: ${(err as Error).message}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return {
      kind: 'transport-error',
      message: `POST ${url} returned HTTP ${res.status} with non-JSON body`,
    };
  }

  if (res.status === 200) {
    return {
      kind: 'ok',
      status: 200,
      response: body as SyncSecretsSuccess,
    };
  }

  const wire = body as { error?: { code?: string; message?: string } } | null;
  return {
    kind: 'wire-error',
    status: res.status,
    error: {
      code: wire?.error?.code ?? `http-${res.status}`,
      message: wire?.error?.message ?? `HTTP ${res.status}`,
    },
  };
}

/**
 * whoami's `servedEnv`: the env the runtime serves, and whether it refuses
 * values under any other. `undefined` when it names none (a runtime that
 * serves no env, or an older one), or on any failure: the runtime still
 * refuses the sync itself.
 */
export async function servedEnvReal(opts: ServedEnvOptions): Promise<ServedEnv | undefined> {
  try {
    const res = await opts.fetchImpl(`${opts.endpoint.replace(/\/+$/, '')}/v1/identity/whoami`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    if (!res.ok) return undefined;
    const served = (
      (await res.json()) as { servedEnv?: { envName?: unknown; refusesOtherEnvs?: unknown } }
    ).servedEnv;
    return typeof served?.envName === 'string' && typeof served.refusesOtherEnvs === 'boolean'
      ? { envName: served.envName, refusesOtherEnvs: served.refusesOtherEnvs }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The most a page of a list holds. */
const PAGE_LIMIT = 100;

/**
 * Every row of a tenant list (`GET /v1/projects`, say), read page by page.
 * The token's own rights decide what it lists.
 */
async function listAllReal(
  opts: ListOptions,
  path: string,
): Promise<
  | { readonly kind: 'ok'; readonly rows: readonly unknown[] }
  | { readonly kind: 'error'; readonly message: string }
> {
  const base = `${opts.endpoint.replace(/\/+$/, '')}${path}`;
  const rows: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage(opts, base, cursor);
    if (page.kind === 'error') return page;
    rows.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { kind: 'ok', rows };
}

/** One page of that list, from `cursor`; `nextCursor` while there's more. */
async function readPage(
  opts: ListOptions,
  base: string,
  cursor: string | undefined,
): Promise<
  | { readonly kind: 'ok'; readonly data: readonly unknown[]; readonly nextCursor?: string }
  | { readonly kind: 'error'; readonly message: string }
> {
  const url = `${base}?limit=${PAGE_LIMIT}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return { kind: 'error', message: `GET ${base} failed: ${(err as Error).message}` };
  }
  let page: { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
  try {
    page = (await res.json()) as typeof page;
  } catch {
    return {
      kind: 'error',
      message: `GET ${base} returned HTTP ${res.status} with a body that isn't JSON`,
    };
  }
  if (!res.ok || !Array.isArray(page.data)) {
    const code = (page as { error?: { code?: unknown } }).error?.code;
    return {
      kind: 'error',
      message: `GET ${base} answered HTTP ${res.status}${typeof code === 'string' ? ` (${code})` : ''}`,
    };
  }
  const more = page.hasMore === true && typeof page.nextCursor === 'string';
  return { kind: 'ok', data: page.data, ...(more && { nextCursor: page.nextCursor as string }) };
}

/** Every project the token can read (`GET /v1/projects`, every page). */
export async function listProjectsReal(opts: ListOptions): Promise<ListProjectsResult> {
  const listed = await listAllReal(opts, '/v1/projects');
  if (listed.kind === 'error') return listed;
  const projects: ProjectRow[] = [];
  for (const p of listed.rows as {
    id?: unknown;
    name?: unknown;
    slug?: unknown;
    orgId?: unknown;
    formerSlugs?: unknown;
  }[]) {
    if (typeof p?.id !== 'string') continue;
    const formerSlugs = Array.isArray(p.formerSlugs)
      ? p.formerSlugs.filter((s): s is string => typeof s === 'string')
      : undefined;
    projects.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      ...(typeof p.slug === 'string' && { slug: p.slug }),
      ...(typeof p.orgId === 'string' && { orgId: p.orgId }),
      ...(formerSlugs !== undefined && { formerSlugs }),
    });
  }
  return { kind: 'ok', projects };
}

/**
 * Every project of the tenant whose slug is `opts.slug`, or was before it
 * was renamed, from `GET /v1/projects` (it has no slug filter).
 */
export async function findProjectsReal(opts: FindProjectsOptions): Promise<FindProjectsResult> {
  const listed = await listProjectsReal(opts);
  if (listed.kind === 'error') return listed;
  return {
    kind: 'ok',
    projects: listed.projects.filter(
      (p) => p.slug === opts.slug || p.formerSlugs?.includes(opts.slug) === true,
    ),
  };
}

/** Every environment order the token can read a project in (`GET /v1/environment-orders`, every page). */
export async function listEnvironmentOrdersReal(
  opts: ListOptions,
): Promise<ListEnvironmentOrdersResult> {
  const listed = await listAllReal(opts, '/v1/environment-orders');
  if (listed.kind === 'error') return listed;
  const orders: EnvironmentOrderRow[] = [];
  for (const o of listed.rows as { entries?: unknown }[]) {
    if (!Array.isArray(o?.entries)) continue;
    const entries: { position: number; projectId?: string }[] = [];
    for (const e of o.entries as { position?: unknown; projectId?: unknown }[]) {
      if (!Number.isSafeInteger(e?.position)) continue;
      entries.push({
        position: e.position as number,
        ...(typeof e.projectId === 'string' && { projectId: e.projectId }),
      });
    }
    orders.push({ entries });
  }
  return { kind: 'ok', orders };
}

/** `GET /v1/deployments/:id`: the deployment as the runtime has it now. */
export async function getDeploymentReal(opts: GetDeploymentOptions): Promise<GetDeploymentResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments/${encodeURIComponent(opts.deploymentId)}`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return { kind: 'error', message: `GET ${url} failed: ${(err as Error).message}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      kind: 'error',
      message: `GET ${url} answered HTTP ${res.status} with a body that isn't JSON`,
    };
  }
  if (!res.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return {
      kind: 'error',
      message: `GET ${url} answered HTTP ${res.status}${typeof code === 'string' ? ` (${code})` : ''}`,
    };
  }
  return { kind: 'ok', record: body as DeploymentRecord };
}

/** `GET /v1/deployments/:id/pack-env`: where each name the deployment's pack declares is set. */
export async function getPackEnvReal(opts: GetDeploymentOptions): Promise<GetPackEnvResult> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/deployments/${encodeURIComponent(opts.deploymentId)}/pack-env`;
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    return { kind: 'error', message: `GET ${url} failed: ${(err as Error).message}` };
  }
  // 501: its pack services take their env from how they're run; 404: a server before the route.
  if (res.status === 501 || res.status === 404) return { kind: 'not-served' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      kind: 'error',
      message: `GET ${url} answered HTTP ${res.status} with a body that isn't JSON`,
    };
  }
  const packEnv = body as Partial<PackEnvRecord> | null;
  if (!res.ok || typeof packEnv?.envName !== 'string' || !Array.isArray(packEnv.data)) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return {
      kind: 'error',
      message: `GET ${url} answered HTTP ${res.status}${typeof code === 'string' ? ` (${code})` : ''}`,
    };
  }
  return { kind: 'ok', packEnv: packEnv as PackEnvRecord };
}
