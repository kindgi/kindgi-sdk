// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ModelToolCall } from '@kindgi/capabilities';
import type { Tool } from '@kindgi/tools';

import type { ConnectionCallFailure } from './connection-gate.js';
import type { TurnContext } from './context.js';

/**
 * The input a call names its accounts with: one property per need of the
 * tool whose choice is a set, each one of the set's names. The runtime
 * reads it, and the tool never sees it.
 */
export const ACCOUNTS_INPUT = 'accounts';

/**
 * The connections a call names, need to connection id, from its turn's
 * offer. A tool offered nothing names none, whatever its input holds: an
 * `accounts` of its own is its input. A name, or a need, outside the
 * offer fails the call (`connection-missing`), never picking another
 * connection, and the failure doesn't repeat the name.
 */
export function namedAccounts(
  ctx: TurnContext,
  call: ModelToolCall,
  tool: Tool,
):
  | { readonly kind: 'named'; readonly accounts?: Readonly<Record<string, string>> }
  | { readonly kind: 'failed'; readonly failure: ConnectionCallFailure } {
  const offered = ctx.accountChoices?.[tool.id as unknown as string];
  if (offered === undefined) return { kind: 'named' };
  const given = call.arguments[ACCOUNTS_INPUT];
  if (given === undefined) return { kind: 'named' };
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    return {
      kind: 'failed',
      failure: {
        code: 'connection-missing',
        message: `${call.name}'s ${ACCOUNTS_INPUT} names each connection it reads by its need, so it didn't run.`,
      },
    };
  }
  const accounts: Record<string, string> = {};
  for (const [need, name] of Object.entries(given as Readonly<Record<string, unknown>>).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const set = offered[need];
    const member = typeof name === 'string' ? set?.members.find((m) => m.name === name) : undefined;
    if (member === undefined) {
      return {
        kind: 'failed',
        failure: {
          code: 'connection-missing',
          connection: need,
          message: `${call.name} named a connection for "${need}" that it can't read from here, so it didn't run.`,
        },
      };
    }
    accounts[need] = member.connectionId;
  }
  return Object.keys(accounts).length === 0 ? { kind: 'named' } : { kind: 'named', accounts };
}

/**
 * The input the tool runs with: the call's, without the `accounts` its
 * turn offered it. A tool offered nothing gets the call's input whole.
 */
export function toolArguments(
  ctx: TurnContext,
  call: ModelToolCall,
  tool: Tool,
): Readonly<Record<string, unknown>> {
  if (ctx.accountChoices?.[tool.id as unknown as string] === undefined) return call.arguments;
  if (!(ACCOUNTS_INPUT in call.arguments)) return call.arguments;
  const { [ACCOUNTS_INPUT]: _named, ...rest } = call.arguments;
  return rest;
}
