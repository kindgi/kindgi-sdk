// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { SessionId, TenantId, UserId } from '@kindgi/types';

import { callerIdentity, isTenantAdmin } from '../caller.js';
import { retryAfterSeconds, statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type {
  SecondFactorBinding,
  SecondFactorProof,
  SecondFactorRef,
  SecondFactorRefusal,
  SecondFactorSettings,
  SecondFactorStatus,
} from '../second-factor-binding.js';
import type { SessionStoreBinding } from '../session-store-binding.js';
import type { AppEnv } from '../types.js';

/**
 * A second factor: the person's own, an admin's view and removal, and the
 * tenant's setting that requires one (see `SecondFactorBinding`).
 *
 * Under `/v1/identity` (`secondFactorIdentityRouter`):
 *   - `GET  /me/second-factor`                     (yours: set up, since, codes left)
 *   - `POST /me/second-factor`                     (start setting one up: the key, shown once)
 *   - `POST /me/second-factor/confirm`             (a code from it: set up, and 10 recovery codes)
 *   - `POST /me/second-factor/recovery-codes`      (10 new ones; the old ones stop working)
 *   - `POST /me/second-factor/remove`              (off; refused while the tenant requires one)
 *   - `GET  /users/:userId/second-factor`          (a person's; tenant admins)
 *   - `POST /users/:userId/second-factor/remove`   (a lost phone; tenant admins, for anyone but themselves)
 *
 * Under `/v1/auth/settings` (`authSettingsRouter`): `GET`, and `PATCH
 * {secondFactor: {required}}` (tenant admins).
 *
 * The `/me` routes take a session: an API key can't set up or take off a
 * person's second factor (`400 auth-not-session-token`). Answers that
 * carry a key or codes are never replayed for an `Idempotency-Key`.
 */

/** Longer than any code or recovery code, typed with spaces or dashes. */
const PROOF_MAX_CHARS = 64;

export interface SecondFactorRouterOptions {
  readonly binding: SecondFactorBinding;
  readonly authorizer?: Authorizer;
  /** When given, an admin's routes answer 404 for someone the tenant doesn't have. */
  readonly directory?: IdentityDirectoryBinding;
  /** To read whether a session gave a second factor (turning the setting on). */
  readonly sessionStore?: SessionStoreBinding;
}

const fail = (c: Context<AppEnv>, code: string, message: string) => {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
};

const refusal = (c: Context<AppEnv>, r: SecondFactorRefusal) => {
  switch (r.kind) {
    case 'wrong':
      return fail(
        c,
        'second-factor-invalid',
        "That code isn't right. Try the one your app shows now.",
      );
    case 'locked':
      c.header('Retry-After', String(retryAfterSeconds(r.retryAfterMs)));
      return fail(c, 'second-factor-locked', 'Too many wrong codes. Wait, then try again.');
    case 'unusable':
      return fail(
        c,
        'second-factor-unusable',
        "Your app's key can't be read here any more. Use a recovery code, or ask an admin to remove your second factor.",
      );
  }
};

const notSetUp = (c: Context<AppEnv>) =>
  fail(c, 'second-factor-not-set-up', "You don't have a second factor set up.");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{code}` or `{recoveryCode}`, one of them; a message when it's neither. */
function parseProof(raw: unknown): SecondFactorProof | string {
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= PROOF_MAX_CHARS;
  if (isRecord(raw) && Object.keys(raw).length === 1) {
    if (text(raw.code)) return { code: raw.code };
    if (text(raw.recoveryCode)) return { recoveryCode: raw.recoveryCode };
  }
  return `The body must be { code } (from your authenticator app) or { recoveryCode }, of at most ${PROOF_MAX_CHARS} characters`;
}

/** The body as JSON, or `undefined` when there's none (an empty `POST`). */
async function bodyOf(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `{secondFactor: {required}}`, and nothing else: `required`, or `undefined`. */
function parseSettingsPatch(raw: unknown): boolean | undefined {
  const sf = isRecord(raw) && Object.keys(raw).length === 1 ? raw.secondFactor : undefined;
  const required = isRecord(sf) && Object.keys(sf).length === 1 ? sf.required : undefined;
  return typeof required === 'boolean' ? required : undefined;
}

function serializeStatus(s: SecondFactorStatus, required: boolean): Record<string, unknown> {
  return s.setUp
    ? {
        setUp: true,
        since: s.since,
        recoveryCodesLeft: s.recoveryCodesLeft,
        usable: s.usable,
        required,
      }
    : { setUp: false, started: s.started, required };
}

function serializeSettings(s: SecondFactorSettings): Record<string, unknown> {
  return {
    secondFactor: {
      required: s.required,
      onPreviousSecret: s.onPreviousSecret,
      unusable: s.unusable,
    },
  };
}

export function secondFactorIdentityRouter(options: SecondFactorRouterOptions): Hono<AppEnv> {
  const { binding, authorizer, directory } = options;
  const r = new Hono<AppEnv>();

  /** The caller as a person on a session: the `/me` routes' only caller. */
  const me = (c: Context<AppEnv>): SecondFactorRef | Response => {
    const userId = c.get('userId');
    if (c.get('sessionId') === undefined || userId === undefined) {
      return fail(
        c,
        'auth-not-session-token',
        'Your own second factor is set up and taken off when signed in (a session), not with an API key.',
      );
    }
    return { tenantId: c.get('tenantId') as TenantId, userId: userId as unknown as string };
  };

  r.get('/me/second-factor', async (c) => {
    const ref = me(c);
    if (ref instanceof Response) return ref;
    const [status, required] = await Promise.all([
      binding.status(ref),
      binding.required(ref.tenantId),
    ]);
    return c.json(serializeStatus(status, required));
  });

  r.post('/me/second-factor', async (c) => {
    const ref = me(c);
    if (ref instanceof Response) return ref;
    // No body, or `{}`: nothing set up yet, so nothing to prove.
    const raw = await bodyOf(c);
    const empty = raw === undefined || (isRecord(raw) && Object.keys(raw).length === 0);
    const proof = empty ? undefined : parseProof(raw);
    if (typeof proof === 'string') return fail(c, 'bad-input', proof);
    const outcome = await binding.start(ref, proof);
    if (outcome.kind === 'proof-needed') {
      return fail(
        c,
        'second-factor-invalid',
        'You have a second factor set up: give a code from your app, or a recovery code, to replace it.',
      );
    }
    if (outcome.kind !== 'started') return refusal(c, outcome);
    withholdFromReplay(c);
    return c.json({ key: outcome.key, uri: outcome.uri });
  });

  r.post('/me/second-factor/confirm', async (c) => {
    const ref = me(c);
    if (ref instanceof Response) return ref;
    const parsed = parseProof(await bodyOf(c));
    if (typeof parsed === 'string' || !('code' in parsed)) {
      return fail(
        c,
        'bad-input',
        'The body must be { code }: the one your app shows for the new key',
      );
    }
    const outcome = await binding.confirm(ref, parsed.code);
    if (outcome.kind === 'not-started') {
      return fail(
        c,
        'second-factor-not-started',
        'Start setting it up again (POST /v1/identity/me/second-factor): there is no new key to confirm, or it is over an hour old.',
      );
    }
    if (outcome.kind !== 'confirmed') return refusal(c, outcome);
    withholdFromReplay(c);
    return c.json({ recoveryCodes: [...outcome.recoveryCodes] });
  });

  r.post('/me/second-factor/recovery-codes', async (c) => {
    const ref = me(c);
    if (ref instanceof Response) return ref;
    const proof = parseProof(await bodyOf(c));
    if (typeof proof === 'string') return fail(c, 'bad-input', proof);
    const outcome = await binding.newRecoveryCodes(ref, proof);
    if (outcome.kind === 'not-set-up') return notSetUp(c);
    if (outcome.kind !== 'replaced') return refusal(c, outcome);
    withholdFromReplay(c);
    return c.json({ recoveryCodes: [...outcome.recoveryCodes] });
  });

  r.post('/me/second-factor/remove', async (c) => {
    const ref = me(c);
    if (ref instanceof Response) return ref;
    const proof = parseProof(await bodyOf(c));
    if (typeof proof === 'string') return fail(c, 'bad-input', proof);
    const outcome = await binding.remove(ref, proof);
    if (outcome.kind === 'not-set-up') return notSetUp(c);
    if (outcome.kind === 'required') {
      return fail(
        c,
        'second-factor-required',
        'This workspace requires a second factor: you can replace yours, and an admin can remove it.',
      );
    }
    if (outcome.kind !== 'removed') return refusal(c, outcome);
    return c.json({ removed: true });
  });

  /** A tenant admin's: the person, or a 404 when the tenant doesn't have them. */
  const person = async (c: Context<AppEnv>): Promise<SecondFactorRef | Response> => {
    if (!(await isTenantAdmin(c, authorizer))) {
      return fail(
        c,
        'permission-denied',
        "Only a tenant admin reads or removes a person's second factor",
      );
    }
    const tenantId = c.get('tenantId') as TenantId;
    const userId = c.req.param('userId') as string;
    if (directory !== undefined) {
      const user = await directory.getUser({ tenantId, userId: userId as UserId });
      if (user === null) {
        c.status(statusFor('identity-user-not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'identity-user-not-found',
              message: `No user with id "${userId}" under this tenant`,
              userId,
            },
            c.get('requestId'),
          ),
        );
      }
    }
    return { tenantId, userId };
  };

  r.get('/users/:userId/second-factor', async (c) => {
    const ref = await person(c);
    if (ref instanceof Response) return ref;
    const [status, required] = await Promise.all([
      binding.status(ref),
      binding.required(ref.tenantId),
    ]);
    return c.json(serializeStatus(status, required));
  });

  r.post('/users/:userId/second-factor/remove', async (c) => {
    const ref = await person(c);
    if (ref instanceof Response) return ref;
    // An admin's own takes a code from it, and stays where it's required.
    if ((c.get('userId') as unknown as string | undefined) === ref.userId) {
      return fail(
        c,
        'permission-denied',
        'Your own second factor is taken off at POST /v1/identity/me/second-factor/remove, with a code from it.',
      );
    }
    const removed = await binding.removeFor(ref, callerIdentity(c));
    return c.json({ removed });
  });

  return r;
}

export function authSettingsRouter(options: SecondFactorRouterOptions): Hono<AppEnv> {
  const { binding, authorizer, sessionStore } = options;
  const r = new Hono<AppEnv>();

  const admin = async (c: Context<AppEnv>) =>
    (await isTenantAdmin(c, authorizer))
      ? undefined
      : fail(
          c,
          'permission-denied',
          "Only a tenant admin reads or changes the workspace's sign-in settings",
        );

  r.get('/', async (c) => {
    const refusedAs = await admin(c);
    if (refusedAs !== undefined) return refusedAs;
    return c.json(serializeSettings(await binding.settings(c.get('tenantId') as TenantId)));
  });

  /**
   * Turned on from a session made without one, it would end that session
   * at its next request: set yours up first. An API key isn't a session.
   */
  const madeWithout = async (c: Context<AppEnv>, tenantId: TenantId): Promise<boolean> => {
    const sessionId = c.get('sessionId') as SessionId | undefined;
    if (sessionId === undefined) return false;
    const session =
      sessionStore === undefined ? null : await sessionStore.get({ tenantId, sessionId });
    return session?.secondFactor === undefined;
  };

  r.patch('/', async (c) => {
    const refusedAs = await admin(c);
    if (refusedAs !== undefined) return refusedAs;
    const required = parseSettingsPatch(await bodyOf(c));
    if (required === undefined) {
      return fail(c, 'bad-input', 'The body must be { secondFactor: { required: true | false } }');
    }
    const tenantId = c.get('tenantId') as TenantId;
    if (required && (await madeWithout(c, tenantId))) {
      return fail(
        c,
        'second-factor-enroll-first',
        'Set up your own second factor, then sign in again with it, before requiring one: this session would end at its next request.',
      );
    }
    const settings = await binding.setRequired({ tenantId, required, by: callerIdentity(c) });
    return c.json(serializeSettings(settings));
  });

  return r;
}
