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
   * The connection the run's mail was read with, fixed when the fire
   * starts the run: the company's, or the person's own.
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
  /**
   * The connections the call named, need to connection id: each one a
   * member of the need's set, from its turn's `accountChoices`. A need
   * it names nothing for uses the set's default.
   */
  readonly accounts?: Readonly<Record<string, string>>;
}

/**
 * How a ready call's connection was picked, and the registration it came
 * through, for the run's record. A tool never sees it.
 */
export interface ConnectionPick {
  /**
   * - `mailbox`: the connection the run's mail came to, the company's or
   *   the person's.
   * - `choice`: a choice, `choiceId`: the tool's, else the agent's or
   *   flow's, the company's or the person's own. A set's default when the
   *   call named none.
   * - `named`: the member of the tool's set, `choiceId`, that the call
   *   named.
   * - `only`: the project's only company connection of the app.
   * - `main`: the person's main connection.
   * - `own`: the person's only connection of the app.
   */
  readonly by: 'mailbox' | 'choice' | 'named' | 'only' | 'main' | 'own';
  /** The choice that picked it, with `by: 'choice'` and `'named'`. */
  readonly choiceId?: string;
  /** Whose need it was: the company's, or the run's person's. Absent from older records. */
  readonly as?: 'company' | 'person';
  /**
   * With a set: how many connections it holds, as the run tree uses it.
   * The record counts a person's set, and never names its members.
   */
  readonly setSize?: number;
  /**
   * The app's registration the connection came through: its id, and its
   * label, else its app's name and its id's first 8 characters.
   */
  readonly registration: { readonly id: string; readonly name: string };
}

export type ResolveConnectionsOutcome =
  | {
      readonly kind: 'ready';
      readonly connections: Readonly<Record<string, ToolConnection>>;
      /** How each was picked, keyed like `connections`. Absent from a runtime that doesn't say. */
      readonly picks?: Readonly<Record<string, ConnectionPick>>;
    }
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

/** What the agent loop asks of a turn's tools: which of their needs have a set. */
export interface ConnectionAccountChoicesInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  readonly runId: string;
  readonly target?: ConnectionTarget;
  /** The run's person, as `ResolveConnectionsInput.person`. */
  readonly person?: { readonly userId: string };
  /** The run's mailbox: a need it binds has no set to name from. */
  readonly mailbox?: ConnectionRunMailbox;
  /** The turn's tools that may take a set, each with its `needsSpec.connections`. */
  readonly tools: readonly {
    readonly toolId: string;
    readonly needs: Readonly<Record<string, ConnectionNeed>>;
  }[];
}

/**
 * Each tool's needs whose choice is a set, tool id to need: the app's
 * name, the set's members still candidates, by name, and its default. A
 * tool or need with no set is left out. The ids are for the run, never the
 * model.
 */
export type ConnectionAccountChoices = Readonly<
  Record<
    string,
    Readonly<
      Record<
        string,
        {
          readonly appName: string;
          readonly members: readonly { readonly name: string; readonly connectionId: string }[];
          /** The set's default, by its connection id: what a call that names none reads. */
          readonly default: string;
        }
      >
    >
  >
>;

/**
 * What a run's tool dispatch asks for a call's connections: a runtime
 * implements it. For each need it finds the tenant's registration of the
 * app that allows the project, the owner (the run's person, or the
 * company), and that owner's live connection with every permission the
 * need lists, in the served env.
 *
 * A need's candidates are its owner's live connections of the app
 * (working or needing reconnecting) on a registration that allows the
 * project, in the served env: the company's for a company need, the run's
 * person's for theirs. It takes, in order:
 *
 * 1. the run's mailbox's connection, when `mailbox` is this owner's for
 *    this app and names one;
 * 2. the member of the tool's set the call names in `accounts`;
 * 3. the tool's choice for this need, a set's default;
 * 4. the target's choice for the app;
 * 5. for a person, their main connection, else their only one; for the
 *    company, the only candidate;
 * 6. with none, `connection-missing`; with several and nothing chosen,
 *    `connection-not-chosen`.
 *
 * A choice is the owner's: a person's need reads only that person's
 * choices, and a company need the company's. A set is for a tool that
 * may take one (`connectionSetRefusal` in `@kindgi/agents`), and the
 * call's own version decides again: one that may not gets the default.
 *
 * A connection steps 1 to 4 pick must still be a candidate, be working and
 * hold the need's permissions; if not, the need is `connection-missing`,
 * naming it, and never another connection. An id that isn't the owner's
 * connection of the app answers as no connection does. Candidates are
 * counted before permissions, so one that lacks a permission still counts.
 * Needs that pick one connection share it, with their permissions joined.
 *
 * - **`ready`:** every need has a token.
 * - **`wait`:** a person's connection is missing, lacks a permission, or
 *   needs reconnecting, and the call may wait: one connect request per
 *   connection, made once however often the call asks. Needs that come to
 *   the same connection share one request, for all their permissions.
 * - **`refused`:** no registration allows the project
 *   (`connection-app-missing`), a person's connection in a run with no
 *   person (`connection-needs-a-person`), a missing one the call can't
 *   wait for (`connection-missing`), or several connections and nothing
 *   chosen (`connection-not-chosen`). A person's refusal names the app and
 *   counts their connections, never their names, and lists no `choices`.
 *
 * When the app can't give a token just now, it throws
 * `ConnectionRenewError` and the connection stays as it is. One the app
 * can't renew at all (it gave no refresh token, or withdrew the grant) is
 * marked as needing reconnecting, and the call waits or is refused as for
 * any connection that needs reconnecting.
 */
export interface ConnectionResolver {
  resolveConnections(input: ResolveConnectionsInput): Promise<ResolveConnectionsOutcome>;
  /**
   * Once per turn: which of the turn's tools' needs have a set the call may
   * name from (`accounts`). Absent: no set is offered, and every need
   * resolves as if it named none.
   */
  accountChoices?(input: ConnectionAccountChoicesInput): Promise<ConnectionAccountChoices>;
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
