// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi license` — a deployment renews its own license key, when you run
 * it: by hand, or from your own scheduler (cron, CI, a scheduled job).
 * Nothing calls Kindgi unless you run `renew`.
 *
 *   - `enroll --for <github login | em- id> --renewer <ref>`: once per deployment.
 *     Makes the renewer's key pair, keeps the private half at `<ref>` (it
 *     never leaves it, and is never printed), and prints the line to add on
 *     access.kindgi.com, signed in as the person it's for.
 *   - `renew --key <ref> | --env-file <path>  --renewer <ref>`: asks for the
 *     key's next version, checks it offline, and writes it only when it's
 *     new. With `--runtime`, a new key goes to the running server first,
 *     and an unchanged one to a server that runs an older key.
 *     One line by shape; exit 1 when refused or failed, so a scheduler's
 *     alerting sees it.
 *
 * `<ref>`: `file:<path>`, `env-file:<path>#<NAME>`,
 * `gcp:projects/<project>/secrets/<name>`,
 * `azure:https://<vault>.vault.azure.net/secrets/<name>`,
 * `aws:<region>:<name>` (`license/stores.ts`).
 */

import { KindgiApiError } from '@kindgi/client';
import { bearerValueProblem } from '@kindgi/types';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { isSelfServe, warnDaysOf } from '../license/expiry.js';
import type { LicenseClaims } from '../license/license-key.js';
import {
  KINDGI_ACCESS_ORIGIN,
  type RenewalUsage,
  decodeRenewerPrivateKey,
  encodeRenewerPrivateKey,
  enrollLine,
  generateRenewerKey,
} from '../license/protocol.js';
import {
  type CountsSent,
  PRODUCTION_NO_COUNTS,
  type PushAnswer,
  type RuntimeTook,
  networkReason,
  renewLicense,
} from '../license/renew.js';
import {
  SecretRefError,
  type SecretStore,
  runCloudCli,
  secretStoreFor,
} from '../license/stores.js';
import { type Rendered, renderJson } from '../output.js';
import { type SaidLine, note, renderLines, warning } from '../progress-lines.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { CommandResult, GroupCommand, LeafCommand } from './types.js';

/**
 * A GitHub login: letters, digits and single hyphens, up to 39. An email
 * user's `em-` id (`em-` and 26 base32 characters) has the same form.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Who `--for` names: the account on access.kindgi.com the enroll line is for. */
const FOR_WHOM = 'your GitHub login, or the em- id your key page shows';
const DAY_MS = 86_400_000;

function store(ctx: CommandContext, flag: string, ref: string): SecretStore {
  try {
    return secretStoreFor(ref, {
      cwd: ctx.cwd,
      cloud: { fetch: ctx.fetch, env: ctx.env, run: runCloudCli },
    });
  } catch (cause) {
    if (cause instanceof SecretRefError) throw new UsageError(`--${flag}: ${cause.message}`);
    throw cause;
  }
}

/** `--access-url`: https, or http to this machine (a local instance); access.kindgi.com by default. */
export function accessOrigin(ctx: CommandContext): string {
  const raw = stringFlag(ctx, 'access-url') ?? KINDGI_ACCESS_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--access-url must be a URL. Got "${raw}".`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.pathname !== '/') {
    throw new UsageError(
      `--access-url must be the service's origin over https (http only on this machine), like ${KINDGI_ACCESS_ORIGIN}. Got "${raw}".`,
    );
  }
  return url.origin;
}

/**
 * `--runtime <url>` with `--runtime-token <ref>`: the deployment's runtime (its
 * URL, as `KINDGI_API_URL` gives it) and where a token for it is kept (a
 * system key holding `system:license`, or its own token), to read its use
 * since the current key was issued (`GET /v1/license/usage`), to hand it a
 * new key before it's written (`PUT /v1/license`), and to see whether it
 * runs an older key than the one kept (`GET /v1/license`). Both or neither.
 * Neither value is printed: a URL can hold credentials, and a reference
 * given wrong can be the token itself.
 */
function runtimeOf(ctx: CommandContext):
  | {
      readonly usage: (since: Date) => Promise<RenewalUsage>;
      readonly push: (key: string) => Promise<PushAnswer>;
      readonly running: () => Promise<Date | undefined>;
    }
  | undefined {
  const runtime = stringFlag(ctx, 'runtime');
  const tokenRef = stringFlag(ctx, 'runtime-token');
  if ((runtime === undefined) !== (tokenRef === undefined)) {
    throw new UsageError(
      'Give --runtime <url> and --runtime-token <ref> together: the runtime, and where a token for it is kept (a system key holding system:license, or its own KINDGI_API_TOKEN).',
    );
  }
  if (runtime === undefined || tokenRef === undefined) return undefined;
  const base = runtimeBase(runtime);
  const tokens = store(ctx, 'runtime-token', tokenRef);
  const client = async () => {
    const token = (await tokens.read())?.trim();
    if (token === undefined || token === '') {
      throw new Error(`there's no token in ${tokens.describe}`);
    }
    // Checked before it's sent: fetch's own error would quote it.
    const problem = bearerValueProblem(token);
    if (problem !== undefined) {
      throw new Error(
        `the token in ${tokens.describe} can't be sent in a header: it has ${problem}`,
      );
    }
    return ctx.clientFor(base, token);
  };
  return {
    async usage(since) {
      const api = await client();
      try {
        return await api.license.usage({ since });
      } catch (cause) {
        throw new Error(usageProblem(base, cause));
      }
    },
    async push(key) {
      let api: Awaited<ReturnType<typeof client>>;
      try {
        api = await client();
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        return { kind: 'not-handed', said: `${base} wasn't asked (${why})` };
      }
      try {
        await api.license.replace({ key });
        return { kind: 'taken' };
      } catch (cause) {
        return pushAnswer(base, cause);
      }
    },
    // Can't say, for any reason: nothing is handed over on its word.
    async running() {
      try {
        const api = await client();
        const { expiresAt } = await api.license.get();
        const at = expiresAt === undefined ? undefined : new Date(expiresAt);
        return at === undefined || Number.isNaN(at.getTime()) ? undefined : at;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * What the runtime said to a key handed to it: refused it (its own check),
 * can't take one (no `PUT /v1/license`: its own token gets a 404, and its
 * system keys reach only the license's reads), or wasn't handed it.
 */
function pushAnswer(runtime: string, cause: unknown): PushAnswer {
  if (!(cause instanceof KindgiApiError)) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return { kind: 'not-handed', said: `${runtime} couldn't be asked (${why})` };
  }
  const error = cause.error;
  const serverCode = 'serverCode' in error ? error.serverCode : undefined;
  if (serverCode === 'license-key-refused') {
    return { kind: 'refused', error: serverCode, message: error.message };
  }
  if (error.code === 'not-found' || serverCode === 'system-key-on-tenant-route') {
    return {
      kind: 'absent',
      said: `${runtime} has no PUT /v1/license`,
    };
  }
  if (error.code === 'network' && error.cause instanceof SyntaxError) {
    return {
      kind: 'not-handed',
      said: `${runtime} answered, but not as a runtime: a page from a proxy or another server, perhaps`,
    };
  }
  if (error.code === 'network') {
    const why = error.timeoutMs !== undefined ? 'no answer in time' : networkReason(error.cause);
    return { kind: 'not-handed', said: `${runtime} couldn't be asked (${why})` };
  }
  return { kind: 'not-handed', said: `${runtime} answered: ${error.message}` };
}

/** What the runtime made of a new key handed to it, as a line. */
function runtimeLine(
  runtime: RuntimeTook | undefined,
  needsRuntime: string | undefined,
): SaidLine[] {
  if (runtime === undefined) {
    return [
      note(
        needsRuntime === undefined
          ? 'The runtime uses the new key from its next start; until then it runs on the one it started with.'
          : `The runtime uses the new key from its next start, and needs to be ${needsRuntime} or later to start with it; until then it runs on the one it started with.`,
      ),
    ];
  }
  if (runtime.kind === 'taken') return [note('The runtime took the new key: it runs it now.')];
  return [
    warning(
      `⚠ The runtime didn't take the new key (${runtime.said}): it uses it from its next start; until then it runs on the one it started with.`,
    ),
  ];
}

/**
 * What the runtime made of the unchanged key, handed to it because it ran
 * one that expires earlier, as a line; none when it wasn't handed it.
 */
function handedOverLine(runtime: RuntimeTook | undefined, kept: string): SaidLine[] {
  if (runtime === undefined) return [];
  if (runtime.kind === 'taken') {
    return [
      note(
        `The runtime ran an older key than the one in ${kept}: it took that one, and runs it now.`,
      ),
    ];
  }
  return [
    warning(
      `⚠ The runtime runs an older key than the one in ${kept}, and didn't take it (${runtime.said}): it uses it from its next start.`,
    ),
  ];
}

/** `--runtime`: an http(s) URL with no credentials in it, as its origin and path. */
function runtimeBase(raw: string): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new UsageError(
      "--runtime must be the runtime's http(s) URL as KINDGI_API_URL gives it, with no credentials in it, like https://kindgi.acme.example.",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Why the runtime gave no counts, in a line: no answer, an answer without the route or not JSON, or its refusal. */
function usageProblem(runtime: string, cause: unknown): string {
  if (cause instanceof KindgiApiError) {
    const error = cause.error;
    // A 200 whose body isn't JSON (the client's `network` error, its cause
    // the parser's): an auth proxy's sign-in page, say. Never quoted.
    if (error.code === 'network' && error.cause instanceof SyntaxError) {
      return `${runtime} answered, but not with counts: a page from a proxy or another server, perhaps`;
    }
    if (error.code === 'network') {
      const why = error.timeoutMs !== undefined ? 'no answer in time' : networkReason(error.cause);
      return `${runtime} couldn't be asked (${why})`;
    }
    if (error.code === 'not-found') {
      return `${runtime} answered 404: it doesn't report its use (GET /v1/license/usage)`;
    }
    return `${runtime} answered: ${error.message}`;
  }
  return `${runtime} couldn't be asked (${cause instanceof Error ? cause.message : String(cause)})`;
}

/**
 * The counts line, when a runtime was asked. The Azure module's counts alert
 * reads it, leaving out the production key's reason: the tests run renew
 * against that query (deploy/azure-container-apps/license-renewal.tf). Not
 * sent is a warning, as that alert fires on it; the production key's reason
 * is how every such renewal goes, so a note.
 */
function countsLine(counts: CountsSent | undefined): SaidLine[] {
  if (counts === undefined) return [];
  if (!counts.sent) {
    const line = `counts: not sent (${counts.reason}); this renewal goes without them.`;
    return [counts.reason === PRODUCTION_NO_COUNTS ? note(line) : warning(line)];
  }
  const u = counts.usage;
  const production =
    u.projectsInProduction === undefined ? '' : `, ${u.projectsInProduction} in production`;
  return [
    note(
      `counts: sent (${u.runs} runs, ${u.people} people${production} since ${day(new Date(u.since))}, runtime ${u.runtimeVersion})`,
    ),
  ];
}

/**
 * What a license command prints. With no format asked for, its lines on
 * stdout, as ever: the Azure module's alerts read renew's there. With
 * `--json`, `--raw` or `--table`, the result as JSON on stdout and the
 * lines on stderr. Under `--quiet` (which wins over the others), the
 * warnings alone on stderr, and on stdout only `shown`: what the command
 * is for, when there's one.
 */
function licenseRendered(
  ctx: CommandContext,
  result: unknown,
  lines: readonly SaidLine[],
  shown?: string,
): Rendered {
  const { format, formatRequested } = ctx.globals;
  if (!formatRequested) return { stdout: renderLines(lines, false), stderr: '' };
  if (format === 'quiet') {
    return { stdout: shown === undefined ? '' : `${shown}\n`, stderr: renderLines(lines, true) };
  }
  return { stdout: renderJson(result, format).stdout, stderr: renderLines(lines, false) };
}

function required(ctx: CommandContext, flag: string, what: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new UsageError(`--${flag} is required: ${what}.`);
  return value;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

const enroll: LeafCommand = {
  kind: 'leaf',
  name: 'enroll',
  description:
    'Enroll this deployment to renew its license key: makes its renewer key (kept at --renewer, never printed) and prints the line to add on access.kindgi.com.',
  usage:
    'kindgi license enroll --for <github login | em- id> --renewer <ref> [--access-url <origin>] [--replace]',
  optionSpec: {
    for: {
      type: 'string',
      description:
        'Your GitHub login, or the em- id your key page shows: the line is for it alone.',
    },
    renewer: {
      type: 'string',
      description:
        "Where to keep the renewer's private key: file:<path>, env-file:<path>#<NAME>, gcp:…, azure:…, aws:….",
    },
    'access-url': {
      type: 'string',
      description: 'Another instance of the service (default https://access.kindgi.com).',
    },
    replace: {
      type: 'boolean',
      description:
        'Make a new renewer key even if --renewer already holds one (the old one stops working once you add the new line).',
    },
  },
  async run(ctx): Promise<CommandResult> {
    try {
      const login = required(ctx, 'for', FOR_WHOM);
      if (!GITHUB_LOGIN.test(login))
        throw new UsageError(`--for must be ${FOR_WHOM}. Got "${login}".`);
      const renewerRef = required(ctx, 'renewer', "where to keep the renewer's private key");
      const origin = accessOrigin(ctx);
      const where = store(ctx, 'renewer', renewerRef);
      const existing = await where.read();
      const kept = existing === undefined ? undefined : decodeRenewerPrivateKey(existing);
      if (existing !== undefined && kept === undefined && ctx.options.replace !== true) {
        throw new UsageError(
          `${where.describe} already holds something that isn't a renewer key: name another place, or pass --replace to overwrite it.`,
        );
      }
      const reuse = kept !== undefined && ctx.options.replace !== true;
      const key = reuse ? kept : generateRenewerKey();
      if (!reuse) await where.write(encodeRenewerPrivateKey(key));
      const line = enrollLine(key, login, origin);
      const renewCommand = `kindgi license renew --key <where the license key is> --renewer ${renewerRef}${origin === KINDGI_ACCESS_ORIGIN ? '' : ` --access-url ${origin}`}`;
      const lines = [
        `Renewer ${key.renewerId}: its private key is ${reuse ? 'already ' : ''}in ${where.describe}.`,
        '',
        `Add this deployment on ${origin}, signed in as the person it's for (${login}), under "Renew the key from your deployment":`,
        '',
        `  ${line}`,
        '',
        'Then renew the key whenever you like, by hand or on your own schedule:',
        '',
        `  ${renewCommand}`,
      ].map(note);
      const result = {
        renewerId: key.renewerId,
        renewer: renewerRef,
        changed: !reuse,
        overwritten: !reuse && existing !== undefined,
        login,
        accessUrl: origin,
        enrollLine: line,
        nextSteps: [renewCommand],
      };
      // The enroll line is what enroll is for: under --quiet, it alone.
      return { kind: 'ok', rendered: licenseRendered(ctx, result, lines, line) };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'license enroll');
    }
  },
};

function describeKey(claims: LicenseClaims): string {
  return `${claims.name}'s ${claims.use} key, until ${day(claims.expiresAt)}`;
}

const renew: LeafCommand = {
  kind: 'leaf',
  name: 'renew',
  description:
    "Renew this deployment's license key: asks access.kindgi.com for the next one, checks it offline, and writes it only when it's new.",
  usage:
    'kindgi license renew (--key <ref> | --env-file <path>) --renewer <ref> [--runtime <url> --runtime-token <ref>] [--access-url <origin>]',
  optionSpec: {
    key: {
      type: 'string',
      description:
        'Where the license key is kept, and the new one goes: file:…, env-file:…#NAME, gcp:…, azure:…, aws:….',
    },
    'env-file': {
      type: 'string',
      description: 'Shorthand for --key env-file:<path>#KINDGI_LICENSE_KEY (a kindgi.env).',
    },
    renewer: {
      type: 'string',
      description: "Where the renewer's private key is (as enroll was given).",
    },
    'access-url': {
      type: 'string',
      description: 'Another instance of the service (default https://access.kindgi.com).',
    },
    runtime: {
      type: 'string',
      description:
        "This deployment's runtime, reached with --runtime-token: the renewal carries its use since the current key was issued (counts only), a new key goes to it before it's written, and an unchanged one goes to it when it runs an older key.",
    },
    'runtime-token': {
      type: 'string',
      description:
        'Where a token for the runtime is kept, a system key holding system:license or its own (KINDGI_API_TOKEN): file:…, env-file:…#NAME, gcp:…, azure:…, aws:….',
    },
  },
  async run(ctx): Promise<CommandResult> {
    try {
      const runtime = runtimeOf(ctx);
      const keyFlag = stringFlag(ctx, 'key');
      const envFile = stringFlag(ctx, 'env-file');
      if ((keyFlag === undefined) === (envFile === undefined)) {
        throw new UsageError(
          'Give --key <ref> or --env-file <path> (one of them): where the license key is.',
        );
      }
      const keyRef = keyFlag ?? `env-file:${envFile}#KINDGI_LICENSE_KEY`;
      const renewerRef = required(
        ctx,
        'renewer',
        "where the renewer's private key is (as enroll was given)",
      );
      const origin = accessOrigin(ctx);
      const keyStore = store(ctx, 'key', keyRef);
      const outcome = await renewLicense(
        {
          key: keyStore,
          renewer: store(ctx, 'renewer', renewerRef),
          origin,
          ...(runtime !== undefined && {
            usage: runtime.usage,
            push: runtime.push,
            running: runtime.running,
          }),
        },
        { fetch: ctx.fetch, ...(ctx.licenseDeps?.renew ?? {}) },
      );
      if (outcome.kind === 'refused') {
        return {
          kind: 'error',
          // An error keeps every line, under --quiet too.
          stderr: [
            ...countsLine(outcome.counts).map((l) => l.text),
            `refused (${outcome.error}): ${outcome.message}`,
          ]
            .map((l) => `${l}\n`)
            .join(''),
          exitCode: 1,
        };
      }
      if (outcome.kind === 'failed')
        return { kind: 'error', stderr: `${outcome.message}\n`, exitCode: 1 };
      const now = (ctx.licenseDeps?.renew?.now ?? Date.now)();
      const daysLeft = Math.floor((outcome.claims.expiresAt.getTime() - now) / DAY_MS);
      // A key Kindgi issued is renewed when Kindgi extends its term; a
      // self-serve one, in its last 30 days. By its subject, as `kindgi
      // doctor` and the runtime's banner tell them apart (`isSelfServe`).
      // A sign-in leaves a key this deployment renews to it, so the renewer
      // is stopped first (the page's "Renew the key from your deployment").
      const nextKey = isSelfServe(outcome.claims.subject)
        ? `stop this deployment's renewer at ${origin}, then sign in there for a new key`
        : 'write to contact@kindgi.com to extend the term';
      const expiring = `It expires in ${daysLeft} days. If renew keeps answering unchanged, ${nextKey}.`;
      const lines = [
        note(`${outcome.kind}: ${describeKey(outcome.claims)} (renewer ${outcome.renewerId})`),
        ...countsLine(outcome.counts),
        ...(outcome.kind === 'renewed'
          ? runtimeLine(outcome.runtime, outcome.needsRuntime)
          : handedOverLine(outcome.runtime, keyStore.describe)),
        ...(daysLeft <= warnDaysOf(outcome.claims)
          ? // The Azure module's expiring alert reads this line's days: the tests
            // run renew against its query (deploy/azure-container-apps).
            [warning(`⚠ ${expiring}`)]
          : []),
      ];
      const result = {
        status: outcome.kind,
        renewerId: outcome.renewerId,
        // daysLeft is negative once it has expired, as the ⚠ line says it.
        license: {
          name: outcome.claims.name,
          use: outcome.claims.use,
          expiresAt: outcome.claims.expiresAt.toISOString(),
          daysLeft,
        },
        ...(outcome.counts !== undefined && { counts: outcome.counts }),
        ...(outcome.runtime !== undefined && { runtime: outcome.runtime }),
        ...(outcome.needsRuntime !== undefined && { needsRuntime: outcome.needsRuntime }),
        warnings: lines.filter((l) => l.problem).map((l) => l.text.replace(/^⚠ /, '')),
      };
      return { kind: 'ok', rendered: licenseRendered(ctx, result, lines) };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'license renew');
    }
  },
};

export const licenseCommand: GroupCommand = {
  kind: 'group',
  name: 'license',
  description:
    'Your Kindgi license key: enroll a deployment once, then renew its key when you run renew (by hand or on your own schedule).',
  subcommands: [enroll, renew],
};
