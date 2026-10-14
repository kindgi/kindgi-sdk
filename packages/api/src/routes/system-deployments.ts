// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { TenantId } from '@kindgi/types';

import {
  DEPLOYMENT_ENDPOINT_PROBLEM_CODES,
  type DeploymentEndpoint,
  type DeploymentEndpointProblemCode,
} from '../deployment-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type SystemTenantDirectory,
  requireSystemScope,
  systemReadAcrossTenants,
  withSystemTenantContext,
} from '../middleware/system.js';
import { hostNamesPackService, packServiceName } from '../pack-service-name.js';
import type { SystemScope } from '../system.js';
import type { AppEnv } from '../types.js';

/**
 * A deployment as the orchestrator needs it to create or retire its pack
 * service: ids and the image, nothing of the tenant beyond its id.
 */
export interface SystemDeploymentEntry {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
  /**
   * The pack it deploys (the image index's `packId`): retiring keeps the
   * newest few superseded deployments per tenant and pack.
   */
  readonly packId: string;
  /** The project the deploy was scoped to; absent for a tenant-wide one. */
  readonly projectId?: string;
  /** Digest-pinned, as registered: the service is created from exactly this. */
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly artifactVersion: string;
  /** ISO-8601. */
  readonly activatedAt: string;
}

/**
 * Why a deployment's pack service should go:
 * - `superseded`: no live or promoted version routes to it any more. The
 *   orchestrator may keep the newest few per pack, for rollbacks;
 * - `tenant-closing`, `tenant-suspended`: every deployment of the tenant,
 *   routed or not, since nothing of it runs;
 * - `project-suspended`, `pack-suspended`: every deployment of the project,
 *   or this deployment.
 */
export const SYSTEM_DEPLOYMENT_RETIRE_REASONS = [
  'superseded',
  'tenant-closing',
  'tenant-suspended',
  'project-suspended',
  'pack-suspended',
] as const;

export type SystemDeploymentRetireReason = (typeof SYSTEM_DEPLOYMENT_RETIRE_REASONS)[number];

export interface SystemDeploymentToRetire extends SystemDeploymentEntry {
  readonly reason: SystemDeploymentRetireReason;
}

/**
 * One page across tenants, or `cursor-unreadable` for a cursor the binding
 * never issued (stale or tampered): the route answers it `400`, as every
 * system list does.
 */
export type SystemDeploymentPage<T> =
  | {
      readonly kind: 'ok';
      readonly data: readonly T[];
      /** Absent on the last page. */
      readonly nextCursor?: string;
    }
  | { readonly kind: 'cursor-unreadable' };

/**
 * How the server calls a deployment's pack service:
 * - `google-id-token`: with an ID token for the endpoint's URL (Cloud
 *   Run's invoker check), and the pack token;
 * - `token`: with the pack token only.
 */
export type PackEndpointAuth = 'google-id-token' | 'token';

export const PACK_ENDPOINT_AUTHS: readonly PackEndpointAuth[] = ['google-id-token', 'token'];

export interface SetPackEndpointInput {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
  /** `https://<host>` (and a port, if any): no user info, path, query or fragment. */
  readonly url: string;
  readonly auth: PackEndpointAuth;
  /** The pack service's token. Stored wrapped; never returned, logged or recorded. */
  readonly token: string;
}

/** The checks the binding runs: what the server needs the pack service, or the tenant's record, for. */
export type SetPackEndpointOutcome =
  | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'suspended'; readonly reason: 'project-suspended' | 'pack-suspended' }
  | {
      readonly kind: 'refused';
      readonly code: Extract<
        DeploymentEndpointProblemCode,
        'endpoint-unreachable' | 'endpoint-info-mismatch' | 'image-not-allowed'
      >;
      /** For `endpoint-info-mismatch`: the names of the fields that differed, never their values. */
      readonly differs?: readonly string[];
    };

export interface DeploymentRef {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
}

/**
 * Where the runtime keeps each deployment's pack service: its endpoint
 * (URL, auth, wrapped token), its status and problem, and whether it's
 * suspended. Every method but the two lists acts inside the named tenant's
 * row-level security.
 */
export interface SystemDeploymentsBinding {
  /**
   * Across tenants, oldest `activatedAt` first: deployments that need a
   * pack service. Each is routed (a live or promoted version resolves to
   * it), has no endpoint or a cleared one, and nothing about it is closing
   * or suspended.
   */
  listNeedingEndpoint(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemDeploymentEntry>>;
  /**
   * Across tenants, oldest `activatedAt` first: deployments with an
   * endpoint whose pack service should go, each with its `reason`.
   */
  listToRetire(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemDeploymentToRetire>>;
  /**
   * Records the endpoint, once the binding's own checks pass: the project
   * and pack aren't suspended; the image is in the tenant's repository; the
   * pack service answers `/v1/info` (with the `kindgi-tenant-id` header) as
   * this deployment. A refusal is recorded as the endpoint's `problem`.
   * The same body twice records it once.
   */
  setEndpoint(input: SetPackEndpointInput): Promise<SetPackEndpointOutcome>;
  /** Clears the endpoint (`cleared`): calls fail closed. Clearing twice keeps the first time. */
  clearEndpoint(
    input: DeploymentRef,
  ): Promise<
    { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint } | { readonly kind: 'not-found' }
  >;
  /** Records why a pending deployment has no pack service yet. */
  recordProblem(
    input: DeploymentRef & { readonly code: DeploymentEndpointProblemCode },
  ): Promise<
    | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'not-pending'; readonly endpoint: DeploymentEndpoint }
  >;
  /**
   * Suspends the deployment's pack (or restores it): it lists to retire as
   * `pack-suspended`, its endpoint can't be set, and its calls fail closed.
   * Setting the same state twice keeps the first time.
   */
  setSuspended(
    input: DeploymentRef & { readonly suspended: boolean; readonly reason?: string },
  ): Promise<
    | { readonly kind: 'ok'; readonly suspended: boolean; readonly since: string }
    | { readonly kind: 'not-found' }
  >;
}

export interface SystemDeploymentsOptions {
  readonly binding: SystemDeploymentsBinding;
  /**
   * Check 2: whether an endpoint's host name is on the operator's allowlist
   * (`KINDGI_PACK_ENDPOINT_HOSTS`, read with `@kindgi/env-schema`'s
   * `packEndpointHostAllowed`). It's given the URL's `hostname`.
   */
  readonly endpointHostAllowed: (hostname: string) => boolean;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 128;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;
const MAX_REASON_LENGTH = 500;
const DEPLOYMENTS: SystemScope = 'system:deployments';
const SUSPEND: SystemScope = 'system:suspend';

type WireError = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;

/**
 * `/v1/system/deployments` and `/v1/system/tenants/{tenantId}/deployments/…`:
 * how whatever runs a pack service per deployment (an orchestrator) learns
 * which deployments need one or should lose theirs, and records where each
 * runs. Mounted only on a runtime serving many tenants, under
 * `system:deployments`, except the pack suspend route, which takes
 * `system:suspend`, so the orchestrator's key can't suspend or restore a
 * pack. No tenant input ever names a pack's URL.
 */
export function systemDeploymentsRouter(
  options: SystemDeploymentsOptions & {
    /** The tenants a system route can name, and their states (`systemTenantDirectory`). */
    readonly directory: SystemTenantDirectory;
    readonly authorizer?: Authorizer;
  },
): Hono<AppEnv> {
  const { binding, directory: tenants, authorizer } = options;
  const r = new Hono<AppEnv>();

  // ---------- GET /deployments?endpoint=missing|retire ----------
  r.get('/deployments', async (c) => {
    const denied = systemReadAcrossTenants(c, DEPLOYMENTS, authorizer);
    if (denied !== undefined) return denied;
    const want = c.req.query('endpoint');
    if (want !== 'missing' && want !== 'retire') {
      return fail(c, badInput('`endpoint` must be `missing` or `retire`').error);
    }
    const limit = parseLimit(c.req.query('limit'));
    if (limit.kind === 'err') return fail(c, limit.error);
    const cursor = c.req.query('cursor');
    const page = {
      ...(cursor !== undefined && cursor !== '' && { cursor }),
      limit: limit.value,
    };
    const result =
      want === 'missing'
        ? await binding.listNeedingEndpoint(page)
        : await binding.listToRetire(page);
    if (result.kind === 'cursor-unreadable') {
      return fail(c, badInput('`cursor` is not one this route gave: start again without it').error);
    }
    return c.json({
      data: result.data.map((entry) => ({
        ...entryToWire(entry),
        ...('reason' in entry && { reason: entry.reason }),
      })),
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
      hasMore: result.nextCursor !== undefined,
    });
  });

  const onDeployment = '/tenants/:tenantId/deployments/:deploymentId';

  // ---------- PUT …/endpoint ----------
  r.put(`${onDeployment}/endpoint`, requireSystemScope(DEPLOYMENTS, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseEndpoint(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: DEPLOYMENTS, refuse: ['closing', 'suspended'], ...(authorizer && { authorizer }) },
      async (tenant) => {
        const target = { tenantId: tenant.id, deploymentId: ref.value.deploymentId };
        const checked = checkEndpoint(parsed.value.url, target, options);
        if (checked.kind === 'err') {
          // On record, so a deploy waiting for `ready` can say why at once.
          const recorded = await binding.recordProblem({ ...target, code: checked.error.code });
          if (recorded.kind === 'not-found') return deploymentNotFound(c, target.deploymentId);
          return fail(c, checked.error);
        }
        const outcome = await binding.setEndpoint({
          ...target,
          url: checked.value.origin,
          auth: parsed.value.auth,
          token: parsed.value.token,
        });
        switch (outcome.kind) {
          case 'ok':
            return c.json(endpointToWire(outcome.endpoint));
          case 'not-found':
            return deploymentNotFound(c, target.deploymentId);
          case 'suspended':
            return fail(c, {
              code: outcome.reason,
              message: `Deployment ${target.deploymentId}'s ${outcome.reason === 'pack-suspended' ? 'pack' : 'project'} is suspended: its endpoint can't be set.`,
            });
          case 'refused':
            return fail(c, {
              code: outcome.code,
              message: REFUSED[outcome.code],
              ...(outcome.differs !== undefined && { differs: outcome.differs }),
            });
        }
      },
    );
  });

  // ---------- DELETE …/endpoint ----------
  // A closing or suspended tenant's endpoints are cleared too: that's how
  // its pack services are retired.
  r.delete(`${onDeployment}/endpoint`, requireSystemScope(DEPLOYMENTS, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: DEPLOYMENTS, ...(authorizer && { authorizer }) },
      async (tenant) => {
        const cleared = await binding.clearEndpoint({
          tenantId: tenant.id,
          deploymentId: ref.value.deploymentId,
        });
        if (cleared.kind === 'not-found') return deploymentNotFound(c, ref.value.deploymentId);
        return c.json(endpointToWire(cleared.endpoint));
      },
    );
  });

  // ---------- PUT …/endpoint/problem ----------
  r.put(
    `${onDeployment}/endpoint/problem`,
    requireSystemScope(DEPLOYMENTS, authorizer),
    async (c) => {
      const ref = deploymentRef(c);
      if (ref.kind === 'err') return fail(c, ref.error);
      const body = await readJsonBody(c);
      if (body.kind === 'err') return fail(c, body.error);
      const code = parseProblemBody(body.value);
      if (code.kind === 'err') return fail(c, code.error);
      return withSystemTenantContext(
        c,
        tenants,
        ref.value.tenantId,
        { scope: DEPLOYMENTS, ...(authorizer && { authorizer }) },
        async (tenant) => {
          const recorded = await binding.recordProblem({
            tenantId: tenant.id,
            deploymentId: ref.value.deploymentId,
            code: code.value,
          });
          switch (recorded.kind) {
            case 'ok':
              return c.json(endpointToWire(recorded.endpoint));
            case 'not-found':
              return deploymentNotFound(c, ref.value.deploymentId);
            case 'not-pending':
              return fail(c, {
                code: 'endpoint-not-pending',
                message: `Deployment ${ref.value.deploymentId}'s endpoint is ${recorded.endpoint.status}: a problem goes with pending only.`,
                status: recorded.endpoint.status,
              });
          }
        },
      );
    },
  );

  // ---------- PUT …/suspended (the pack) ----------
  r.put(`${onDeployment}/suspended`, requireSystemScope(SUSPEND, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseSuspendBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      // Closing is one-way: its deployments already list to retire, and the
      // only system write that still reaches it is retiring them.
      { scope: SUSPEND, refuse: ['closing'], ...(authorizer && { authorizer }) },
      async (tenant) => {
        const result = await binding.setSuspended({
          tenantId: tenant.id,
          deploymentId: ref.value.deploymentId,
          ...parsed.value,
        });
        if (result.kind === 'not-found') return deploymentNotFound(c, ref.value.deploymentId);
        return c.json({ suspended: result.suspended, since: result.since });
      },
    );
  });

  return r;
}

/** What the orchestrator reads when the binding refuses an endpoint. */
const REFUSED: Readonly<
  Record<Extract<SetPackEndpointOutcome, { kind: 'refused' }>['code'], string>
> = {
  'endpoint-unreachable': "The pack service didn't answer /v1/info as this deployment's service.",
  'endpoint-info-mismatch':
    "The pack service answered as another pack or version: it doesn't serve this deployment's image.",
  'image-not-allowed': "The deployment's image is outside the tenant's repository.",
};

type EndpointRefusal = WireError & { readonly code: DeploymentEndpointProblemCode };

/**
 * Checks 1 to 3, which need nothing but the request: the URL's shape, its
 * host on the operator's allowlist, and the host naming the deployment's
 * own service. Check 4 (the pack's own answer) and the image are the
 * binding's.
 */
function checkEndpoint(
  raw: string,
  target: DeploymentRef,
  options: SystemDeploymentsOptions,
): { kind: 'ok'; value: URL } | { kind: 'err'; error: EndpointRefusal } {
  const url = parseEndpointUrl(raw);
  if (url.kind === 'err') return url;
  const host = url.value.hostname.toLowerCase();
  if (!options.endpointHostAllowed(host)) {
    return {
      kind: 'err',
      error: {
        code: 'endpoint-host-not-allowed',
        message: `${host} isn't on the operator's allowlist of pack hosts (KINDGI_PACK_ENDPOINT_HOSTS).`,
      },
    };
  }
  const name = packServiceName(target.tenantId, target.deploymentId);
  if (!hostNamesPackService(host, name)) {
    return {
      kind: 'err',
      error: {
        code: 'endpoint-name-mismatch',
        message: `${host} doesn't name this deployment's pack service, ${name}.`,
        expected: name,
      },
    };
  }
  return url;
}

function entryToWire(entry: SystemDeploymentEntry) {
  return {
    tenantId: entry.tenantId as unknown as string,
    deploymentId: entry.deploymentId,
    packId: entry.packId,
    ...(entry.projectId !== undefined && { projectId: entry.projectId }),
    imageRef: entry.imageRef,
    imageDigest: entry.imageDigest,
    artifactVersion: entry.artifactVersion,
    activatedAt: entry.activatedAt,
  };
}

/** Named fields only: never the URL, the auth or the token. */
function endpointToWire(endpoint: DeploymentEndpoint) {
  return {
    status: endpoint.status,
    since: endpoint.since,
    ...(endpoint.status === 'pending' &&
      endpoint.problem !== undefined && {
        problem: { code: endpoint.problem.code, since: endpoint.problem.since },
      }),
  };
}

type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

/** The path's deployment: the tenant id is checked by `withSystemTenantContext`. */
function deploymentRef(
  c: Context<AppEnv>,
): Parsed<{ readonly tenantId: string; readonly deploymentId: string }> {
  const tenantId = c.req.param('tenantId') ?? '';
  const deploymentId = c.req.param('deploymentId') ?? '';
  if (deploymentId === '' || deploymentId.length > MAX_ID_LENGTH) {
    return badInput(`\`deploymentId\` must be 1 to ${MAX_ID_LENGTH} characters`);
  }
  return { kind: 'ok', value: { tenantId, deploymentId } };
}

function parseLimit(raw: string | undefined): Parsed<number> {
  if (raw === undefined || raw === '') return { kind: 'ok', value: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return badInput(`\`limit\` must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { kind: 'ok', value: n };
}

interface ParsedEndpointBody {
  /** As sent: checks 1 to 3 run in the tenant's context, so a refusal is on record. */
  readonly url: string;
  readonly auth: PackEndpointAuth;
  readonly token: string;
}

function parseEndpoint(body: unknown): Parsed<ParsedEndpointBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.url !== 'string') return badInput('`url` must be a string');
  if (typeof b.auth !== 'string' || !(PACK_ENDPOINT_AUTHS as readonly string[]).includes(b.auth)) {
    return badInput('`auth` must be `google-id-token` or `token`');
  }
  const token = b.token;
  if (
    typeof token !== 'string' ||
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    return badInput(
      `\`token\` must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} printable ASCII characters without spaces (it travels in a header)`,
    );
  }
  return { kind: 'ok', value: { url: b.url, auth: b.auth as PackEndpointAuth, token } };
}

/**
 * Check 1: `https`, no user info, no path beyond `/`, no query or fragment.
 * Refused as `endpoint-url-invalid`, a 400 the caller fixes.
 */
function parseEndpointUrl(
  raw: string,
): { kind: 'ok'; value: URL } | { kind: 'err'; error: EndpointRefusal } {
  const invalid = (why: string): { kind: 'err'; error: EndpointRefusal } => ({
    kind: 'err',
    error: { code: 'endpoint-url-invalid', message: `\`url\` ${why}` },
  });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid('must be an absolute URL');
  }
  if (url.protocol !== 'https:') return invalid('must be https');
  if (url.username !== '' || url.password !== '') return invalid('must carry no user info');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) {
    return invalid('must have no path beyond /, and no query or fragment');
  }
  return { kind: 'ok', value: url };
}

function parseProblemBody(body: unknown): Parsed<DeploymentEndpointProblemCode> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const code = (body as Record<string, unknown>).code;
  if (
    typeof code !== 'string' ||
    !(DEPLOYMENT_ENDPOINT_PROBLEM_CODES as readonly string[]).includes(code)
  ) {
    return badInput(`\`code\` must be one of ${DEPLOYMENT_ENDPOINT_PROBLEM_CODES.join(', ')}`);
  }
  return { kind: 'ok', value: code as DeploymentEndpointProblemCode };
}

function parseSuspendBody(
  body: unknown,
): Parsed<{ readonly suspended: boolean; readonly reason?: string }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.suspended !== 'boolean') return badInput('`suspended` must be true or false');
  if (b.reason !== undefined) {
    if (
      typeof b.reason !== 'string' ||
      b.reason.trim() === '' ||
      b.reason.length > MAX_REASON_LENGTH
    ) {
      return badInput(
        `\`reason\` must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`,
      );
    }
    return { kind: 'ok', value: { suspended: b.suspended, reason: b.reason } };
  }
  return { kind: 'ok', value: { suspended: b.suspended } };
}

async function readJsonBody(c: Context<AppEnv>): Promise<Parsed<unknown>> {
  try {
    return { kind: 'ok', value: JSON.parse(await c.req.text()) as unknown };
  } catch {
    return badInput('Request body must be JSON');
  }
}

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function deploymentNotFound(c: Context<AppEnv>, deploymentId: string): Response {
  return fail(c, {
    code: 'deployment-not-found',
    message: `No deployment "${deploymentId}" in this tenant.`,
  });
}

function fail(c: Context<AppEnv>, error: WireError): Response {
  c.status(statusFor(error.code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError(error, c.get('requestId')));
}
