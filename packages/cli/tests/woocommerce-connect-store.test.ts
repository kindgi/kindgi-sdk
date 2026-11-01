// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/cli/src/templates/**

/**
 * The woocommerce starter's `connect-store` script, run as a person runs it,
 * against a WordPress in memory and a `kindgi` that records what it's asked:
 * the store's owner approves, and the script makes the agent's user and
 * password, saves them in Kindgi and revokes the approval's own password.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
  const out = await runCli({
    argv: ['init', 'acme-shop', '--template=woocommerce'],
    env: {},
    cwd,
    home,
    initSeam: { pnpmVersion: async () => '10.28.0', packageManagerRuns: async () => true },
  });
  expect(out.exitCode, out.stderr).toBe(0);
  root = join(cwd, 'acme-shop');
  await installFakeKindgi(root);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

// --- a `kindgi` that records each call --------------------------------------

/**
 * The pack's `@kindgi/cli`, standing in: it records each call's arguments
 * and stdin, keeps what was set, and refuses a change or a second secret in
 * the real CLI's words (pinned in env-project-target.test.ts and
 * secrets.test.ts). `FAKE_KINDGI_REFUSES` refuses each call it matches, a
 * pattern on the call's arguments (`.` for every call, `^env set WOO_USER `
 * for one), as a CLI that isn't signed in does.
 */
async function installFakeKindgi(packRoot: string): Promise<void> {
  const dir = join(packRoot, 'node_modules', '@kindgi', 'cli');
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@kindgi/cli',
      type: 'module',
      bin: { kindgi: './dist/cli.js' },
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(join(dir, 'dist', 'index.js'), 'export {};\n');
  await writeFile(
    join(dir, 'dist', 'cli.js'),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const refuses = process.env.FAKE_KINDGI_REFUSES;
if (refuses !== undefined && new RegExp(refuses).test(argv.join(' '))) {
  process.stderr.write('Error [auth]: Bearer token is not recognized\\n');
  process.exit(1);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(process.env.FAKE_KINDGI_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + '\\n');
const path = process.env.FAKE_KINDGI_STATE;
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { env: {}, secrets: {} };
const flag = (name) => argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const where = flag('scope') + ' in env ' + flag('env');
if (argv[0] === 'env' && argv[1] === 'set') {
  const [, , key, value] = argv;
  const was = state.env[where + ' ' + key];
  if (was !== undefined && was !== value && !argv.includes('--force')) {
    process.stderr.write('kindgi env set refuses to change ' + key + ', already set at ' + where + ' to "' + was + '". Re-run with --force to replace it.\\n');
    process.exit(1);
  }
  state.env[where + ' ' + key] = value;
} else if (argv[0] === 'secrets' && argv[1] === 'set') {
  const versions = state.secrets[where + ' ' + argv[2]] ?? [];
  if (versions.length > 0 && !argv.includes('--write-mode=add-version')) {
    process.stderr.write('Version conflict: ' + argv[2] + ' already exists (version ' + versions.length + '). To store a new version, retry with --write-mode=add-version.\\n');
    process.exit(1);
  }
  state.secrets[where + ' ' + argv[2]] = [...versions, stdin];
} else if (argv[0] === 'env' && argv[1] === 'list') {
  // A read: nothing changes.
} else {
  process.stderr.write('fake kindgi: no ' + argv.join(' ') + '\\n');
  process.exit(2);
}
writeFileSync(path, JSON.stringify(state));
`,
  );
}

interface KindgiCall {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
}

async function kindgiCalls(): Promise<KindgiCall[]> {
  const raw = await readFile(join(cwd, 'kindgi.log'), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as KindgiCall);
}

async function kindgiState(): Promise<{
  env: Record<string, string>;
  secrets: Record<string, string[]>;
}> {
  return JSON.parse(await readFile(join(cwd, 'kindgi-state.json'), 'utf8'));
}

// --- a WordPress with WooCommerce, in memory --------------------------------

interface AppPassword {
  readonly uuid: string;
  readonly app_id: string;
  readonly name: string;
  readonly password: string;
}

interface WpUser {
  readonly id: number;
  readonly slug: string;
  readonly email: string;
  readonly roles: string[];
  readonly passwords: AppPassword[];
}

interface Store {
  readonly url: string;
  readonly users: WpUser[];
  /** The users WooCommerce answered, by the password they signed in with. */
  readonly wooSignIns: string[];
  /** What the store refuses from now on: deleting a user's Application Password. */
  readonly refuse: { agentDeletes: boolean };
  close(): Promise<void>;
}

interface Request {
  readonly method: string;
  readonly url: URL;
  readonly body: Record<string, unknown>;
  readonly match: RegExpMatchArray;
  /** Who signed in, with which of their Application Passwords. */
  readonly who: { readonly user: WpUser; readonly used: AppPassword };
}

/** A route's answer: its status and JSON body. */
type Answer = readonly [number, unknown];

const NOT_ALLOWED: Answer = [
  403,
  { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.' },
];

async function startStore(
  opts: {
    applicationPasswords?: boolean;
    woocommerce?: boolean;
    /** WooCommerce answers a sign-in only once this settles. */
    hold?: Promise<void>;
  } = {},
): Promise<Store> {
  const users: WpUser[] = [
    { id: 1, slug: 'owner', email: 'owner@example.com', roles: ['administrator'], passwords: [] },
  ];
  const wooSignIns: string[] = [];
  const refuse = { agentDeletes: false };
  const shown = (p: AppPassword) => ({ uuid: p.uuid, app_id: p.app_id, name: p.name });
  const isAdmin = (u: WpUser) => u.roles.includes('administrator');
  const remove = (list: AppPassword[], uuid: string | undefined): Answer => {
    list.splice(
      list.findIndex((p) => p.uuid === uuid),
      1,
    );
    return [200, { deleted: true }];
  };
  const ofUser = (r: Request) => users.find((u) => u.id === Number(r.match[1]));

  // The routes a signed-in user reaches, as WordPress and WooCommerce answer them.
  const routes: readonly [string, RegExp, (r: Request) => Answer | Promise<Answer>][] = [
    [
      'GET',
      /^wc\/v3\/orders$/,
      async (r) => {
        if (!isAdmin(r.who.user) && !r.who.user.roles.includes('shop_manager')) return NOT_ALLOWED;
        wooSignIns.push(r.who.used.password);
        await opts.hold;
        return [200, []];
      },
    ],
    [
      'GET',
      /^wp\/v2\/users\/me$/,
      (r) => [
        200,
        {
          id: r.who.user.id,
          slug: r.who.user.slug,
          email: r.who.user.email,
          capabilities: isAdmin(r.who.user) ? { create_users: true, promote_users: true } : {},
        },
      ],
    ],
    [
      'GET',
      /^wp\/v2\/users\/me\/application-passwords\/introspect$/,
      (r) => [200, shown(r.who.used)],
    ],
    [
      'GET',
      /^wp\/v2\/users\/me\/application-passwords$/,
      (r) => [200, r.who.user.passwords.map(shown)],
    ],
    [
      'DELETE',
      /^wp\/v2\/users\/me\/application-passwords\/([\w-]+)$/,
      (r) => remove(r.who.user.passwords, r.match[1]),
    ],
    [
      'GET',
      /^wp\/v2\/users$/,
      (r) => {
        if (!isAdmin(r.who.user)) return NOT_ALLOWED;
        const slug = r.url.searchParams.get('slug');
        return [200, users.filter((u) => u.slug === slug).map(({ passwords: _, ...u }) => u)];
      },
    ],
    [
      'POST',
      /^wp\/v2\/users$/,
      (r) => {
        if (!isAdmin(r.who.user)) return NOT_ALLOWED;
        if (users.some((u) => u.email === r.body.email)) {
          return [
            400,
            { code: 'existing_user_email', message: 'Sorry, that email address is already used!' },
          ];
        }
        const made: WpUser = {
          id: users.length + 1,
          slug: String(r.body.username),
          email: String(r.body.email),
          roles: r.body.roles as string[],
          passwords: [],
        };
        users.push(made);
        return [201, { id: made.id, slug: made.slug, roles: made.roles }];
      },
    ],
    [
      'GET',
      /^wp\/v2\/users\/(\d+)\/application-passwords$/,
      (r) => (isAdmin(r.who.user) ? [200, ofUser(r)!.passwords.map(shown)] : NOT_ALLOWED),
    ],
    [
      'POST',
      /^wp\/v2\/users\/(\d+)\/application-passwords$/,
      (r) => {
        if (!isAdmin(r.who.user)) return NOT_ALLOWED;
        const made = newPassword(String(r.body.app_id), String(r.body.name));
        ofUser(r)!.passwords.push(made);
        return [201, { ...shown(made), password: made.password }];
      },
    ],
    [
      'DELETE',
      /^wp\/v2\/users\/(\d+)\/application-passwords\/([\w-]+)$/,
      (r) => {
        if (!isAdmin(r.who.user)) return NOT_ALLOWED;
        if (refuse.agentDeletes) {
          return [
            500,
            {
              code: 'rest_cannot_delete_application_password',
              message: 'Could not delete the application password.',
            },
          ];
        }
        return remove(ofUser(r)!.passwords, r.match[2]);
      },
    ],
  ];

  const signedIn = (header: string | undefined) => {
    if (!header?.startsWith('Basic ')) return undefined;
    const [login, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    const user = users.find((u) => u.slug === login);
    const used = user?.passwords.find((p) => p.password === password);
    return user && used ? { user, used } : undefined;
  };

  /** The REST index: what it offers, and where its Authorize Application page is. */
  const index = (host: string): Answer => [
    200,
    {
      namespaces: ['wp/v2', ...(opts.woocommerce === false ? [] : ['wc/v3'])],
      authentication:
        opts.applicationPasswords === false
          ? []
          : {
              'application-passwords': {
                endpoints: { authorization: `http://${host}/wp-admin/authorize-application.php` },
              },
            },
    },
  ];

  const answer = async (req: IncomingMessage): Promise<Answer> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname.replace(/^\/wp-json\/?/, '');
    if (path === '') return index(req.headers.host ?? '');
    const who = signedIn(req.headers.authorization);
    if (who === undefined) {
      return [401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.' }];
    }
    const body = await readBody(req);
    for (const [method, pattern, handle] of routes) {
      const match = path.match(pattern);
      if (method === req.method && match !== null) {
        return handle({ method, url, body, match, who });
      }
    }
    return [404, { code: 'rest_no_route', message: 'No route was found.' }];
  };

  const server: Server = createServer((req, res) => {
    void answer(req).then(([status, body]) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    users,
    wooSignIns,
    refuse,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function newPassword(appId: string, name: string): AppPassword {
  return {
    uuid: randomUUID(),
    app_id: appId,
    name,
    password: randomBytes(18).toString('base64url'),
  };
}

/**
 * What WordPress's Authorize Application page does when `login` approves:
 * a new Application Password for that user, sent to the success URL.
 */
async function approve(store: Store, link: URL, login = 'owner'): Promise<string> {
  const user = store.users.find((u) => u.slug === login)!;
  const made = newPassword(link.searchParams.get('app_id')!, link.searchParams.get('app_name')!);
  user.passwords.push(made);
  const back = new URL(link.searchParams.get('success_url')!);
  back.searchParams.set('site_url', store.url);
  back.searchParams.set('user_login', login);
  back.searchParams.set('password', made.password);
  return (await fetch(back)).text();
}

async function decline(link: URL): Promise<string> {
  const back = new URL(link.searchParams.get('reject_url')!);
  back.searchParams.set('success', 'false');
  return (await fetch(back)).text();
}

// --- the script, run as a person runs it ------------------------------------

interface Run {
  /** The approval link, once the script prints it. */
  readonly link: Promise<URL>;
  readonly done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  readonly child: ChildProcess;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
});

function connectStore(args: readonly string[], env: Record<string, string> = {}): Run {
  // As a person's shell runs it: pnpm's own bin shims (vitest's) set
  // NODE_PATH, which would find a @kindgi/cli outside the pack.
  const { NODE_PATH: _, ...inherited } = process.env;
  const child = spawn(process.execPath, [join(root, 'scripts', 'connect-store.mjs'), ...args], {
    cwd: root,
    env: {
      ...inherited,
      FAKE_KINDGI_LOG: join(cwd, 'kindgi.log'),
      FAKE_KINDGI_STATE: join(cwd, 'kindgi-state.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  let found: (url: URL) => void = () => {};
  const link = new Promise<URL>((resolve) => {
    found = resolve;
  });
  child.stdout.on('data', (d) => {
    stdout += d;
    const line = /^ {2}(http\S+)$/m.exec(stdout);
    if (line) found(new URL(line[1]!));
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr })),
  );
  return { link, done, child };
}

const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});
async function store(opts?: Parameters<typeof startStore>[0]): Promise<Store> {
  const s = await startStore(opts);
  stores.push(s);
  return s;
}
const agentOf = (s: Store) => s.users.find((u) => u.slug === 'kindgi-agent')!;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the woocommerce starter's connect-store", () => {
  test("the owner's approval connects the store: Kindgi's own Shop Manager, its own password, saved in Kindgi", async () => {
    const shop = await store();
    const run = connectStore([shop.url, '--no-browser']);
    const link = await run.link;
    expect(link.origin + link.pathname).toBe(`${shop.url}/wp-admin/authorize-application.php`);
    expect(link.searchParams.get('app_name')).toBe('Kindgi (acme-shop, local)');
    expect(link.searchParams.get('app_id')).toMatch(UUID);
    expect(link.searchParams.get('success_url')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/approved\?state=/,
    );
    const page = await approve(shop, link);
    const { code, stdout, stderr } = await run.done;
    expect(code, stderr).toBe(0);
    expect(page).toContain('<h1 style="font-size:1.4rem">Connected</h1>');

    const agent = shop.users.find((u) => u.slug === 'kindgi-agent')!;
    expect(agent.roles).toEqual(['shop_manager']);
    expect(agent.email).toBe('owner+kindgi-agent@example.com');
    expect(agent.passwords.map((p) => [p.name, p.app_id])).toEqual([
      ['Kindgi (acme-shop, local)', link.searchParams.get('app_id')],
    ]);
    const password = agent.passwords[0]!.password;
    // It checked the agent's own password on WooCommerce, and the owner's is gone.
    expect(shop.wooSignIns).toEqual([password]);
    expect(shop.users.find((u) => u.slug === 'owner')!.passwords).toEqual([]);

    const calls = await kindgiCalls();
    expect(calls.map((c) => c.argv)).toEqual([
      // Read before the approval, on the same target.
      ['env', 'list', '--env=local', '--scope=tenant'],
      // The password first, so the store's address never names a store whose password Kindgi lacks.
      ['secrets', 'set', 'WOO_APP_PASSWORD', '--env=local', '--scope=tenant', '--from-stdin'],
      ['env', 'set', 'WOO_STORE_URL', shop.url, '--env=local', '--scope=tenant'],
      ['env', 'set', 'WOO_USER', 'kindgi-agent', '--env=local', '--scope=tenant'],
    ]);
    // Run in the pack, the password on stdin and never in an argument or the output.
    const pack = await realpath(root);
    expect(calls.map((c) => c.cwd)).toEqual([pack, pack, pack, pack]);
    expect(calls[1]!.stdin).toBe(password);
    expect(JSON.stringify(calls.map((c) => c.argv))).not.toContain(password);
    expect(stdout + stderr).not.toContain(password);
    expect(stdout).toContain("✓ Revoked owner's approval password.");
    expect(stdout).toContain(
      'Connected. Try the store agent: pnpm exec kindgi runs start --agent=acme-shop.store-agent',
    );
    // Before 7.0, WordPress sends the approval to 127.0.0.1 only on a local
    // site; the wait says what wp-admin shows then, and what to do.
    expect(stdout).toContain(
      `Waiting for the approval (5 minutes at most)…\nIf wp-admin says the URL must be served over a secure connection, the store's WordPress is older than 7.0: connect it by hand, as the README's "Connect it by hand" says (Ctrl-C stops this).\n`,
    );
  });

  test('connecting again replaces only its own password; a deploy gets one of its own', async () => {
    const shop = await store();
    let run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    expect((await run.done).code).toBe(0);
    const agent = shop.users.find((u) => u.slug === 'kindgi-agent')!;
    const first = agent.passwords[0]!;

    // The same store by another of its addresses: the old one is said.
    const other = shop.url.replace('127.0.0.1', 'localhost');
    run = connectStore([other, '--no-browser']);
    await approve(shop, await run.link);
    let out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(
      `Replaced: WOO_STORE_URL was "${shop.url}"; WOO_APP_PASSWORD gets a new version.`,
    );
    expect(out.stdout).toContain(
      "✓ Revoked the agent's password from the connect before (Kindgi (acme-shop, local)).",
    );
    // Another address may be another store, whose password only its owner can revoke.
    expect(out.stdout).toContain(
      `! WOO_STORE_URL named ${shop.url} before. If that's another store, this pack's password there still signs in: remove "Kindgi (acme-shop, local)" there, under Users → All Users → kindgi-agent → Application Passwords.`,
    );
    expect(agent.passwords).toHaveLength(1);
    expect(agent.passwords[0]!.uuid).not.toBe(first.uuid);
    const local = agent.passwords[0]!;

    // `npm run` needs `--` before the flags, and `pnpm` passes it along.
    run = connectStore([
      '--',
      shop.url,
      '--hosted',
      '--env=production',
      '--scope=project:p1',
      '--no-browser',
    ]);
    const link = await run.link;
    expect(link.searchParams.get('app_name')).toBe('Kindgi (acme-shop, production, project:p1)');
    expect(link.searchParams.get('app_id')).not.toBe(first.app_id);
    await approve(shop, link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(agent.passwords.map((p) => p.name)).toEqual([
      'Kindgi (acme-shop, local)',
      'Kindgi (acme-shop, production, project:p1)',
    ]);
    expect(agent.passwords[0]).toEqual(local);
    expect(out.stdout).toContain(
      "Connected: the pack's tools in production sign in to the store as kindgi-agent.",
    );

    const calls = (await kindgiCalls()).slice(-4).map((c) => c.argv);
    expect(calls[0]!.slice(0, 2)).toEqual(['env', 'list']);
    for (const argv of calls)
      expect(argv).toEqual(
        expect.arrayContaining(['--env=production', '--scope=project:p1', '--hosted']),
      );
    const state = await kindgiState();
    expect(state.secrets['tenant in env local WOO_APP_PASSWORD']).toEqual([
      first.password,
      local.password,
    ]);
    expect(state.secrets['project:p1 in env production WOO_APP_PASSWORD']).toEqual([
      agent.passwords[1]!.password,
    ]);

    // Another client's project, on the same store and env, keeps the first's.
    run = connectStore([
      '--',
      shop.url,
      '--hosted',
      '--env=production',
      '--scope=project:p2',
      '--no-browser',
    ]);
    await approve(shop, await run.link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(agent.passwords.map((p) => p.name)).toEqual([
      'Kindgi (acme-shop, local)',
      'Kindgi (acme-shop, production, project:p1)',
      'Kindgi (acme-shop, production, project:p2)',
    ]);
    expect(out.stdout).not.toContain('Revoked the agent');
  });

  test('a declined approval changes nothing', async () => {
    const shop = await store();
    const run = connectStore([shop.url, '--no-browser']);
    const page = await decline(await run.link);
    const { code, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain('The approval was declined in wp-admin. Nothing changed.');
    expect(page).toContain('Not connected');
    expect(shop.users.map((u) => u.slug)).toEqual(['owner']);
    // Only the read before the approval.
    expect((await kindgiCalls()).map((c) => c.argv)).toEqual([
      ['env', 'list', '--env=local', '--scope=tenant'],
    ]);
  });

  test.each([[['editor']], [['shop_manager', 'administrator']]])(
    "a kindgi-agent the store already has as %j is left alone, and the approval's password still goes",
    async (roles) => {
      const shop = await store();
      shop.users.push({
        id: 2,
        slug: 'kindgi-agent',
        email: 'k@example.com',
        roles: [...roles],
        passwords: [],
      });
      const run = connectStore([shop.url, '--no-browser']);
      const page = await approve(shop, await run.link);
      const { code, stdout, stderr } = await run.done;
      expect(code).toBe(1);
      // What can be done in wp-admin: a user's name can't be changed there.
      expect(stderr).toContain(
        `There's already a user named kindgi-agent, as ${roles.join(', ')}. Kindgi signs in as its own user of that name, a Shop Manager and nothing more, and wp-admin can't change a username. If it's Kindgi's, give it the Shop Manager role alone (Users → All Users → kindgi-agent → Role); if not, delete it there. Then run this again.`,
      );
      expect(page).toContain('Not connected');
      expect(shop.users[1]!.roles).toEqual(roles);
      expect(shop.users[1]!.passwords).toEqual([]);
      expect(shop.users[0]!.passwords).toEqual([]);
      expect(stdout).toContain("✓ Revoked owner's approval password");
      expect((await kindgiCalls()).map((c) => c.argv)).toEqual([
        ['env', 'list', '--env=local', '--scope=tenant'],
      ]);
    },
  );

  test('a kindgi that refuses is refused before any approval, in its own words', async () => {
    const shop = await store();
    const { code, stdout, stderr } = await connectStore([shop.url, '--no-browser'], {
      FAKE_KINDGI_REFUSES: '.',
    }).done;
    expect(code).toBe(1);
    expect(stderr).toContain(
      'kindgi env list --env=local --scope=tenant failed, so nothing was asked of the store:\nError [auth]: Bearer token is not recognized',
    );
    expect(stdout).not.toContain('authorize-application.php');
    expect(shop.users.map((u) => u.slug)).toEqual(['owner']);
    expect(shop.users[0]!.passwords).toEqual([]);
  });

  test('a switch to a store whose password Kindgi refuses leaves the store before connected: its address and its password', async () => {
    const first = await store();
    let run = connectStore([first.url, '--no-browser']);
    await approve(first, await run.link);
    expect((await run.done).code).toBe(0);
    const kept = await kindgiState();

    const shop = await store();
    run = connectStore([shop.url, '--no-browser'], { FAKE_KINDGI_REFUSES: '^secrets set ' });
    const page = await approve(shop, await run.link);
    const { code, stdout, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain(
      'kindgi secrets set WOO_APP_PASSWORD failed:\nError [auth]: Bearer token is not recognized',
    );
    expect(page).toContain('Not connected');
    // The store's address and the secret still belong to one store, the one before.
    expect(await kindgiState()).toEqual(kept);
    expect(kept.env['tenant in env local WOO_STORE_URL']).toBe(first.url);
    const agentBefore = first.users.find((u) => u.slug === 'kindgi-agent')!;
    expect(kept.secrets['tenant in env local WOO_APP_PASSWORD']).toEqual([
      agentBefore.passwords[0]!.password,
    ]);
    // Nobody else had the new store's password: it went, as did the approval's.
    expect(shop.users.find((u) => u.slug === 'kindgi-agent')!.passwords).toEqual([]);
    expect(shop.users[0]!.passwords).toEqual([]);
    expect(stdout).toContain("✓ Revoked owner's approval password.");
  });

  test("a switch whose address Kindgi can't save revokes the new password, so it signs in nowhere, and running again finishes", async () => {
    const first = await store();
    let run = connectStore([first.url, '--no-browser']);
    await approve(first, await run.link);
    expect((await run.done).code).toBe(0);

    // The password is saved; the address, asked to change, isn't.
    const shop = await store();
    run = connectStore([shop.url, '--no-browser'], {
      FAKE_KINDGI_REFUSES: '^env set WOO_STORE_URL .*--force',
    });
    const page = await approve(shop, await run.link);
    let out = await run.done;
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(
      `kindgi env set WOO_STORE_URL failed:\nError [auth]: Bearer token is not recognized\nKindgi couldn't save this store's address (WOO_STORE_URL still says "${first.url}"), so the store's new password is revoked: WOO_APP_PASSWORD's newest version is that revoked password, and the agent can't sign in until this runs again. Running this again once kindgi can set WOO_STORE_URL finishes the connect.`,
    );
    expect(page).toContain('Not connected');
    // The address still names the store before, and the newest password signs in to neither.
    const state = await kindgiState();
    expect(state.env['tenant in env local WOO_STORE_URL']).toBe(first.url);
    const versions = state.secrets['tenant in env local WOO_APP_PASSWORD']!;
    expect(versions).toHaveLength(2);
    expect(agentOf(shop).passwords).toEqual([]);
    expect(agentOf(first).passwords.map((p) => p.password)).toEqual([versions[0]]);
    expect(shop.users[0]!.passwords).toEqual([]);

    // Again: it finishes on the new store.
    run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    const now = await kindgiState();
    expect(now.env['tenant in env local WOO_STORE_URL']).toBe(shop.url);
    expect(agentOf(shop).passwords).toHaveLength(1);
    expect(now.secrets['tenant in env local WOO_APP_PASSWORD']!.at(-1)).toBe(
      agentOf(shop).passwords[0]!.password,
    );
  });

  test('once WOO_STORE_URL names the new store, a failure after it keeps the password, and running again finishes', async () => {
    const first = await store();
    let run = connectStore([first.url, '--no-browser']);
    await approve(first, await run.link);
    expect((await run.done).code).toBe(0);

    const shop = await store();
    run = connectStore([shop.url, '--no-browser'], { FAKE_KINDGI_REFUSES: '^env set WOO_USER ' });
    const page = await approve(shop, await run.link);
    let out = await run.done;
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(
      "kindgi env set WOO_USER failed:\nError [auth]: Bearer token is not recognized\nKindgi holds the store's new password (WOO_APP_PASSWORD) and its address (WOO_STORE_URL) now: the password stays in the store, and running this again once kindgi can set WOO_USER finishes the connect.",
    );
    expect(page).toContain('Not connected');
    const state = await kindgiState();
    expect(state.env['tenant in env local WOO_STORE_URL']).toBe(shop.url);
    expect(agentOf(shop).passwords.map((p) => p.password)).toEqual([
      state.secrets['tenant in env local WOO_APP_PASSWORD']!.at(-1),
    ]);
    expect(shop.users[0]!.passwords).toEqual([]);

    // Again: it finishes, and only its own password is left.
    run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(agentOf(shop).passwords).toHaveLength(1);
    expect((await kindgiState()).secrets['tenant in env local WOO_APP_PASSWORD']!.at(-1)).toBe(
      agentOf(shop).passwords[0]!.password,
    );
  });

  test("an agent's password the store won't revoke is said, for the person to remove", async () => {
    const shop = await store();
    let run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    expect((await run.done).code).toBe(0);
    const agent = shop.users.find((u) => u.slug === 'kindgi-agent')!;
    shop.refuse.agentDeletes = true;

    // Kindgi refuses the password, so the new one goes, or would.
    run = connectStore([shop.url, '--no-browser'], { FAKE_KINDGI_REFUSES: '^secrets set ' });
    await approve(shop, await run.link);
    let out = await run.done;
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(
      `! Couldn't revoke the agent's new password, the newest "Kindgi (acme-shop, local)" (HTTP 500). Remove it under Users → All Users → kindgi-agent → Application Passwords.`,
    );
    expect(agent.passwords).toHaveLength(2);

    // Kindgi saves the password but not the address: the one the store keeps is said too.
    const other = shop.url.replace('127.0.0.1', 'localhost');
    run = connectStore([other, '--no-browser'], {
      FAKE_KINDGI_REFUSES: '^env set WOO_STORE_URL .*--force',
    });
    await approve(shop, await run.link);
    out = await run.done;
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(
      `! Couldn't revoke the agent's new password, the newest "Kindgi (acme-shop, local)" (HTTP 500).`,
    );
    expect(out.stderr).toContain(
      `Kindgi couldn't save this store's address (WOO_STORE_URL still says "${shop.url}"), and the store couldn't revoke its new password: WOO_APP_PASSWORD's newest version is that password, which the pack's tools send to ${shop.url}. Remove it as said above, then run this again once kindgi can set WOO_STORE_URL.`,
    );
    expect(agent.passwords).toHaveLength(3);
    expect((await kindgiState()).secrets['tenant in env local WOO_APP_PASSWORD']!.at(-1)).toBe(
      agent.passwords[2]!.password,
    );

    // A connect that works can't revoke the ones before it, and says so for each.
    run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    const left = `! Couldn't revoke the agent's password from the connect before, an older "Kindgi (acme-shop, local)" (HTTP 500). Remove it under Users → All Users → kindgi-agent → Application Passwords.`;
    expect(out.stdout.split('\n').filter((l) => l === left)).toHaveLength(3);
    expect(agent.passwords).toHaveLength(4);
    // The approver's own still goes.
    expect(shop.users[0]!.passwords).toEqual([]);
  });

  test("a stop after the approval still revokes the approver's password", async () => {
    let release: () => void = () => {};
    const shop = await store({
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const run = connectStore([shop.url, '--no-browser']);
    const page = approve(shop, await run.link);
    // It's checking the agent's new password on WooCommerce, which waits.
    await vi.waitFor(() => expect(shop.wooSignIns).toHaveLength(1));
    run.child.kill('SIGINT');
    const { code, stdout, stderr } = await run.done;
    release();
    expect(code).toBe(130);
    expect(stderr).toContain(
      'Stopped (SIGINT) before the store was connected: run this again to connect it, which replaces what this run left.',
    );
    expect(await page).toContain('It was stopped in the terminal.');
    expect(shop.users[0]!.passwords).toEqual([]);
    expect(stdout).toContain("✓ Revoked owner's approval password.");
  });

  test('a pack whose @kindgi/cli is not installed is refused before any approval', async () => {
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    const shop = await store();
    const { code, stdout, stderr } = await connectStore([shop.url, '--no-browser']).done;
    expect(code).toBe(1);
    expect(stderr).toContain("This pack's @kindgi/cli isn't installed. Run pnpm install first.");
    expect(stdout).toBe('');
  });

  test('an approval by someone who cannot add users connects nothing', async () => {
    const shop = await store();
    shop.users.push({
      id: 2,
      slug: 'clerk',
      email: 'clerk@example.com',
      roles: ['shop_manager'],
      passwords: [],
    });
    const run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link, 'clerk');
    const { code, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain(
      "clerk can't add users, so Kindgi can't make its own. Approve as one of the store's administrators.",
    );
    expect(shop.users.map((u) => u.slug)).toEqual(['owner', 'clerk']);
    expect(shop.users[1]!.passwords).toEqual([]);
  });

  test.each([
    [{ applicationPasswords: false }, "This store doesn't offer Application Passwords."],
    [{ woocommerce: false }, "WooCommerce isn't active on this store"],
  ])('a store it cannot connect is refused before any approval (%o)', async (opts, said) => {
    const shop = await store(opts);
    const run = connectStore([shop.url, '--no-browser']);
    const { code, stdout, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain(said);
    expect(stdout).not.toContain('authorize-application.php');
  });

  test.each([
    [[], 'Name one store.'],
    [['https://shop.example.com', '--hosted'], 'With --hosted, name the env your deploy runs in'],
    [['https://shop.example.com', '--envv=x'], "Unknown option '--envv'."],
    [['shop.example.com'], `"shop.example.com" isn't an address.`],
  ])('%j is refused with what to give', async (args, said) => {
    const { code, stdout, stderr } = await connectStore(args).done;
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(said);
    if (said === 'Name one store.') {
      expect(stderr).toContain('Usage: pnpm connect-store https://shop.example.com');
    }
  });
});
