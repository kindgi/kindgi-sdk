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

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
 * secrets.test.ts).
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
if (process.env.FAKE_KINDGI_REFUSES) {
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
  opts: { applicationPasswords?: boolean; woocommerce?: boolean } = {},
): Promise<Store> {
  const users: WpUser[] = [
    { id: 1, slug: 'owner', email: 'owner@example.com', roles: ['administrator'], passwords: [] },
  ];
  const wooSignIns: string[] = [];
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
  const routes: readonly [string, RegExp, (r: Request) => Answer][] = [
    [
      'GET',
      /^wc\/v3\/orders$/,
      (r) => {
        if (!isAdmin(r.who.user) && !r.who.user.roles.includes('shop_manager')) return NOT_ALLOWED;
        wooSignIns.push(r.who.used.password);
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
      (r) => (isAdmin(r.who.user) ? remove(ofUser(r)!.passwords, r.match[2]) : NOT_ALLOWED),
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
  return { link, done };
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
      ['env', 'set', 'WOO_STORE_URL', shop.url, '--env=local', '--scope=tenant'],
      ['env', 'set', 'WOO_USER', 'kindgi-agent', '--env=local', '--scope=tenant'],
      ['secrets', 'set', 'WOO_APP_PASSWORD', '--env=local', '--scope=tenant', '--from-stdin'],
    ]);
    // Run in the pack, the password on stdin and never in an argument or the output.
    const pack = await realpath(root);
    expect(calls.map((c) => c.cwd)).toEqual([pack, pack, pack]);
    expect(calls[2]!.stdin).toBe(password);
    expect(JSON.stringify(calls.map((c) => c.argv))).not.toContain(password);
    expect(stdout + stderr).not.toContain(password);
    expect(stdout).toContain("✓ Revoked owner's approval password.");
    expect(stdout).toContain(
      'Connected. Try the store agent: pnpm exec kindgi runs start --agent=acme-shop.store-agent',
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
    expect(link.searchParams.get('app_name')).toBe('Kindgi (acme-shop, production)');
    expect(link.searchParams.get('app_id')).not.toBe(first.app_id);
    await approve(shop, link);
    out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(agent.passwords.map((p) => p.name)).toEqual([
      'Kindgi (acme-shop, local)',
      'Kindgi (acme-shop, production)',
    ]);
    expect(agent.passwords[0]).toEqual(local);
    expect(out.stdout).toContain(
      "Connected: the pack's tools in production sign in to the store as kindgi-agent.",
    );

    const calls = (await kindgiCalls()).slice(-3).map((c) => c.argv);
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
    expect(await kindgiCalls()).toEqual([]);
  });

  test("a kindgi-agent the store already has in another role is left alone, and the approval's password still goes", async () => {
    const shop = await store();
    shop.users.push({
      id: 2,
      slug: 'kindgi-agent',
      email: 'k@example.com',
      roles: ['editor'],
      passwords: [],
    });
    const run = connectStore([shop.url, '--no-browser']);
    const page = await approve(shop, await run.link);
    const { code, stdout, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain("There's already a user named kindgi-agent, as editor.");
    expect(page).toContain('Not connected');
    expect(shop.users[1]!.roles).toEqual(['editor']);
    expect(shop.users[0]!.passwords).toEqual([]);
    expect(stdout).toContain("✓ Revoked owner's approval password");
    expect(await kindgiCalls()).toEqual([]);
  });

  test("when Kindgi refuses the save, the agent's new password goes and the one before stays", async () => {
    const shop = await store();
    let run = connectStore([shop.url, '--no-browser']);
    await approve(shop, await run.link);
    expect((await run.done).code).toBe(0);
    const agent = shop.users.find((u) => u.slug === 'kindgi-agent')!;
    const before = [...agent.passwords];

    run = connectStore([shop.url, '--no-browser'], { FAKE_KINDGI_REFUSES: '1' });
    const page = await approve(shop, await run.link);
    const { code, stdout, stderr } = await run.done;
    expect(code).toBe(1);
    expect(stderr).toContain(
      'kindgi env set WOO_STORE_URL failed:\nError [auth]: Bearer token is not recognized',
    );
    expect(page).toContain('Not connected');
    expect(agent.passwords).toEqual(before);
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
