// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type KeyObject, createHash, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { tenantInputBounds } from '@kindgi/bounds';
import {
  type VerifyInboundSignatureFailure,
  inboundSigningKey,
  verifyInboundSignature,
} from '@kindgi/crypto';
import type { Logger } from '@kindgi/log';
import type { Scope } from '@kindgi/platform';
import type { EnvName, ProjectId, TenantId, TriggerId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { deepJsonRefusal, nestsDeeperThan } from '../middleware/request-body.js';
import { type TenantLimiter, tenantLimitReached } from '../middleware/tenant-limits.js';
import {
  type TenantStateBinding,
  frozenTenantRefusal,
  tenantStateReader,
} from '../middleware/tenant-state.js';
import { type ProviderKeys, guardProviderKeys } from '../provider-keys.js';
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
  nearestForwardedClient,
} from '../rate-limit-store.js';
import { resolveAtScope, scopeOfRecorded } from '../secret-scope.js';
import type { SecretBinding, SecretWrites } from '../secrets-binding.js';
import {
  type FoundWebhookTrigger,
  type TriggerRegistryBinding,
  WEBHOOK_BODY_LIMITS,
  type WebhookRefusalReason,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { UUID_RE } from './uuid-param.js';

export interface HooksRouterOptions {
  /** Needs `findWebhook`, `fireWebhook` and `recordWebhookRefusal`. */
  readonly triggers: TriggerRegistryBinding;
  /**
   * The tenant's own limit on deliveries a minute, across its triggers
   * (`limits.webhookReceivesPerMinute`), after each trigger's. Absent: none.
   */
  readonly tenantLimiter?: TenantLimiter;
  /** Where a trigger's signing secret is read: at the scope recorded for it (`secret-scope.ts`). */
  readonly secrets: SecretBinding;
  /** Where a read refused for its scope is recorded (`resolveAtScope`). */
  readonly auditEvents?: AuditEventBinding;
  /** The env this deployment serves: where the signing secret is read. */
  readonly envName: EnvName;
  /** A model provider's key is never a webhook trigger's secret. */
  readonly providerKeys?: ProviderKeys;
  /**
   * Who the client is: the key of the per-client refusal limit, and the
   * address in the audit record; `undefined` when there's no address at
   * all (then refusals aren't counted per client). Default: the nearest
   * `X-Forwarded-For` hop, else one shared bucket.
   */
  readonly clientAddress?: (request: Request) => string | undefined;
  /**
   * Writes to secrets through this app (`observeSecretWrites`): a write to
   * a trigger's secret drops the signing key this process keeps for it at
   * once. Without it, a change is seen within
   * {@link WEBHOOK_SIGNING_KEY_TTL_MS}, as one from another instance is.
   */
  readonly secretWrites?: SecretWrites;
  /**
   * Where the counts live: refusals per client, accepted deliveries per
   * trigger. Default: this process's memory, so each instance counts on
   * its own. If it fails, the request is let through (the limit is a
   * speed bump, not a lock) and the failure logged.
   */
  readonly rateLimitStore?: RateLimitStore;
  /**
   * Each tenant's state: a closing tenant takes no delivery, as it takes no
   * write (`tenantStateGate`), and a suspended one's deliveries are skipped.
   * Absent (a runtime serving one tenant): none is frozen.
   */
  readonly tenantStates?: TenantStateBinding;
  /**
   * Whether a project is suspended: its triggers' deliveries are skipped,
   * as nothing deploys or runs in it. Absent: no check.
   */
  readonly projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
  /** Clock in milliseconds, for signed timestamps; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Refusals a client may cause a minute; past them, its further refusals are
 * answered 429 and not recorded. A delivery that proves its sender is never
 * held back by them.
 */
export const WEBHOOK_REFUSALS_PER_CLIENT_PER_MINUTE = 60;

/**
 * How long this process keeps a trigger's signing key between reads of its
 * secret, so a flood of bad signatures costs one read a trigger in that
 * time. A write through this app drops it at once; another instance's
 * write (a rotation) is seen within it.
 */
export const WEBHOOK_SIGNING_KEY_TTL_MS = 10_000;

const MINUTE_MS = 60_000;
// While the store fails, one warning at most this often (not one a request).
const WARN_EVERY_MS = 60_000;
/** The most signing keys kept at once; past it, the expired go, else the oldest. */
const MAX_SIGNING_KEYS = 1_000;
const SCHEME_KINDS = ['hmac-sha256', 'standard-webhooks'] as const;
/**
 * A secret that won't verify anything until someone writes it: kept as
 * unavailable for the TTL too, so a flood at its trigger costs one read.
 * A store or provider failure isn't kept: it may pass in a second.
 */
const SECRET_UNAVAILABLE_UNTIL_WRITTEN = new Set([
  'secret-not-found',
  'secret-revoked',
  'provider-key-refused',
]);
/** WooCommerce's save-time ping: `webhook_id=<n>`, unsigned. */
const WOO_PING_RE = /^webhook_id=\d{1,20}$/;

/**
 * The inbound receiver: `POST /v1/hooks/{tenantId}/{webhookId}`, outside
 * the bearer chain. No caller is signed in: the request's signature, made
 * with the trigger's secret, is what lets it start the trigger's flow as
 * the trigger's owner, and nothing else.
 *
 * Every request that doesn't prove its sender (an unknown tenant or id, a
 * missing, wrong or stale signature, a secret that can't be read) gets the
 * same `401 webhook-refused`; the reason goes to the trigger's history and
 * the access audit, never into the answer. A client past its refusals is
 * answered `429` for the rest of them, unrecorded; a delivery that proves
 * its sender is never held back by anyone's refusals, its own address's
 * included. Then: a closing tenant takes no delivery (`409 tenant-closing`),
 * a suspended tenant or project takes it without keeping it (`202`,
 * `skipped`, and nothing recorded), an unregistered trigger is `410`, a
 * paused one takes the delivery without starting a run (`202`, a `skipped`
 * fire), and a delivery whose dedupe key a fire already holds is `200
 * duplicate`, with no second run.
 */
export function hooksRouter(options: HooksRouterOptions): Hono<AppEnv> {
  const { triggers } = options;
  const findWebhook = triggers.findWebhook?.bind(triggers);
  const fireWebhook = triggers.fireWebhook?.bind(triggers);
  const recordWebhookRefusal = triggers.recordWebhookRefusal?.bind(triggers);
  if (
    findWebhook === undefined ||
    fireWebhook === undefined ||
    recordWebhookRefusal === undefined
  ) {
    throw new Error(
      'hooksRouter: the trigger registry must implement findWebhook, fireWebhook and recordWebhookRefusal',
    );
  }
  const secrets =
    options.providerKeys === undefined
      ? options.secrets
      : guardProviderKeys(options.secrets, options.providerKeys, 'a webhook trigger');
  const clientAddress = options.clientAddress ?? nearestForwardedClient;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();
  const now = options.now ?? Date.now;
  /**
   * Signing keys by tenant, scope, secret name and scheme, each until its TTL: a
   * `KeyObject`, never the secret as a string, or `undefined` for a secret
   * that can't verify until it's written. `writes` counts the writes heard,
   * so a read that a write overtook isn't kept.
   */
  const signingKeys = new Map<
    string,
    { readonly key: KeyObject | undefined; readonly until: number }
  >();
  let writes = 0;
  options.secretWrites?.subscribe((written) => {
    writes += 1;
    if (written.envName !== options.envName) return;
    for (const kind of SCHEME_KINDS) {
      signingKeys.delete(
        signingKeyId(written.scope.tenantId, scopeKeyOf(written.scope), written.name, kind),
      );
    }
  });
  let lastWarnedAt: number | undefined;
  let lastUnknownWarnedAt: number | undefined;
  let unknownSinceWarning = 0;

  /** A take from the store; `allowed` when the store fails (logged, at most once a minute). */
  async function take(
    c: Context<AppEnv>,
    key: string,
    limit: number,
  ): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    try {
      return await store.take({ key, limit, windowMs: MINUTE_MS });
    } catch (cause) {
      const at = now();
      if (lastWarnedAt === undefined || at - lastWarnedAt >= WARN_EVERY_MS) {
        c.get('log').warn(
          `webhook receiver: the rate-limit store failed, so requests aren't counted: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        lastWarnedAt = at;
      }
      return { allowed: true };
    }
  }

  /**
   * The trigger's signing key: kept from an earlier read for up to the TTL,
   * else its secret read and the key derived. `undefined` when the secret
   * can't be read or used with the scheme: kept too when only a write can
   * change that (missing, revoked, a provider's key, a value the scheme
   * can't use), and a write through this app drops it at once; a store
   * failure isn't kept. `log` is where a failed audit append is logged.
   */
  async function signingKeyOf(
    found: FoundWebhookTrigger,
    log: Logger,
  ): Promise<KeyObject | undefined> {
    // Read where it was recorded when the trigger was registered, and only
    // there (`secret-scope.ts`); none usable, nothing verifies. A trigger
    // from before it was recorded reads the tenant's, as it did.
    if (found.hmacSecretScope === null) return undefined;
    const scope: Scope =
      found.hmacSecretScope === undefined
        ? { kind: 'tenant', tenantId: found.tenantId }
        : scopeOfRecorded(found.tenantId, found.hmacSecretScope);
    const id = signingKeyId(
      found.tenantId,
      scopeKeyOf(scope),
      found.hmacSecretName,
      found.signature.kind,
    );
    const kept = signingKeys.get(id);
    if (kept !== undefined && kept.until > now()) return kept.key;
    const writesBefore = writes;
    const read = {
      scope,
      envName: options.envName,
      name: found.hmacSecretName,
      resolveContext: { caller: 'webhook-receiver' as const },
    };
    const secret =
      found.hmacSecretScope === undefined
        ? await secrets.resolve(read)
        : await resolveAtScope(secrets, read, options.auditEvents, log);
    const derived =
      secret.kind === 'err' ? undefined : inboundSigningKey(found.signature, secret.value.value);
    const key = derived?.kind === 'ok' ? derived.key : undefined;
    const lasting =
      key !== undefined ||
      derived?.kind === 'err' ||
      (secret.kind === 'err' && SECRET_UNAVAILABLE_UNTIL_WRITTEN.has(secret.error.code));
    if (lasting && writes === writesBefore) keep(id, key);
    return key;
  }

  function keep(id: string, key: KeyObject | undefined): void {
    signingKeys.delete(id);
    if (signingKeys.size >= MAX_SIGNING_KEYS) {
      const at = now();
      for (const [k, kept] of signingKeys) if (kept.until <= at) signingKeys.delete(k);
      if (signingKeys.size >= MAX_SIGNING_KEYS) {
        signingKeys.delete(signingKeys.keys().next().value as string);
      }
    }
    signingKeys.set(id, { key, until: now() + WEBHOOK_SIGNING_KEY_TTL_MS });
  }

  function answer(c: Context<AppEnv>, code: string, message: string): Response {
    c.status(statusFor(code) as never);
    return c.json(toWireError({ code, message }, c.get('requestId')));
  }

  /**
   * The one answer for a request that doesn't prove its sender: `401`,
   * recorded; or, for a client past its refusals this minute, `429`,
   * unrecorded (its refusals are on record already).
   */
  async function refusedUnproven(
    c: Context<AppEnv>,
    client: string | undefined,
    trigger: FoundWebhookTrigger | undefined,
    reason: WebhookRefusalReason,
  ): Promise<Response> {
    // A failed proof is the sender's refusal; a secret the deployment can't
    // read is the trigger's configuration, so it neither counts against the
    // sender's address nor goes in the access audit.
    const senders = reason !== 'secret-unavailable';
    if (senders && client !== undefined) {
      const taken = await take(
        c,
        `hooks-refused:${client}`,
        WEBHOOK_REFUSALS_PER_CLIENT_PER_MINUTE,
      );
      if (!taken.allowed) {
        c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
        return answer(c, 'rate-limit-exceeded', 'Too many refused requests: try again shortly');
      }
    }
    if (trigger !== undefined) {
      await recordWebhookRefusal?.({
        tenantId: trigger.tenantId,
        triggerId: trigger.triggerId,
        outcome: 'refused',
        reason,
        audit: senders,
        ...(client !== undefined && { clientAddress: client }),
      });
    }
    return answer(c, 'webhook-refused', "This request doesn't prove its sender");
  }

  const tenantStateOf =
    options.tenantStates === undefined ? undefined : tenantStateReader(options.tenantStates);

  const r = new Hono<AppEnv>();
  r.post('/:tenantId/:webhookId', async (c) => {
    const request = c.req.raw;
    const client = clientAddress(request);

    // 1. The body, read to at most the receiver's cap, as raw bytes: the
    //    signature covers them exactly, so no parser runs first.
    const body = await readCapped(request, WEBHOOK_BODY_LIMITS.maxBytes);
    if (body === 'too-large') {
      return answer(
        c,
        'webhook-body-too-large',
        `The body is larger than ${WEBHOOK_BODY_LIMITS.maxBytes} bytes`,
      );
    }

    // 2. WooCommerce's save-time ping: unsigned, and it needs exactly 200.
    //    Answered before any lookup, so it says nothing about which ids
    //    exist, and it starts nothing.
    if (isWooPing(request, body)) return c.json({ received: 'ping' }, 200);

    // 3. The trigger, by its tenant and routable id: paused and unregistered
    //    ones too, so a request is verified with the trigger's own secret
    //    before anyone learns it's gone.
    const tenantId = c.req.param('tenantId');
    const webhookId = c.req.param('webhookId');
    const found =
      UUID_RE.test(tenantId) && UUID_RE.test(webhookId)
        ? await findWebhook({ tenantId: tenantId as TenantId, webhookId })
        : null;
    if (found === null) {
      unknownSinceWarning += 1;
      const at = now();
      if (lastUnknownWarnedAt === undefined || at - lastUnknownWarnedAt >= WARN_EVERY_MS) {
        c.get('log').warn(
          `webhook receiver: ${unknownSinceWarning} request(s) to an unknown trigger since the last warning (the latest from ${client ?? 'an unknown address'})`,
        );
        lastUnknownWarnedAt = at;
        unknownSinceWarning = 0;
      }
      return refusedUnproven(c, client, undefined, 'signature-invalid');
    }

    // 4. The signature, with the trigger's scheme and its signing key. Only
    //    a request that fails it counts against its client: one that
    //    proves its sender goes on, whatever its address's refusals.
    const key = await signingKeyOf(found, c.get('log').child({ subsystem: 'audit' }));
    if (key === undefined) {
      return refusedUnproven(c, client, found, 'secret-unavailable');
    }
    const verified = verifyInboundSignature({
      scheme: found.signature,
      secret: key,
      headers: request.headers,
      body,
      now,
    });
    if (verified.kind === 'err') {
      return refusedUnproven(c, client, found, refusalReasonOf(verified.reason));
    }

    // 5. Frozen, gone, or paused: known only to a sender that proved itself.
    //    A closing tenant takes no delivery, as it takes no write. A
    //    suspended tenant or project is answered as a paused trigger is (see
    //    below), but nothing is recorded: a suspended tenant takes no write,
    //    and a fire would hold the delivery's dedupe key, so a redelivery
    //    after the restore would be a duplicate.
    const state = (await tenantStateOf?.(c, found.tenantId)) ?? 'active';
    if (state === 'suspended') return c.json({ skipped: 'tenant-suspended' }, 202);
    if (state !== 'active') return frozenTenantRefusal(c, state);
    if (
      options.projectSuspended !== undefined &&
      (await options.projectSuspended(found.tenantId, found.projectId))
    ) {
      return c.json({ skipped: 'project-suspended' }, 202);
    }
    if (found.unregistered) {
      await record(found, 'refused', 'unregistered', client);
      return answer(c, 'webhook-gone', 'This trigger was unregistered');
    }
    if (found.status === 'paused') {
      // Taken without starting a run: senders such as WooCommerce never
      // resend, and a 4xx would count toward switching their webhook off.
      await record(found, 'skipped', 'paused', client);
      return c.json({ skipped: 'paused' }, 202);
    }

    // 6. The trigger's own limits: its body cap, its accepted rate.
    if (body.byteLength > found.bodyLimitBytes) {
      await record(found, 'refused', 'body-too-large', client);
      return answer(
        c,
        'webhook-body-too-large',
        `The body is larger than this trigger takes (${found.bodyLimitBytes} bytes)`,
      );
    }
    const taken = await take(
      c,
      `hooks-trigger:${found.triggerId as unknown as string}`,
      found.rateLimitPerMinute,
    );
    if (!taken.allowed) {
      await record(found, 'refused', 'rate-limited', client);
      c.header('Retry-After', String(Math.max(Math.ceil(taken.retryAfterMs / 1000), 1)));
      return answer(
        c,
        'rate-limit-exceeded',
        'Too many deliveries to this trigger: try again shortly',
      );
    }
    // The tenant's limit across its triggers, once the trigger's own let it through.
    if (options.tenantLimiter !== undefined) {
      const limits = await options.tenantLimiter.limitsOf(c, found.tenantId);
      const tenantTaken = await options.tenantLimiter.take(
        c,
        found.tenantId,
        'webhook-receives',
        limits?.webhookReceivesPerMinute,
      );
      if (!tenantTaken.allowed) {
        await record(found, 'refused', 'rate-limited', client);
        return tenantLimitReached(c, 'webhook-receives', tenantTaken.retryAfterMs);
      }
    }

    // 7. The event: JSON for a JSON content type, else the text.
    const event = parseEvent(request.headers.get('content-type'), body);
    if (event.kind === 'err') {
      await record(found, 'refused', 'body-not-json', client);
      return answer(c, 'webhook-body-not-json', 'The body says it is JSON, but it is not');
    }
    // A JSON event nested past the bounds is refused before anything walks it.
    const maxDepth = tenantInputBounds().requestJsonMaxDepth;
    if (nestsDeeperThan(event.value, maxDepth)) {
      await record(found, 'refused', 'body-too-deep', client);
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError(deepJsonRefusal(maxDepth), c.get('requestId')));
    }

    // 8. The fire, deduped on the delivery id and the body; its run starts
    //    as the trigger's owner once the fire is recorded.
    const fired = await fireWebhook({
      tenantId: found.tenantId,
      triggerId: found.triggerId,
      dedupeKey: dedupeKeyOf(found, request.headers, verified.signedId, body),
      event: event.value,
    });
    if (fired.kind === 'err') {
      if (fired.error.code === 'trigger-not-found') {
        return answer(c, 'webhook-gone', 'This trigger was unregistered');
      }
      return answer(c, fired.error.code, fired.error.message);
    }
    if (fired.value.duplicate) {
      return c.json({ fireId: fired.value.fireId, duplicate: true }, 200);
    }
    return c.json({ fireId: fired.value.fireId }, 202);
  });
  return r;

  async function record(
    trigger: FoundWebhookTrigger,
    outcome: 'refused' | 'skipped',
    reason: WebhookRefusalReason,
    client: string | undefined,
  ): Promise<void> {
    await recordWebhookRefusal?.({
      tenantId: trigger.tenantId,
      triggerId: trigger.triggerId as TriggerId,
      outcome,
      reason,
      audit: false,
      ...(client !== undefined && { clientAddress: client }),
    });
  }
}

function signingKeyId(
  tenantId: string,
  scopeKey: string,
  secretName: string,
  scheme: string,
): string {
  return `${tenantId}\n${scopeKey}\n${secretName}\n${scheme}`;
}

/** A scope, as a cache key: its kind and id. */
function scopeKeyOf(scope: Scope): string {
  if (scope.kind === 'org') return `org:${scope.orgId as unknown as string}`;
  if (scope.kind === 'project') return `project:${scope.projectId as unknown as string}`;
  return 'tenant';
}

function refusalReasonOf(reason: VerifyInboundSignatureFailure): WebhookRefusalReason {
  switch (reason) {
    case 'signature-missing':
      return 'signature-missing';
    case 'stale':
      return 'stale';
    case 'secret-invalid':
      return 'secret-unavailable';
    default:
      return 'signature-invalid';
  }
}

/**
 * The delivery's dedupe key. A scheme that signs an id (Standard Webhooks'
 * `webhook-id`) uses it; else the trigger's `deliveryIdHeader`, its value
 * empty when the request lacks it. With either, the body is in the key:
 * WooCommerce's delivery id is per second, not per event, so two orders in
 * one second share it. A trigger with neither dedupes nothing.
 */
function dedupeKeyOf(
  trigger: FoundWebhookTrigger,
  headers: Headers,
  signedId: string | undefined,
  body: Uint8Array,
): string {
  const id =
    signedId ??
    (trigger.deliveryIdHeader === undefined
      ? undefined
      : (headers.get(trigger.deliveryIdHeader) ?? ''));
  if (id === undefined) return `delivery:${randomUUID()}`;
  const digest = createHash('sha256').update(id).update('\n').update(body).digest('hex');
  return `delivery:${digest}`;
}

function parseEvent(
  contentType: string | null,
  body: Uint8Array,
): { kind: 'ok'; value: unknown } | { kind: 'err' } {
  const text = new TextDecoder().decode(body);
  const mediaType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
    return { kind: 'ok', value: text };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'err' };
  }
}

/** WooCommerce's ping when a webhook is saved: no signature or topic, a `webhook_id=<n>` body. */
function isWooPing(request: Request, body: Uint8Array): boolean {
  if (body.byteLength > 32) return false;
  const headers = request.headers;
  if (headers.has('x-wc-webhook-signature') || headers.has('x-wc-webhook-topic')) return false;
  return WOO_PING_RE.test(new TextDecoder().decode(body));
}

/** The request's body, at most `max` bytes; `too-large` past it (read no further). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return 'too-large';
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return 'too-large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
