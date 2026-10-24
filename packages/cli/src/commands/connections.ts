// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createInterface } from 'node:readline';

import type { ConnectRequest, Connection, ConnectionEntry, ConnectionPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi connections`: accounts at other apps (a mailbox, a GitHub
 * installation) that tools act with. A member lists and connects their
 * own; a tenant admin lists every one and connects the company's. An app
 * is connected through a registration the tenant admin added
 * (`kindgi connection-apps add`).
 */

/**
 * The terminal, clock and pauses of `kindgi connections connect` and of the
 * removals that ask first. Tests inject them; production leaves this
 * undefined.
 */
export interface ConnectionsSeam {
  /** A person at the terminal to ask and to wait for. Default: stdin and stderr are TTYs. */
  readonly interactive?: () => boolean;
  /** A yes/no question. Default: asked on the terminal. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly now?: () => Date;
  /** The pause between reads of a connect request. Default: a timer the stop signal cuts short. */
  readonly pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Where the link and the waiting line go while it waits. Default: stderr. */
  readonly progress?: (line: string) => void;
}

/** How often a waiting `connect` reads its request. */
const CONNECT_POLL_MS = 2_000;

/** A person at a terminal: stdin and stderr are both TTYs. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/** Ask a yes/no question on the terminal; only `y` or `yes` is a yes. */
async function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question(question, resolveAnswer);
      rl.once('close', () => resolveAnswer(''));
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

function pauseUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Whether a removal may go ahead: `--yes`, or a person at the terminal
 * answered yes to `question()`. With no terminal to ask on, and no
 * `--yes`, nothing is removed. `question` reads what it names only when
 * there's someone to ask.
 */
export async function confirmRemoval(
  ctx: CommandContext,
  label: string,
  question: () => Promise<string>,
): Promise<{ readonly kind: 'ok' } | { readonly kind: 'refused'; readonly stderr: string }> {
  if (ctx.options.yes === true) return { kind: 'ok' };
  const seam = ctx.connectionsSeam ?? {};
  if (!(seam.interactive ?? isInteractive)()) {
    return {
      kind: 'refused',
      stderr: `kindgi ${label} asks first, and there's no terminal to ask on. Run it with --yes.\n`,
    };
  }
  const yes = await (seam.confirm ?? confirmOnTerminal)(`${await question()} [y/N] `);
  return yes ? { kind: 'ok' } : { kind: 'refused', stderr: `kindgi ${label}: nothing changed.\n` };
}

/** Who owns a connection, in words: `company`, or the member's user id. */
function ownerWords(c: Pick<Connection, 'owner'>): string {
  return c.owner.kind === 'company' ? 'company' : (c.owner.userId ?? 'member');
}

const TABLE: TableSpec<ConnectionPage, Connection> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (c) => c.connectionId },
    { header: 'APP', get: (c) => c.app },
    { header: 'ACCOUNT', get: (c) => c.account.label },
    { header: 'OWNER', get: ownerWords },
    {
      header: 'STATE',
      get: (c) => (c.stateReason !== undefined ? `${c.state} (${c.stateReason})` : c.state),
    },
    { header: 'LAST USED', get: (c) => (c.lastUsedAt !== undefined ? String(c.lastUsedAt) : '') },
  ],
};

/** `list --include-removed`: when each was removed, too. */
const TABLE_WITH_REMOVED: TableSpec<ConnectionPage, Connection> = {
  rows: TABLE.rows,
  columns: [
    ...TABLE.columns,
    { header: 'REMOVED', get: (c) => (c.removedAt !== undefined ? String(c.removedAt) : '') },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List connections: a member's own, every one for a tenant admin. `--mine` keeps to your own. Removed ones are left out unless `--include-removed`.",
  usage:
    'kindgi connections list [--project=<project-id>] [--app=<app>] [--mine] [--include-removed] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    project: {
      type: 'string',
      description: 'Only those whose registration allows this project.',
    },
    app: { type: 'string', description: "Only this app's, by its entry id: `google`, `github`." },
    mine: { type: 'boolean', description: 'Only your own, even as a tenant admin.' },
    'include-removed': {
      type: 'boolean',
      description: 'Removed connections too, with when (`removedAt`).',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'connections list',
      async () => {
        const projectId = stringFlag(ctx, 'project');
        const app = stringFlag(ctx, 'app');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().connections.list({
          ...(projectId !== undefined && { projectId }),
          ...(app !== undefined && { app }),
          ...(ctx.options.mine === true && { owner: 'me' as const }),
          ...(ctx.options['include-removed'] === true && { includeRemoved: true }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      ctx.options['include-removed'] === true ? TABLE_WITH_REMOVED : TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One connection: whose account it is, its permissions and its state.',
  usage: 'kindgi connections get <connection-id>',
  run: (ctx) =>
    runSdk(ctx, 'connections get', async () =>
      ctx.client().connections.get(requiredPositional(ctx, 0, 'connection-id')),
    ),
};

/** A permission as the person is asked about it: its key, its plain words, and whether it changes things. */
function permissionWords(key: string, p: ConnectionEntry['permissions'][string]): string {
  return `${key}: ${p.says}${p.changes ? ' (changes things)' : ''}`;
}

async function entryFor(ctx: CommandContext, app: string): Promise<ConnectionEntry> {
  const { data } = await ctx.client().connectionEntries.list();
  const entry = data.find((e) => e.id === app);
  if (entry === undefined) {
    const known = data.map((e) => e.id).join(', ');
    throw new UsageError(
      `This server connects no app "${app}"${known !== '' ? `; it connects ${known}` : ''}`,
    );
  }
  return entry;
}

/**
 * `--permissions=gmail.send,gmail.read`; left out, the person at the
 * terminal is asked about each permission the app's entry offers, none
 * picked for them, as the console's Connect does. Nothing is asked for by
 * default: a connect adds to what's granted, so a tool that needs more asks
 * again then. Undefined when the person picked none.
 */
async function permissionsFor(ctx: CommandContext, app: string): Promise<string[] | undefined> {
  const given = stringFlag(ctx, 'permissions');
  if (given !== undefined) {
    const keys = given
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');
    if (keys.length === 0) throw new UsageError('--permissions names no permission');
    return keys;
  }
  const entry = await entryFor(ctx, app);
  const offered = Object.entries(entry.permissions);
  const seam = ctx.connectionsSeam ?? {};
  if (!(seam.interactive ?? isInteractive)()) {
    const listed = offered.map(([key, p]) => permissionWords(key, p)).join('; ');
    throw new UsageError(
      `Missing --permissions=<key>,…, which of ${entry.name}'s permissions to ask for (there's no terminal to ask on): ${listed}`,
    );
  }
  const ask = seam.confirm ?? confirmOnTerminal;
  const picked: string[] = [];
  for (const [key, p] of offered) {
    if (await ask(`Ask ${entry.name} for ${permissionWords(key, p)}? [y/N] `)) picked.push(key);
  }
  return picked.length > 0 ? picked : undefined;
}

type Waited =
  | { readonly kind: 'ended'; readonly request: ConnectRequest }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'expired' };

/** Read the request until it's no longer pending, its link expired, or the person stopped waiting. */
async function waitForConnect(ctx: CommandContext, request: ConnectRequest): Promise<Waited> {
  const seam = ctx.connectionsSeam ?? {};
  const now = seam.now ?? (() => new Date());
  const pause = seam.pause ?? pauseUnlessStopped;
  const expiresAt = Date.parse(String(request.expiresAt));
  for (;;) {
    await pause(CONNECT_POLL_MS, ctx.stopSignal);
    if (ctx.stopSignal?.aborted === true) return { kind: 'stopped' };
    const read = await ctx.client().connections.getRequest(request.requestId);
    if (read.state !== 'pending') return { kind: 'ended', request: read };
    if (now().getTime() >= expiresAt) return { kind: 'expired' };
  }
}

/** Whose account a connection is, in words: `<label> at <app>`, and whether it's the company's. */
function accountWords(c: Connection): string {
  const whose = c.owner.kind === 'company' ? ", the company's account" : '';
  return `${c.account.label} at ${c.app}${whose}`;
}

/** What a connected connect says: whose account it connected. */
async function connected(
  ctx: CommandContext,
  request: ConnectRequest,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const id = request.connectionId;
  if (id === undefined) return { stdout: `Connected ${request.app}.\n`, stderr: '' };
  const c = await ctx.client().connections.get(id);
  return { stdout: `Connected ${accountWords(c)} (connection ${c.connectionId}).\n`, stderr: '' };
}

/**
 * A connect the person allowed less on than asked: the server ends it
 * declined, yet stores the connection with what was granted, and names it.
 * It exits 1, since the request didn't get what it asked for.
 */
async function connectedWithLess(
  ctx: CommandContext,
  request: ConnectRequest,
  id: string,
): Promise<Rendered & { readonly exitCode: number }> {
  const c = await ctx.client().connections.get(id);
  const not =
    request.missing !== undefined && request.missing.length > 0
      ? `: not ${request.missing.join(', ')}`
      : '';
  return {
    stdout: `Connected ${accountWords(c)} (connection ${c.connectionId}), with less than asked.\n`,
    stderr: `The app granted less than asked${not}. Tools that need those ask to connect again.\n`,
    exitCode: 1,
  };
}

/** A declined connect that stored nothing; a reconnect leaves its connection as it was. */
function declinedWords(r: ConnectRequest): string {
  const not =
    r.missing !== undefined && r.missing.length > 0 ? ` (not ${r.missing.join(', ')})` : '';
  return r.reconnects !== undefined
    ? `Declined at ${r.app}${not}: connection ${r.reconnects} stays as it was.\n`
    : `Declined at ${r.app}${not}: nothing connected.\n`;
}

const ENDED: Record<'declined' | 'expired' | 'failed', (r: ConnectRequest) => string> = {
  declined: declinedWords,
  expired: () => 'The link expired before the connect finished: nothing connected.\n',
  failed: (r) => `The connect failed (${r.failure ?? 'no reason given'}): nothing connected.\n`,
};

/** What a waited-for connect says, and its exit code: 0 once connected. */
async function afterWaiting(
  ctx: CommandContext,
  request: ConnectRequest,
  waited: Waited,
): Promise<Rendered & { readonly exitCode?: number }> {
  if (waited.kind === 'stopped') {
    return {
      stdout: '',
      stderr: `Stopped waiting. The link works until ${String(request.expiresAt)}; \`kindgi connections list --app=${request.app}\` shows the connection once it's made.\n`,
      exitCode: 130,
    };
  }
  if (waited.kind === 'expired') return { stdout: '', stderr: ENDED.expired(request), exitCode: 1 };
  const ended = waited.request;
  if (ended.state === 'connected') return await connected(ctx, ended);
  if (ended.state === 'declined' && ended.connectionId !== undefined) {
    return await connectedWithLess(ctx, ended, ended.connectionId);
  }
  // A state this CLI doesn't know yet still ends the wait, said as the server gave it.
  const said = (ENDED as Partial<Record<string, (r: ConnectRequest) => string>>)[ended.state];
  return {
    stdout: '',
    stderr: said?.(ended) ?? `The connect ended ${ended.state}: nothing connected.\n`,
    exitCode: 1,
  };
}

const connect: LeafCommand = {
  kind: 'leaf',
  name: 'connect',
  description:
    "Connect your account at an app (the company's with --for-company): prints the link to open, and at a terminal waits until the connect finishes and says whose account it is.",
  usage:
    'kindgi connections connect <app> [--app-id=<registration-id>] [--project=<project-id>] [--permissions=<key>,…] [--for-company]',
  optionSpec: {
    'app-id': {
      type: 'string',
      description: 'Which registration, when the tenant has more than one for the app.',
    },
    project: {
      type: 'string',
      description: "The project it's for; the registration must allow it.",
    },
    permissions: {
      type: 'string',
      description:
        "The entry's permission keys to ask for, comma-separated (`gmail.send,gmail.read`). Left out, it asks you at the terminal about each one the app's entry offers, none picked for you; without a terminal it's required.",
    },
    'for-company': {
      type: 'boolean',
      description: "Connect the company's account, not your own. Tenant admins only.",
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'connections connect', async () => {
      const app = requiredPositional(ctx, 0, 'app');
      const appId = stringFlag(ctx, 'app-id');
      const projectId = stringFlag(ctx, 'project');
      const permissions = await permissionsFor(ctx, app);
      if (permissions === undefined) {
        return {
          stdout: '',
          stderr: 'kindgi connections connect: no permission picked, so nothing was asked.\n',
          exitCode: 1,
        };
      }
      const request = await ctx.client().connections.connect({
        app,
        permissions,
        ...(appId !== undefined && { appId }),
        ...(projectId !== undefined && { projectId }),
        ...(ctx.options['for-company'] === true && { for: 'company' as const }),
      });
      if (ctx.globals.formatRequested) return renderJson(request, ctx.globals.format);
      const link = `Open this link to connect ${app}:\n  ${request.connectUrl}\n`;
      const seam = ctx.connectionsSeam ?? {};
      if (!(seam.interactive ?? isInteractive)()) {
        return { stdout: `${link}It works until ${String(request.expiresAt)}.\n`, stderr: '' };
      }
      (seam.progress ?? ((line: string) => process.stderr.write(line)))(
        `${link}Waiting for the connect to finish (Ctrl-C stops waiting; the link works until ${String(request.expiresAt)})…\n`,
      );
      return await afterWaiting(ctx, request, await waitForConnect(ctx, request));
    }),
};

/** What a removal did at the app, in words. */
export function withdrawnWords(withdrawn: Connection['withdrawn']): string {
  switch (withdrawn) {
    case 'at-app':
      return 'its access is withdrawn at the app and its token destroyed here';
    case 'app-failed':
      return 'the app refused to withdraw its access, so revoke it there too; its token is destroyed here';
    case 'kept-for-other-connection':
      return 'its token is destroyed here; the grant at the app stays, since another connection uses it';
    case 'not-supported':
      return "the app can't withdraw this connection alone, so revoke it there if it should go; its token is destroyed here";
    default:
      return 'its token is destroyed here';
  }
}

const disconnect: LeafCommand = {
  kind: 'leaf',
  name: 'disconnect',
  description:
    'Disconnect: withdraws the access at the app where it can, destroys the token, and prints what was done. Asks first, unless --yes.',
  usage: 'kindgi connections disconnect <connection-id> [--yes]',
  optionSpec: {
    yes: { type: 'boolean', description: "Don't ask first (for scripts)." },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'connections disconnect', async () => {
      const id = requiredPositional(ctx, 0, 'connection-id');
      const client = ctx.client();
      const ok = await confirmRemoval(ctx, 'connections disconnect', async () => {
        const c = await client.connections.get(id);
        const whose = c.owner.kind === 'company' ? "the company's account" : ownerWords(c);
        return `Disconnect ${c.account.label} at ${c.app} (${whose})? Tools that use it stop working until it's connected again.`;
      });
      if (ok.kind === 'refused') return { stdout: '', stderr: ok.stderr, exitCode: 1 };
      const c = await client.connections.disconnect(id);
      if (ctx.globals.formatRequested) return renderJson(c, ctx.globals.format);
      return {
        stdout: `Disconnected ${c.account.label} at ${c.app}: ${withdrawnWords(c.withdrawn)}.\n`,
        stderr: '',
      };
    }),
};

export const connectionsCommand: Command = {
  kind: 'group',
  name: 'connections',
  description:
    'Connections: accounts at other apps that tools act with (list / get / connect / disconnect).',
  subcommands: [list, get, connect, disconnect],
};
