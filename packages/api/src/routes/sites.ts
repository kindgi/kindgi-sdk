// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId, UserId } from '@kindgi/types';
import { type Context, Hono } from 'hono';

import { callerIdentity, isTenantAdmin } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import type {
  Site,
  SiteBinding,
  SiteChangeOutcome,
  SitePersonRestoreRefusal,
  SiteRegisterInput,
  SiteRole,
  SiteRoleGrant,
} from '../site-binding.js';
import type { AppEnv } from '../types.js';
import { serializeUser } from './identity.js';
import { clampLimit } from './pagination.js';
import { UUID_RE } from './uuid-param.js';

/**
 * `/v1/projects/:projectId/sites`: the sites that sign their own people in
 * to this project (`SiteBinding`). Every call is a tenant admin's: a site
 * creates people in the tenant and gives them reviewer roles.
 */
export function sitesRouter(
  binding: SiteBinding,
  authorizer: Authorizer | undefined,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.use('/:projectId/sites', projectIdChecked, adminOnly(authorizer));
  r.use('/:projectId/sites/*', projectIdChecked, adminOnly(authorizer));

  r.get('/:projectId/sites', async (c) => {
    const page = await binding.list({
      ...where(c),
      limit: clampLimit(c.req.query('limit')),
      ...(c.req.query('cursor') !== undefined && { cursor: c.req.query('cursor') as string }),
      ...(c.req.query('includeUnregistered') === 'true' && { includeUnregistered: true }),
    });
    return c.json({
      data: page.data.map(siteToWire),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    });
  });

  r.post('/:projectId/sites', async (c) => {
    const body = await jsonBody(c);
    if (body === undefined) return badInput(c, 'The body must be a JSON object');
    const settings = checkSiteSettings(body, { partial: false });
    if (settings.kind === 'invalid') return invalid(c, settings.field, settings.message);
    const outcome = await binding.register({
      ...where(c),
      ...(settings.value as Omit<SiteRegisterInput, 'tenantId' | 'projectId' | 'by'>),
      by: callerIdentity(c),
    });
    if (outcome.kind === 'invalid') return invalid(c, outcome.field, outcome.message);
    if (outcome.kind === 'project-not-found') {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          { code: 'project-not-found', message: 'No project with that id in this tenant' },
          c.get('requestId'),
        ),
      );
    }
    // The enrollment code is a credential: an Idempotency-Key repeat doesn't get it.
    withholdFromReplay(c);
    return c.json({ site: siteToWire(outcome.site), enrollment: outcome.enrollment }, 201);
  });

  r.get('/:projectId/sites/:siteId', async (c) => {
    const site = await binding.get({ ...where(c), siteId: c.req.param('siteId') });
    return site === null ? notFound(c) : c.json(siteToWire(site));
  });

  r.patch('/:projectId/sites/:siteId', async (c) => {
    const body = await jsonBody(c);
    if (body === undefined) return badInput(c, 'The body must be a JSON object');
    const settings = checkSiteSettings(body, { partial: true });
    if (settings.kind === 'invalid') return invalid(c, settings.field, settings.message);
    // A change is checked as the site it makes: an approvals URL alone is
    // checked against the site's origin, a ceiling alone against its role
    // map, and allowed roles alone keep the map of the roles still allowed
    // (`applySiteChange`). The binding applies and checks the change again
    // as it stores it.
    const current = await binding.get({ ...where(c), siteId: c.req.param('siteId') });
    if (current === null) return notFound(c);
    const merged = checkSiteSettings(
      applySiteChange(siteSettingsOf(current), settings.value as Record<string, unknown>),
      { partial: false },
    );
    if (merged.kind === 'invalid') return invalid(c, merged.field, merged.message);
    return answer(
      c,
      await binding.update({
        ...where(c),
        siteId: c.req.param('siteId'),
        patch: settings.value,
        by: callerIdentity(c),
      }),
    );
  });

  for (const [path, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    r.post(`/:projectId/sites/:siteId/${path}`, async (c) =>
      answer(
        c,
        await binding.setPaused({
          ...where(c),
          siteId: c.req.param('siteId'),
          paused,
          by: callerIdentity(c),
        }),
      ),
    );
  }

  r.post('/:projectId/sites/:siteId/unregister', async (c) =>
    answer(
      c,
      await binding.unregister({
        ...where(c),
        siteId: c.req.param('siteId'),
        by: callerIdentity(c),
      }),
    ),
  );

  r.post('/:projectId/sites/:siteId/enrollment-codes', async (c) => {
    const outcome = await binding.newEnrollmentCode({
      ...where(c),
      siteId: c.req.param('siteId'),
      by: callerIdentity(c),
    });
    if (outcome.kind === 'not-found') return notFound(c);
    withholdFromReplay(c);
    return c.json(outcome.enrollment, 201);
  });

  r.post('/:projectId/sites/:siteId/keys/:kid/revoke', async (c) => {
    const outcome = await binding.revokeKey({
      ...where(c),
      siteId: c.req.param('siteId'),
      kid: c.req.param('kid'),
      by: callerIdentity(c),
    });
    // The binding's `not-found` is either one: no such site, or no such key on it.
    if (outcome.kind === 'not-found') {
      return notFound(
        c,
        'No site with that id in this project, or no key with that id on the site',
      );
    }
    return answer(c, outcome);
  });

  const restorePerson = binding.restorePerson?.bind(binding);
  if (restorePerson !== undefined) {
    r.post('/:projectId/sites/:siteId/people/:userId/restore', async (c) => {
      const userId = c.req.param('userId');
      const outcome = await restorePerson({
        ...where(c),
        siteId: c.req.param('siteId'),
        userId: userId as UserId,
        by: callerIdentity(c),
      });
      if (outcome.kind === 'not-found') return notFound(c);
      if (outcome.kind === 'person-not-found') {
        c.status(statusFor('site-person-not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'site-person-not-found',
              message: 'No person of this site with that id',
              userId,
            },
            c.get('requestId'),
          ),
        );
      }
      if (outcome.kind === 'refused') {
        c.status(statusFor('site-person-restore-refused') as never);
        return c.json(
          toWireError(
            {
              code: 'site-person-restore-refused',
              message: restoreRefusedText(outcome.reason),
              reason: outcome.reason,
              userId,
            },
            c.get('requestId'),
          ),
        );
      }
      return c.json({ user: serializeUser(outcome.user) });
    });
  }

  return r;
}

/** Why a restore was refused, as the person asking reads it: nothing changed. */
function restoreRefusedText(reason: SitePersonRestoreRefusal): string {
  switch (reason) {
    case 'not-removed':
      return "This person isn't removed: there's nothing to undo";
    case 'left':
      return 'Their site said they left it, and forgot them: if they come back, it signs them in as a new person';
    case 'linked-elsewhere':
      return "This person also signs in another way (through another site, or the tenant's own sign-in), and letting them back in would let them in there too. Add them again instead, as a new person: with an email, they're invited";
  }
}

/** A site's settings, as a body would give them (for checking a change against the whole site). */
function siteSettingsOf(site: Site): Record<string, unknown> {
  return {
    displayName: site.displayName,
    origin: site.origin,
    approvalsUrl: site.approvalsUrl,
    allowedRoles: site.allowedRoles,
    roleMap: site.roleMap,
    reviewerCeiling: site.reviewerCeiling,
    vouching: site.vouching,
    peopleCap: site.peopleCap,
    newPeoplePerDay: site.newPeoplePerDay,
  };
}

/** A site as the API answers it. */
export function siteToWire(site: Site): Record<string, unknown> {
  return {
    siteId: site.siteId,
    projectId: site.projectId,
    displayName: site.displayName,
    origin: site.origin,
    approvalsUrl: site.approvalsUrl,
    allowedRoles: site.allowedRoles,
    roleMap: site.roleMap,
    reviewerCeiling: site.reviewerCeiling,
    vouching: site.vouching,
    peopleCap: site.peopleCap,
    newPeoplePerDay: site.newPeoplePerDay,
    keys: site.keys,
    ...(site.audience !== undefined && { audience: site.audience }),
    createdAt: site.createdAt,
    ...(site.createdBy !== undefined && { createdBy: site.createdBy }),
    ...(site.pausedAt !== undefined && { pausedAt: site.pausedAt }),
    ...(site.unregisteredAt !== undefined && { unregisteredAt: site.unregisteredAt }),
  };
}

export const SITE_DEFAULTS = {
  allowedRoles: ['administrator', 'shop_manager'],
  roleMap: {
    administrator: { ask: true, reviewer: 'standard' },
    shop_manager: { ask: true, reviewer: 'standard' },
  },
  reviewerCeiling: 'standard',
  vouching: true,
  peopleCap: 50,
  newPeoplePerDay: 20,
} as const satisfies Partial<SiteRegisterInput>;

const ROLE_RE = /^[a-z0-9_-]{1,64}$/;
const REVIEWER_RANK = { standard: 1, senior: 2 } as const;

type Checked<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'invalid'; readonly field: string; readonly message: string };

type SiteSettings = Partial<Omit<SiteRegisterInput, 'tenantId' | 'projectId' | 'by'>>;

/**
 * A site's settings with a change over them, as one body to check: a new
 * site's over the defaults (`SITE_DEFAULTS`), or an update over the site's
 * current settings. A change with no `roleMap` keeps the entries of the
 * map under it whose role is still allowed, so narrowing `allowedRoles`
 * needs no map of its own, and only takes away. A `roleMap` the change
 * gives stays as given: the check still refuses one that names a role
 * that isn't allowed.
 */
export function applySiteChange(
  base: Readonly<Record<string, unknown>>,
  change: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...change };
  const allowed = merged.allowedRoles;
  const map = base.roleMap;
  if (
    change.roleMap === undefined &&
    Array.isArray(allowed) &&
    typeof map === 'object' &&
    map !== null
  ) {
    merged.roleMap = Object.fromEntries(
      Object.entries(map).filter(([role]) => allowed.includes(role)),
    );
  }
  return merged;
}

/**
 * A site's settings, checked: the shape of each field, an approvals URL
 * on the site's own origin, a role map over allowed roles only, and no
 * reviewer role above the ceiling. A new site gets the defaults for what
 * it leaves out (`applySiteChange` over `SITE_DEFAULTS`). The deployment's
 * binding checks what it stores too: for a change, applied to the site's
 * current settings.
 */
export function checkSiteSettings(
  body: Record<string, unknown>,
  options: { readonly partial: boolean },
): Checked<SiteSettings> {
  const known = new Set([
    'displayName',
    'origin',
    'approvalsUrl',
    'allowedRoles',
    'roleMap',
    'reviewerCeiling',
    'vouching',
    'peopleCap',
    'newPeoplePerDay',
  ]);
  const unknown = Object.keys(body).find((k) => !known.has(k));
  if (unknown !== undefined) return no(unknown, `\`${unknown}\` isn't a site setting`);

  const out: Record<string, unknown> = {};
  const required = (field: string): Checked<never> | undefined =>
    !options.partial && body[field] === undefined
      ? no(field, `\`${field}\` is required`)
      : undefined;

  const missing = required('displayName') ?? required('origin') ?? required('approvalsUrl');
  if (missing !== undefined) return missing;

  if (body.displayName !== undefined) {
    const name = body.displayName;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
      return no('displayName', '`displayName` must be 1 to 100 characters');
    }
    if (hasHiddenCharacters(name)) {
      return no(
        'displayName',
        '`displayName` must not contain control, format or invisible characters',
      );
    }
    out.displayName = name.trim();
  }
  if (body.origin !== undefined) {
    const origin = siteOrigin(body.origin);
    if (origin === undefined) {
      return no(
        'origin',
        '`origin` must be an https:// origin with no path (http:// only for localhost, 127.0.0.1 or [::1])',
      );
    }
    out.origin = origin;
  }
  if (body.approvalsUrl !== undefined) {
    const url = body.approvalsUrl;
    if (typeof url !== 'string' || !url.includes('{approvalId}')) {
      return no('approvalsUrl', '`approvalsUrl` must be a URL with `{approvalId}` in it');
    }
    let parsed: URL;
    try {
      parsed = new URL(url.replaceAll('{approvalId}', 'x'));
    } catch {
      return no('approvalsUrl', '`approvalsUrl` must be a URL with `{approvalId}` in it');
    }
    const origin = (out.origin as string | undefined) ?? undefined;
    // Compared as origins, never as a string prefix: `https://acme.example`
    // is a prefix of `https://acme.example.attacker.test`.
    if (origin !== undefined && parsed.origin !== origin) {
      return no('approvalsUrl', `\`approvalsUrl\` must be on the site's origin, ${origin}`);
    }
    out.approvalsUrl = url;
  }
  if (body.allowedRoles !== undefined) {
    const roles = body.allowedRoles;
    if (
      !Array.isArray(roles) ||
      roles.length === 0 ||
      roles.length > 20 ||
      !roles.every((x) => typeof x === 'string' && ROLE_RE.test(x))
    ) {
      return no('allowedRoles', '`allowedRoles` must be 1 to 20 role names (a-z, 0-9, _ and -)');
    }
    out.allowedRoles = [...new Set(roles as string[])];
  }
  if (body.reviewerCeiling !== undefined) {
    if (body.reviewerCeiling !== 'standard' && body.reviewerCeiling !== 'senior') {
      return no('reviewerCeiling', '`reviewerCeiling` must be `standard` or `senior`');
    }
    out.reviewerCeiling = body.reviewerCeiling;
  }
  if (body.roleMap !== undefined) {
    const map = checkRoleMap(body.roleMap);
    if (map.kind === 'invalid') return map;
    out.roleMap = map.value;
  }
  if (body.vouching !== undefined) {
    if (typeof body.vouching !== 'boolean') return no('vouching', '`vouching` must be a boolean');
    out.vouching = body.vouching;
  }
  for (const [field, max] of [
    ['peopleCap', 10_000],
    ['newPeoplePerDay', 1_000],
  ] as const) {
    const n = body[field];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
      return no(field, `\`${field}\` must be a whole number from 1 to ${max}`);
    }
    out[field] = n;
  }

  const settings = options.partial ? out : applySiteChange(SITE_DEFAULTS, out);
  // The map's roles must be allowed, and no reviewer role above the ceiling.
  if (!options.partial) {
    const allowed = new Set(settings.allowedRoles as readonly string[]);
    const map = settings.roleMap as Readonly<Record<SiteRole, SiteRoleGrant>>;
    const stray = Object.keys(map).find((role) => !allowed.has(role));
    if (stray !== undefined) {
      return no('roleMap', `\`roleMap\` names \`${stray}\`, which isn't in \`allowedRoles\``);
    }
    const ceiling = REVIEWER_RANK[settings.reviewerCeiling as 'standard' | 'senior'];
    const above = Object.entries(map).find(
      ([, grant]) => grant.reviewer !== undefined && REVIEWER_RANK[grant.reviewer] > ceiling,
    );
    if (above !== undefined) {
      return no(
        'roleMap',
        `\`roleMap\` gives \`${above[0]}\` the reviewer role ${above[1].reviewer}, above the ceiling ${settings.reviewerCeiling as string}`,
      );
    }
  }
  return { kind: 'ok', value: settings as SiteSettings };
}

function checkRoleMap(raw: unknown): Checked<Readonly<Record<SiteRole, SiteRoleGrant>>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return no('roleMap', '`roleMap` must be an object of role → `{ ask, reviewer? }`');
  }
  const out: Record<SiteRole, SiteRoleGrant> = {};
  for (const [role, grant] of Object.entries(raw as Record<string, unknown>)) {
    if (!ROLE_RE.test(role))
      return no('roleMap', `\`roleMap\` has a role name that isn't one: \`${role}\``);
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
      return no('roleMap', `\`roleMap.${role}\` must be \`{ ask, reviewer? }\``);
    }
    const g = grant as Record<string, unknown>;
    const extra = Object.keys(g).find((k) => k !== 'ask' && k !== 'reviewer');
    if (extra !== undefined || typeof g.ask !== 'boolean') {
      return no(
        'roleMap',
        `\`roleMap.${role}\` must be \`{ ask, reviewer? }\`, with \`ask\` a boolean`,
      );
    }
    // Never `admin`: a site's people decide at most what its ceiling allows.
    if (g.reviewer !== undefined && g.reviewer !== 'standard' && g.reviewer !== 'senior') {
      return no('roleMap', `\`roleMap.${role}.reviewer\` must be \`standard\` or \`senior\``);
    }
    out[role] = {
      ask: g.ask,
      ...(g.reviewer !== undefined && { reviewer: g.reviewer as 'standard' | 'senior' }),
    };
  }
  return { kind: 'ok', value: out };
}

/** An https origin with no path, query or credentials; http only on a loopback host. */
export function siteOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return undefined;
  if (url.pathname !== '/' || raw.replace(/\/$/, '') !== url.origin) return undefined;
  return url.origin;
}

/**
 * Characters that can disguise a name: controls (C0 and C1), format
 * characters (bidirectional marks, overrides and isolates, zero-width
 * characters, the byte-order mark), lone surrogates, the line and
 * paragraph separators, and the others that render as nothing (Unicode's
 * default-ignorable ones, such as the Hangul fillers and the combining
 * grapheme joiner). A variation selector is one too, except right after an
 * emoji or inside a keycap such as `1️⃣`, whose look it picks: `✉️ Contact`
 * is fine. A site's display name, a
 * console link's label and a connection's name are refused when they have
 * one. A person's `name`, which a site sends, is cleaned instead
 * (`withoutHiddenCharacters`): refusing it would keep out a person whose
 * name needs a joiner.
 */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_CHARACTER.test(text);
}

const HIDDEN_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}|(?<![\p{Extended_Pictographic}0-9#*])[\uFE0E\uFE0F]|(?<=[0-9#*])[\uFE0E\uFE0F](?!\u20E3)/u;

/** Every hidden character (`hasHiddenCharacters`), for removing them. */
const HIDDEN_CHARACTERS = new RegExp(HIDDEN_CHARACTER.source, 'gu');

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A name made from `text` that fits in `max` characters (code points): its
 * hidden characters (`hasHiddenCharacters`) removed, trimmed, and cut
 * between the characters a person sees, never inside one, so a flag, a
 * keycap or an accented letter is kept whole or left out. What the cut
 * leaves hidden goes too, and the end is trimmed. A connection's default
 * name and a numbered one are made with it. It can be empty.
 */
export function fitName(text: string, max: number): string {
  let kept = '';
  let size = 0;
  for (const { segment } of GRAPHEMES.segment(text.replace(HIDDEN_CHARACTERS, '').trim())) {
    size += [...segment].length;
    if (size > max) break;
    kept += segment;
  }
  return kept.replace(HIDDEN_CHARACTERS, '').trimEnd();
}

/**
 * What two names compare by: composed (NFC), without variation selectors,
 * lower-cased. `✅ Done` and `✅️ Done` look the same, and so do a composed
 * and a decomposed `Café`, so each pair has one key. A connection's name is
 * taken when another live one of its app, owner and env has the same key.
 */
export function comparableName(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\uFE0E\uFE0F]/gu, '')
    .toLowerCase();
}

/**
 * A person's name with what can disguise it removed: controls, the
 * bidirectional marks, embeddings, overrides and isolates, the line and
 * paragraph separators, and the other format characters, except the
 * zero-width joiner and non-joiner (U+200D, U+200C), which names in
 * Persian and Indic scripts, and emoji sequences, need. Trimmed.
 */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]|(?![\u200c\u200d])\p{Cf}/gu, '').trim();
}

function no(field: string, message: string): { kind: 'invalid'; field: string; message: string } {
  return { kind: 'invalid', field, message };
}

function where(c: Context<AppEnv>): { tenantId: TenantId; projectId: ProjectId } {
  return {
    tenantId: c.get('tenantId') as TenantId,
    projectId: c.req.param('projectId') as ProjectId,
  };
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await c.req.json()) as unknown;
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A project id that isn't a UUID is the route's 400, never looked up. */
async function projectIdChecked(c: Context<AppEnv>, next: () => Promise<void>) {
  if (UUID_RE.test(c.req.param('projectId') ?? '')) return next();
  return badInput(c, '`projectId` must be a project id (a UUID)');
}

function adminOnly(authorizer: Authorizer | undefined) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (await isTenantAdmin(c, authorizer)) return next();
    c.status(statusFor('permission-denied') as never);
    return c.json(
      toWireError(
        {
          code: 'permission-denied',
          message:
            "Only a tenant admin manages a project's sites: a site creates people in the tenant",
        },
        c.get('requestId'),
      ),
    );
  };
}

function answer(c: Context<AppEnv>, outcome: SiteChangeOutcome) {
  if (outcome.kind === 'not-found') return notFound(c);
  if (outcome.kind === 'invalid') return invalid(c, outcome.field, outcome.message);
  return c.json(siteToWire(outcome.site));
}

function notFound(c: Context<AppEnv>, message = 'No site with that id in this project') {
  c.status(statusFor('site-not-found') as never);
  return c.json(toWireError({ code: 'site-not-found', message }, c.get('requestId')));
}

function invalid(c: Context<AppEnv>, field: string, message: string) {
  c.status(statusFor('site-invalid') as never);
  return c.json(toWireError({ code: 'site-invalid', message, field }, c.get('requestId')));
}

function badInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}
