// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ToolContext } from '@kindgi/tools';

import { appRequest } from './app-request.js';
import type { AppEntry } from './types.js';

/** One call to an app's API, made with a connection the tool declared. */
export interface AppCall {
  /** The app's entry: its rate limits pace the call. */
  readonly entry: AppEntry;
  /** The tool's name for the connection: its `needsSpec.connections` key. */
  readonly connection: string;
  /**
   * What the entry's rate limits charge the call as (`costs`): the
   * operation's own name (`gmail.send`), never the id a pack gave the tool.
   */
  readonly toolId: string;
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as given, but for any `Authorization`: the connection's token goes there. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Calls an app's API with the connection the tool declared as
 * `call.connection`, sending its token as `Authorization: Bearer`.
 *
 * - **Pacing:** each of the entry's `rateLimits` is a bucket per connection
 *   in this process, holding `units` and refilled over `perSeconds`. The
 *   call takes `costs[toolId]` (1 when not listed) from each before it goes
 *   out, waiting until there's enough. A limit it costs 0 doesn't count it.
 * - **Busy:** a 429, a 403 that says a rate limit is spent (in GitHub's
 *   headers, or Google's `rateLimitExceeded` or `userRateLimitExceeded`), or
 *   a 503 to a GET is tried again, up to 3 tries in all, after the app's `Retry-After`
 *   (or GitHub's `x-ratelimit-reset`), else after 1 s, then 2 s. A wait the
 *   app asks for past 30 s isn't waited out: the answer goes back to the
 *   tool. A 503 to anything but a GET isn't tried again: the app may have
 *   done it.
 * - **Refused:** a 401 throws `ConnectionRejectedError`, so the runtime renews
 *   the token once and runs the call again.
 * - **Never:** the token is in no error this throws, and nothing is logged.
 *
 * Every wait ends when the call's `abortSignal` fires. Any other answer is
 * the tool's to read.
 */
export async function appFetch(
  ctx: Pick<ToolContext, 'connections' | 'abortSignal'>,
  call: AppCall,
): Promise<Response> {
  const connection = ctx.connections?.[call.connection];
  if (connection === undefined) {
    throw new Error(
      `This call has no connection "${call.connection}": the tool declares it in needsSpec.connections.`,
    );
  }
  if (connection.app !== call.entry.id) {
    throw new Error(
      `The connection "${call.connection}" is to ${connection.appName}, not ${call.entry.name}.`,
    );
  }
  return appRequest(
    {
      connection: call.connection,
      connectionId: connection.connectionId,
      token: connection.accessToken,
      fetch,
      abortSignal: ctx.abortSignal,
    },
    call,
  );
}
