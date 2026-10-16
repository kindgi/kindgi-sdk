// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi projects create` and `kindgi projects rename`: through the
 * client's `projects.create` and `projects.update`, then the project as
 * `projects get` prints it. The refusals go through the client's own
 * reading of the wire error, so their line names the server's code.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** The runtime's refusals, as the wire carries them. */
const SLUG_TAKEN = fromWire(
  { code: 'slug-conflict', message: 'Another project in its org has the slug "support-bot"' },
  409,
);
const NOT_ADMIN = fromWire(
  { code: 'permission-denied', message: 'Only a tenant admin can make a project' },
  403,
);
const NO_ORG = fromWire({ code: 'org-not-found', message: 'No org with id "o-gone"' }, 404);
const NO_PROJECT = fromWire(
  { code: 'project-not-found', message: 'No project with id "p-gone"' },
  404,
);

async function run(
  argv: readonly string[],
  options: {
    readonly refuse?: ReturnType<typeof fromWire>;
    /** The read after the change fails with this. */
    readonly unread?: ReturnType<typeof fromWire>;
  } = {},
) {
  const calls: unknown[][] = [];
  let project: Record<string, unknown> = {};
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: {
          create: async (...args: unknown[]) => {
            calls.push(['create', ...args]);
            if (options.refuse !== undefined) throw new KindgiApiError(options.refuse);
            project = { id: 'p-new', isDefault: false, ...(args[0] as object) };
            return { id: 'p-new' };
          },
          update: async (...args: unknown[]) => {
            calls.push(['update', ...args]);
            if (options.refuse !== undefined) throw new KindgiApiError(options.refuse);
            project = {
              id: args[0],
              name: 'Shop',
              slug: 'shop',
              isDefault: false,
              ...(args[1] as object),
            };
            // The server answers 204: nothing comes back.
            return undefined;
          },
          get: async (...args: unknown[]) => {
            calls.push(['get', ...args]);
            if (options.unread !== undefined) throw new KindgiApiError(options.unread);
            return project;
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi projects create', () => {
  test('--name alone: the slug is the name as a slug; prints the project made', async () => {
    const { out, calls } = await run(['projects', 'create', '--name=Support bot']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      ['create', { name: 'Support bot', slug: 'support-bot' }],
      ['get', 'p-new'],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      id: 'p-new',
      name: 'Support bot',
      slug: 'support-bot',
      isDefault: false,
    });
  });

  test('--slug, --description and --org are passed on as given', async () => {
    const { out, calls } = await run([
      'projects',
      'create',
      '--name=Support bot',
      '--slug=helpdesk',
      '--description=Answers the support inbox',
      '--org=o-acme',
    ]);
    expect(out.exitCode).toBe(0);
    expect(calls[0]).toEqual([
      'create',
      {
        name: 'Support bot',
        slug: 'helpdesk',
        description: 'Answers the support inbox',
        orgId: 'o-acme',
      },
    ]);
  });

  test('the name trimmed; the slug made from it: accents dropped, each run of anything else one -, none at the ends, at most 63', async () => {
    const accents = await run(['projects', 'create', '--name=  Café Crème & Co. (EU)  ']);
    expect(accents.calls[0]).toEqual([
      'create',
      { name: 'Café Crème & Co. (EU)', slug: 'cafe-creme-co-eu' },
    ]);
    const long = await run(['projects', 'create', `--name=${'a'.repeat(62)} b`]);
    expect(long.calls[0]).toEqual([
      'create',
      { name: `${'a'.repeat(62)} b`, slug: 'a'.repeat(62) },
    ]);
  });

  test('no --name, or a name with nothing to make a slug of: a usage error, exit 2, nothing sent', async () => {
    const none = await run(['projects', 'create']);
    expect(none.out.exitCode).toBe(2);
    expect(none.out.stderr).toContain('--name=<name> is required');
    expect(none.calls).toEqual([]);

    const blank = await run(['projects', 'create', '--name=   ']);
    expect(blank.out.exitCode).toBe(2);
    expect(blank.calls).toEqual([]);

    const symbols = await run(['projects', 'create', '--name=!!!']);
    expect(symbols.out.exitCode).toBe(2);
    expect(symbols.out.stderr).toContain(
      '"!!!" has no letters or digits to make a slug of: give --slug=<slug>',
    );
    expect(symbols.calls).toEqual([]);

    const given = await run(['projects', 'create', '--name=!!!', '--slug=bangs']);
    expect(given.out.exitCode).toBe(0);
    expect(given.calls[0]).toEqual(['create', { name: '!!!', slug: 'bangs' }]);
  });

  test('a flag given empty (`--slug=$SLUG` with SLUG unset) is a usage error, never the same as not given', async () => {
    for (const flag of ['--slug=', '--slug=  ', '--org=', '--description=']) {
      const { out, calls } = await run(['projects', 'create', '--name=Support bot', flag]);
      expect(out.exitCode, flag).toBe(2);
      expect(out.stderr, flag).toContain(`${flag.slice(0, flag.indexOf('='))} takes a value`);
      expect(calls, flag).toEqual([]);
    }
  });

  test('made, but the read after it fails: exit 0, its id printed, and stderr says so', async () => {
    const { out, calls } = await run(['projects', 'create', '--name=Support bot'], {
      unread: fromWire({ code: 'internal-error', message: 'database unavailable' }, 503),
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ id: 'p-new' });
    expect(out.stderr).toContain(
      "Made project p-new, but couldn't read it back: database unavailable.",
    );
    expect(out.stderr).toContain('`kindgi projects get p-new` shows it.');
    expect(calls.map((c) => c[0])).toEqual(['create', 'get']);
  });

  test('a --slug of anything but lowercase letters, digits and hyphens, or past 63: a usage error, exit 2, nothing sent', async () => {
    for (const slug of ['Support', '-support', 'sup port', 'a'.repeat(64)]) {
      const { out, calls } = await run(['projects', 'create', '--name=Support', `--slug=${slug}`]);
      expect(out.exitCode, slug).toBe(2);
      expect(out.stderr, slug).toContain(
        'lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters',
      );
      expect(calls, slug).toEqual([]);
    }
    const longest = await run(['projects', 'create', '--name=Support', `--slug=${'a'.repeat(63)}`]);
    expect(longest.out.exitCode).toBe(0);
  });

  test('a slug taken: slug-conflict by its own code, exit 1, and nothing printed as made', async () => {
    const { out, calls } = await run(['projects', 'create', '--name=Support bot'], {
      refuse: SLUG_TAKEN,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      'Error [slug-conflict]: Another project in its org has the slug "support-bot"\n',
    );
    expect(calls).toEqual([['create', { name: 'Support bot', slug: 'support-bot' }]]);
  });

  test("someone who isn't a tenant admin, or an org that isn't there: the server's code, not the client's family", async () => {
    const denied = await run(['projects', 'create', '--name=Shop'], { refuse: NOT_ADMIN });
    expect(denied.out.exitCode).toBe(1);
    expect(denied.out.stderr).toBe(
      'Error [permission-denied]: Only a tenant admin can make a project\n',
    );
    const org = await run(['projects', 'create', '--name=Shop', '--org=o-gone'], {
      refuse: NO_ORG,
    });
    expect(org.out.exitCode).toBe(1);
    expect(org.out.stderr).toBe('Error [org-not-found]: No org with id "o-gone"\n');
  });

  test('--verbose: the refusal line, then the whole error', async () => {
    const { out } = await run(['projects', 'create', '--name=Shop', '--org=o-gone', '--verbose'], {
      refuse: NO_ORG,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr.startsWith('Error [org-not-found]: No org with id "o-gone"\n{')).toBe(true);
    expect(out.stderr).toContain('"serverCode": "org-not-found"');
  });
});

describe('kindgi projects rename', () => {
  test('--name: changes the name only, then prints the project', async () => {
    const { out, calls } = await run(['projects', 'rename', 'p-shop', '--name=Storefront']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      ['update', 'p-shop', { name: 'Storefront' }],
      ['get', 'p-shop'],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({
      id: 'p-shop',
      name: 'Storefront',
      slug: 'shop',
      isDefault: false,
    });
  });

  test('--slug, alone or with --name', async () => {
    const slug = await run(['projects', 'rename', 'p-shop', '--slug=storefront']);
    expect(slug.out.exitCode).toBe(0);
    expect(slug.calls[0]).toEqual(['update', 'p-shop', { slug: 'storefront' }]);
    const both = await run([
      'projects',
      'rename',
      'p-shop',
      '--name=Storefront',
      '--slug=storefront',
    ]);
    expect(both.calls[0]).toEqual(['update', 'p-shop', { name: 'Storefront', slug: 'storefront' }]);
  });

  test('no project id, neither flag, or an empty one: a usage error, exit 2, nothing sent', async () => {
    for (const argv of [
      ['projects', 'rename', '--name=Storefront'],
      ['projects', 'rename', 'p-shop'],
      ['projects', 'rename', 'p-shop', '--name='],
      ['projects', 'rename', 'p-shop', '--slug= '],
      ['projects', 'rename', 'p-shop', '--slug=Store Front'],
    ]) {
      const { out, calls } = await run(argv);
      expect(out.exitCode, argv.join(' ')).toBe(2);
      expect(calls, argv.join(' ')).toEqual([]);
    }
  });

  test('changed, but the read after it fails: exit 0, its id printed, and stderr says so', async () => {
    const { out } = await run(['projects', 'rename', 'p-shop', '--name=Storefront'], {
      unread: fromWire({ code: 'internal-error', message: 'database unavailable' }, 503),
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ id: 'p-shop' });
    expect(out.stderr).toContain("Changed project p-shop, but couldn't read it back");
  });

  test('a project not found, or a slug taken: by their own codes, exit 1', async () => {
    const gone = await run(['projects', 'rename', 'p-gone', '--name=X'], { refuse: NO_PROJECT });
    expect(gone.out.exitCode).toBe(1);
    expect(gone.out.stderr).toBe('Error [project-not-found]: No project with id "p-gone"\n');
    expect(gone.calls).toEqual([['update', 'p-gone', { name: 'X' }]]);
    const taken = await run(['projects', 'rename', 'p-shop', '--slug=support-bot'], {
      refuse: SLUG_TAKEN,
    });
    expect(taken.out.exitCode).toBe(1);
    expect(taken.out.stderr).toBe(
      'Error [slug-conflict]: Another project in its org has the slug "support-bot"\n',
    );
  });
});
