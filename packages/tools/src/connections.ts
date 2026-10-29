// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

/**
 * A connection a tool needs, under the tool's own name for it
 * (`needsSpec.connections.mail`). The runtime finds the connection to the
 * app before the call and hands the tool its token (`ctx.connections`).
 */
export interface ConnectionNeed {
  /** The app's entry id: `'google'`, `'github'`. */
  readonly app: string;
  /** The entry's permission keys the call needs: at least one. */
  readonly permissions: readonly string[];
  /**
   * Whose connection: `'person'` is the run's person (the one it acts for,
   * who started it or owns its trigger); `'company'` is the tenant's.
   */
  readonly as: 'person' | 'company';
}

/** Whose account a connection is at the app: its stable id there, and what people see. */
export interface ConnectionAccount {
  readonly id: string;
  readonly label: string;
}

/**
 * A connection, resolved for one call: what a tool reads from
 * `ctx.connections`. Never printed, journaled or logged.
 */
export interface ToolConnection {
  readonly connectionId: string;
  readonly app: string;
  /** The app's name as people know it: `'Google'`. */
  readonly appName: string;
  readonly accessToken: string;
  readonly account: ConnectionAccount;
  /** The connection's name: its label, else its account's label. */
  readonly name?: string;
  readonly expiresAt?: string;
}

/**
 * A connect the run waits for: the person opens `connectUrl`, consents at
 * the app, and the run goes on. Listed in a run's `waitingFor`.
 */
export interface WaitingForConnection {
  /** The tool's name for the connection. */
  readonly name: string;
  readonly requestId: string;
  readonly waitToken: string;
  readonly app: string;
  readonly appName: string;
  /** What each permission asked for allows, in plain words. */
  readonly says: readonly string[];
  readonly connectUrl: string;
  readonly expiresAt: string;
  /** The person connected this app before, and connects it again. */
  readonly reconnects?: boolean;
}

/**
 * The mailbox a run reads, as the run records it (a runtime's `RunMailbox`):
 * the mail trigger that started it watches this app's mailbox.
 */
export interface ConnectionRunMailbox {
  readonly app: string;
  readonly as: 'company' | 'person';
  /**
   * The company connection the fire read the mail with, written once at
   * the fire. Only with `as: 'company'`.
   */
  readonly connectionId?: string;
}

/** The agent or the flow a call belongs to. */
export type ConnectionTarget = { readonly agentId: string } | { readonly flowId: string };

/** A company connection a project admin can choose for a target. */
export interface ConnectionChoiceOption {
  readonly connectionId: string;
  readonly name: string;
}

export interface ResolveConnectionsInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The env the runtime serves. */
  readonly envName: EnvName;
  readonly runId: string;
  /**
   * The step the call is in, when it has one: with `callId`, it names the
   * call across the run (`computeConnectWaitToken`).
   */
  readonly stepScope?: string;
  readonly callId: string;
  readonly toolId: string;
  /** The tool's `needsSpec.connections`. */
  readonly needs: Readonly<Record<string, ConnectionNeed>>;
  /**
   * The run's person: its principal (the one it acts for, else its actor)
   * when that's a user, whatever started the run. Absent for a service
   * account's run and an event trigger's.
   */
  readonly person?: { readonly userId: string };
  /** How long a connect may wait; 0 when this call can't wait (a run no person started, a flow step). */
  readonly waitMs: number;
  /** Names whose token to renew first, ignoring any cached one (after the app refused it). */
  readonly renew?: readonly string[];
  /**
   * The agent or flow the call belongs to, whose choice of a company
   * connection applies. A runtime checks it against the run's own record
   * and never takes it on trust.
   */
  readonly target?: ConnectionTarget;
  /** The run's mailbox, from the run's own record, when a mail trigger started it. */
  readonly mailbox?: ConnectionRunMailbox;
}

export type ResolveConnectionsOutcome =
  | { readonly kind: 'ready'; readonly connections: Readonly<Record<string, ToolConnection>> }
  /** One request per connection the call waits for; asked again for the same call, the same ones. */
  | { readonly kind: 'wait'; readonly requests: readonly WaitingForConnection[] }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'connection-app-missing'
        | 'connection-needs-a-person'
        | 'connection-missing'
        | 'connection-not-chosen';
      readonly name: string;
      readonly app: string;
      /** The permissions a connection lacks. */
      readonly missing?: readonly string[];
      /** With `connection-not-chosen`: the connections to choose from, sorted by name. */
      readonly choices?: readonly ConnectionChoiceOption[];
      readonly message: string;
    };

/**
 * What a run's tool dispatch asks for a call's connections: a runtime
 * implements it. For each need it finds the tenant's registration of the
 * app that allows the project, the owner (the run's person, or the
 * company), and that owner's live connection with every permission the
 * need lists, in the served env.
 *
 * A company need's candidates are the company's live connections of the
 * app (working or needing reconnecting) on any registration that allows
 * the project, in the served env. It takes, in order:
 *
 * 1. the run's mailbox's connection, when `mailbox` is the company's for
 *    this app and names one;
 * 2. the target's choice for the app in this project and env;
 * 3. the only candidate;
 * 4. with none, `connection-missing`;
 * 5. with several and no choice, `connection-not-chosen`, listing them.
 *
 * A connection step 1 or 2 picks must still be a candidate, be working and
 * hold the need's permissions; if not, the need is `connection-missing`,
 * naming it, and never another connection. An id that isn't the company's
 * connection of the app answers as no connection does. Candidates are
 * counted before permissions, so one that lacks a permission still counts.
 *
 * - **`ready`:** every need has a token.
 * - **`wait`:** a person's connection is missing, lacks a permission, or
 *   needs reconnecting, and the call may wait: one connect request per
 *   connection, made once however often the call asks. Needs that come to
 *   the same connection share one request, for all their permissions.
 * - **`refused`:** no registration allows the project
 *   (`connection-app-missing`), a person's connection in a run with no
 *   person (`connection-needs-a-person`), a missing one the call can't
 *   wait for (`connection-missing`), or several company connections and
 *   no choice of one (`connection-not-chosen`).
 *
 * When the app can't give a token just now, it throws
 * `ConnectionRenewError` and the connection stays as it is. One the app
 * can't renew at all (it gave no refresh token, or withdrew the grant) is
 * marked as needing reconnecting, and the call waits or is refused as for
 * any connection that needs reconnecting.
 */
export interface ConnectionResolver {
  resolveConnections(input: ResolveConnectionsInput): Promise<ResolveConnectionsOutcome>;
}

const CONNECTION_REJECTED = Symbol.for('kindgi.tools.connection-rejected');

/**
 * The app refused a connection's token (an HTTP 401 from its API). A tool
 * throws it; the runtime renews that token once and runs the call again.
 * It never removes the connection or changes its state.
 *
 * Recognized by a registered symbol, not `instanceof`, so a runtime and
 * a tool that load different copies of this package still agree.
 */
export class ConnectionRejectedError extends Error {
  readonly [CONNECTION_REJECTED] = true;
  /** The code the call fails with when the renewed token is refused too. */
  readonly code = 'connection-rejected';

  /**
   * @param connection The tool's name for the connection (its
   *   `needsSpec.connections` key).
   * @param message What the app said; never the token.
   */
  constructor(
    readonly connection: string,
    message?: string,
  ) {
    super(message ?? `the app refused the connection "${connection}"`);
    this.name = 'ConnectionRejectedError';
  }
}

/** Is `value` a `ConnectionRejectedError` (from any copy of this package)? */
export function isConnectionRejectedError(value: unknown): value is ConnectionRejectedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [CONNECTION_REJECTED]?: unknown })[CONNECTION_REJECTED] === true
  );
}

/** A refused connection, as a thrown error names it. */
export interface ConnectionRejection {
  /** The tool's name for the connection. */
  readonly connection: string;
  /** What the app said; never the token. */
  readonly message: string;
}

/** How many errors deep a refusal is looked for: the error and three causes. */
const REJECTION_DEPTH = 4;

/**
 * The refused connection a thrown error is or wraps: a
 * `ConnectionRejectedError` (from any copy of this package), or an error
 * with `code: 'connection-rejected'` naming its `connection`. A tool may
 * wrap the app's refusal in its own error, and a dispatcher wraps the
 * tool's, so it looks through up to three `cause`s. `undefined` when there
 * is none, or the first it finds names no connection.
 */
export function connectionRejectionOf(error: unknown): ConnectionRejection | undefined {
  let at: unknown = error;
  for (let depth = 0; depth < REJECTION_DEPTH; depth += 1) {
    if (typeof at !== 'object' || at === null) return undefined;
    const { code, connection, message, cause } = at as {
      readonly code?: unknown;
      readonly connection?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (isConnectionRejectedError(at) || code === 'connection-rejected') {
      if (typeof connection !== 'string') return undefined;
      return {
        connection,
        message:
          typeof message === 'string' && message !== ''
            ? message
            : `the app refused the connection "${connection}"`,
      };
    }
    at = cause;
  }
  return undefined;
}

const CONNECTION_RENEW_FAILED = Symbol.for('kindgi.tools.connection-renew-failed');

/**
 * The app couldn't give a connection's token just now: it didn't answer,
 * it answered with an error that doesn't withdraw the grant, or the
 * registration's client secret couldn't be read. A `ConnectionResolver`
 * throws it, and the call fails with `code`. The connection stays as it
 * is, so a later call tries again.
 *
 * Recognized by a registered symbol, not `instanceof`, like
 * `ConnectionRejectedError`.
 */
export class ConnectionRenewError extends Error {
  readonly [CONNECTION_RENEW_FAILED] = true;
  readonly code = 'connection-renew-failed';

  /**
   * @param connection The tool's name for the connection.
   * @param message What went wrong; never a token or a secret.
   */
  constructor(
    readonly connection: string,
    message?: string,
  ) {
    super(message ?? `the app couldn't renew the connection "${connection}" just now`);
    this.name = 'ConnectionRenewError';
  }
}

/** Is `value` a `ConnectionRenewError` (from any copy of this package)? */
export function isConnectionRenewError(value: unknown): value is ConnectionRenewError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [CONNECTION_RENEW_FAILED]?: unknown })[CONNECTION_RENEW_FAILED] === true
  );
}
