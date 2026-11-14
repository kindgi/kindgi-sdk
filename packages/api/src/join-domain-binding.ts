// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { SessionId, TenantId, Timestamp } from '@kindgi/types';

import type { ProviderJoinRole } from './identity-provider-binding.js';

/**
 * The email domains a workspace lets people join from: "people at
 * acme.com may join, as viewer on the default project". Someone who signs
 * in with a mailbox at an allowed domain, by a way that counts for it (a
 * Google Workspace account at it, a Microsoft work account, or the emailed
 * link, which proves the mailbox), and whom the workspace doesn't have
 * yet, is offered the workspace and joins with a press. GitHub never
 * counts. A sign-in through the workspace's own identity provider follows
 * that provider's own `join` setting, never an allowed domain.
 *
 * - `/v1/auth/join-domains`: the list (`read` on the tenant); a tenant
 *   admin allows a domain, changes what joiners get, or stops allowing it.
 * - `/v1/system/tenants/{tenantId}/join-domains`: the same, for the
 *   deployment's operator on a runtime serving many tenants
 *   (`system:join-domains`).
 * - `POST /v1/system/join-domains/lookup`: for one verified email, of the
 *   workspaces that let people at its domain join, the ones it may join and
 *   the ones it's in already, for a sign-up page that offers them before it
 *   makes a new workspace (`system:join-domains:read` or
 *   `system:join-domains`).
 *
 * The rules a write keeps are the deployment's, so the binding decides
 * them and the route says why it refused:
 * - A change that lets more people in, or gives joiners more (allowing a
 *   domain, allowing it again, raising its role), takes a person who's a
 *   tenant admin, for the domain of the email their session's sign-in
 *   proved, exactly (no subdomain, no parent), from a way in that counts
 *   for it; or the operator. The proved email is the one the sign-in
 *   recorded on the session, never a primary email reached through a
 *   linked account, which may have moved since. An API key or a service
 *   account has no proved email, so it can't.
 * - The workspace's own identity provider counts for a domain only once
 *   the deployment routes that domain to the workspace: a provider's
 *   `domains` are the workspace's own word until the operator verifies them.
 * - The operator holds `kindgi:system`: on a runtime serving one tenant,
 *   the deployment's own token or a key it minted holding it (on
 *   `/v1/auth/join-domains`); on one serving many, a system principal on
 *   the system routes.
 * - Never a public mailbox domain (gmail.com, outlook.com, ...), and never
 *   a domain the operator verified for another workspace, or for a tenant
 *   this runtime doesn't serve.
 * - Allowing a domain, or allowing it again, is refused with no
 *   authorization store: a joiner's role couldn't be checked there, so
 *   they'd work in every project. A raise meets only who may widen and the
 *   operator's verified domains (`not-yours`, `verified-elsewhere`).
 * - A change that narrows (a lower role, stopping allowing a domain) takes
 *   any tenant admin, an API key too.
 *
 * Stopping allowing a domain stops new joins; people who joined stay. The
 * binding audits what it changes, and a refusal writes nothing.
 */

/** A domain a workspace lets people join from. */
export interface JoinDomain {
  /** Lower case, as an A-label (`xn--bcher-kva.de` for bücher.de), e.g. `acme.com`. */
  readonly domain: string;
  /** What a joiner gets: `viewer` or `runner` on the default project, or `none` (a member only). Never admin. */
  readonly role: ProviderJoinRole;
  readonly createdAt: Timestamp;
  /**
   * Who allowed it: `user:<id>`, a person, or the deployment's own token as
   * its seed user on a runtime serving one tenant; `service_account:<id>`,
   * a key holding `kindgi:system` that acts as one; or `system-key:<id>` on
   * the system routes (`system-key:boot` for the deployment's own token).
   */
  readonly createdBy: string;
  readonly updatedAt?: Timestamp;
  /** Who last changed its role, in `createdBy`'s forms: any tenant admin's, for a lower one. */
  readonly updatedBy?: string;
}

/** Who asks to change who may join: the route reads it from the request. */
export type JoinDomainCaller =
  /**
   * A person, from their session: the binding reads the email the
   * session's sign-in proved, and the way in.
   */
  | {
      readonly kind: 'person';
      readonly userId: string;
      readonly sessionId: SessionId;
      readonly by: string;
    }
  /** The deployment's operator (`kindgi:system`, or a system principal on the system routes). */
  | { readonly kind: 'operator'; readonly by: string }
  /** Anything else: an API key, a service account, a session-less person. */
  | { readonly kind: 'other'; readonly by: string };

/** Why a domain can't be allowed, or its joiners given more. */
export type JoinDomainRefusal =
  /**
   * Not the caller's to widen: not a person, not the domain of the email
   * their sign-in proved (or no proved email recorded on the session), or a
   * way in that doesn't count for it (GitHub; the workspace's own provider
   * for a domain that doesn't route to the workspace).
   */
  | {
      readonly kind: 'not-yours';
      readonly reason:
        | 'not-a-person'
        | 'not-your-domain'
        | 'no-proved-email'
        | 'way-in-does-not-count';
    }
  /** A public mailbox domain: anyone can have an address there. */
  | { readonly kind: 'public' }
  /** The operator verified it for another workspace, or for a tenant this runtime doesn't serve. */
  | { readonly kind: 'verified-elsewhere' }
  /** The deployment has no authorization store. */
  | { readonly kind: 'needs-authorization' };

export type JoinDomainAllowOutcome =
  | { readonly kind: 'allowed'; readonly joinDomain: JoinDomain }
  /** It's allowed already: change its role with `change`. */
  | { readonly kind: 'exists'; readonly joinDomain: JoinDomain }
  | JoinDomainRefusal;

export type JoinDomainChangeOutcome =
  | { readonly kind: 'changed'; readonly joinDomain: JoinDomain }
  /** The role it has already: nothing written, nothing audited. */
  | { readonly kind: 'unchanged'; readonly joinDomain: JoinDomain }
  | { readonly kind: 'not-found' }
  /** A raise, while the deployment's operator manages sign-in and the caller isn't the operator. */
  | { readonly kind: 'operator-managed' }
  /** A raise only: neither a public domain nor a missing authorization store refuses one. */
  | Extract<JoinDomainRefusal, { readonly kind: 'not-yours' | 'verified-elsewhere' }>;

/**
 * A workspace for one verified email (the lookup), of those that let
 * people at its domain join: one it may join (`join`, with what a joiner
 * gets), or one it's in already (`member`: sign in, don't join).
 */
export type JoinLookupWorkspace =
  | {
      readonly kind: 'join';
      readonly tenantId: TenantId;
      readonly name: string;
      readonly role: ProviderJoinRole;
    }
  | { readonly kind: 'member'; readonly tenantId: TenantId; readonly name: string };

export interface JoinDomainBinding {
  /** The tenant's allowed domains, the first allowed first. */
  list(tenantId: TenantId): Promise<readonly JoinDomain[]>;
  /** Let people at `domain` join (a widening), or allow it again after its removal. */
  allow(input: {
    readonly tenantId: TenantId;
    readonly domain: string;
    readonly role: ProviderJoinRole;
    readonly caller: JoinDomainCaller;
  }): Promise<JoinDomainAllowOutcome>;
  /**
   * Change what a joiner gets. Compared with the live row, in one
   * transaction: a raise (`none` to `viewer` to `runner`) takes `allow`'s
   * rules for who may widen and which domain (`not-yours`,
   * `verified-elsewhere`), a lower takes any admin, the same role writes
   * nothing.
   */
  change(input: {
    readonly tenantId: TenantId;
    readonly domain: string;
    readonly role: ProviderJoinRole;
    readonly caller: JoinDomainCaller;
    /**
     * The deployment's operator manages sign-in and `caller` isn't the
     * operator: a raise is refused (`operator-managed`), a lower isn't.
     */
    readonly raiseRefused: boolean;
  }): Promise<JoinDomainChangeOutcome>;
  /** Stop allowing a domain (any admin): new joins stop, joiners stay. */
  remove(input: {
    readonly tenantId: TenantId;
    readonly domain: string;
    readonly by: string;
  }): Promise<{ readonly kind: 'removed' } | { readonly kind: 'not-found' }>;
  /**
   * For one email a sign-up page verified, of the workspaces this runtime
   * serves that let people at its domain join, by the deployment sign-in's
   * rules for the emailed link: the ones it may join (`join`), and the ones
   * it's in already (`member`). Never one that removed that email, nor one
   * that takes only its own identity provider for the domain, and never a
   * list of every workspace the email is in. Ids, names and join roles
   * only. Empty for a public domain.
   */
  lookup(email: string): Promise<readonly JoinLookupWorkspace[]>;
}
