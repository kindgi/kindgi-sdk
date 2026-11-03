// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ConnectionChoiceOption,
  ConnectionNeed,
  ConnectionPick,
  ResolveConnectionsOutcome,
  WaitingForConnection,
} from './connections.js';

/** A connection as a run's record names it: whose account at which app, never its token. */
export interface RecordedConnection {
  readonly connectionId: string;
  readonly app: string;
  readonly appName: string;
  /**
   * Whose account it is at the app: its id, and the company's label. A
   * person's has no label: their account is theirs alone. Older records
   * keep it.
   */
  readonly account: { readonly id: string; readonly label?: string };
  /** The company connection's name: its label, else its account's label. Never a person's. */
  readonly name?: string;
  /** How it was picked, and through which registration. Absent from older records. */
  readonly pick?: ConnectionPick;
}

/**
 * What a call's connection gate records in the run's journal
 * (`CONNECTION_GATE_RECORD_PREFIX`): the resolver's answer, never a
 * connection's token. Any project reader reads it. An agent's call and a
 * flow's tool step record the same shape; a flow's step never records
 * `wait`.
 */
export type ConnectionGateRecord =
  | { readonly kind: 'ready'; readonly connections: Readonly<Record<string, RecordedConnection>> }
  | { readonly kind: 'wait'; readonly requests: readonly WaitingForConnection[] }
  | {
      readonly kind: 'refused';
      readonly code: Extract<ResolveConnectionsOutcome, { kind: 'refused' }>['code'];
      /** The tool's name for the connection. */
      readonly name: string;
      readonly app: string;
      /** Whose need it was: the company's, or the run's person's. Absent from older records. */
      readonly as?: ConnectionNeed['as'];
      /** The permissions a connection lacks. */
      readonly missing?: readonly string[];
      /** With the company's `connection-not-chosen`: its connections, by id and name only. */
      readonly choices?: readonly ConnectionChoiceOption[];
      readonly message: string;
    };

/**
 * The resolver's answer as the record keeps it: what it names, never a
 * connection's token. Any project reader reads a run's record, so a
 * person's connection is named by its app and account id, never by their
 * name or address for it. A refusal says whose need it was, from `needs`,
 * unless its `name` isn't one of them.
 */
export function connectionGateRecordOf(
  outcome: ResolveConnectionsOutcome,
  needs: Readonly<Record<string, ConnectionNeed>>,
): ConnectionGateRecord {
  if (outcome.kind === 'refused') {
    const need = needs[outcome.name];
    return {
      kind: 'refused',
      code: outcome.code,
      name: outcome.name,
      app: outcome.app,
      ...(need !== undefined && { as: need.as }),
      ...(outcome.missing !== undefined && { missing: outcome.missing }),
      ...(outcome.choices !== undefined && {
        choices: outcome.choices.map((c) => ({ connectionId: c.connectionId, name: c.name })),
      }),
      message: outcome.message,
    };
  }
  if (outcome.kind === 'wait') {
    return {
      kind: 'wait',
      requests: outcome.requests.map((r) => ({
        name: r.name,
        requestId: r.requestId,
        waitToken: r.waitToken,
        app: r.app,
        appName: r.appName,
        says: r.says,
        connectUrl: r.connectUrl,
        expiresAt: r.expiresAt,
        ...(r.reconnects !== undefined && { reconnects: r.reconnects }),
      })),
    };
  }
  const connections: Record<string, RecordedConnection> = {};
  for (const [name, c] of Object.entries(outcome.connections)) {
    const company = needs[name]?.as === 'company';
    const pick = outcome.picks?.[name];
    connections[name] = {
      connectionId: c.connectionId,
      app: c.app,
      appName: c.appName,
      account: company ? { id: c.account.id, label: c.account.label } : { id: c.account.id },
      ...(c.name !== undefined && company && { name: c.name }),
      ...(pick !== undefined && { pick: recordedPick(pick) }),
    };
  }
  return { kind: 'ready', connections };
}

/** A pick as the record keeps it: its own fields only. */
function recordedPick(pick: ConnectionPick): ConnectionPick {
  return {
    by: pick.by,
    ...(pick.choiceId !== undefined && { choiceId: pick.choiceId }),
    ...(pick.as !== undefined && { as: pick.as }),
    ...(pick.setSize !== undefined && { setSize: pick.setSize }),
    registration: { id: pick.registration.id, name: pick.registration.name },
  };
}
