// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An app a Kindgi server can connect accounts at: Google, GitHub, Microsoft. An entry
 * is data. The server reads it to send people to the app's consent page,
 * to say in plain words what each permission allows, to learn whose
 * account was connected, and to withdraw access on a disconnect. The code
 * that talks to the app's token endpoints is the server's, one per
 * `signIn.kind`.
 *
 * Check an entry with `defineApp`.
 */
export interface AppEntry {
  /** `^[a-z][a-z0-9-]{1,31}$`: `'google'`, `'github'`. */
  readonly id: string;
  /** The app's name as people know it: `'Google'`. */
  readonly name: string;
  readonly signIn: SignIn;
  /** Who may own a connection to this app. At least one, each once. */
  readonly owners: readonly ConnectionOwnerKind[];
  /**
   * What a tool may ask for, by key (`^[a-z][a-z0-9_.-]{0,63}$`, e.g.
   * `'gmail.send'`). At least one.
   */
  readonly permissions: Readonly<Record<string, AppPermission>>;
  readonly account: AccountLookup;
  readonly removal: AppRemoval;
  readonly rateLimits?: readonly AppRateLimit[];
  /** The docs page an admin follows to register the app: `'/guides/connections/google/'`. */
  readonly setupGuide: string;
}

/** Who owns a connection: one member, or the company (the tenant). */
export type ConnectionOwnerKind = 'member' | 'company';

/**
 * How a person signs in at the app. A closed set: the server implements
 * each kind.
 *
 * - `oauth2`: the authorization code flow with PKCE (`S256`), with refresh
 *   and, when `revokeUrl` is given, revoke. Every URL is `https:`.
 *   `authorizeParams` are sent on the consent page's URL as given.
 *   - `scopes` are asked for at every sign-in, besides the permissions'
 *     and the account lookup's: Microsoft gives a refresh token only when
 *     `'offline_access'` is asked for.
 *   - `scopeResource`: the app may name a granted scope with this prefix,
 *     which ends in `/`, or without it, in any case (Microsoft answers
 *     `https://graph.microsoft.com/mail.read` for `Mail.Read`). The server
 *     compares both sides lowercase with the prefix dropped: each
 *     permission's `grants` and each scope the app answers. The app may
 *     answer more than was asked (scopes consented to earlier).
 *   - `tenant`: the sign-in happens in a directory of the app's own
 *     (Microsoft's tenant, not a Kindgi tenant), named in the URLs:
 *     `authorizeUrl` and `tokenUrl` each hold `{tenant}` once, and
 *     `revokeUrl` may too. The registration's `tenant` fills it, else
 *     `default`; with no `default`, each registration must give its own.
 *     The server fills it in the text before reading it as a URL.
 *   `refreshToken` says whether a connect needs one:
 *   - `'required'` (the default): a grant without one, and none kept from
 *     before, is refused.
 *   - `'optional'`: the app may give none (some give them only to the apps
 *     they approve). The connection then works until its access token
 *     ends, which the token answer must say, and then needs reconnecting.
 *     One the app gives anyway is used as under `'required'`.
 * - `github-app`: a GitHub App's installation, with its tokens made from
 *   the app's private key.
 */
export type SignIn =
  | {
      readonly kind: 'oauth2';
      readonly authorizeUrl: string;
      readonly tokenUrl: string;
      readonly revokeUrl?: string;
      readonly pkce: 'S256';
      readonly authorizeParams?: Readonly<Record<string, string>>;
      readonly scopes?: readonly string[];
      readonly scopeResource?: string;
      readonly tenant?: { readonly default?: string };
      readonly refreshToken?: 'required' | 'optional';
    }
  | { readonly kind: 'github-app' };

export interface AppPermission {
  /** The app's own scope or permission: a Google scope URL, `'issues:write'`. */
  readonly grants: string;
  /** Plain words for the person asked: `'Send mail as you'`. */
  readonly says: string;
  /** Whether it changes anything at the app. `false` is read only. */
  readonly changes: boolean;
  /** The app's own review class for it, where the app has one. */
  readonly review?: 'none' | 'sensitive' | 'restricted';
}

/**
 * How the server learns whose account was connected. `id` is the app's
 * stable id for the account; `label` is what people see.
 *
 * - `openid`: from the ID token the token endpoint returns. `sub` is the
 *   id and `email` the label. Its `iss` must be one of `issuers` and its
 *   `aud` the registration's client id. The first issuer is the one the
 *   server discovers keys from. `scopes` are asked for besides the
 *   permissions' own, and include `'openid'`.
 * - `github-installation`: the installation's account. Its id is the id
 *   and its login the label.
 * - `profile`: a GET of `url` with the new access token, answered with a
 *   JSON object. `id` names its field that holds the app's stable id for
 *   the account; `label` names the fields for what people see, the first
 *   that holds a non-empty string winning (Microsoft's `mail` is empty for
 *   some accounts, so `userPrincipalName` follows it). A field that isn't
 *   a non-empty string counts as not there: with no id, the connect fails.
 *   `scopes` are asked for besides the permissions' own. `url` can't hold
 *   `{tenant}`.
 */
export type AccountLookup =
  | {
      readonly kind: 'openid';
      readonly issuers: readonly [string, ...string[]];
      readonly scopes: readonly string[];
    }
  | { readonly kind: 'github-installation' }
  | {
      readonly kind: 'profile';
      readonly url: string;
      readonly scopes: readonly string[];
      readonly id: string;
      readonly label: readonly [string, ...string[]];
    };

/** How access is withdrawn, and how the app tells the server it was. */
export interface AppRemoval {
  /**
   * How a disconnect withdraws access at the app: `oauth2-revoke` needs an
   * `oauth2` sign-in with a `revokeUrl`; `github-installation-token`, a
   * `github-app` one.
   */
  readonly revoke?: 'oauth2-revoke' | 'github-installation-token';
  /**
   * Whether the app's revoke withdraws everything the person granted the
   * registration, not only this connection's permissions. Google's does.
   */
  readonly revokeIsGrantWide?: boolean;
  /** How the app reports a removal made at the app. */
  readonly notices?: 'google-risc' | 'github-webhooks';
}

/** The app's limit on calls, per connection. */
export interface AppRateLimit {
  readonly per: 'connection';
  /** Whole units allowed per `perSeconds`. */
  readonly units: number;
  readonly perSeconds: number;
  /**
   * Units a call costs, by the operation's own name (`gmail.send`), never
   * the id a pack gives a tool that makes it. One not listed costs 1; one
   * that costs 0 isn't counted in this limit (a limit on sends alone).
   */
  readonly costs?: Readonly<Record<string, number>>;
}
